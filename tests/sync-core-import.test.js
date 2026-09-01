'use strict';
/**
 * sync-core v4 导入单元测试（node:test + JSDOM + vm + 真 JSZip）
 *
 * 被测目标：src/static/js/sync/sync-core.js
 *   - BK.SyncCore.importFromZip(fileOrBytes, opts)
 *
 * 测试策略：
 *   - 真 JSZip 构造 v4 测试包（data / full 两种 mode）
 *   - fake forage store 注入（避免碰真 IndexedDB）
 *   - fake localStorage（进度/书签/滚动等合并验证）
 *   - mock BKShelf / BKBookmark / BKStorage / DataManager
 *
 * 加载方式：与 sync-core-export.test.js 同构的 JSDOM + vm.runInThisContext
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const RealJSZip = require('jszip');

// ── 构造 JSDOM 环境并加载被测模块 ──────────────────────────────────────
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// 先加载 sync-shared.js（sync-core 依赖它）
const sharedPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-shared.js');
const sharedCode = readFileSync(sharedPath, 'utf-8');
vm.runInThisContext(sharedCode, { filename: sharedPath, displayErrors: true });

// 加载 sync-data-collect.js（sync-core 复用其 collectUserData）
const collectPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-data-collect.js');
const collectCode = readFileSync(collectPath, 'utf-8');
vm.runInThisContext(collectCode, { filename: collectPath, displayErrors: true });

// 加载 book-convert.js（sync-core full 模式可能用到）
const convertPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'book-convert.js');
try {
  const convertCode = readFileSync(convertPath, 'utf-8');
  vm.runInThisContext(convertCode, { filename: convertPath, displayErrors: true });
} catch (e) { /* book-convert 可能不存在，忽略 */ }

// 加载被测模块 sync-core.js
const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-core.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const SC = win.BK.SyncCore;
assert.ok(SC, 'sync-core.js 必须暴露 win.BK.SyncCore');
assert.ok(typeof SC.importFromZip === 'function', '必须有 importFromZip 方法');

// 使用真 JSZip（导入需要真解包）
win.JSZip = RealJSZip;

// ── 辅助：fake forage store ──────────────────────────────────────────────
function makeFakeStore(data) {
  var store = {};
  Object.assign(store, data || {});
  return {
    getItem: function (key) {
      return Promise.resolve(store.hasOwnProperty(key) ? store[key] : null);
    },
    setItem: function (key, val) {
      store[key] = val;
      return Promise.resolve(val);
    },
    removeItem: function (key) {
      delete store[key];
      return Promise.resolve();
    },
    keys: function () {
      return Promise.resolve(Object.keys(store));
    },
    _raw: store
  };
}

// ── 辅助：构造 fake localStorage ─────────────────────────────────────────
function makeFakeLS(data) {
  var lsData = {};
  Object.assign(lsData, data || {});
  var ls = {
    _data: lsData,
    getItem: function (k) { return lsData.hasOwnProperty(k) ? lsData[k] : null; },
    setItem: function (k, v) { lsData[k] = String(v); },
    removeItem: function (k) { delete lsData[k]; },
    key: function (i) { var keys = Object.keys(lsData); return keys[i] || null; },
    get length() { return Object.keys(lsData).length; }
  };
  try { Object.defineProperty(win, 'localStorage', { value: ls, configurable: true }); } catch (e) { win.localStorage = ls; }
  return ls;
}

// ── 辅助：构造完整 mock 环境 ──────────────────────────────────────────────
// opts:
//   lsData / importStoreData / zlStoreData / pdfStoreData / shelfRecords
//   epubBookmarks / highlightPages / cityIndex / downloadedBooks
//   localImportedBooks — 预置到 importStore 的本地已存在导入书 ID 列表（data 模式合并资格）
//   dataManager — 覆盖/扩展 mock DataManager 的字段（如 cacheBook: undefined 强制走直写回退）
function setupImportEnv(opts) {
  opts = opts || {};

  // localStorage
  var lsData = {};
  Object.assign(lsData, opts.lsData || {});
  makeFakeLS(lsData);

  // forage stores
  var importStoreData = {};
  Object.assign(importStoreData, opts.importStoreData || {});
  // 预置本地已存在的导入书（data 模式 userdata 合并 + 入架资格）
  (opts.localImportedBooks || []).forEach(function (id) {
    if (!importStoreData['imported_book:' + id]) {
      importStoreData['imported_book:' + id] = makeTxtBook(id);
    }
  });
  var importStore = makeFakeStore(importStoreData);
  var zlStore = makeFakeStore(opts.zlStoreData || {});
  var pdfStore = makeFakeStore(opts.pdfStoreData || {});

  // mock BKShelf
  var shelfRecords = {};
  Object.assign(shelfRecords, opts.shelfRecords || {});
  win.BKShelf = {
    all: function () { return Object.keys(shelfRecords).map(function (k) { return shelfRecords[k]; }); },
    add: function (bookId) {
      // 模拟 shelf.js:98 的 purged 守卫：bk_purged:<id> 存在时不入架（阻止复活）
      if (lsData['bk_purged:' + bookId] === '1') return;
      if (!shelfRecords[bookId]) {
        shelfRecords[bookId] = { id: bookId, addedAt: Date.now() };
      }
    },
    get: function (bookId) {
      return shelfRecords[bookId] || null;
    },
    updateNote: function (bookId, note) {
      if (shelfRecords[bookId]) shelfRecords[bookId].note = note;
    },
    updateRating: function (bookId, rating) {
      if (shelfRecords[bookId]) shelfRecords[bookId].rating = rating;
    },
    markRead: function (bookId, o) {
      if (shelfRecords[bookId]) {
        shelfRecords[bookId].finished = true;
        if (o && o.completedAt) shelfRecords[bookId].completedAt = o.completedAt;
      }
    },
    _records: shelfRecords
  };

  // mock BKBookmark（EPUB 书签，IndexedDB）
  var bookmarkStore = opts.epubBookmarks ? opts.epubBookmarks.slice() : [];
  win.BKBookmark = {
    getAll: function () { return Promise.resolve(bookmarkStore.slice()); },
    _save: function (arr) { bookmarkStore = arr || []; return Promise.resolve(); },
    _store: bookmarkStore
  };
  // _store 需要引用跟随
  Object.defineProperty(win.BKBookmark, '_store', { get: function () { return bookmarkStore; } });

  // mock BKStorage（高亮，IndexedDB）
  var highlightPages = {};
  Object.assign(highlightPages, opts.highlightPages || {});
  win.BKStorage = {
    getAllPages: function () {
      return Promise.resolve(Object.keys(highlightPages).map(function (k) {
        return { key: k, highlights: highlightPages[k] };
      }));
    },
    getPage: function (key) {
      return Promise.resolve(highlightPages[key] || []);
    },
    setPage: function (key, arr) {
      highlightPages[key] = arr;
      return Promise.resolve();
    },
    _pages: highlightPages
  };

  // mock DataManager（书城索引 + 缓存 + 索引构建）
  var cityIndex = opts.cityIndex || null;
  var downloadedBooks = {};
  Object.assign(downloadedBooks, opts.downloadedBooks || {});
  var cacheBookCalls = [];
  var contentIndexCalls = [];
  var bookIndexCalls = [];
  var dmDefaults = {
    getCachedIndex: function () { return cityIndex; },
    loadIndex: function () { return Promise.resolve(cityIndex); },
    isBookDownloaded: function (bookId) {
      return Promise.resolve(!!downloadedBooks[bookId]);
    },
    cacheBook: function (bookId, bookData) {
      // 模拟 dm-book-ops.js cacheBook：写 zl-data + 返回 bookData（调用方断言）
      cacheBookCalls.push({ id: bookId, bookData: bookData });
      var key = (win.BK && win.BK.SyncShared)
        ? win.BK.SyncShared.KEY_ZL_PREFIX + bookId : 'zl_book:' + bookId;
      return zlStore.setItem(key, bookData).then(function () { return bookData; });
    },
    buildContentIndex: function (bookData) {
      contentIndexCalls.push(bookData);
    },
    addToBookIndex: function (bookData) {
      bookIndexCalls.push(bookData);
    }
  };
  // opts.dataManager 可覆盖字段（如 cacheBook: null 强制 sync-core 走直写回退）
  var dm = Object.assign({}, dmDefaults, opts.dataManager || {});
  win.DataManager = dm;

  return {
    importStore: importStore,
    zlStore: zlStore,
    pdfStore: pdfStore,
    shelfRecords: shelfRecords,
    bookmarkStore: function () { return bookmarkStore; },
    highlightPages: highlightPages,
    downloadedBooks: downloadedBooks,
    cacheBookCalls: cacheBookCalls,
    contentIndexCalls: contentIndexCalls,
    bookIndexCalls: bookIndexCalls
  };
}

// ── 辅助：构造 v4 data ZIP ───────────────────────────────────────────────
async function makeV4DataZip(books, shelfData) {
  var zip = new RealJSZip();
  zip.file('manifest.json', JSON.stringify({
    version: 4, mode: 'data', exportedAt: '2026-09-01T00:00:00Z', deviceName: 'test'
  }));
  zip.file('shelf.json', JSON.stringify(shelfData || []));
  for (var i = 0; i < books.length; i++) {
    var b = books[i];
    var dir = zip.folder('books').folder(b.dirName || b.id);
    if (b.bookJson) dir.file('book.json', JSON.stringify(b.bookJson));
    dir.file('userdata.json', JSON.stringify(b.userdata || {}));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// ── 辅助：构造 v4 full ZIP ───────────────────────────────────────────────
async function makeV4FullZip(books, shelfData) {
  var zip = new RealJSZip();
  zip.file('manifest.json', JSON.stringify({
    version: 4, mode: 'full', exportedAt: '2026-09-01T00:00:00Z', deviceName: 'test'
  }));
  zip.file('shelf.json', JSON.stringify(shelfData || []));
  for (var i = 0; i < books.length; i++) {
    var b = books[i];
    var dir = zip.folder('books').folder(b.dirName || b.id);
    dir.file('book.json', JSON.stringify(b.bookJson));
    dir.file('userdata.json', JSON.stringify(b.userdata || {}));
    if (b.pdfBytes) dir.file('original.pdf', b.pdfBytes);
    if (b.bookText) dir.file('book.txt', b.bookText);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// ── 辅助：构造非 v4 ZIP ──────────────────────────────────────────────────
async function makeVersionZip(version, books, shelfData) {
  var zip = new RealJSZip();
  zip.file('manifest.json', JSON.stringify({
    version: version, mode: 'data', exportedAt: '2026-09-01T00:00:00Z'
  }));
  if (shelfData) zip.file('shelf.json', JSON.stringify(shelfData));
  for (var i = 0; i < books.length; i++) {
    var b = books[i];
    var dir = zip.folder('books').folder(b.dirName || b.id);
    if (b.bookJson) dir.file('book.json', JSON.stringify(b.bookJson));
    if (b.userdata) dir.file('userdata.json', JSON.stringify(b.userdata));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// ── 辅助：构造无 manifest ZIP ────────────────────────────────────────────
async function makeNoManifestZip(books) {
  var zip = new RealJSZip();
  for (var i = 0; i < books.length; i++) {
    var b = books[i];
    var dir = zip.folder('books').folder(b.dirName || b.id);
    if (b.bookJson) dir.file('book.json', JSON.stringify(b.bookJson));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// ── 辅助：构造普通 TXT 书数据 ───────────────────────────────────────────
function makeTxtBook(id, title) {
  return {
    id: id,
    title: title || '测试书',
    author: '佚名',
    format: 'txt',
    chapters: [{ title: '第一章', content: '正文内容。' }]
  };
}

// ── 辅助：构造 PDF 书数据 ───────────────────────────────────────────────
function makePdfBook(id, title) {
  return {
    id: id,
    title: title || 'PDF测试书',
    author: '佚名',
    format: 'pdf',
    chapters: [{ content: [{ type: 'pdf_page', pageNumber: 1, pdfBookId: id }] }]
  };
}

// ════════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════════

describe('v4 data 包导入 — 合并策略', () => {

  test('进度按 lastReadTs 取新：导入比本地新时覆盖', async () => {
    var bookId = 'imported-merge-1';
    // 本地已有进度 ts=1000
    var env = setupImportEnv({
      lsData: {
        ['bk_progress:' + bookId]: '0.3',
        ['bk_lastread_ts:' + bookId]: '1000'
      }
    });
    // 导入包进度 ts=2000（更新）
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { progress: '0.8', lastReadTs: '2000' } }],
      [{ id: bookId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
    assert.equal(win.localStorage.getItem('bk_progress:' + bookId), '0.8');
    assert.equal(win.localStorage.getItem('bk_lastread_ts:' + bookId), '2000');
  });

  test('进度按 lastReadTs 取新：导入比本地旧时不覆盖', async () => {
    var bookId = 'imported-merge-2';
    var env = setupImportEnv({
      lsData: {
        ['bk_progress:' + bookId]: '0.9',
        ['bk_lastread_ts:' + bookId]: '5000'
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { progress: '0.1', lastReadTs: '2000' } }],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 本地进度不变
    assert.equal(win.localStorage.getItem('bk_progress:' + bookId), '0.9');
    assert.equal(win.localStorage.getItem('bk_lastread_ts:' + bookId), '5000');
  });

  test('书签按 id 去重截断 100', async () => {
    var bookId = 'imported-bm-1';
    // 本地 50 条书签
    var localBm = [];
    for (var i = 0; i < 50; i++) {
      localBm.push({ id: 'bm-local-' + i, bookId: bookId, cfi: 'cfi-' + i, timestamp: 1000 + i });
    }
    // 导入 60 条（20 条 id 与本地重复，40 条新）
    var importBm = [];
    for (var j = 0; j < 60; j++) {
      if (j < 20) {
        importBm.push({ id: 'bm-local-' + j, bookId: bookId, cfi: 'cfi-imp-' + j, timestamp: 2000 + j });
      } else {
        importBm.push({ id: 'bm-imp-' + j, bookId: bookId, cfi: 'cfi-imp-' + j, timestamp: 2000 + j });
      }
    }
    var env = setupImportEnv({
      epubBookmarks: localBm
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { bookmarks: importBm } }],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    var merged = env.bookmarkStore();
    // 50 local + 40 new = 90 unique（< 100 不截断）
    assert.equal(merged.length, 90);
    // 导入版替换重复 id（cfi 应为 imp 版）
    var dup = merged.find(function (b) { return b.id === 'bm-local-0'; });
    assert.ok(dup, '重复 id 应存在');
    assert.equal(dup.cfi, 'cfi-imp-0', '导入版应替换重复 id 的内容');
  });

  test('书签超 100 条截断', async () => {
    var bookId = 'imported-bm-trunc-1';
    var localBm = [];
    for (var i = 0; i < 60; i++) {
      localBm.push({ id: 'bm-l-' + i, bookId: bookId, timestamp: 1000 + i });
    }
    var importBm = [];
    for (var j = 0; j < 60; j++) {
      importBm.push({ id: 'bm-i-' + j, bookId: bookId, timestamp: 2000 + j });
    }
    var env = setupImportEnv({ epubBookmarks: localBm });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { bookmarks: importBm } }],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    var merged = env.bookmarkStore();
    assert.equal(merged.length, 100, '应截断为 100 条');
  });

  test('chapterReads 并集', async () => {
    var bookId = 'imported-cr-1';
    var env = setupImportEnv({
      lsData: {
        ['bk_chapter_read:' + bookId + '/1']: '1',
        ['bk_chapter_read:' + bookId + '/2']: '1',
        ['bk_chapter_read:' + bookId + '/3']: '1'
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { chapterReads: ['3', '4', '5'] } }],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 1,2,3 ∪ 3,4,5 = 1,2,3,4,5
    for (var n = 1; n <= 5; n++) {
      assert.equal(win.localStorage.getItem('bk_chapter_read:' + bookId + '/' + n), '1',
        '章 ' + n + ' 应已读');
    }
  });

  test('shelf 补缺不覆盖已有', async () => {
    var bookA = 'imported-shelf-a';
    var bookB = 'imported-shelf-b';
    var env = setupImportEnv({
      shelfRecords: {
        [bookA]: { id: bookA, note: '本地笔记', rating: 5, finished: true, completedAt: 9999 }
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookA, userdata: {} }, { id: bookB, userdata: {} }],
      [
        { id: bookA, note: '导入笔记', rating: 3, finished: false },
        { id: bookB, note: '新书笔记', rating: 4 }
      ]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // bookA 本地值不覆盖
    assert.equal(env.shelfRecords[bookA].note, '本地笔记', '本地 note 不被覆盖');
    assert.equal(env.shelfRecords[bookA].rating, 5, '本地 rating 不被覆盖');
    assert.equal(env.shelfRecords[bookA].finished, true, '本地 finished 不被覆盖');
    // bookB 补缺
    assert.ok(env.shelfRecords[bookB], 'bookB 应被添加');
    assert.equal(env.shelfRecords[bookB].note, '新书笔记', 'bookB note 应为导入值');
    assert.equal(env.shelfRecords[bookB].rating, 4, 'bookB rating 应为导入值');
  });

  test('多书合并：进度+书签+章节+书架同时验证', async () => {
    var bookA = 'imported-multi-a';
    var bookB = 'imported-multi-b';
    var env = setupImportEnv({
      lsData: {
        ['bk_progress:' + bookA]: '0.5',
        ['bk_lastread_ts:' + bookA]: '1000',
        ['bk_chapter_read:' + bookB + '/1']: '1'
      }
    });
    var bytes = await makeV4DataZip(
      [
        { id: bookA, userdata: { progress: '0.7', lastReadTs: '2000', chapterReads: ['1', '2'] } },
        { id: bookB, userdata: { progress: '0.3', lastReadTs: '3000', chapterReads: ['1', '2', '3'] } }
      ],
      [{ id: bookA }, { id: bookB }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 2);
    // bookA: ts 2000 > 1000 → 覆盖
    assert.equal(win.localStorage.getItem('bk_progress:' + bookA), '0.7');
    assert.equal(win.localStorage.getItem('bk_lastread_ts:' + bookA), '2000');
    // bookA chapters: 1,2 (import only)
    assert.equal(win.localStorage.getItem('bk_chapter_read:' + bookA + '/1'), '1');
    assert.equal(win.localStorage.getItem('bk_chapter_read:' + bookA + '/2'), '1');
    // bookB: chapters 1,2,3 (union)
    for (var n = 1; n <= 3; n++) {
      assert.equal(win.localStorage.getItem('bk_chapter_read:' + bookB + '/' + n), '1');
    }
    // both on shelf
    assert.ok(env.shelfRecords[bookA], 'bookA on shelf');
    assert.ok(env.shelfRecords[bookB], 'bookB on shelf');
  });
});

describe('v4 full 包导入 — 书文件写入', () => {

  test('非书城书：生成新 imported- ID，写入 importStore，shelf.add', async () => {
    var origId = 'imported-orig-1';
    var book = makeTxtBook(origId, '导入书测试');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: 'some-other-book' }] }
    });
    var bytes = await makeV4FullZip(
      [{ id: origId, bookJson: book, userdata: { progress: '0.5', lastReadTs: '2000' } }],
      [{ id: origId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
    // importStore 应有新 imported- key
    var keys = Object.keys(env.importStore._raw);
    var bookKey = keys.find(function (k) { return k.indexOf('imported_book:') === 0; });
    assert.ok(bookKey, 'importStore 应有 imported_book: key');
    var newId = bookKey.replace('imported_book:', '');
    assert.ok(newId.indexOf('imported-') === 0, '新 ID 应以 imported- 开头');
    assert.notEqual(newId, origId, '新 ID 应不同于原 ID');
    // shelf 应引用新 ID
    assert.ok(env.shelfRecords[newId], 'shelf 应有新 ID');
    assert.ok(!env.shelfRecords[origId], 'shelf 不应有原 ID');
    // 进度应写入新 ID
    assert.equal(win.localStorage.getItem('bk_progress:' + newId), '0.5');
  });

  test('书城书：保持原 ID，写入 zlStore，入架并补缺', async () => {
    var cityBookId = 'books-2-2082';
    var book = makeTxtBook(cityBookId, '书城TXT书');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityBookId, title: '书城TXT书' }] }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityBookId, bookJson: book, userdata: { progress: '0.4', lastReadTs: '2000' } }],
      [{ id: cityBookId, note: '导入笔记', rating: 3 }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
    // zlStore 应有 zl_book: key
    var zlKeys = Object.keys(env.zlStore._raw);
    var zlKey = zlKeys.find(function (k) { return k === 'zl_book:' + cityBookId; });
    assert.ok(zlKey, 'zlStore 应有 zl_book: key');
    // importStore 不应有该书
    var importKeys = Object.keys(env.importStore._raw);
    var importBookKey = importKeys.find(function (k) { return k.indexOf(cityBookId) !== -1; });
    assert.ok(!importBookKey, 'importStore 不应有书城书');
    // 书城书也入架 + 补缺 note/rating（P2 修复：不再跳过书城书）
    assert.ok(env.shelfRecords[cityBookId], 'shelf 应有书城书');
    assert.equal(env.shelfRecords[cityBookId].note, '导入笔记', '书城书 note 应补缺');
    assert.equal(env.shelfRecords[cityBookId].rating, 3, '书城书 rating 应补缺');
    // 进度应写入原 ID
    assert.equal(win.localStorage.getItem('bk_progress:' + cityBookId), '0.4');
  });

  test('PDF 书：original.pdf 写入 pdfStore', async () => {
    var origId = 'imported-pdf-orig-1';
    var book = makePdfBook(origId, 'PDF导入测试');
    var pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    var env = setupImportEnv({
      cityIndex: { books: [] }
    });
    var bytes = await makeV4FullZip(
      [{ id: origId, bookJson: book, userdata: {}, pdfBytes: pdfBytes }],
      [{ id: origId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
    // 新 ID
    var keys = Object.keys(env.importStore._raw);
    var bookKey = keys.find(function (k) { return k.indexOf('imported_book:') === 0; });
    assert.ok(bookKey, 'importStore 应有书数据');
    var newId = bookKey.replace('imported_book:', '');
    // pdfStore 应有 pdf:<newId>
    var pdfData = env.pdfStore._raw['pdf:' + newId];
    assert.ok(pdfData, 'pdfStore 应有 pdf:<newId>');
    // book.json 中的 pdf_page.pdfBookId 应重映射
    var savedBook = env.importStore._raw[bookKey];
    var pdfPage = savedBook.chapters[0].content[0];
    assert.equal(pdfPage.pdfBookId, newId, 'pdfBookId 应重映射为新 ID');
  });

  test('书城 PDF 书：original.pdf 写入 pdfStore（保持原 ID）', async () => {
    var cityPdfId = 'books-5-999';
    var book = makePdfBook(cityPdfId, '书城PDF');
    var pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityPdfId }] }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityPdfId, bookJson: book, userdata: {}, pdfBytes: pdfBytes }],
      [{ id: cityPdfId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
    // pdfStore 应有 pdf:<cityPdfId>（原 ID 不变）
    assert.ok(env.pdfStore._raw['pdf:' + cityPdfId], 'pdfStore 应有 pdf:<原ID>');
    // zlStore 应有 zl_book:<cityPdfId>
    assert.ok(env.zlStore._raw['zl_book:' + cityPdfId], 'zlStore 应有 zl_book:<原ID>');
    // importStore 不应有
    assert.ok(!env.importStore._raw['imported_book:' + cityPdfId], 'importStore 不应有书城书');
  });

  test('full 包导入后 userdata 中的 bookId 相关字段重映射', async () => {
    var origId = 'imported-remap-1';
    var book = makeTxtBook(origId, '重映射测试');
    var env = setupImportEnv({
      cityIndex: { books: [] },
      epubBookmarks: []
    });
    var importBm = [{ id: 'bm-1', bookId: origId, cfi: 'cfi-1', path: '/' + origId + '/ch1' }];
    var importHl = [{ key: '/' + origId + '/1', highlights: [{ id: 'hl-1', text: '高亮' }] }];
    var bytes = await makeV4FullZip(
      [{ id: origId, bookJson: book, userdata: {
        progress: '0.5', lastReadTs: '2000',
        bookmarks: importBm, highlights: importHl
      }}],
      [{ id: origId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 找新 ID
    var keys = Object.keys(env.importStore._raw);
    var bookKey = keys.find(function (k) { return k.indexOf('imported_book:') === 0; });
    var newId = bookKey.replace('imported_book:', '');
    // 书签 bookId 应重映射
    var mergedBm = env.bookmarkStore();
    var found = mergedBm.find(function (b) { return b.id === 'bm-1'; });
    assert.ok(found, '书签应存在');
    assert.equal(found.bookId, newId, '书签 bookId 应重映射');
    // 高亮 key 应重映射
    assert.ok(env.highlightPages['/' + newId + '/1'], '高亮 key 应重映射');
    assert.ok(!env.highlightPages['/' + origId + '/1'], '旧 key 不应存在');
  });
});

describe('报错路径', () => {

  test('manifest.version === 3 → 抛错含"旧版本"', async () => {
    var env = setupImportEnv({});
    var bytes = await makeVersionZip(3,
      [{ id: 'x', userdata: {} }], [{ id: 'x' }]);
    await assert.rejects(
      function () { return SC.importFromZip(bytes, {
        importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
      }); },
      /旧版本/
    );
  });

  test('manifest.version === 2 → 抛错含"旧版本"', async () => {
    var env = setupImportEnv({});
    var bytes = await makeVersionZip(2,
      [{ id: 'x', userdata: {} }], [{ id: 'x' }]);
    await assert.rejects(
      function () { return SC.importFromZip(bytes, {
        importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
      }); },
      /旧版本/
    );
  });

  test('manifest.version === 1 → 抛错含"旧版本"', async () => {
    var env = setupImportEnv({});
    var bytes = await makeVersionZip(1,
      [{ id: 'x', userdata: {} }], [{ id: 'x' }]);
    await assert.rejects(
      function () { return SC.importFromZip(bytes, {
        importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
      }); },
      /旧版本/
    );
  });

  test('无 manifest → 抛错"不是有效的书籍数据包"', async () => {
    var env = setupImportEnv({});
    var bytes = await makeNoManifestZip([{ id: 'x', bookJson: makeTxtBook('x') }]);
    await assert.rejects(
      function () { return SC.importFromZip(bytes, {
        importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
      }); },
      /不是有效的书籍数据包/
    );
  });

  test('manifest 解析失败 → 抛错"不是有效的书籍数据包"', async () => {
    var env = setupImportEnv({});
    var zip = new RealJSZip();
    zip.file('manifest.json', '{invalid json');
    zip.file('shelf.json', '[]');
    var bytes = await zip.generateAsync({ type: 'uint8array' });
    await assert.rejects(
      function () { return SC.importFromZip(bytes, {
        importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
      }); },
      /不是有效的书籍数据包/
    );
  });

  test('JSZip 未加载时 reject', async () => {
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip([{ id: 'x', userdata: {} }], [{ id: 'x' }]);
    var saved = win.JSZip;
    delete win.JSZip;
    try {
      await assert.rejects(
        function () { return SC.importFromZip(bytes, {
          importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
        }); },
        /JSZip/
      );
    } finally {
      win.JSZip = saved;
    }
  });
});

describe('孤儿条目处理', () => {

  test('books/ 有目录但 shelf.json 无记录 → 忽略孤儿并继续', async () => {
    var bookA = 'imported-orphan-a';
    var bookB = 'imported-orphan-b'; // 孤儿：在 books/ 但不在 shelf.json
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip(
      [
        { id: bookA, userdata: { progress: '0.5', lastReadTs: '2000' } },
        { id: bookB, userdata: { progress: '0.3', lastReadTs: '2000' } }
      ],
      [{ id: bookA }] // shelf 只有 bookA
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 两本书的 userdata 都合并了
    assert.equal(result.success, 2);
    assert.equal(win.localStorage.getItem('bk_progress:' + bookA), '0.5');
    assert.equal(win.localStorage.getItem('bk_progress:' + bookB), '0.3');
    // 只有 bookA 在 shelf（从 shelf.json）
    assert.ok(env.shelfRecords[bookA], 'bookA 应在 shelf');
    // bookB 不在 shelf（孤儿，不在 shelf.json）
    assert.ok(!env.shelfRecords[bookB], 'bookB 不应在 shelf');
  });

  test('shelf.json 有记录但 books/ 无目录 → 入架但无 userdata', async () => {
    var bookA = 'imported-missing-a';
    var env = setupImportEnv({});
    // zip 中没有 books 目录，只有 shelf.json
    var zip = new RealJSZip();
    zip.file('manifest.json', JSON.stringify({
      version: 4, mode: 'data', exportedAt: '2026-09-01T00:00:00Z', deviceName: 'test'
    }));
    zip.file('shelf.json', JSON.stringify([{ id: bookA }]));
    var bytes = await zip.generateAsync({ type: 'uint8array' });
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 应成功（0 失败），shelf 有 bookA
    assert.ok(env.shelfRecords[bookA], 'bookA 应在 shelf');
  });
});

describe('返回值结构', () => {

  test('返回 { success, skipped, failed, errors }', async () => {
    var bookId = 'imported-ret-1';
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: { progress: '0.5', lastReadTs: '2000' } }],
      [{ id: bookId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.ok(typeof result === 'object');
    assert.ok('success' in result);
    assert.ok('skipped' in result);
    assert.ok('failed' in result);
    assert.ok('errors' in result);
    assert.ok(Array.isArray(result.errors));
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
  });

  test('接受 Uint8Array 输入', async () => {
    var bookId = 'imported-uint8-1';
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {} }],
      [{ id: bookId }]
    );
    assert.ok(bytes instanceof Uint8Array);
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
  });

  test('接受 ArrayBuffer 输入', async () => {
    var bookId = 'imported-ab-1';
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {} }],
      [{ id: bookId }]
    );
    var buf = bytes.buffer; // ArrayBuffer
    var result = await SC.importFromZip(buf, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1);
  });
});

describe('data 模式 — EPUB 高亮合并', () => {

  test('高亮逐 key 合并，同 key 内按 id 去重', async () => {
    var bookId = 'imported-hl-1';
    var env = setupImportEnv({
      highlightPages: {
        ['/' + bookId + '/1']: [{ id: 'hl-local-1', text: '本地高亮' }]
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {
        highlights: [
          { key: '/' + bookId + '/1', highlights: [{ id: 'hl-local-1', text: '导入版替换' }] },
          { key: '/' + bookId + '/2', highlights: [{ id: 'hl-new-1', text: '新页高亮' }] }
        ]
      }}],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // key /1: 合并后 1 条（导入版替换重复 id）
    assert.equal(env.highlightPages['/' + bookId + '/1'].length, 1);
    assert.equal(env.highlightPages['/' + bookId + '/1'][0].text, '导入版替换');
    // key /2: 新增 1 条
    assert.equal(env.highlightPages['/' + bookId + '/2'].length, 1);
    assert.equal(env.highlightPages['/' + bookId + '/2'][0].text, '新页高亮');
  });
});

describe('data 模式 — 滚动位置合并', () => {

  test('滚动位置：同章在导入比本地新时覆盖', async () => {
    var bookId = 'imported-scroll-1';
    var env = setupImportEnv({
      lsData: {
        ['bk_scroll:' + bookId + '/1']: '100',
        ['bk_lastread_ts:' + bookId]: '1000'
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {
        lastReadTs: '2000',
        scroll: { '1': '500' }
      }}],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(win.localStorage.getItem('bk_scroll:' + bookId + '/1'), '500');
  });

  test('滚动位置：同章在导入比本地旧时不覆盖', async () => {
    var bookId = 'imported-scroll-2';
    var env = setupImportEnv({
      lsData: {
        ['bk_scroll:' + bookId + '/1']: '800',
        ['bk_lastread_ts:' + bookId]: '5000'
      }
    });
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {
        lastReadTs: '2000',
        scroll: { '1': '200' }
      }}],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(win.localStorage.getItem('bk_scroll:' + bookId + '/1'), '800');
  });

  test('滚动位置：新章直接写入', async () => {
    var bookId = 'imported-scroll-3';
    var env = setupImportEnv({});
    var bytes = await makeV4DataZip(
      [{ id: bookId, userdata: {
        lastReadTs: '2000',
        scroll: { '5': '300' }
      }}],
      [{ id: bookId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(win.localStorage.getItem('bk_scroll:' + bookId + '/5'), '300');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 审查问题修复回归测试（P1-P5、P7）
// ════════════════════════════════════════════════════════════════════════

describe('P1 — data 模式幽灵 ID 防护', () => {

  test('data 包含 book.json：本地不存在的导入书不重映射不合并不入架', async () => {
    var origId = 'book-local-missing-1';
    var book = makeTxtBook(origId, '幽灵书');
    var env = setupImportEnv({ cityIndex: { books: [] } });
    // data 包带 book.json（导出端 data 模式会写 book.json）
    var bytes = await makeV4DataZip(
      [{ id: origId, bookJson: book, userdata: { progress: '0.5', lastReadTs: '2000' } }],
      [{ id: origId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 不应生成幽灵 imported- ID
    var keys = Object.keys(env.importStore._raw);
    var ghostKey = keys.find(function (k) {
      return k.indexOf('imported_book:') === 0;
    });
    assert.ok(!ghostKey, 'importStore 不应有幽灵 imported_book: key');
    // shelf 不应有任何 imported- 幽灵条目
    var shelfIds = Object.keys(env.shelfRecords);
    var ghostShelf = shelfIds.find(function (k) { return k.indexOf('imported-') === 0; });
    assert.ok(!ghostShelf, 'shelf 不应有幽灵 imported- 条目，实际=' + JSON.stringify(shelfIds));
    // 计入 skipped
    assert.ok(result.skipped >= 1, 'skipped 应 ≥1，实际=' + result.skipped);
  });

  test('data 包含 book.json：本地已存在的导入书正常合并并保持原 ID', async () => {
    var origId = 'imported-exist-1';
    var book = makeTxtBook(origId, '本地已有书');
    var env = setupImportEnv({
      cityIndex: { books: [] },
      localImportedBooks: [origId]
    });
    var bytes = await makeV4DataZip(
      [{ id: origId, bookJson: book, userdata: { progress: '0.5', lastReadTs: '2000' } }],
      [{ id: origId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    // 恒等映射：进度写入原 ID，不生成新 ID
    assert.equal(win.localStorage.getItem('bk_progress:' + origId), '0.5',
      '进度应写入原 ID（本地已存在，恒等映射）');
    var newKeys = Object.keys(env.importStore._raw).filter(function (k) {
      return k.indexOf('imported_book:') === 0 && k !== 'imported_book:' + origId;
    });
    assert.ok(!newKeys.length, '不应生成新的 imported- ID');
    assert.ok(result.skipped === 0, '本地已存在不应计 skipped');
  });

  test('data 包含 book.json：书城书正常合并（ID 跨设备稳定）', async () => {
    var cityId = 'books-2-3001';
    var book = makeTxtBook(cityId, '书城书合并');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] }
    });
    var bytes = await makeV4DataZip(
      [{ id: cityId, bookJson: book, userdata: { progress: '0.6', lastReadTs: '2000' } }],
      [{ id: cityId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(win.localStorage.getItem('bk_progress:' + cityId), '0.6',
      '书城书 data 模式应照常合并');
    assert.ok(result.skipped === 0, '书城书不应计 skipped');
  });
});

describe('P2 — 书城书 shelf 补缺', () => {

  test('data 模式：书城书 note/rating/finished 补缺合并并入架', async () => {
    var cityId = 'books-2-3002';
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] }
    });
    var bytes = await makeV4DataZip(
      [{ id: cityId, userdata: {} }],
      [{ id: cityId, note: '导入笔记', rating: 4, finished: true, completedAt: 8888 }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.ok(env.shelfRecords[cityId], '书城书应入架');
    assert.equal(env.shelfRecords[cityId].note, '导入笔记', 'note 应补缺');
    assert.equal(env.shelfRecords[cityId].rating, 4, 'rating 应补缺');
    assert.equal(env.shelfRecords[cityId].finished, true, 'finished 应补缺');
  });

  test('data 模式：purged 书城书不复活（仍补缺元数据）', async () => {
    var cityId = 'books-2-3003';
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] },
      lsData: { ['bk_purged:' + cityId]: '1' }
    });
    var bytes = await makeV4DataZip(
      [{ id: cityId, userdata: { progress: '0.2', lastReadTs: '1000' } }],
      [{ id: cityId, note: '被移除书的笔记' }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.ok(!env.shelfRecords[cityId], 'purged 书不应入架');
    // 进度照常合并（purged 只挡入架，不挡数据合并）
    assert.equal(win.localStorage.getItem('bk_progress:' + cityId), '0.2',
      'purged 不应影响 userdata 合并');
  });

  test('full 模式：purged 书城书不复活（cacheBook 路径不改写 purged 状态）', async () => {
    var cityId = 'books-2-3004';
    var book = makeTxtBook(cityId, 'purged书城书');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] },
      lsData: { ['bk_purged:' + cityId]: '1' }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityId, bookJson: book, userdata: {} }],
      [{ id: cityId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.ok(!env.shelfRecords[cityId], 'purged 书城书不应入架');
  });
});

describe('P3 — 书城书 cacheBook 路径与失败计数', () => {

  test('full 模式：书城书走 DataManager.cacheBook（调用断言）', async () => {
    var cityId = 'books-2-3005';
    var book = makeTxtBook(cityId, 'cacheBook路径');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityId, bookJson: book, userdata: {} }],
      [{ id: cityId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(env.cacheBookCalls.length, 1, 'cacheBook 应被调用 1 次');
    assert.equal(env.cacheBookCalls[0].id, cityId, 'cacheBook 应收到书城书 ID');
    // cacheBook 写入 zl_book:<id>
    assert.ok(env.zlStore._raw['zl_book:' + cityId], 'zlStore 应有 cacheBook 写入的数据');
  });

  test('full 模式：已下载书城书跳过 cacheBook 并计入 skipped', async () => {
    var cityId = 'books-2-3006';
    var book = makeTxtBook(cityId, '已下载书');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] },
      downloadedBooks: { [cityId]: true }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityId, bookJson: book, userdata: {} }],
      [{ id: cityId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(env.cacheBookCalls.length, 0, '已下载不应调 cacheBook');
    assert.ok(result.skipped >= 1, '已下载跳过应计 skipped，实际=' + result.skipped);
  });

  test('full 模式：DataManager 不可用时书城书回退直写 zlStore', async () => {
    var cityId = 'books-2-3007';
    var book = makeTxtBook(cityId, '直写回退');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] },
      // cacheBook: null → sync-core 应识别为不可用，回退 _writeCityBookToZlStore
      dataManager: { cacheBook: null }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityId, bookJson: book, userdata: {} }],
      [{ id: cityId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.success, 1, '回退直写不应计失败');
    assert.ok(env.zlStore._raw['zl_book:' + cityId], 'zlStore 应有直写数据');
  });

  test('full 模式：cacheBook 失败计入 failed 并记录错误', async () => {
    var cityId = 'books-2-3008';
    var book = makeTxtBook(cityId, 'cacheBook失败');
    var env = setupImportEnv({
      cityIndex: { books: [{ id: cityId }] },
      dataManager: {
        cacheBook: function () { return Promise.reject(new Error('写入失败')); }
      }
    });
    var bytes = await makeV4FullZip(
      [{ id: cityId, bookJson: book, userdata: {} }],
      [{ id: cityId }]
    );
    var result = await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.equal(result.failed, 1, 'cacheBook 失败应计 failed');
    assert.equal(result.errors.length, 1, 'errors 应有 1 条');
    assert.equal(result.errors[0].id, cityId, '错误应携带书 ID');
  });
});

describe('P4 — 导入书内容索引', () => {

  test('full 模式：导入书保存后调用 buildContentIndex + addToBookIndex', async () => {
    var origId = 'imported-idx-1';
    var book = makeTxtBook(origId, '索引测试');
    var env = setupImportEnv({ cityIndex: { books: [] } });
    var bytes = await makeV4FullZip(
      [{ id: origId, bookJson: book, userdata: {} }],
      [{ id: origId }]
    );
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    var keys = Object.keys(env.importStore._raw);
    var bookKey = keys.find(function (k) { return k.indexOf('imported_book:') === 0; });
    var newId = bookKey.replace('imported_book:', '');
    assert.equal(env.contentIndexCalls.length, 1, 'buildContentIndex 应被调用 1 次');
    assert.equal(env.contentIndexCalls[0].id, newId, 'buildContentIndex 应收到新 ID 的书');
    assert.equal(env.bookIndexCalls.length, 1, 'addToBookIndex 应被调用 1 次');
  });
});

describe('P7 — shelf-only 包路径', () => {

  test('仅 shelf.json 无 books 目录：入架前加载书城索引', async () => {
    var cityId = 'books-2-3009';
    var env = setupImportEnv({});
    var zip = new RealJSZip();
    zip.file('manifest.json', JSON.stringify({
      version: 4, mode: 'data', exportedAt: '2026-09-01T00:00:00Z', deviceName: 'test'
    }));
    zip.file('shelf.json', JSON.stringify([{ id: cityId, note: '索引补缺' }]));
    var bytes = await zip.generateAsync({ type: 'uint8array' });
    // 注入 DataManager：getCachedIndex 首次返回 null，loadIndex 后返回索引
    var idx = { books: [{ id: cityId }] };
    var loadCalled = { v: false };
    win.DataManager = Object.assign({}, win.DataManager, {
      getCachedIndex: function () { return loadCalled.v ? idx : null; },
      loadIndex: function () { loadCalled.v = true; return Promise.resolve(idx); }
    });
    await SC.importFromZip(bytes, {
      importStore: env.importStore, zlStore: env.zlStore, pdfStore: env.pdfStore
    });
    assert.ok(loadCalled.v, 'loadIndex 应被调用（入架前索引就绪）');
    assert.ok(env.shelfRecords[cityId], '书城书应入架');
    assert.equal(env.shelfRecords[cityId].note, '索引补缺', 'note 应补缺');
  });
});
