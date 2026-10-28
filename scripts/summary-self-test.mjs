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
const healthyPrevious = previous.map(paper => ({ ...paper, ...good }));
const healthyBaseline = `window.PAPERS = ${JSON.stringify(healthyPrevious)};\nwindow.PAPER_METADATA = {};\n`;

function mockNetwork() {
  const sessions = new Set();
  let queryCount = 0;
  globalThis.fetch = async (url, request) => {
    const scenario = process.env.TEST_ARXIV_SCENARIO;
    appendFileSync(process.env.TEST_REQUEST_LOG, `${new URL(url).hostname}\n`);
    if (String(url).includes('rss.arxiv.org')) {
      if (scenario === 'feed-failure') return new Response('unavailable', { status: 503 });
      if (scenario === 'feed-html') return new Response('<html>maintenance</html>');
      const published = scenario === 'feed-stale' ? '2020-01-01' : new Date().toISOString().slice(0, 10);
      return new Response(`<feed>
        <entry><id>oai:arXiv.org:2610.39999v1</id><title>Video benchmark &amp; evaluation</title>
        <published>${published}T00:00:00Z</published><arxiv:announce_type>new</arxiv:announce_type>
        <summary>arXiv:2610.39999v1 Announce Type: new\nAbstract: Actual source abstract for video research</summary>
        <dc:creator>First Author, Second Author</dc:creator><category term="cs.CV"/></entry>
        <entry><id>oai:arXiv.org:2610.39998v2</id><title>Video replacement</title>
        <published>${published}T00:00:00Z</published><arxiv:announce_type>replace</arxiv:announce_type>
        <summary>Actual source abstract</summary><category term="cs.CV"/></entry>
      </feed>`);
    }
    if (String(url).includes('arxiv.org')) {
      queryCount += 1;
      if (scenario && (scenario !== 'api-partial' || queryCount > 1)) {
        if (scenario === 'network') throw new TypeError('fetch failed');
        return new Response('API unavailable', { status: scenario === '429' ? 429 : (scenario === 'api-partial' ? 503 : (scenario === '400' ? 400 : 406)) });
      }
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
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';\n(${mockNetwork.toString()})();`);
  const dataPath = join(root, 'data/papers.js');
  const requestLog = join(root, 'requests.log');
  function run(args, failure = false, scenario = '') {
    writeFileSync(dataPath, scenario ? healthyBaseline : baseline);
    writeFileSync(requestLog, '');
    const result = spawnSync(process.execPath, ['--import', preload, collector, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env, OPENCODE_GO_API_KEY: 'test-key', OPENALEX_API_KEY: scenario ? 'test-key' : '',
        OPENCODE_GO_BASE_URL: 'https://opencode.ai/zen/go/v1/chat/completions',
        TEST_SUMMARY_FAILURE: failure ? '1' : '0', TEST_ARXIV_SCENARIO: scenario, TEST_REQUEST_LOG: requestLog,
        ARXIV_MAX_RETRIES: '0', ARXIV_RATE_LIMIT_RETRY_MS: '1',
      },
    });
    result.requests = readFileSync(requestLog, 'utf8').trim().split('\n');
    return result;
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

  for (const scenario of ['406', '429', 'network', 'api-partial']) {
    const fallback = run(['--dry-run', '--require-summaries'], false, scenario);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(readFileSync(dataPath, 'utf8'), healthyBaseline);
    const papers = parsePreviousPapers(fallback.stdout);
    const latest = papers.filter(paper => paper.recommendationModes.includes('latest'));
    assert.equal(latest.length, 1);
    assert.equal(latest[0].id, '2610.39999');
    assert.equal(latest[0].title, 'Video benchmark & evaluation');
    assert.equal(latest[0].authors, 'First Author, Second Author');
    assert.equal(latest[0].summaryKo, '재생성한 한국어 요약');
    assert.equal(latest[0].sourceUrl, 'https://arxiv.org/abs/2610.39999v1');
    assert.equal(latest[0].pdfUrl, 'https://arxiv.org/pdf/2610.39999v1.pdf');
    for (const cached of healthyPrevious.filter(paper => paper.recommendationModes.includes('year'))) {
      assert.equal(papers.find(paper => paper.id === cached.id).summaryKo, cached.summaryKo);
    }
    assert.match(fallback.stdout, /"source": "arxiv-atom"/);
    assert.match(fallback.stdout, /"status": "fallback"/);
    assert.match(fallback.stdout, /"dateBasis": "announced"/);
    assert.match(fallback.stdout, /"status": "stale-cache"/);
    assert.deepEqual(fallback.requests, [
      ...Array(scenario === 'api-partial' ? 2 : 1).fill('export.arxiv.org'),
      'rss.arxiv.org', 'opencode.ai',
    ]);
  }

  const failedFallbackSummary = run(['--require-summaries'], true, '406');
  assert.equal(failedFallbackSummary.status, 1, failedFallbackSummary.stderr);
  assert.match(failedFallbackSummary.stderr, /Required Korean summaries are incomplete/);
  assert.equal(readFileSync(dataPath, 'utf8'), healthyBaseline);

  for (const scenario of ['feed-failure', 'feed-html', 'feed-stale', '400']) {
    const failed = run(['--require-summaries'], false, scenario);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(readFileSync(dataPath, 'utf8'), healthyBaseline);
    assert.match(failed.stderr, scenario === '400' ? /arXiv API error 400/ : /existing data was not overwritten/);
    assert.deepEqual(failed.requests, scenario === '400' ? ['export.arxiv.org'] : ['export.arxiv.org', 'rss.arxiv.org']);
  }
  console.log('summary integration self-test passed (dry-run, cache repair, abstract recovery, strict failure, partial metadata, write, API 406/429 fallback, partial API discard, stale/invalid feeds, citation preservation)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
