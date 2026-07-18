export const CITATION_MODES = Object.freeze({
  week: 7,
  month: 30,
  sixMonths: 180,
  year: 365,
});

export const CATEGORY_ORDER = Object.freeze(['cv', 'llm', 'multimodal']);

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export function citationWindow(days, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: dateOnly(start), to: dateOnly(end) };
}

function ageDays(published, now) {
  const publishedAt = Date.parse(`${published}T00:00:00Z`);
  if (!Number.isFinite(publishedAt)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor((now.getTime() - publishedAt) / 86400000) + 1);
}

export function compareCitationPapers(a, b, now = new Date()) {
  const citationDiff = (b.citationCount || 0) - (a.citationCount || 0);
  if (citationDiff) return citationDiff;

  const aVelocity = (a.citationCount || 0) / Math.max(ageDays(a.published, now), 7);
  const bVelocity = (b.citationCount || 0) / Math.max(ageDays(b.published, now), 7);
  if (bVelocity !== aVelocity) return bVelocity - aVelocity;

  if (a.published !== b.published) return a.published < b.published ? 1 : -1;
  return a.id.localeCompare(b.id);
}

function dedupeCandidates(candidates) {
  const seen = new Map();
  for (const paper of candidates) {
    const current = seen.get(paper.id);
    if (!current || (paper.citationCount || 0) > (current.citationCount || 0)) {
      seen.set(paper.id, paper);
    }
  }
  return [...seen.values()];
}

export function selectCitationPapers(candidates, options = {}) {
  const limit = options.limit || 6;
  const perCategory = options.perCategory || 2;
  const now = options.now || new Date();
  const sorted = dedupeCandidates(candidates).sort((a, b) => compareCitationPapers(a, b, now));
  const selected = [];
  const selectedIds = new Set();

  for (const category of CATEGORY_ORDER) {
    for (const paper of sorted.filter(item => item.category === category).slice(0, perCategory)) {
      if (!selectedIds.has(paper.id)) {
        selected.push(paper);
        selectedIds.add(paper.id);
      }
    }
  }

  for (const paper of sorted) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(paper.id)) {
      selected.push(paper);
      selectedIds.add(paper.id);
    }
  }

  return selected.sort((a, b) => compareCitationPapers(a, b, now)).slice(0, limit);
}

export function assignRecommendation(papers, mode) {
  return papers.map((paper, index) => ({
    ...paper,
    recommendationMode: mode,
    recommendationRank: index + 1,
  }));
}
