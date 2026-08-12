'use strict';

const assert = require('node:assert/strict');
const {
  createStore,
  STORAGE_KEY,
  LEGACY_KEY,
  MAX_ITEMS,
} = require('../favorites.js');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump(key) { return values.get(key); },
  };
}

function paper(id, title = `Paper ${id}`) {
  return {
    id,
    title,
    authors: 'Test Author',
    published: '2026-08-12',
    category: 'cv',
    categories: ['cs.CV'],
    tags: ['benchmark'],
    summaryKo: '테스트 요약',
    detail: { problem: '문제', method: '방법', takeaway: '시사점' },
    sourceUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}.pdf`,
  };
}

const times = [
  new Date('2026-08-12T00:00:00Z'),
  new Date('2026-08-12T00:01:00Z'),
  new Date('2026-08-12T00:02:00Z'),
];
let timeIndex = 0;
const now = () => times[Math.min(timeIndex++, times.length - 1)];

// Legacy IDs migrate in their original oldest-to-newest order; missing IDs survive.
const legacyStorage = memoryStorage({ [LEGACY_KEY]: JSON.stringify(['2608.00001', '2608.99999']) });
const migrated = createStore({ storage: legacyStorage, papers: [paper('2608.00001')], now });
assert.equal(migrated.size(), 2);
assert.deepEqual(migrated.list().map(item => item.id), ['2608.99999', '2608.00001']);
assert.equal(migrated.get('2608.99999').paper.unresolved, true);
assert.equal(JSON.parse(legacyStorage.dump(STORAGE_KEY)).schemaVersion, 1);

// Snapshots remain after the current feed no longer contains the paper.
const reloaded = createStore({ storage: legacyStorage, papers: [], now });
assert.equal(reloaded.get('2608.00001').paper.title, 'Paper 2608.00001');

// A current paper refreshes the snapshot but preserves the original savedAt.
const originalSavedAt = reloaded.get('2608.00001').savedAt;
const refreshed = createStore({ storage: legacyStorage, papers: [paper('2608.00001', 'Updated title')], now });
assert.equal(refreshed.get('2608.00001').paper.title, 'Updated title');
assert.equal(refreshed.get('2608.00001').savedAt, originalSavedAt);

// Failed storage writes leave in-memory and persisted libraries unchanged.
const failureBase = memoryStorage();
const failureStore = createStore({ storage: failureBase, papers: [paper('2608.00002')], now });
const beforeFailure = failureBase.dump(STORAGE_KEY);
const failingStorage = {
  getItem: failureBase.getItem,
  setItem() { throw new Error('quota'); },
};
const failingStore = createStore({ storage: failingStorage, papers: [paper('2608.00002')], now });
assert.throws(() => failingStore.add(paper('2608.00002')), /저장공간/);
assert.equal(failingStore.size(), 0);
assert.equal(failureBase.dump(STORAGE_KEY), beforeFailure);

// Import merges by ID, keeps the oldest savedAt, and prefers the current feed snapshot.
const importStorage = memoryStorage();
const importStore = createStore({ storage: importStorage, papers: [paper('2608.00003', 'Current title')], now });
importStore.add(paper('2608.00003', 'Initial title'));
const exported = importStore.exportData();
exported.items[0].paper.title = 'Imported stale title';
exported.items[0].savedAt = '2026-01-01T00:00:00.000Z';
exported.items.push({
  id: '2608.00004',
  savedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  paper: paper('2608.00004'),
});
const result = importStore.importData(exported);
assert.deepEqual(result, { added: 1, updated: 1, total: 2 });
assert.equal(importStore.get('2608.00003').paper.title, 'Current title');
assert.equal(importStore.get('2608.00003').savedAt, '2026-01-01T00:00:00.000Z');

// Invalid imports are atomic.
const beforeInvalid = JSON.stringify(importStore.list());
const invalid = importStore.exportData();
invalid.items[0].paper.detail = null;
assert.throws(() => importStore.importData(invalid), /상세 정보/);
assert.equal(JSON.stringify(importStore.list()), beforeInvalid);

const unsafe = importStore.exportData();
unsafe.items[0].paper.sourceUrl = 'javascript:alert(1)';
assert.throws(() => importStore.importData(unsafe), /원문 링크/);
assert.equal(JSON.stringify(importStore.list()), beforeInvalid);

// Item limit is enforced before mutation.
const oversized = { app: 'Study-ML', schemaVersion: 1, items: new Array(MAX_ITEMS + 1).fill(null) };
assert.throws(() => importStore.importData(oversized), /최대 1,000편/);
assert.equal(JSON.stringify(importStore.list()), beforeInvalid);

// Corrupt persisted data is never overwritten by a later mutation.
const corruptStorage = memoryStorage({ [STORAGE_KEY]: '{not-json' });
const corruptStore = createStore({ storage: corruptStorage, papers: [paper('2608.00005')], now });
assert.match(corruptStore.warning(), /덮어쓰지 않았습니다/);
assert.throws(() => corruptStore.add(paper('2608.00005')), /손상된 즐겨찾기 데이터/);
assert.equal(corruptStorage.dump(STORAGE_KEY), '{not-json');

// Changes from a tab running the legacy app are promoted into the snapshot library.
const compatibilityStorage = memoryStorage();
const compatibilityStore = createStore({ storage: compatibilityStorage, papers: [paper('2608.00006'), paper('2608.00007')], now });
compatibilityStore.add(paper('2608.00006'));
compatibilityStorage.setItem(LEGACY_KEY, JSON.stringify(['2608.00006', '2608.00007']));
compatibilityStore.syncLegacy();
assert.deepEqual(compatibilityStore.list().map(item => item.id), ['2608.00007', '2608.00006']);
assert.equal(compatibilityStore.get('2608.00007').paper.title, 'Paper 2608.00007');

// Rapid additions still sort newest first when the clock does not advance.
const fixedNow = () => new Date('2026-08-12T12:00:00.000Z');
const rapidStore = createStore({ storage: memoryStorage(), papers: [paper('2608.00008'), paper('2608.00009')], now: fixedNow });
rapidStore.add(paper('2608.00008'));
rapidStore.add(paper('2608.00009'));
assert.deepEqual(rapidStore.list().map(item => item.id), ['2608.00009', '2608.00008']);

// Old-style arXiv IDs preserve their slash in fallback links.
const oldIdStorage = memoryStorage({ [LEGACY_KEY]: JSON.stringify(['hep-th/0307015']) });
const oldIdStore = createStore({ storage: oldIdStorage, papers: [], now });
assert.equal(oldIdStore.get('hep-th/0307015').paper.sourceUrl, 'https://arxiv.org/abs/hep-th/0307015');

console.log('favorites self-test passed');
