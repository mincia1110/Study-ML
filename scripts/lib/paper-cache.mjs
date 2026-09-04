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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeSummary(value) {
  const detail = value?.detail;
  if (typeof value?.summaryKo !== 'string' || !value.summaryKo.trim() || !isPlainObject(detail)) return null;
  const fields = ['problem', 'method', 'takeaway'];
  if (fields.some(field => typeof detail[field] !== 'string' || !detail[field].trim())) return null;
  return {
    summaryKo: value.summaryKo.trim(),
    detail: Object.fromEntries(fields.map(field => [field, detail[field].trim()])),
  };
}

export function reusableSummary(paper) {
  const summary = normalizeSummary(paper);
  if (!summary) return null;
  return {
    tags: Array.isArray(paper.tags) ? paper.tags : [],
    ...summary,
  };
}
