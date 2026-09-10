import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePreviousPapers } from './lib/paper-cache.mjs';

// Exercise the real CLI with isolated data and deterministic HTTP responses.
const root = mkdtempSync(join(tmpdir(), 'study-ml-summary-test-'));
const collector = fileURLToPath(new URL('./collect-papers.mjs', import.meta.url));
const unavailable = {
  summaryKo: '자동 한국어 요약을 생성하지 못했습니다. 논문 원문과 초록을 확인해 주세요.',
  detail: { problem: '자동 요약을 제공할 수 없습니다.', method: '자동 요약을 제공할 수 없습니다.', takeaway: '자동 요약을 제공할 수 없습니다.' },
};
const good = { summaryKo: '한국어 요약', detail: { problem: '연구 문제', method: '제안 방법', takeaway: '결과와 한계' } };
const previous = [
  { id: '2609.00001', ...unavailable, recommendationModes: ['latest'] },
  { id: '2501.00002', title: 'Cached paper', authors: 'Test', categories: ['cs.CL'], ...unavailable, recommendationModes: ['year'] },
  { id: '2501.00003', ...good, recommendationModes: ['year'] },
];
const baseline = `window.PAPERS = ${JSON.stringify(previous)};\nwindow.PAPER_METADATA = {};\n`;

function mockNetwork() {
  const sessions = new Set();
  globalThis.fetch = async (url, request) => {
    if (String(url).includes('arxiv.org')) {
      const id = new URL(url).searchParams.has('id_list') ? '2501.00002' : '2609.00001';
      return new Response(`<feed><entry><id>http://arxiv.org/abs/${id}v1</id><title>Language model research</title><published>2026-09-10T00:00:00Z</published><summary>Actual source abstract ${id}</summary><author><name>Test Author</name></author><category term="cs.CL" /></entry></feed>`);
    }
    const body = JSON.parse(request.body);
    if (!request.headers['x-opencode-session'] || sessions.has(request.headers['x-opencode-session'])) throw new Error('Missing or reused conversation session');
    sessions.add(request.headers['x-opencode-session']);
    if (request.headers['User-Agent'] !== 'Study-ML-paper-collector/1.0') throw new Error('Missing client identity');
    if (!body.messages[0].content.includes('Actual source abstract')) throw new Error('Missing actual source');
    if (process.env.TEST_SUMMARY_FAILURE === '1') return new Response('provider failure', { status: 400 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summaryKo: '재생성한 한국어 요약', detail: { problem: '연구 문제', method: '제안 방법', takeaway: '결과와 한계' } }) } }] });
  };
}

try {
  mkdirSync(join(root, 'data'));
  const preload = join(root, 'mock.mjs');
  writeFileSync(preload, `(${mockNetwork.toString()})();`);
  const dataPath = join(root, 'data/papers.js');
  function run(args, failure = false) {
    writeFileSync(dataPath, baseline);
    return spawnSync(process.execPath, ['--import', preload, collector, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, OPENCODE_GO_API_KEY: 'test-key', OPENALEX_API_KEY: '', TEST_SUMMARY_FAILURE: failure ? '1' : '0' },
    });
  }
  const dry = run(['--dry-run', '--require-summaries']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(dataPath, 'utf8'), baseline);
  const regenerated = parsePreviousPapers(dry.stdout);
  assert.equal(regenerated.length, 3);
  for (const id of ['2609.00001', '2501.00002']) assert.equal(regenerated.find(p => p.id === id).summaryKo, '재생성한 한국어 요약');
  assert.equal(regenerated.find(p => p.id === '2501.00003').summaryKo, good.summaryKo);
  assert.match(dry.stdout, /"status": "ok"/);

  const failed = run(['--require-summaries'], true);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /existing data was not overwritten/);
  assert.equal(readFileSync(dataPath, 'utf8'), baseline);

  const partial = run(['--dry-run'], true);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /"unavailable": 2/);
  assert.match(partial.stdout, /"status": "partial"/);
  assert.match(partial.stdout, /"summarizer": "mixed"/);

  const success = run(['--require-summaries']);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(parsePreviousPapers(readFileSync(dataPath, 'utf8')).filter(p => p.summaryKo === '재생성한 한국어 요약').length, 2);
  console.log('summary integration self-test passed (dry-run, cache repair, abstract recovery, strict failure, partial metadata, write)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
