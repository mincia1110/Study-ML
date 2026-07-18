(function() {
  'use strict';

  var papers = window.PAPERS || [];
  papers.forEach(function(p) {
    if (!Array.isArray(p.recommendationModes)) p.recommendationModes = ['latest'];
    if (!p.recommendationRanks) p.recommendationRanks = {};
  });

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
    var citation = p.metrics && Number(p.metrics.citationCount) > 0
      ? '<span class="citation-badge">인용 ' + Number(p.metrics.citationCount).toLocaleString('ko-KR') + '회</span>'
      : '';
    return '<article class="paper-card ' + p.category + '" data-paper-id="' + p.id + '" data-category="' + p.category + '">' +
      '<div class="card-header">' +
        '<div class="card-labels"><span class="card-category">' + catLabel[p.category] + '</span>' + citation + '</div>' +
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
    var selected = papers.filter(function(p) { return p.recommendationModes.indexOf(currentPeriod) !== -1; });
    selected.sort(function(a, b) {
      var aRank = a.recommendationRanks[currentPeriod] || 999;
      var bRank = b.recommendationRanks[currentPeriod] || 999;
      return aRank - bRank || (a.published < b.published ? 1 : -1);
    });
    document.getElementById('paper-grid').innerHTML = selected.length
      ? selected.map(cardHTML).join('')
      : '<p class="empty-state">이 기간에 표시할 추천 논문이 없습니다.</p>';
  }

  var currentFilter = 'all';
  var searchQuery = '';
  var validPeriods = ['latest', 'week', 'month', 'sixMonths', 'year'];
  var queryPeriod = new URLSearchParams(window.location.search).get('period');
  var currentPeriod = validPeriods.indexOf(queryPeriod) !== -1 ? queryPeriod : 'latest';

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

  function updateRecommendationNote() {
    var note = document.getElementById('recommendation-note');
    if (!note) return;
    if (currentPeriod === 'latest') {
      note.textContent = 'arXiv 최신 후보에서 키워드 관련도와 신규 여부로 추천합니다.';
      return;
    }
    var citation = window.PAPER_METADATA && window.PAPER_METADATA.citation;
    if (!citation || citation.status === 'missing-key') {
      note.textContent = 'OpenAlex API key가 없어 citation 추천을 갱신하지 못했습니다.';
    } else if (citation.status === 'disabled') {
      note.textContent = '이번 데이터 갱신에서는 citation 추천을 수집하지 않았습니다.';
    } else if (citation.status === 'stale-cache') {
      note.textContent = 'OpenAlex 응답 오류로 이전 citation 추천을 표시합니다.';
    } else if ((citation.fallbackModes || []).indexOf(currentPeriod) !== -1) {
      note.textContent = '아직 인용 집계가 충분하지 않아 최신 키워드 추천으로 보완했습니다.';
    } else {
      note.textContent = '해당 기간에 공개된 논문을 누적 인용 수 순으로 추천합니다.';
    }
  }

  document.querySelectorAll('.period-chip').forEach(function(chip) {
    chip.classList.toggle('active', chip.dataset.period === currentPeriod);
    chip.addEventListener('click', function() {
      currentPeriod = chip.dataset.period;
      document.querySelectorAll('.period-chip').forEach(function(c) { c.classList.toggle('active', c === chip); });
      var url = new URL(window.location.href);
      if (currentPeriod === 'latest') url.searchParams.delete('period');
      else url.searchParams.set('period', currentPeriod);
      window.history.replaceState({}, '', url);
      render();
      applyFilters();
      updateRecommendationNote();
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

  updateRecommendationNote();
  render();
  applyFilters();
})();
