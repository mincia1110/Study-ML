'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const library = require('../favorites.js');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Only the DOM operations needed to exercise startup and storage events.
// Actual card interactions and layout are checked in a browser.
function element() {
  const classes = new Set();
  return {
    textContent: '', innerHTML: '', dataset: {}, handlers: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : force;
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
    },
    setAttribute() {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild(node) { this.innerHTML += node.textContent; },
  };
}

function start({ blocked = false, values = new Map(), locks, id = '2609.90001' } = {}) {
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  };
  const paper = { ...library.fallbackPaper(id), title: 'Startup fixture',
    category: 'cv', unresolved: false, recommendationModes: ['latest'] };
  const context = {
    URL, URLSearchParams, Map, Date, console,
    PAPERS: [paper], PAPER_METADATA: { collectedAt: '2026-09-04T00:00:00Z' },
    FavoriteLibrary: library,
    navigator: { locks },
    location: { search: '', href: 'http://localhost/' },
    history: { replaceState() {} },
    setTimeout() { return 1; }, clearTimeout() {}, handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    document: {
      body: { dataset: { updated: '2026-09-04' } },
      getElementById: id => get('#' + id),
      querySelector: get, querySelectorAll: () => [],
      createElement: element, createTextNode: text => ({ textContent: text }),
    },
  };
  context.window = context;
  Object.defineProperty(context, 'localStorage', { get() {
    if (blocked) throw new Error('SecurityError');
    return storage;
  } });
  vm.runInNewContext(source, context, { filename: 'app.js' });
  const toggle = () => get('#paper-grid').handlers.click({ target: { closest: () => ({
    dataset: { id: paper.id }, classList: { contains: name => name === 'save-btn' },
  }) } });
  return { get, values, toggle, storageEvent: event => context.handlers.storage(event) };
}

const blocked = start({ blocked: true });
assert.equal(blocked.get('#paper-count').textContent, '1개 논문');
assert.match(blocked.get('#paper-grid').innerHTML, /Startup fixture/);
assert.equal(blocked.get('#updated').textContent, '2026-09-04');
blocked.toggle();
assert.equal(blocked.get('#favorite-count').textContent, '0');
assert.match(blocked.get('#toast-message').textContent, /저장공간/);
assert.equal(blocked.values.size, 0);

const normal = start();
normal.toggle();
assert.equal(normal.get('#favorite-count').textContent, '1');
const before = normal.values.get(library.STORAGE_KEY);
normal.values.set(library.LEGACY_KEY, '{bad');
assert.doesNotThrow(() => normal.storageEvent({ key: library.LEGACY_KEY }));
assert.equal(normal.get('#favorite-count').textContent, '1');
assert.equal(normal.values.get(library.STORAGE_KEY), before);
assert.match(normal.get('#library-status').textContent, /손상/);

// A successful modern reload clears the displayed error from legacy sync.
normal.storageEvent({ key: library.STORAGE_KEY });
assert.equal(normal.get('#library-status').textContent, '');
normal.values.clear();
normal.storageEvent({ key: null });
assert.equal(normal.get('#favorite-count').textContent, '0');
assert.equal(normal.values.size, 0);
normal.toggle();
assert.equal(normal.get('#favorite-count').textContent, '1');

async function testConcurrentTabs() {
  const values = new Map();
  let queue = Promise.resolve();
  const locks = {
    request(name, action) {
      assert.equal(name, 'study-ml-favorites');
      const request = queue.then(action);
      queue = request.catch(() => {});
      return request;
    },
  };
  const first = start({ values, locks, id: '2609.90001' });
  const second = start({ values, locks, id: '2609.90002' });
  await queue;

  // Both tabs still see the empty library when they queue their clicks.
  first.toggle();
  second.toggle();
  await queue;
  const stored = JSON.parse(values.get(library.STORAGE_KEY));
  assert.deepEqual(stored.items.map(item => item.id), ['2609.90001', '2609.90002']);
  await first.storageEvent({ key: library.LEGACY_KEY });
  assert.equal(first.get('#favorite-count').textContent, '2');
  assert.equal(second.get('#favorite-count').textContent, '2');
}

testConcurrentTabs().then(() => console.log('app self-test passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
