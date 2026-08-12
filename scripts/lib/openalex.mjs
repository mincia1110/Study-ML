import { CITATION_MODES, citationWindow, selectCitationPapers, assignRecommendation } from './recommend.mjs';

const OPENALEX_API = 'https://api.openalex.org/works';
const ARXIV_SOURCE_ID = 'S4306400194';
const RESULTS_PER_QUERY = 30;

const CATEGORY_SEARCHES = Object.freeze({
  cv: '("computer vision" OR "image generation" OR "object detection" OR segmentation OR "3d vision")',
  llm: '("large language model" OR LLM OR "language model" OR RAG OR "AI agent")',
  multimodal: '(multimodal OR "vision language" OR "image text" OR "video language")',
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}) {
  const attempts = options.attempts || 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`OpenAlex API ${response.status}: ${await response.text().catch(() => '')}`);
      }
      if (attempt === attempts - 1) throw new Error(`OpenAlex API ${response.status} after ${attempts} attempts`);
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await wait(2 ** attempt * 1000);
  }
  throw new Error('OpenAlex request failed');
}

export function extractArxivIdFromWork(work) {
  for (const location of work.locations || []) {
    for (const value of [location.landing_page_url, location.pdf_url]) {
      const match = String(value || '').match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i);
      if (match) return match[1];
    }
  }
  return null;
}

function normalizeWork(work, category) {
  const id = extractArxivIdFromWork(work);
  if (!id || work.is_retracted) return null;
  return {
    id,
    title: work.display_name || '',
    published: work.publication_date || '',
    category,
    citationCount: Number(work.cited_by_count) || 0,
    openAlexId: String(work.id || '').replace('https://openalex.org/', ''),
  };
}

export function buildOpenAlexUrl({ apiKey, category, from, to }) {
  const params = new URLSearchParams({
    api_key: apiKey,
    search: CATEGORY_SEARCHES[category],
    filter: `locations.source.id:${ARXIV_SOURCE_ID},from_publication_date:${from},to_publication_date:${to},is_retracted:false`,
    sort: 'cited_by_count:desc,publication_date:desc',
    per_page: String(RESULTS_PER_QUERY),
    select: 'id,display_name,publication_date,cited_by_count,is_retracted,locations',
  });
  return `${OPENALEX_API}?${params}`;
}

export async function collectCitationRecommendations(apiKey, options = {}) {
  if (!apiKey) return { byMode: {}, windows: {}, queryCount: 0 };
  const now = options.now || new Date();
  const fetcher = options.fetcher || fetchJsonWithRetry;
  const byMode = {};
  const windows = {};
  let queryCount = 0;

  for (const [mode, days] of Object.entries(CITATION_MODES)) {
    const window = citationWindow(days, now);
    windows[mode] = window;
    const candidates = [];
    for (const category of Object.keys(CATEGORY_SEARCHES)) {
      const url = buildOpenAlexUrl({ apiKey, category, ...window });
      const data = await fetcher(url);
      queryCount += 1;
      for (const work of data.results || []) {
        const normalized = normalizeWork(work, category);
        if (normalized) candidates.push(normalized);
      }
    }
    byMode[mode] = assignRecommendation(selectCitationPapers(candidates, { now }), mode);
  }

  return { byMode, windows, queryCount };
}
