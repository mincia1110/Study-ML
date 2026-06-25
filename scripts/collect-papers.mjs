#!/usr/bin/env node
'use strict';

import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * collect-papers.mjs — arXiv daily paper collector.
 *
 * SUMMARY GUIDELINES (see also docs/summary-guidelines.md):
 * - detail.problem, detail.method, detail.takeaway: 1-2 Korean sentences each.
 * - Concrete and cautious, no hype, mention limitations when evident.
 * - Uses opencode-go/deepseek-v4-flash when a key is available.
 * - Falls back to template-generated summaries when no key is available.
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
 *   # without a key, falls back to template summaries + ~/.opencodex/config.json
 */

const ARXIV_API = 'https://export.arxiv.org/api/query';
const CAT_QUERIES = [
  'cat:cs.CV AND (all:"large language model" OR all:"vision-language" OR all:multimodal OR all:video OR all:3d OR all:benchmark)',
  'cat:cs.CL AND (all:"large language model" OR all:reasoning OR all:agent OR all:retrieval OR all:RAG)',
];
const MAX_RESULTS = 50;
const MAX_PAPERS = 12;
const OUTPUT_PATH = 'data/papers.js';

const OPENCODE_GO_URL = process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1/chat/completions';
const OPENCODE_GO_MODEL = process.env.OPENCODE_GO_MODEL || 'deepseek-v4-flash';

// ponytail: read key from env first, fall back to opencodex config so local runs
// "just work" without manual export. CI sets OPENCODE_GO_API_KEY as a secret.
function resolveApiKey() {
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

/* ── template-based Korean summary generation ── */

function inferTopic(title, abstract, category) {
  const text = (title + ' ' + abstract).toLowerCase();
  if (hasTerm(text, 'video')) return 'video';
  if (hasTerm(text, '3d') || hasTerm(text, 'gaussian')) return '3d';
  if (hasTerm(text, 'medical') || hasTerm(text, 'cancer') || hasTerm(text, 'biomedical')) return 'medical';
  if (hasTerm(text, 'autonomous') || hasTerm(text, 'driving')) return 'driving';
  if (hasTerm(text, 'privacy')) return 'privacy';
  if (hasTerm(text, 'agent') || hasTerm(text, 'agents')) return 'agent';
  if (hasTerm(text, 'retrieval') || hasTerm(text, 'rag')) return 'retrieval';
  if (hasTerm(text, 'benchmark') || hasTerm(text, 'dataset') || hasTerm(text, 'evaluation')) return 'benchmark';
  if (category === 'cv') return 'vision';
  if (category === 'multimodal') return 'multimodal';
  return 'llm';
}

function generateSummary(title, abstract, categories, category) {
  const topic = inferTopic(title, abstract, category);
  const titleMain = title.replace(/:.*$/, '').trim();
  const categoryLabel = { cv: '컴퓨터 비전', llm: 'LLM', multimodal: '멀티모달' }[category] || 'ML';
  const templates = {
    video: ['비디오 이해 모델이 답만 맞히는 수준을 넘어, 시간적 근거와 장면 변화를 얼마나 안정적으로 잡는지 다룬다.', '논문은 비디오 입력에서 질문, 증거 구간, 설명 또는 압축 표현을 함께 다루는 평가·모델링 방식을 제안한다.', '긴 영상과 복잡한 사건 흐름을 다루는 모델의 신뢰성을 보려면 정답률뿐 아니라 근거 위치와 실패 사례를 함께 확인해야 한다.'],
    '3d': ['이미지나 텍스트에서 3D 장면을 만들 때 품질, 속도, 3D 일관성을 동시에 맞추기 어렵다는 문제를 다룬다.', '논문은 3D 표현과 생성 모델을 결합해 더 적은 자원으로 장면 구조와 외형을 보존하는 방법을 제안한다.', '3D 생성은 실제 제품화에서 렌더링 비용과 품질 편차가 크므로, 벤치마크와 예시 장면의 범위를 같이 확인해야 한다.'],
    medical: ['의료 영상 AI가 평균 성능은 높아 보여도 환자군, 촬영 장비, 프로토콜이 달라질 때 성능이 흔들리는 문제를 다룬다.', '논문은 데이터 하위집단이나 임상 조건을 나눠 모델을 평가하거나 적응시키는 방식을 제안한다.', '의료 AI는 작은 성능 향상보다 조건별 실패를 드러내는 평가가 중요하며, 실제 임상 적용 전 별도 검증이 필요하다.'],
    driving: ['자율주행 장면에서 위험 객체를 찾는 것뿐 아니라 왜 위험한지 설명하고 위치를 근거로 제시하는 문제를 다룬다.', '논문은 비전-언어 모델과 그라운딩 또는 시간 추론을 결합해 주행 장면의 위험을 해석 가능하게 만드는 방식을 제안한다.', '안전 관련 응용에서는 설명 가능성이 유용하지만, 실제 도로 일반화와 작은 객체 인식 실패를 별도로 봐야 한다.'],
    retrieval: ['LLM이 외부 지식을 쓸 때 검색 품질, 개인정보, 맥락 보존 사이의 균형을 맞추는 문제를 다룬다.', '논문은 검색 임베딩, RAG 전처리, 의미 재작성 등 검색 기반 워크플로를 개선하는 방식을 제안한다.', '검색 기반 시스템은 모델 자체보다 데이터 품질과 검색 실패가 결과를 좌우하므로, 도메인별 평가가 필요하다.'],
    agent: ['에이전트가 장기 기억, 환경 모델, 코드 수정 같은 다단계 작업을 안정적으로 수행하는 문제를 다룬다.', '논문은 에이전트의 메모리, 진단, 시뮬레이션 또는 계획 단계를 분리해 더 검증 가능한 구조로 만드는 방법을 제안한다.', '에이전트 연구는 데모보다 실패 복구와 비용이 중요하므로, 벤치마크 조건과 실제 작업 전이를 함께 봐야 한다.'],
    privacy: ['대규모 모델이나 RAG 시스템에서 학습 데이터와 민감 정보가 노출될 수 있는 문제를 다룬다.', '논문은 공격 분석, 의미 재작성, 감사 프레임워크 등으로 노출 위험을 측정하거나 줄이는 방법을 제안한다.', '프라이버시 보호는 정확도와 함께 운영 요구사항이므로, 공격 가정과 데이터 접근 권한을 확인해야 한다.'],
    benchmark: ['새 모델의 평균 점수만으로는 실제 강점과 약점을 판단하기 어렵다는 평가 문제를 다룬다.', '논문은 데이터셋, 벤치마크, 세부 지표를 만들어 모델 성능을 더 구체적인 조건에서 비교한다.', '벤치마크 논문은 점수보다 평가 설계가 중요하므로, 데이터 구성과 누락된 사용 사례를 함께 확인해야 한다.'],
    vision: ['컴퓨터 비전 모델이 이미지·장면·객체 관계를 더 안정적으로 이해하거나 생성하는 문제를 다룬다.', '논문은 표현 학습, 생성, 검출, 평가 방식 중 하나를 개선해 시각 정보 처리 성능을 높이려 한다.', 'CV 모델은 데이터 분포 변화에 민감하므로, 공개 벤치마크 성능과 실제 환경 성능을 구분해 봐야 한다.'],
    multimodal: ['텍스트, 이미지, 비디오 같은 여러 입력을 함께 다룰 때 추론과 근거 제시가 어려운 문제를 다룬다.', '논문은 비전-언어 모델이나 멀티모달 학습 구조를 이용해 장면 이해, 생성, 질의응답을 개선한다.', '멀티모달 모델은 그럴듯한 설명을 만들 수 있으므로, 정답뿐 아니라 시각적 근거와 오류 유형을 확인해야 한다.'],
    llm: ['LLM이 추론, 검색, 코드, 평가 같은 실제 작업에서 안정적으로 동작하도록 만드는 문제를 다룬다.', '논문은 모델 구조, 학습 목표, 평가 프로토콜 또는 에이전트 워크플로를 개선하는 방법을 제안한다.', 'LLM 논문은 벤치마크 성능이 실제 사용성을 모두 보장하지 않으므로, 비용과 실패 조건을 같이 봐야 한다.'],
  };
  const [problem, method, takeaway] = templates[topic];
  return {
    summaryKo: `${titleMain}: ${categoryLabel} 분야의 최근 연구로, ${problem.replace(/다룬다\.$/, '다룬 논문이다.')}`,
    detail: { problem, method, takeaway },
  };
}

/* ── LLM summary via opencode-go (deepseek-v4-flash) ── */

async function summarizeWithLLM(paper) {
  const prompt = `다음 arXiv 논문을 한국어로 요약해라. JSON만 반환해라. 과장하지 말고 초록에 없는 내용은 만들지 마라.

제목: ${paper.title}
저자: ${paper.authors}
분야: ${paper.categories.join(', ')}
초록: ${paper.abstract || paper.summaryKo}

형식:
{"summaryKo":"한 문장 요약","detail":{"problem":"1-2문장: 해결하려는 문제","method":"1-2문장: 제안하는 방법","takeaway":"1-2문장: 주요 결과와 한계"}}`;

  const res = await fetch(OPENCODE_GO_URL, {
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
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  // extract JSON object from response (may be wrapped in markdown fences)
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in LLM response');
  const parsed = JSON.parse(match[0]);
  if (!parsed.summaryKo || !parsed.detail?.problem) throw new Error('missing fields in LLM JSON');
  return { summaryKo: parsed.summaryKo, detail: parsed.detail };
}

/* ── arXiv feed fetch & parse ── */

async function fetchEntries(query) {
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${MAX_RESULTS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arXiv API error ${res.status} for query=${query}`);
  const xml = await res.text();
  return xml.split('<entry>').slice(1);
}

async function collectPapers() {
  const seen = new Map(); // id -> paper

  for (const catQ of CAT_QUERIES) {
    const entries = await fetchEntries(catQ);
    for (const raw of entries) {
      const id = extractArxivId(raw);
      if (!id || seen.has(id)) continue;

      const title = extractTag(raw, 'title').replace(/\s+/g, ' ');
      const published = extractTag(raw, 'published').substring(0, 10);
      const abstract = extractTag(raw, 'summary').replace(/\s+/g, ' ');
      const categories = extractCategories(raw);
      const authors = extractAuthors(raw);

      if (!title) continue;

      const score = computeScore(title, abstract, categories);
      const category = inferCategory(categories, title, abstract);

      // Keep abstract for LLM use; strip later before output
      seen.set(id, {
        id,
        title,
        authors,
        published,
        category,
        categories,
        abstract,
        tags: [],
        summaryKo: '',
        detail: {},
        sourceUrl: `https://arxiv.org/abs/${id}v1`,
        pdfUrl: `https://arxiv.org/pdf/${id}v1.pdf`,
        _score: score,
      });
    }
  }

  // Sort first, then summarize only the top N
  const sorted = [...seen.values()]
    .sort((a, b) => (b._score - a._score) || (b.published > a.published ? 1 : -1))
    .slice(0, MAX_PAPERS);

  // Generate tags (keyword-based) for each
  for (const p of sorted) {
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

  // Summarize: LLM if key present, template fallback otherwise
  for (const p of sorted) {
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

  return sorted;
}

/* ── output ── */

function serialize(papers) {
  const json = JSON.stringify(papers, null, 2);
  const metadata = JSON.stringify({
    collectedAt: new Date().toISOString(),
    source: 'arXiv',
    note: 'Auto-collected by scripts/collect-papers.mjs. Summaries use LLM when OPENCODE_GO_API_KEY is available, otherwise template fallback. See docs/summary-guidelines.md.',
    summarizer: USE_LLM ? `${OPENCODE_GO_MODEL} via opencode-go` : 'template',
  }, null, 2);
  return `// data/papers.js — Auto-generated by scripts/collect-papers.mjs\n// Run \`node scripts/collect-papers.mjs\` to regenerate.\n/* eslint-disable */\nwindow.PAPERS = ${json};\n\nwindow.PAPER_METADATA = ${metadata};\n`;
}

/* ── main ── */

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.error(USE_LLM ? `Using LLM: ${OPENCODE_GO_MODEL}` : 'No API key found; using template summaries');

  const papers = await collectPapers();

  if (papers.length === 0) {
    console.error('Warning: no papers collected. Output will be empty.');
  }

  const output = serialize(papers);

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
