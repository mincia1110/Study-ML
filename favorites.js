(function(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FavoriteLibrary = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  var STORAGE_KEY = 'favoriteLibraryV1';
  var LEGACY_KEY = 'savedPaperIds';
  var SCHEMA_VERSION = 1;
  var MAX_ITEMS = 1000;
  var EXPORT_APP = 'Study-ML';
  var VALID_CATEGORIES = new Set(['cv', 'llm', 'multimodal']);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isoOr(value, fallback) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
  }

  function cleanString(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength || 20000) : '';
  }

  function cleanArray(value) {
    return Array.isArray(value)
      ? value.filter(function(item) { return typeof item === 'string'; }).slice(0, 50).map(function(item) { return item.slice(0, 200); })
      : [];
  }

  function validId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(id);
  }

  function arxivUrl(id, pdf) {
    var encodedId = id.split('/').map(encodeURIComponent).join('/');
    return 'https://arxiv.org/' + (pdf ? 'pdf/' : 'abs/') + encodedId + (pdf ? '.pdf' : '');
  }

  function safeArxivUrl(value, id, pdf) {
    if (typeof value === 'string') {
      try {
        var url = new URL(value);
        if (url.protocol === 'https:' && (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org')) return url.href;
      } catch (_) {}
    }
    return arxivUrl(id, pdf);
  }

  function fallbackPaper(id) {
    return {
      id: id,
      title: 'arXiv ' + id,
      authors: '상세 정보 복원 대기',
      published: '',
      category: 'unknown',
      categories: [],
      tags: [],
      summaryKo: '현재 논문 데이터에 없어 상세 정보 복원을 기다리고 있습니다.',
      detail: { problem: '', method: '', takeaway: '' },
      sourceUrl: arxivUrl(id, false),
      pdfUrl: arxivUrl(id, true),
      unresolved: true,
    };
  }

  function snapshotPaper(paper, fallbackId) {
    var id = cleanString(paper && paper.id, 100) || fallbackId;
    if (!validId(id)) throw libraryError('invalid', '유효하지 않은 arXiv ID가 있습니다.');
    if (!paper || paper.unresolved) return fallbackPaper(id);
    var detail = paper.detail || {};
    return {
      id: id,
      title: cleanString(paper.title, 1000) || ('arXiv ' + id),
      authors: cleanString(paper.authors, 1000),
      published: cleanString(paper.published, 30),
      category: VALID_CATEGORIES.has(paper.category) ? paper.category : 'unknown',
      categories: cleanArray(paper.categories),
      tags: cleanArray(paper.tags),
      summaryKo: cleanString(paper.summaryKo),
      detail: {
        problem: cleanString(detail.problem),
        method: cleanString(detail.method),
        takeaway: cleanString(detail.takeaway),
      },
      sourceUrl: safeArxivUrl(paper.sourceUrl, id, false),
      pdfUrl: safeArxivUrl(paper.pdfUrl, id, true),
      recommendationModes: cleanArray(paper.recommendationModes),
      recommendationRanks: paper.recommendationRanks && typeof paper.recommendationRanks === 'object' ? clone(paper.recommendationRanks) : {},
      metrics: paper.metrics && typeof paper.metrics === 'object' ? clone(paper.metrics) : undefined,
      unresolved: false,
    };
  }

  function libraryError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function assertPaperShape(paper, id) {
    if (!paper || typeof paper !== 'object' || Array.isArray(paper)) throw libraryError('invalid', '논문 스냅샷 형식이 올바르지 않습니다.');
    if (paper.id !== id) throw libraryError('invalid', '논문 ID가 서로 일치하지 않습니다.');
    ['title', 'authors', 'published', 'summaryKo', 'sourceUrl', 'pdfUrl'].forEach(function(key) {
      if (typeof paper[key] !== 'string') throw libraryError('invalid', '논문 ' + key + ' 값이 올바르지 않습니다.');
    });
    if (!Array.isArray(paper.categories) || !Array.isArray(paper.tags)) throw libraryError('invalid', '논문 분류 형식이 올바르지 않습니다.');
    if (!paper.detail || typeof paper.detail !== 'object') throw libraryError('invalid', '논문 상세 정보가 없습니다.');
    ['problem', 'method', 'takeaway'].forEach(function(key) {
      if (typeof paper.detail[key] !== 'string') throw libraryError('invalid', '논문 상세 정보 형식이 올바르지 않습니다.');
    });
    function assertArxivUrl(value, label) {
      try {
        var url = new URL(value);
        if (url.protocol !== 'https:' || (url.hostname !== 'arxiv.org' && url.hostname !== 'www.arxiv.org')) throw new Error('invalid');
      } catch (_) {
        throw libraryError('invalid', '논문 ' + label + ' 링크가 올바르지 않습니다.');
      }
    }
    assertArxivUrl(paper.sourceUrl, '원문');
    assertArxivUrl(paper.pdfUrl, 'PDF');
  }

  function validateItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !validId(raw.id)) throw libraryError('invalid', '즐겨찾기 항목 형식이 올바르지 않습니다.');
    if (!Number.isFinite(Date.parse(raw.savedAt)) || !Number.isFinite(Date.parse(raw.updatedAt))) throw libraryError('invalid', '즐겨찾기 날짜 형식이 올바르지 않습니다.');
    assertPaperShape(raw.paper, raw.id);
    return {
      id: raw.id,
      savedAt: new Date(raw.savedAt).toISOString(),
      updatedAt: new Date(raw.updatedAt).toISOString(),
      paper: snapshotPaper(raw.paper, raw.id),
    };
  }

  function validatePayload(payload, requireApp) {
    if (!payload || typeof payload !== 'object' || payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.items)) {
      throw libraryError('invalid', 'Study-ML 즐겨찾기 v1 파일이 아닙니다.');
    }
    if (requireApp && payload.app !== EXPORT_APP) throw libraryError('invalid', 'Study-ML에서 내보낸 파일이 아닙니다.');
    if (payload.items.length > MAX_ITEMS) throw libraryError('limit', '즐겨찾기는 최대 1,000편까지 가져올 수 있습니다.');
    var ids = new Set();
    return payload.items.map(function(raw) {
      var item = validateItem(raw);
      if (ids.has(item.id)) throw libraryError('invalid', '중복된 논문 ID가 있습니다: ' + item.id);
      ids.add(item.id);
      return item;
    });
  }

  function paperMap(papers) {
    var map = new Map();
    (Array.isArray(papers) ? papers : []).forEach(function(paper) {
      if (paper && validId(paper.id)) map.set(paper.id, paper);
    });
    return map;
  }

  function createStore(options) {
    options = options || {};
    var storage = options.storage;
    if (!storage) throw new Error('storage is required');
    var now = options.now || function() { return new Date(); };
    var currentPapers = paperMap(options.papers);
    var warning = '';
    var items = [];
    var writeBlocked = false;

    function nowIso() {
      return new Date(now()).toISOString();
    }

    function nextSavedAt() {
      var latest = items.reduce(function(maximum, item) { return Math.max(maximum, Date.parse(item.savedAt)); }, 0);
      return new Date(Math.max(new Date(now()).getTime(), latest + 1)).toISOString();
    }

    function orderedIds(nextItems) {
      return nextItems.slice().sort(function(a, b) { return a.savedAt.localeCompare(b.savedAt); }).map(function(item) { return item.id; });
    }

    function persist(nextItems) {
      if (writeBlocked) {
        throw libraryError('corrupt', '손상된 즐겨찾기 데이터가 있어 변경하지 않았습니다. 브라우저 데이터를 복구하거나 초기화하기 전에 원본을 백업해 주세요.');
      }
      var payload = { schemaVersion: SCHEMA_VERSION, items: nextItems };
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (error) {
        throw libraryError('storage', '브라우저 저장공간에 기록하지 못했습니다. JSON으로 내보낸 뒤 기존 항목을 정리해 주세요.');
      }
      try { storage.setItem(LEGACY_KEY, JSON.stringify(orderedIds(nextItems))); }
      catch (_) {}
    }

    function readLegacyIds() {
      var rawIds;
      try { rawIds = JSON.parse(storage.getItem(LEGACY_KEY) || '[]'); }
      catch (_) { rawIds = []; }
      if (!Array.isArray(rawIds)) return [];
      return rawIds.filter(validId).filter(function(id, index, all) { return all.indexOf(id) === index; }).slice(0, MAX_ITEMS);
    }

    function migrateLegacy() {
      var ids = readLegacyIds();
      var base = new Date(now()).getTime() - ids.length * 1000;
      var migrated = ids.map(function(id, index) {
        var timestamp = new Date(base + index * 1000).toISOString();
        return { id: id, savedAt: timestamp, updatedAt: timestamp, paper: snapshotPaper(currentPapers.get(id) || fallbackPaper(id), id) };
      });
      if (migrated.length) {
        try { persist(migrated); }
        catch (error) { warning = error.message; writeBlocked = true; }
      }
      return migrated;
    }

    function load() {
      var raw;
      try { raw = storage.getItem(STORAGE_KEY); }
      catch (_) {
        warning = '브라우저 저장공간을 읽을 수 없어 즐겨찾기를 변경하지 않았습니다.';
        writeBlocked = true;
        return [];
      }
      if (!raw) return migrateLegacy();
      try {
        var loaded = validatePayload(JSON.parse(raw), false);
        writeBlocked = false;
        return loaded;
      } catch (error) {
        warning = '저장된 즐겨찾기 데이터를 읽지 못했습니다. 기존 데이터는 덮어쓰지 않았습니다.';
        writeBlocked = true;
        return [];
      }
    }

    function refreshSnapshots(nextItems) {
      var changed = false;
      var refreshed = nextItems.map(function(item) {
        var current = currentPapers.get(item.id);
        if (!current) return item;
        var paper = snapshotPaper(current, item.id);
        if (JSON.stringify(paper) === JSON.stringify(item.paper)) return item;
        changed = true;
        return { id: item.id, savedAt: item.savedAt, updatedAt: nowIso(), paper: paper };
      });
      if (changed) {
        try { persist(refreshed); } catch (error) { warning = error.message; return nextItems; }
      }
      return refreshed;
    }

    function syncFromLegacy() {
      if (writeBlocked) return items;
      var ids = readLegacyIds();
      var currentIds = orderedIds(items);
      if (JSON.stringify(ids) === JSON.stringify(currentIds)) return items;
      var byId = new Map(items.map(function(item) { return [item.id, item]; }));
      var newestExisting = items.reduce(function(latest, item) { return Math.max(latest, Date.parse(item.savedAt)); }, 0);
      var nextTimestamp = Math.max(new Date(now()).getTime(), newestExisting + 1);
      var nextItems = ids.map(function(id, index) {
        var existing = byId.get(id);
        if (existing) return existing;
        var timestamp = new Date(nextTimestamp + index).toISOString();
        return { id: id, savedAt: timestamp, updatedAt: timestamp, paper: snapshotPaper(currentPapers.get(id) || fallbackPaper(id), id) };
      });
      persist(nextItems);
      items = nextItems;
      return items;
    }

    items = refreshSnapshots(load());

    function replace(nextItems) {
      persist(nextItems);
      items = nextItems;
    }

    return {
      storageKey: STORAGE_KEY,
      legacyKey: LEGACY_KEY,
      warning: function() { return warning; },
      list: function() {
        return clone(items).sort(function(a, b) { return b.savedAt.localeCompare(a.savedAt); });
      },
      size: function() { return items.length; },
      has: function(id) { return items.some(function(item) { return item.id === id; }); },
      get: function(id) { var item = items.find(function(candidate) { return candidate.id === id; }); return item ? clone(item) : null; },
      add: function(paper) {
        var id = paper && paper.id;
        if (!validId(id)) throw libraryError('invalid', '유효하지 않은 논문입니다.');
        var existing = items.find(function(item) { return item.id === id; });
        if (existing) return clone(existing);
        if (items.length >= MAX_ITEMS) throw libraryError('limit', '즐겨찾기는 최대 1,000편까지 저장할 수 있습니다. JSON으로 내보낸 뒤 기존 항목을 정리해 주세요.');
        var timestamp = nextSavedAt();
        var item = { id: id, savedAt: timestamp, updatedAt: timestamp, paper: snapshotPaper(paper, id) };
        replace(items.concat([item]));
        return clone(item);
      },
      remove: function(id) {
        var removed = items.find(function(item) { return item.id === id; });
        if (!removed) return null;
        replace(items.filter(function(item) { return item.id !== id; }));
        return clone(removed);
      },
      restore: function(rawItem) {
        var item = validateItem(rawItem);
        if (items.some(function(candidate) { return candidate.id === item.id; })) return clone(item);
        if (items.length >= MAX_ITEMS) throw libraryError('limit', '즐겨찾기는 최대 1,000편까지 저장할 수 있습니다.');
        var current = currentPapers.get(item.id);
        if (current) item = { id: item.id, savedAt: item.savedAt, updatedAt: nowIso(), paper: snapshotPaper(current, item.id) };
        replace(items.concat([item]));
        return clone(item);
      },
      exportData: function() {
        return { app: EXPORT_APP, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), items: clone(items) };
      },
      importData: function(payload) {
        var incoming = validatePayload(payload, true);
        var nextById = new Map(items.map(function(item) { return [item.id, clone(item)]; }));
        var added = 0;
        var updated = 0;
        incoming.forEach(function(imported) {
          var existing = nextById.get(imported.id);
          var savedAt = existing && existing.savedAt < imported.savedAt ? existing.savedAt : imported.savedAt;
          var current = currentPapers.get(imported.id);
          var chosen;
          if (current) {
            chosen = { id: imported.id, savedAt: savedAt, updatedAt: nowIso(), paper: snapshotPaper(current, imported.id) };
          } else if (!existing || imported.updatedAt > existing.updatedAt) {
            chosen = { id: imported.id, savedAt: savedAt, updatedAt: imported.updatedAt, paper: imported.paper };
          } else {
            chosen = { id: existing.id, savedAt: savedAt, updatedAt: existing.updatedAt, paper: existing.paper };
          }
          if (!existing) added += 1;
          else if (JSON.stringify(existing) !== JSON.stringify(chosen)) updated += 1;
          nextById.set(imported.id, chosen);
        });
        if (nextById.size > MAX_ITEMS) throw libraryError('limit', '병합 결과가 즐겨찾기 1,000편을 초과합니다.');
        var nextItems = Array.from(nextById.values());
        replace(nextItems);
        return { added: added, updated: updated, total: nextItems.length };
      },
      reload: function(papers) {
        if (papers) currentPapers = paperMap(papers);
        warning = '';
        items = refreshSnapshots(load());
        return this.list();
      },
      syncLegacy: function(papers) {
        if (papers) currentPapers = paperMap(papers);
        items = refreshSnapshots(syncFromLegacy());
        return this.list();
      },
    };
  }

  return {
    createStore: createStore,
    snapshotPaper: snapshotPaper,
    fallbackPaper: fallbackPaper,
    validatePayload: validatePayload,
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_ITEMS: MAX_ITEMS,
  };
});
