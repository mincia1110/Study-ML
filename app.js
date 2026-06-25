(function() {
  'use strict';

  var papers = window.PAPERS || [];

  var saved;
  try {
    saved = new Set(JSON.parse(localStorage.getItem('savedPaperIds') || '[]'));
  } catch (_) {
    saved = new Set();
  }

  function saveState() {
    try { localStorage.setItem('savedPaperIds', JSON.stringify([...saved])); } catch (_) {}
  }

  var catLabel = { cv: 'CV', llm: 'LLM', multimodal: 'Multimodal' };

  function esc(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function cardHTML(p) {
    var savedCls = saved.has(p.id) ? ' saved' : '';
    var star = saved.has(p.id) ? '\u2605' : '\u2606';
    var label = saved.has(p.id) ? '\uC800\uC7A5 \uCDE8\uC18C' : '\uC800\uC7A5';
    var tags = p.tags.map(function(t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
    var categories = p.categories.map(function(c) { return '<span class="tag category-tag">' + esc(c) + '</span>'; }).join('');
    return '<article class="paper-card ' + p.category + '" data-paper-id="' + p.id + '" data-category="' + p.category + '">' +
      '<div class="card-header">' +
        '<span class="card-category">' + catLabel[p.category] + '</span>' +
        '<span class="paper-id">' + p.id + '</span>' +
        '<button class="save-btn' + savedCls + '" type="button" data-id="' + p.id + '" aria-label="' + label + '">' + star + '</button>' +
      '</div>' +
      '<h3 class="paper-title">' + esc(p.title) + '</h3>' +
      '<p class="paper-authors">' + esc(p.published) + ' · ' + esc(p.authors) + '</p>' +
      '<div class="paper-tags">' + categories + tags + '</div>' +
      '<p class="paper-summary">' + esc(p.summaryKo) + '</p>' +
      '<div class="paper-actions">' +
        '<a href="' + p.sourceUrl + '" target="_blank" rel="noreferrer">arXiv</a>' +
        '<a href="' + p.pdfUrl + '" target="_blank" rel="noreferrer">PDF</a>' +
        '<button class="details-toggle" type="button" aria-expanded="false">\uC790\uC138\uD788 \u25B8</button>' +
      '</div>' +
      '<div class="paper-details hidden">' +
        '<dl>' +
          '<dt>\uBB38\uC81C</dt><dd>' + esc(p.detail.problem) + '</dd>' +
          '<dt>\uBC29\uBC95</dt><dd>' + esc(p.detail.method) + '</dd>' +
          '<dt>\uC2DC\uC0AC\uC810</dt><dd>' + esc(p.detail.takeaway) + '</dd>' +
        '</dl>' +
      '</div>' +
    '</article>';
  }

  function render() {
    document.getElementById('paper-grid').innerHTML = papers.map(cardHTML).join('');
  }

  var currentFilter = 'all';
  var searchQuery = '';

  function updateCount() {
    var visible = document.querySelectorAll('.paper-card:not(.hidden)').length;
    document.getElementById('paper-count').textContent = visible + '\uAC1C \uB17C\uBB38';
  }

  function applyFilters() {
    var cards = document.querySelectorAll('.paper-card');
    var q = searchQuery.toLowerCase().trim();
    cards.forEach(function(card) {
      var cat = card.dataset.category;
      var id = card.dataset.paperId;
      var showByFilter = currentFilter === 'all' || currentFilter === cat || (currentFilter === 'saved' && saved.has(id));
      var showBySearch = true;
      if (q) {
        var p = papers.find(function(x) { return x.id === id; });
        showBySearch = p && (
          p.title.toLowerCase().indexOf(q) !== -1 ||
          p.authors.toLowerCase().indexOf(q) !== -1 ||
          p.summaryKo.indexOf(q) !== -1 ||
          p.categories.some(function(c) { return c.toLowerCase().indexOf(q) !== -1; }) ||
          p.tags.some(function(t) { return t.toLowerCase().indexOf(q) !== -1; }) ||
          p.id.indexOf(q) !== -1 ||
          p.detail.problem.toLowerCase().indexOf(q) !== -1 ||
          p.detail.method.toLowerCase().indexOf(q) !== -1 ||
          p.detail.takeaway.toLowerCase().indexOf(q) !== -1
        );
      }
      card.classList.toggle('hidden', !(showByFilter && showBySearch));
    });
    updateCount();
  }

  function dateOnly(iso) {
    return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  document.querySelectorAll('.chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      applyFilters();
    });
  });

  document.getElementById('paper-search').addEventListener('input', function(e) {
    searchQuery = e.target.value;
    applyFilters();
  });

  document.getElementById('paper-grid').addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('save-btn')) {
      var id = btn.dataset.id;
      if (saved.has(id)) {
        saved.delete(id);
        btn.textContent = '\u2606';
        btn.classList.remove('saved');
        btn.setAttribute('aria-label', '\uC800\uC7A5');
      } else {
        saved.add(id);
        btn.textContent = '\u2605';
        btn.classList.add('saved');
        btn.setAttribute('aria-label', '\uC800\uC7A5 \uCDE8\uC18C');
      }
      saveState();
      if (currentFilter === 'saved') applyFilters();
      return;
    }
    if (btn.classList.contains('details-toggle')) {
      var details = btn.closest('.paper-card').querySelector('.paper-details');
      var hidden = details.classList.toggle('hidden');
      btn.textContent = hidden ? '\uC790\uC138\uD788 \u25B8' : '\uC811\uAE30 \u25B2';
      btn.setAttribute('aria-expanded', String(!hidden));
    }
  });

  // Update metadata from PAPER_METADATA
  if (window.PAPER_METADATA) {
    var dataEl = document.getElementById('updated-data');
    if (dataEl && window.PAPER_METADATA.collectedAt) {
      dataEl.textContent = dateOnly(window.PAPER_METADATA.collectedAt);
    }
  }
  document.querySelector('#updated').textContent = window.PAPER_METADATA && window.PAPER_METADATA.collectedAt
    ? dateOnly(window.PAPER_METADATA.collectedAt)
    : document.body.dataset.updated;

  var nav = document.querySelector('#site-nav');
  var navToggle = document.querySelector('.nav-toggle');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function() {
      var open = nav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function() {
      nav.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  }

  render();
  applyFilters();
})();
