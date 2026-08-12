(function() {
  'use strict';

  var papers = window.PAPERS || [];
  papers.forEach(function(paper) {
    if (!Array.isArray(paper.recommendationModes)) paper.recommendationModes = ['latest'];
    if (!paper.recommendationRanks) paper.recommendationRanks = {};
  });

  var paperById = new Map(papers.map(function(paper) { return [paper.id, paper]; }));
  var favorites = window.FavoriteLibrary.createStore({ storage: localStorage, papers: papers });
  var catLabel = { cv: 'CV', llm: 'LLM', multimodal: 'Multimodal', unknown: 'arXiv' };
  var currentView = 'recommendations';
  var currentCategory = 'all';
  var searchQuery = '';
  var validPeriods = ['latest', 'week', 'month', 'sixMonths', 'year'];
  var queryPeriod = new URLSearchParams(window.location.search).get('period');
  var currentPeriod = validPeriods.indexOf(queryPeriod) !== -1 ? queryPeriod : 'latest';
  var undoTimer = null;
  var undoItem = null;

  function esc(value) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value == null ? '' : value)));
    return div.innerHTML;
  }

  function titleHTML(title) {
    return esc(title).replace(/\$\^\{([^{}$]+)\}\$|\$\^([^$\s]+)\$/g, function(_, braced, plain) {
      return '<sup>' + (braced || plain) + '</sup>';
    });
  }

  function searchableText(paper) {
    var detail = paper.detail || {};
    return [paper.id, paper.title, paper.authors, paper.summaryKo, detail.problem, detail.method, detail.takeaway]
      .concat(paper.categories || [], paper.tags || [])
      .join(' ')
      .toLowerCase();
  }

  function cardHTML(paper, favoriteItem) {
    var isFavorite = favorites.has(paper.id);
    var favoriteClass = isFavorite ? ' saved' : '';
    var star = isFavorite ? '\u2605' : '\u2606';
    var label = isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가';
    var tags = (paper.tags || []).map(function(tag) { return '<span class="tag">' + esc(tag) + '</span>'; }).join('');
    var categories = (paper.categories || []).map(function(category) { return '<span class="tag category-tag">' + esc(category) + '</span>'; }).join('');
    var citation = paper.metrics && Number(paper.metrics.citationCount) > 0
      ? '<span class="citation-badge">인용 ' + Number(paper.metrics.citationCount).toLocaleString('ko-KR') + '회</span>'
      : '';
    var unresolved = Boolean(paper.unresolved);
    var savedDate = favoriteItem ? '<span class="favorite-date">즐겨찾기 ' + esc(dateOnly(favoriteItem.savedAt)) + '</span>' : '';
    var published = paper.published ? esc(paper.published) + ' · ' : '';
    var actions = '<a href="' + esc(paper.sourceUrl) + '" target="_blank" rel="noreferrer">arXiv</a>';
    var details = '';
    if (!unresolved) {
      actions += '<a href="' + esc(paper.pdfUrl) + '" target="_blank" rel="noreferrer">PDF</a>' +
        '<button class="details-toggle" type="button" aria-expanded="false">자세히 ▸</button>';
      details = '<div class="paper-details hidden"><dl>' +
        '<dt>문제</dt><dd>' + esc(paper.detail.problem) + '</dd>' +
        '<dt>방법</dt><dd>' + esc(paper.detail.method) + '</dd>' +
        '<dt>시사점</dt><dd>' + esc(paper.detail.takeaway) + '</dd>' +
        '</dl></div>';
    }
    return '<article class="paper-card ' + esc(paper.category) + (unresolved ? ' unresolved' : '') + '" data-paper-id="' + esc(paper.id) + '" data-category="' + esc(paper.category) + '">' +
      '<div class="card-header">' +
        '<div class="card-labels"><span class="card-category">' + esc(catLabel[paper.category] || 'arXiv') + '</span>' + citation + '</div>' +
        '<span class="paper-id">' + esc(paper.id) + '</span>' +
        '<button class="save-btn' + favoriteClass + '" type="button" data-id="' + esc(paper.id) + '" aria-label="' + label + '" title="' + label + '">' + star + '</button>' +
      '</div>' +
      '<h3 class="paper-title">' + titleHTML(paper.title) + '</h3>' +
      '<p class="paper-authors">' + published + esc(paper.authors) + '</p>' +
      '<div class="paper-tags">' + categories + tags + '</div>' +
      '<p class="paper-summary">' + esc(paper.summaryKo) + '</p>' +
      savedDate +
      '<div class="paper-actions">' + actions + '</div>' +
      details +
    '</article>';
  }

  function recommendationPapers() {
    return papers.filter(function(paper) {
      return paper.recommendationModes.indexOf(currentPeriod) !== -1;
    }).sort(function(a, b) {
      var aRank = a.recommendationRanks[currentPeriod] || 999;
      var bRank = b.recommendationRanks[currentPeriod] || 999;
      return aRank - bRank || (a.published < b.published ? 1 : -1);
    }).map(function(paper) { return { paper: paper, item: null }; });
  }

  function favoritePapers() {
    return favorites.list().map(function(item) {
      return { paper: item.paper, item: item };
    });
  }

  function filteredEntries() {
    var query = searchQuery.toLowerCase().trim();
    var entries = currentView === 'favorites' ? favoritePapers() : recommendationPapers();
    return entries.filter(function(entry) {
      var categoryMatches = currentCategory === 'all' || entry.paper.category === currentCategory;
      var searchMatches = !query || searchableText(entry.paper).indexOf(query) !== -1;
      return categoryMatches && searchMatches;
    });
  }

  function emptyStateHTML() {
    if (currentView === 'favorites') {
      if (favorites.size() === 0) {
        return '<div class="empty-state favorite-empty"><strong>아직 즐겨찾기가 없습니다.</strong><span>논문 카드의 ☆를 눌러 추가하거나 JSON 백업을 가져오세요.</span><span>브라우저나 사이트 데이터를 삭제하면 사라질 수 있으므로 중요한 목록은 내보내기로 백업하세요.</span></div>';
      }
      return '<div class="empty-state"><strong>조건에 맞는 즐겨찾기가 없습니다.</strong><span>검색어나 분야 필터를 바꿔 보세요.</span></div>';
    }
    return '<p class="empty-state">이 조건에 표시할 추천 논문이 없습니다.</p>';
  }

  function render() {
    var entries = filteredEntries();
    document.getElementById('paper-grid').innerHTML = entries.length
      ? entries.map(function(entry) { return cardHTML(entry.paper, entry.item); }).join('')
      : emptyStateHTML();
    document.getElementById('paper-count').textContent = entries.length + '개 논문';
    document.getElementById('favorite-count').textContent = String(favorites.size());
    updateFavoriteTools();
  }

  function setStatus(message, kind) {
    var status = document.getElementById('library-status');
    status.textContent = message;
    status.className = 'library-status' + (kind ? ' ' + kind : '');
  }

  function showToast(message, options) {
    options = options || {};
    var toast = document.getElementById('toast');
    var text = document.getElementById('toast-message');
    var undo = document.getElementById('toast-undo');
    text.textContent = message;
    undo.hidden = !options.undo;
    toast.hidden = false;
    toast.classList.add('visible');
    toast.setAttribute('aria-hidden', 'false');
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(hideToast, options.duration || 6000);
  }

  function hideToast() {
    var toast = document.getElementById('toast');
    toast.classList.remove('visible');
    toast.setAttribute('aria-hidden', 'true');
    toast.hidden = true;
    document.getElementById('toast-undo').hidden = true;
    undoItem = null;
  }

  function updateFavoriteTools() {
    var favoriteMode = currentView === 'favorites';
    document.getElementById('favorite-tools').hidden = !favoriteMode;
    document.querySelector('.recommendation-controls').classList.toggle('disabled', favoriteMode);
    document.querySelectorAll('.period-chip').forEach(function(chip) {
      chip.disabled = favoriteMode;
    });
    updateRecommendationNote();
  }

  function setView(view) {
    currentView = view;
    document.querySelectorAll('.view-chip').forEach(function(chip) {
      var active = chip.dataset.view === view;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function setCategory(category) {
    currentCategory = category;
    document.querySelectorAll('.category-chip').forEach(function(chip) {
      var active = chip.dataset.category === category;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function toggleFavorite(id) {
    var paper = paperById.get(id) || (favorites.get(id) || {}).paper;
    try {
      if (favorites.has(id)) {
        undoItem = favorites.remove(id);
        showToast('즐겨찾기에서 제거했습니다.', { undo: true, duration: 6000 });
      } else {
        favorites.add(paper);
        undoItem = null;
        showToast('즐겨찾기에 추가했습니다.');
      }
      setStatus('');
      render();
    } catch (error) {
      setStatus(error.message, 'error');
      showToast(error.message, { duration: 8000 });
    }
  }

  function updateRecommendationNote() {
    var note = document.getElementById('recommendation-note');
    if (currentView === 'favorites') {
      note.textContent = '추천 기간과 무관한 전체 즐겨찾기를 최근 저장순으로 표시합니다.';
      return;
    }
    if (currentPeriod === 'latest') {
      note.textContent = 'arXiv 최신 후보에서 키워드 관련도와 신규 여부로 추천합니다.';
      return;
    }
    var citation = window.PAPER_METADATA && window.PAPER_METADATA.citation;
    if (!citation || citation.status === 'missing-key') note.textContent = 'OpenAlex API key가 없어 citation 추천을 갱신하지 못했습니다.';
    else if (citation.status === 'disabled') note.textContent = '이번 데이터 갱신에서는 citation 추천을 수집하지 않았습니다.';
    else if (citation.status === 'stale-cache') note.textContent = 'OpenAlex 응답 오류로 이전 citation 추천을 표시합니다.';
    else if ((citation.fallbackModes || []).indexOf(currentPeriod) !== -1) note.textContent = '아직 인용 집계가 충분하지 않아 최신 키워드 추천으로 보완했습니다.';
    else note.textContent = '해당 기간에 공개된 논문을 누적 인용 수 순으로 추천합니다.';
  }

  function dateOnly(iso) {
    if (!iso || !Number.isFinite(Date.parse(iso))) return '';
    return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  function exportFavorites() {
    var data = favorites.exportData();
    var blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'study-ml-favorites-' + dateOnly(data.exportedAt) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    showToast('즐겨찾기 ' + data.items.length + '편을 내보냈습니다.');
  }

  function importFavorites(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setStatus('가져오기 파일은 5MB 이하여야 합니다.', 'error');
      return;
    }
    file.text().then(function(text) {
      var payload;
      try { payload = JSON.parse(text); }
      catch (_) { throw new Error('JSON 파일을 읽을 수 없습니다.'); }
      return favorites.importData(payload);
    }).then(function(result) {
      setStatus('');
      render();
      showToast('새로 추가 ' + result.added + '편 · 갱신 ' + result.updated + '편 · 전체 ' + result.total + '편', { duration: 8000 });
    }).catch(function(error) {
      setStatus(error.message, 'error');
      showToast('가져오지 못했습니다. 기존 즐겨찾기는 유지됩니다.', { duration: 8000 });
    }).finally(function() {
      document.getElementById('favorite-import').value = '';
    });
  }

  document.querySelectorAll('.view-chip').forEach(function(chip) {
    chip.addEventListener('click', function() { setView(chip.dataset.view); });
  });

  document.querySelectorAll('.category-chip').forEach(function(chip) {
    chip.addEventListener('click', function() { setCategory(chip.dataset.category); });
  });

  document.querySelectorAll('.period-chip').forEach(function(chip) {
    chip.classList.toggle('active', chip.dataset.period === currentPeriod);
    chip.addEventListener('click', function() {
      currentPeriod = chip.dataset.period;
      document.querySelectorAll('.period-chip').forEach(function(candidate) { candidate.classList.toggle('active', candidate === chip); });
      var url = new URL(window.location.href);
      if (currentPeriod === 'latest') url.searchParams.delete('period');
      else url.searchParams.set('period', currentPeriod);
      window.history.replaceState({}, '', url);
      render();
    });
  });

  document.getElementById('paper-search').addEventListener('input', function(event) {
    searchQuery = event.target.value;
    render();
  });

  document.getElementById('paper-grid').addEventListener('click', function(event) {
    var button = event.target.closest('button');
    if (!button) return;
    if (button.classList.contains('save-btn')) {
      toggleFavorite(button.dataset.id);
      return;
    }
    if (button.classList.contains('details-toggle')) {
      var details = button.closest('.paper-card').querySelector('.paper-details');
      var hidden = details.classList.toggle('hidden');
      button.textContent = hidden ? '자세히 ▸' : '접기 ▲';
      button.setAttribute('aria-expanded', String(!hidden));
    }
  });

  document.getElementById('favorite-export').addEventListener('click', exportFavorites);
  document.getElementById('favorite-import-trigger').addEventListener('click', function() {
    document.getElementById('favorite-import').click();
  });
  document.getElementById('favorite-import').addEventListener('change', function(event) {
    importFavorites(event.target.files[0]);
  });
  document.getElementById('toast-undo').addEventListener('click', function() {
    if (!undoItem) return;
    try {
      favorites.restore(undoItem);
      render();
      showToast('즐겨찾기를 복원했습니다.');
    } catch (error) {
      showToast(error.message, { duration: 8000 });
    }
  });
  document.getElementById('toast-close').addEventListener('click', hideToast);

  window.addEventListener('storage', function(event) {
    if (event.key !== favorites.storageKey && event.key !== favorites.legacyKey) return;
    if (event.key === favorites.legacyKey) favorites.syncLegacy(papers);
    else favorites.reload(papers);
    render();
    showToast('다른 탭의 즐겨찾기 변경을 반영했습니다.');
  });

  if (window.PAPER_METADATA) {
    var dataEl = document.getElementById('updated-data');
    if (dataEl && window.PAPER_METADATA.collectedAt) dataEl.textContent = dateOnly(window.PAPER_METADATA.collectedAt);
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

  if (favorites.warning()) setStatus(favorites.warning(), 'error');
  render();
})();
