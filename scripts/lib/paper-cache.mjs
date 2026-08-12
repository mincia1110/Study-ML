import { readFileSync } from 'node:fs';

export function parsePreviousPapers(source) {
  const match = source.match(/window\.PAPERS\s*=\s*(\[[\s\S]*?\]);\s*window\.PAPER_METADATA/);
  if (!match) return [];
  try {
    const papers = JSON.parse(match[1]);
    return Array.isArray(papers) ? papers : [];
  } catch (_) {
    return [];
  }
}

export function readPreviousPapers(path) {
  try {
    return parsePreviousPapers(readFileSync(path, 'utf-8'));
  } catch (_) {
    return [];
  }
}

export function reusableSummary(paper) {
  if (!paper?.summaryKo || !paper?.detail?.problem || !paper?.detail?.method || !paper?.detail?.takeaway) return null;
  return {
    tags: Array.isArray(paper.tags) ? paper.tags : [],
    summaryKo: paper.summaryKo,
    detail: paper.detail,
  };
}
