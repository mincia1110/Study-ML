#!/usr/bin/env node
'use strict';

import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { collectCitationRecommendations, extractArxivIdFromWork, buildOpenAlexUrl } from './lib/openalex.mjs';
import { CITATION_MODES, citationWindow, selectCitationPapers } from './lib/recommend.mjs';
import { normalizeSummary, parsePreviousPapers, readPreviousPapers, reusableSummary } from './lib/paper-cache.mjs';
import { createArxivClient } from './lib/arxiv-client.mjs';

/**
 * collect-papers.mjs — arXiv daily paper collector.
 *
 * SUMMARY GUIDELINES (see also docs/summary-guidelines.md):
 * - detail.problem, detail.method, detail.takeaway: 1-2 Korean sentences each.
 * - Concrete and cautious, no hype, mention limitations when evident.
 * - Uses opencode-go/deepseek-v4-flash when a key is available.
 * - Falls back to a source-directed unavailable-summary when no valid LLM summary is available.
 * - Manual review and refinement welcomed when quality matters.
 *
 * Node 18+ only (built-in fetch). No dependencies.
 * Usage:
 *   node scripts/collect-papers.mjs          # writes data/papers.js
 *   node scripts/collect-papers.mjs --dry-run  # prints to stdout, no write
 *
 * API key (optional, enables LLM summaries via opencode-go/deepseek-v4-flash):
 *   node --env-file=.env scripts/collect-papers.mjs   # project .env
 *   OPENCODE_GO_API_KEY=sk-... node scripts/...       # inline
 *   # or set OPENCODE_GO_API_KEY as a GitHub Actions secret
 *   # without a key, uses a source-directed unavailable-summary
 */

const ARXIV_API = 'https://export.arxiv.org/api/query';
const CAT_QUERIES = [
  'cat:cs.CV AND (all:"large language model" OR all:"vision-language" OR all:multimodal OR all:video OR all:3d OR all:benchmark)',
  'cat:cs.CL AND (all:"large language model" OR all:reasoning OR all:agent OR all:retrieval OR all:RAG)',
];
const MAX_RESULTS = 50;
const MAX_PAPERS = 12;
const OUTPUT_PATH = 'data/papers.js';
const IS_SELF_TEST = process.argv.includes('--self-test');
const OPENALEX_API_KEY = IS_SELF_TEST ? '' : (process.env.OPENALEX_API_KEY || '');

const OPENCODE_GO_URL = process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1/chat/completions';
const OPENCODE_GO_MODEL = process.env.OPENCODE_GO_MODEL || 'deepseek-v4-flash';
const DEFAULT_LLM_TIMEOUT_MS = 60_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const LLM_TIMEOUT_MS = positiveInteger(process.env.OPENCODE_GO_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS);
const ARXIV_REQUEST_TIMEOUT_MS = positiveInteger(process.env.ARXIV_REQUEST_TIMEOUT_MS, 60_000);
const ARXIV_MAX_RETRIES = positiveInteger(process.env.ARXIV_MAX_RETRIES, 3);
const arxivClient = createArxivClient({
  requestTimeoutMs: ARXIV_REQUEST_TIMEOUT_MS,
  maxRetries: ARXIV_MAX_RETRIES,
});

// ponytail: read key from env first, fall back to opencodex config so local runs
// "just work" without manual export. CI sets OPENCODE_GO_API_KEY as a secret.
function resolveApiKey() {
  if (IS_SELF_TEST) return '';
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.opencodex', 'config.json'), 'utf-8'));
    return cfg?.providers?.['opencode-go']?.apiKey || '';
  } catch (_) {
    return '';
  }
}

const API_KEY = resolveApiKey();
const USE_LLM = Boolean(API_KEY);

/* ── helpers ── */

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractArxivId(entry) {
  const m = entry.match(/<id>[^<]*\/abs\/(\d+\.\d+)/);
  return m ? m[1] : null;
}

function extractTag(entry, tag) {
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`);
  const m = entry.match(re);
  return m ? stripHtml(m[1]) : '';
}

function extractCategories(entry) {
  const cats = [];
  const re = /<category\s+term="([^"]+)"/g;
  let m;
  while ((m = re.exec(entry)) !== null) cats.push(m[1]);
  return cats;
}

function extractAuthors(entry) {
  const names = [];
  const re = /<author>[\s\S]*?<name>([^<]+)<\/name>/g;
  let m;
  while ((m = re.exec(entry)) !== null) names.push(stripHtml(m[1]));
  if (names.length === 0) return 'Unknown';
  if (names.length <= 3) return names.join(', ');
  return names[0] + ' et al.';
}

function parsePreviousPaperIds(source) {
  return new Set(parsePreviousPapers(source).map(p => p.id).filter(Boolean));
}

function latestPreviousIds(previousPapers) {
  return new Set(previousPapers
    .filter(p => !Array.isArray(p.recommendationModes) || p.recommendationModes.includes('latest'))
    .map(p => p.id));
}

function selectFreshFirst(papers, previousIds, limit = MAX_PAPERS) {
  const fresh = papers.filter(p => !previousIds.has(p.id));
  const backfill = papers.filter(p => previousIds.has(p.id));
  return [...fresh, ...backfill].slice(0, limit);
}

/* ── scoring ── */

function computeScore(title, abstract, categories) {
  const text = (title + ' ' + abstract).toLowerCase();
  const catStr = categories.join(' ').toLowerCase();
  let score = 0;
  const terms = [
    'foundation model', 'benchmark', 'diffusion', 'large language',
    'agent', 'retrieval', 'embedding', '3d', 'gaussian',
    'privacy', 'medical', 'autonomous', 'video', 'multimodal',
    'visual question answering', 'chain-of-thought', 'reasoning',
    'dataset', 'evaluation', 'survey', 'reinforcement learning',
    'representation learning', 'world model', 'code generation',
    'text-to-image', 'detection', 'segmentation', 'generation',
  ];
  for (const t of terms) {
    if (text.includes(t)) score += 3;
  }
  if (catStr.includes('cs.cv') && catStr.includes('cs.cl')) score += 5;
  if (catStr.includes('cs.cv') && catStr.includes('cs.ai')) score += 3;
  return score;
}

/* ── category inference ── */

function hasTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

function inferCategory(categories, title, abstract) {
  const catSet = new Set(categories.map(c => c.toLowerCase()));
  const text = (title + ' ' + abstract).toLowerCase();
  const hasLlm = catSet.has('cs.cl') || hasTerm(text, 'large language model') || hasTerm(text, 'llm') || hasTerm(text, 'retrieval') || hasTerm(text, 'agent') || hasTerm(text, 'agents') || hasTerm(text, 'code generation');
  const hasCv = catSet.has('cs.cv') || hasTerm(text, 'image') || hasTerm(text, 'vision') || hasTerm(text, 'video') || hasTerm(text, '3d') || hasTerm(text, 'detection') || hasTerm(text, 'segmentation');
  if (hasCv && hasLlm) return 'multimodal';
  if (hasCv) return 'cv';
  return 'llm';
}

/* ── unavailable Korean summary fallback ── */

function generateSummary(title, abstract, categories, category) {
  const unavailable = '자동 한국어 요약을 생성하지 못했습니다. 논문 원문과 초록을 확인해 주세요.';
  return {
    summaryKo: unavailable,
    detail: {
      problem: '자동 요약을 제공할 수 없습니다. 연구가 다루는 문제는 논문 원문과 초록에서 확인해 주세요.',
      method: '자동 요약을 제공할 수 없습니다. 제안 방법은 논문 원문과 초록에서 확인해 주세요.',
      takeaway: '자동 요약을 제공할 수 없습니다. 결과와 한계는 논문 원문과 초록에서 확인해 주세요.',
    },
  };
}

/* ── LLM summary via opencode-go (deepseek-v4-flash) ── */

async function summarizeWithLLM(paper, options = {}) {
  const prompt = `다음 arXiv 논문을 한국어로 요약해라. JSON만 반환해라. 과장하지 말고 초록에 없는 내용은 만들지 마라.

제목: ${paper.title}
저자: ${paper.authors}
분야: ${paper.categories.join(', ')}
초록: ${paper.abstract || paper.summaryKo}

형식:
{"summaryKo":"한 문장 요약","detail":{"problem":"1-2문장: 해결하려는 문제","method":"1-2문장: 제안하는 방법","takeaway":"1-2문장: 주요 결과와 한계"}}`;

  const timeoutMs = positiveInteger(options.timeoutMs, LLM_TIMEOUT_MS);
  const fetcher = options.fetcher || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(OPENCODE_GO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENCODE_GO_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    // extract JSON object from response (may be wrapped in markdown fences)
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in LLM response');
    const parsed = JSON.parse(match[0]);
    const summary = normalizeSummary(parsed);
    if (!summary) throw new Error('missing or invalid fields in LLM JSON');
    return summary;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`LLM API timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ── arXiv feed fetch & parse ── */

async function fetchEntries(query) {
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${MAX_RESULTS}`;
  const xml = await arxivClient.fetchText(url, `query=${query}`);
  return xml.split('<entry>').slice(1);
}

async function fetchEntriesByIds(ids) {
  const entries = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const params = new URLSearchParams({ id_list: batch.join(','), max_results: String(batch.length) });
    const xml = await arxivClient.fetchText(`${ARXIV_API}?${params}`, 'citation metadata');
    entries.push(...xml.split('<entry>').slice(1));
  }
  return entries;
}

function paperFromEntry(raw) {
  const id = extractArxivId(raw);
  const title = extractTag(raw, 'title').replace(/\s+/g, ' ');
  if (!id || !title) return null;
  const published = extractTag(raw, 'published').substring(0, 10);
  const abstract = extractTag(raw, 'summary').replace(/\s+/g, ' ');
  const categories = extractCategories(raw);
  return {
    id,
    title,
    authors: extractAuthors(raw),
    published,
    category: inferCategory(categories, title, abstract),
    categories,
    abstract,
    tags: [],
    summaryKo: '',
    detail: {},
    sourceUrl: `https://arxiv.org/abs/${id}v1`,
    pdfUrl: `https://arxiv.org/pdf/${id}v1.pdf`,
    _score: computeScore(title, abstract, categories),
  };
}

function addRecommendation(paper, mode, rank) {
  if (!paper.recommendationModes) paper.recommendationModes = [];
  if (!paper.recommendationModes.includes(mode)) paper.recommendationModes.push(mode);
  if (!paper.recommendationRanks) paper.recommendationRanks = {};
  paper.recommendationRanks[mode] = rank;
}

function restorePreviousCitationPapers(selectedById, previousPapers) {
  for (const previous of previousPapers) {
    const modes = (previous.recommendationModes || []).filter(mode => mode !== 'latest');
    if (modes.length === 0) continue;
    const current = selectedById.get(previous.id);
    if (current) {
      for (const mode of modes) addRecommendation(current, mode, previous.recommendationRanks?.[mode] || 999);
      if (!current.metrics && previous.metrics) current.metrics = structuredClone(previous.metrics);
    } else {
      const restored = structuredClone(previous);
      restored.recommendationModes = modes;
      restored.recommendationRanks = Object.fromEntries(modes.map(mode => [mode, previous.recommendationRanks?.[mode] || 999]));
      selectedById.set(previous.id, restored);
    }
  }
}

async function collectPapers(options = {}) {
  const previousPapers = readPreviousPapers(OUTPUT_PATH);
  const previousById = new Map(previousPapers.map(p => [p.id, p]));
  const seen = new Map(); // id -> paper

  for (const catQ of CAT_QUERIES) {
    const entries = await fetchEntries(catQ);
    for (const raw of entries) {
      const paper = paperFromEntry(raw);
      if (paper && !seen.has(paper.id)) seen.set(paper.id, paper);
    }
  }

  // Sort first, then prefer papers not shown in the previous generated page.
  const latest = selectFreshFirst(
    [...seen.values()].sort((a, b) => (b._score - a._score) || (b.published > a.published ? 1 : -1)),
    latestPreviousIds(previousPapers),
  );
  latest.forEach((paper, index) => addRecommendation(paper, 'latest', index + 1));

  const selectedById = new Map(latest.map(p => [p.id, p]));
  let citationStatus = options.latestOnly ? 'disabled' : (OPENALEX_API_KEY ? 'ok' : 'missing-key');
  let citationResult = { byMode: {}, windows: {}, queryCount: 0 };
  const citationFallbackModes = [];

  if (!options.latestOnly && OPENALEX_API_KEY) {
    try {
      citationResult = await collectCitationRecommendations(OPENALEX_API_KEY, { now: options.now });
      for (const [mode, recommendations] of Object.entries(citationResult.byMode)) {
        let effective = recommendations;
        if (recommendations.length > 0 && recommendations.every(item => item.citationCount === 0)) {
          const window = citationResult.windows[mode];
          const fallback = latest.filter(item => item.published >= window.from && item.published <= window.to).slice(0, 6);
          if (fallback.length > 0) {
            effective = fallback.map((item, index) => ({ id: item.id, recommendationRank: index + 1, citationCount: 0 }));
            citationFallbackModes.push(mode);
          }
        }
        citationResult.byMode[mode] = effective;
      }

      const citationIds = [...new Set(Object.values(citationResult.byMode).flat().map(p => p.id))];
      const missingIds = citationIds.filter(id => !selectedById.has(id));
      const citationPapers = new Map();
      if (missingIds.length > 0) {
        for (const raw of await fetchEntriesByIds(missingIds)) {
          const paper = paperFromEntry(raw);
          if (paper) citationPapers.set(paper.id, paper);
        }
      }

      for (const [mode, recommendations] of Object.entries(citationResult.byMode)) {
        recommendations.forEach((recommendation, index) => {
          const paper = selectedById.get(recommendation.id) || citationPapers.get(recommendation.id);
          if (!paper) return;
          addRecommendation(paper, mode, recommendation.recommendationRank || index + 1);
          paper.metrics = {
            citationCount: recommendation.citationCount || 0,
            citationSource: 'openalex',
            citationUpdatedAt: new Date().toISOString(),
            ...(recommendation.openAlexId ? { openAlexId: recommendation.openAlexId } : {}),
          };
          selectedById.set(paper.id, paper);
        });
      }
    } catch (error) {
      citationStatus = 'stale-cache';
      console.warn(`Citation collection failed: ${error.message}; preserving previous citation papers`);
      restorePreviousCitationPapers(selectedById, previousPapers);
    }
  } else if (!options.latestOnly) {
    restorePreviousCitationPapers(selectedById, previousPapers);
  }

  const sorted = [...selectedById.values()].sort((a, b) => {
    const aRank = a.recommendationRanks?.latest || 999;
    const bRank = b.recommendationRanks?.latest || 999;
    return (aRank - bRank) || (b.published > a.published ? 1 : -1);
  });

  // Generate tags (keyword-based) for each
  for (const p of sorted) {
    const cached = reusableSummary(previousById.get(p.id));
    if (cached) {
      p.tags = cached.tags;
      p.summaryKo = cached.summaryKo;
      p.detail = cached.detail;
      continue;
    }
    const low = (p.title + ' ' + p.abstract).toLowerCase();
    const tagSet = new Set();
    const tagMap = {
      'benchmark': ['benchmark'], 'diffusion': ['diffusion'], 'agent': ['agents'],
      '3d': ['3d'], 'privacy': ['privacy'], 'medical': ['medical'],
      'video': ['video'], 'autonomous': ['autonomous-driving'],
      'retrieval': ['retrieval'], 'embedding': ['embedding'],
      'multimodal': ['multimodal'], 'code generation': ['code-generation'],
      'dataset': ['benchmark'], 'survey': ['survey'],
      'generation': ['generation'], 'detection': ['detection'],
    };
    for (const [keyword, tags] of Object.entries(tagMap)) {
      if (low.includes(keyword)) tags.forEach(t => tagSet.add(t));
    }
    p.tags = [...tagSet].slice(0, 5);
  }

  // Summarize with the LLM; otherwise retain a transparent unavailable-summary.
  for (const p of sorted) {
    const currentSummary = normalizeSummary(p);
    if (currentSummary) {
      p.summaryKo = currentSummary.summaryKo;
      p.detail = currentSummary.detail;
      continue;
    }
    const category = p.category;
    const templateSum = generateSummary(p.title, p.abstract, p.categories, category);
    if (USE_LLM) {
      try {
        const llmSum = await summarizeWithLLM(p);
        p.summaryKo = llmSum.summaryKo;
        p.detail = llmSum.detail;
      } catch (err) {
        console.warn(`LLM summary failed for ${p.id}: ${err.message}; using template`);
        p.summaryKo = templateSum.summaryKo;
        p.detail = templateSum.detail;
      }
    } else {
      p.summaryKo = templateSum.summaryKo;
      p.detail = templateSum.detail;
    }
  }

  // Strip abstract and _score from output
  for (const p of sorted) {
    delete p.abstract;
    delete p._score;
  }

  return {
    papers: sorted,
    metadata: {
      citation: {
        source: 'OpenAlex',
        status: citationStatus,
        queryCount: citationResult.queryCount,
        windows: citationResult.windows,
        fallbackModes: citationFallbackModes,
      },
    },
  };
}

/* ── output ── */

function serialize(papers, extraMetadata = {}) {
  const json = JSON.stringify(papers, null, 2);
  const metadata = JSON.stringify({
    collectedAt: new Date().toISOString(),
    source: 'arXiv',
    note: 'Auto-collected by scripts/collect-papers.mjs. See docs/summary-guidelines.md.',
    summarizer: USE_LLM ? 'llm' : 'template',
    recommendationVersion: 1,
    ...extraMetadata,
  }, null, 2);
  return `// data/papers.js — Auto-generated by scripts/collect-papers.mjs\n// Run \`node scripts/collect-papers.mjs\` to regenerate.\n/* eslint-disable */\nwindow.PAPERS = ${json};\n\nwindow.PAPER_METADATA = ${metadata};\n`;
}

/* ── main ── */

async function main() {
  if (process.argv.includes('--self-test')) {
    const previous = parsePreviousPaperIds('window.PAPERS = [{"id":"a"},{"id":"b"}];\n\nwindow.PAPER_METADATA = {};');
    assert.deepEqual([...previous], ['a', 'b']);
    assert.deepEqual(selectFreshFirst([{ id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'd' }], previous, 3).map(p => p.id), ['c', 'd', 'a']);
    assert.deepEqual(citationWindow(7, new Date('2026-07-18T14:00:00Z')), { from: '2026-07-12', to: '2026-07-18' });
    assert.deepEqual(selectCitationPapers([
      { id: 'cv1', category: 'cv', published: '2026-07-01', citationCount: 10 },
      { id: 'cv2', category: 'cv', published: '2026-07-02', citationCount: 9 },
      { id: 'cv3', category: 'cv', published: '2026-07-03', citationCount: 8 },
      { id: 'llm1', category: 'llm', published: '2026-07-01', citationCount: 7 },
      { id: 'llm2', category: 'llm', published: '2026-07-02', citationCount: 6 },
      { id: 'mm1', category: 'multimodal', published: '2026-07-01', citationCount: 5 },
      { id: 'mm2', category: 'multimodal', published: '2026-07-02', citationCount: 4 },
    ], { limit: 6, perCategory: 2, now: new Date('2026-07-18T00:00:00Z') }).map(p => p.id), ['cv1', 'cv2', 'llm1', 'llm2', 'mm1', 'mm2']);
    assert.equal(extractArxivIdFromWork({ locations: [{ landing_page_url: 'https://arxiv.org/abs/2607.12345v2' }] }), '2607.12345');
    assert.match(buildOpenAlexUrl({ apiKey: 'test', category: 'cv', from: '2026-07-12', to: '2026-07-18' }), /from_publication_date%3A2026-07-12/);
    const fixture = JSON.parse(readFileSync('scripts/fixtures/openalex-works.json', 'utf-8'));
    const fixtureResult = await collectCitationRecommendations('test', {
      now: new Date('2026-07-18T00:00:00Z'),
      fetcher: async url => {
        const search = new URL(url).searchParams.get('search') || '';
        const category = search.includes('computer vision') ? 'cv' : (search.includes('large language') ? 'llm' : 'multimodal');
        return { results: fixture[category] };
      },
    });
    assert.equal(fixtureResult.queryCount, 12);
    assert.deepEqual(Object.keys(fixtureResult.byMode), Object.keys(CITATION_MODES));
    assert.equal(fixtureResult.byMode.week.length, 6);
    assert.deepEqual(fixtureResult.byMode.week.map(p => p.category), ['cv', 'cv', 'llm', 'llm', 'multimodal', 'multimodal']);

    // Citation restoration filters stale latest metadata and preserves current latest ranks.
    const overlap = { id: 'overlap', recommendationModes: ['latest'], recommendationRanks: { latest: 1 } };
    const mixedPrevious = {
      id: 'overlap',
      recommendationModes: ['latest', 'week'],
      recommendationRanks: { latest: 9, week: 3 },
      metrics: { citationCount: 4 },
    };
    const citationOnlyPrevious = {
      id: 'citation-only',
      recommendationModes: ['month', 'year'],
      recommendationRanks: { month: 4, year: 7 },
      summaryKo: '이전 요약',
    };
    const previousForRestore = structuredClone([mixedPrevious, citationOnlyPrevious]);
    const restoredSelection = new Map([[overlap.id, overlap]]);
    restorePreviousCitationPapers(restoredSelection, [mixedPrevious, citationOnlyPrevious]);
    assert.deepEqual(overlap.recommendationRanks, { latest: 1, week: 3 });
    assert.deepEqual(overlap.recommendationModes, ['latest', 'week']);
    assert.deepEqual(restoredSelection.get('citation-only').recommendationModes, ['month', 'year']);
    assert.deepEqual(restoredSelection.get('citation-only').recommendationRanks, { month: 4, year: 7 });
    assert.deepEqual([mixedPrevious, citationOnlyPrevious], previousForRestore);
    const staleMixedSelection = new Map();
    restorePreviousCitationPapers(staleMixedSelection, [mixedPrevious]);
    assert.deepEqual(staleMixedSelection.get('overlap').recommendationModes, ['week']);
    assert.deepEqual(staleMixedSelection.get('overlap').recommendationRanks, { week: 3 });
    assert.deepEqual(mixedPrevious, previousForRestore[0]);

    // Cached summaries use the same strict shape as fresh LLM responses.
    assert.equal(reusableSummary({ summaryKo: 7, detail: { problem: '문제', method: '방법', takeaway: '시사점' } }), null);
    assert.equal(reusableSummary({ summaryKo: '요약', detail: ['문제', '방법', '시사점'] }), null);
    assert.equal(reusableSummary({ summaryKo: '  ', detail: { problem: '문제', method: '방법', takeaway: '시사점' } }), null);
    assert.equal(reusableSummary({ summaryKo: '요약', detail: { problem: '문제', method: null, takeaway: '시사점' } }), null);
    assert.deepEqual(
      reusableSummary({ summaryKo: '  요약  ', detail: { problem: ' 문제 ', method: '방법', takeaway: '시사점', extra: '제외' }, tags: ['tag'] }),
      { tags: ['tag'], summaryKo: '요약', detail: { problem: '문제', method: '방법', takeaway: '시사점' } },
    );

    const summaryFixture = {
      summaryKo: '테스트 요약',
      detail: { problem: '테스트 문제', method: '테스트 방법', takeaway: '테스트 시사점' },
    };
    assert.deepEqual(
      await summarizeWithLLM({ title: 'Success test', authors: 'Test', categories: ['cs.CL'], abstract: 'Test abstract' }, {
        timeoutMs: 50,
        fetcher: async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(summaryFixture) } }] }),
        }),
      }),
      summaryFixture,
    );
    const fencedSummary = await summarizeWithLLM({ title: 'Fenced test', authors: 'Test', categories: ['cs.CL'], abstract: 'Test abstract' }, {
      timeoutMs: 50,
      fetcher: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ ...summaryFixture, extra: 'ignored', detail: { ...summaryFixture.detail, extra: 'ignored' } })}\n\`\`\`` } }] }),
      }),
    });
    assert.deepEqual(fencedSummary, summaryFixture);
    for (const invalidSummary of [
      { summaryKo: summaryFixture.summaryKo, detail: { problem: '문제' } },
      { summaryKo: summaryFixture.summaryKo, detail: null },
      { summaryKo: 7, detail: summaryFixture.detail },
      { summaryKo: summaryFixture.summaryKo, detail: { problem: '문제', method: null, takeaway: '시사점' } },
      { summaryKo: summaryFixture.summaryKo, detail: ['문제', '방법', '시사점'] },
      { summaryKo: '  ', detail: summaryFixture.detail },
      { summaryKo: summaryFixture.summaryKo, detail: { problem: '문제', method: '  ', takeaway: '시사점' } },
    ]) {
      await assert.rejects(
        summarizeWithLLM({ title: 'Invalid test', authors: 'Test', categories: ['cs.CL'], abstract: 'Test abstract' }, {
          timeoutMs: 50,
          fetcher: async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(invalidSummary) } }] }),
          }),
        }),
        /missing or invalid fields in LLM JSON/,
      );
    }
    const unavailableSummary = generateSummary('Video proposal', 'video abstract', ['cs.CV'], 'cv');
    assert.match(unavailableSummary.summaryKo, /원문과 초록/);
    assert.deepEqual(Object.keys(unavailableSummary.detail).sort(), ['method', 'problem', 'takeaway']);
    assert.ok(Object.values(unavailableSummary.detail).every(value => typeof value === 'string' && value.trim()));
    await assert.rejects(
      summarizeWithLLM({ title: 'Timeout test', authors: 'Test', categories: ['cs.CL'], abstract: 'Test abstract' }, {
        timeoutMs: 5,
        fetcher: async (_url, request) => ({
          ok: true,
          json: () => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        }),
      }),
      /LLM API timed out after 5ms/,
    );
    let clock = 0;
    const delays = [];
    const statuses = [429, 200, 200];
    const retryClient = createArxivClient({
      fetcher: async () => {
        const status = statuses.shift();
        return {
          ok: status === 200,
          status,
          headers: { get: name => name === 'retry-after' && status === 429 ? '7' : null },
        };
      },
      sleep: async ms => { delays.push(ms); clock += ms; },
      now: () => clock,
      requestTimeoutMs: 50,
      minIntervalMs: 3000,
      baseRetryMs: 5000,
      maxRetries: 2,
      logger: { warn() {} },
    });
    assert.equal((await retryClient.fetch('test:first')).status, 200);
    assert.equal((await retryClient.fetch('test:second')).status, 200);
    assert.deepEqual(delays, [7000, 3000]);

    // A response whose headers arrive before a stalled body is still bounded and retried.
    let bodyCalls = 0;
    let bodyAborted = false;
    const bodyClient = createArxivClient({
      fetcher: async (_url, request) => {
        bodyCalls += 1;
        if (bodyCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: () => new Promise((resolve, reject) => {
              request.signal.addEventListener('abort', () => {
                bodyAborted = true;
                reject(new Error('body aborted'));
              }, { once: true });
            }),
          };
        }
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<feed />' };
      },
      sleep: async () => {},
      minIntervalMs: 0,
      baseRetryMs: 0,
      requestTimeoutMs: 5,
      maxRetries: 1,
      logger: { warn() {} },
    });
    assert.equal(await bodyClient.fetchText('test:body'), '<feed />');
    assert.equal(bodyCalls, 2);
    assert.equal(bodyAborted, true);

    let badRequestCalls = 0;
    const noRetryClient = createArxivClient({
      fetcher: async () => { badRequestCalls += 1; return { ok: false, status: 400, headers: { get: () => null } }; },
      sleep: async () => {},
      minIntervalMs: 0,
      requestTimeoutMs: 50,
      maxRetries: 2,
      logger: { warn() {} },
    });
    await assert.rejects(noRetryClient.fetch('test:bad-request'), /arXiv API error 400/);
    assert.equal(badRequestCalls, 1);
    console.log('self-test passed');
    return;
  }

  const dryRun = process.argv.includes('--dry-run');
  const latestOnly = process.argv.includes('--latest-only');

  console.error(USE_LLM ? `Using LLM: ${OPENCODE_GO_MODEL} (timeout ${LLM_TIMEOUT_MS}ms)` : 'No API key found; using source-directed unavailable summaries');

  if (!OPENALEX_API_KEY && !latestOnly) console.error('No OPENALEX_API_KEY found; preserving cached citation recommendations');

  const result = await collectPapers({ latestOnly });
  const papers = result.papers;

  if (papers.length === 0) {
    console.error('Warning: no papers collected. Output will be empty.');
  }

  const output = serialize(papers, result.metadata);

  if (dryRun) {
    console.log(output);
  } else {
    writeFileSync(OUTPUT_PATH, output, 'utf-8');
    console.log(`Written ${papers.length} papers to ${OUTPUT_PATH}`);
  }
}

main().catch(err => {
  console.error('collect-papers.mjs failed:', err);
  process.exit(1);
});
