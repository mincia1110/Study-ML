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

function start({ blocked = false } = {}) {
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const values = new Map();
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  };
  const paper = { ...library.fallbackPaper('2609.90001'), title: 'Startup fixture',
    category: 'cv', unresolved: false, recommendationModes: ['latest'] };
  const context = {
    URL, URLSearchParams, Map, Date, console,
    PAPERS: [paper], PAPER_METADATA: { collectedAt: '2026-09-04T00:00:00Z' },
    FavoriteLibrary: library,
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

console.log('app self-test passed');
