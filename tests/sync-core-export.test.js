'use strict';
/**
 * sync-core v4 导出单元测试（node:test + JSDOM + vm）
 *
 * 被测目标：src/static/js/sync/sync-core.js
 *   - BK.SyncCore.generateZipBytes(mode)  生成 zip 字节（不触发下载）
 *   - BK.SyncCore.exportData(mode)        生成 zip 字节 + exportBinary 写出
 *
 * 测试策略：
 *   - fake JSZip（记录 file()/folder() 调用序列，不真打包）
 *   - fake forage store 注入（避免碰真 IndexedDB）
 *   - fake localStorage 快照注入（进度/书签/滚动等）
 *   - BKShell / BKBookmark / BKStorage / BK.SyncData 等全局 mock
 *   - 真 JSZip 冒烟（PK 魔数验证）
 *
 * 加载方式：与 sync-shared.test.js 同构的 JSDOM + vm.runInThisContext
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

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

// 加载被测模块 sync-core.js
const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-core.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const SC = win.BK.SyncCore;
assert.ok(SC, 'sync-core.js 必须暴露 win.BK.SyncCore');

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
    }
  };
}

// ── 辅助：fake JSZip（记录 file/folder 调用，返回假字节）────────────────
function makeFakeJSZip() {
  var files = {};
  var folders = {};
  var genOpts = null;
  var genResult = new Uint8Array([1, 2, 3, 4]);
  function JSZip() {
    return {
      file: function (name, content) {
        files[name] = content;
      },
      folder: function (name) {
        var sub = {
          file: function (n, c) { files[name + '/' + n] = c; },
          folder: function (subName) {
            var sub2 = {
              file: function (n, c) { files[name + '/' + subName + '/' + n] = c; },
              folder: function (n2) {
                return {
                  file: function (n3, c) {
                    files[name + '/' + subName + '/' + n2 + '/' + n3] = c;
                  }
                };
              }
            };
            return sub2;
          }
        };
        return sub;
      },
      generateAsync: function (opts) {
        genOpts = opts;
        return Promise.resolve(genResult);
      }
    };
  }
  return { JSZip: JSZip, files: files, getGenOpts: function () { return genOpts; }, genResult: genResult };
}

// ── 辅助：构造完整测试环境 ──────────────────────────────────────────────
/**
 * 构造完整的 mock 环境，包括：
 * - fake localStorage（含进度/书签/滚动/设备名）
 * - fake forage stores（importStore / zlStore / pdfStore）
 * - mock BKShelf / BKBookmark / BKStorage / BK.Export
 */
function setupMockEnv(opts) {
  opts = opts || {};

  // ── localStorage ──────────────────────────────────────
  var lsData = {};
  // 设备名
  lsData['bk_device_name'] = opts.deviceName || '测试设备-001';
  // 阅读进度
  (opts.progress || []).forEach(function (p) {
    lsData['bk_progress:' + p.bookId] = p.value;
    lsData['bk_lastread_ts:' + p.bookId] = p.ts || '1700000000000';
  });
  // 章节已读
  (opts.chapterReads || []).forEach(function (cr) {
    lsData['bk_chapter_read:' + cr.bookId + '/' + cr.chNum] = '1';
  });
  // 滚动位置
  (opts.scroll || []).forEach(function (s) {
    lsData['bk_scroll:' + s.bookId + '/' + s.chNum] = s.value;
  });

  // 替换 window.localStorage
  var ls = {
    _data: lsData,
    getItem: function (k) { return lsData.hasOwnProperty(k) ? lsData[k] : null; },
    setItem: function (k, v) { lsData[k] = String(v); },
    removeItem: function (k) { delete lsData[k]; },
    key: function (i) { var keys = Object.keys(lsData); return keys[i] || null; },
    get length() { return Object.keys(lsData).length; }
  };
  try { Object.defineProperty(win, 'localStorage', { value: ls, configurable: true }); } catch (e) { win.localStorage = ls; }

  // ── forage stores ─────────────────────────────────────
  var importStore = makeFakeStore(opts.importStoreData || {});
  var zlStore = makeFakeStore(opts.zlStoreData || {});
  var pdfStore = makeFakeStore(opts.pdfStoreData || {});

  // ── mock BKShelf ──────────────────────────────────────
  win.BKShelf = {
    all: function () { return opts.shelf || []; }
  };

  // ── mock BKBookmark（EPUB 书签，IndexedDB）─────────────
  win.BKBookmark = {
    getAll: function () { return Promise.resolve(opts.epubBookmarks || []); }
  };

  // ── mock BKStorage（高亮，IndexedDB）────────────────────
  win.BKStorage = {
    getAllPages: function () { return Promise.resolve(opts.highlights || []); }
  };

  // ── mock BK.Export（exportBinary）──────────────────────
  var exportedFiles = [];
  win.BK = win.BK || {};
  win.BK.Export = win.BK.Export || {};
  win.BK.Export.exportBinary = function (bytes, filename, mime, options) {
    exportedFiles.push({ bytes: bytes, filename: filename, mime: mime, options: options });
    return Promise.resolve({ method: 'test', saved: true });
  };

  return { importStore: importStore, zlStore: zlStore, pdfStore: pdfStore, exportedFiles: exportedFiles };
}

// ── 辅助：构造普通 TXT 书数据 ───────────────────────────────────────────
function makeTxtBook(id, title) {
  return {
    id: id,
    title: title || '测试书',
    author: '佚名',
    format: 'txt',
    chapters: [{ title: '第一章', content: '这是正文内容。' }]
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

// ── 辅助：构造 EPUB 书数据 ───────────────────────────────────────────────
function makeEpubBook(id, title) {
  return {
    id: id,
    title: title || 'EPUB测试书',
    author: '作者',
    format: 'epub',
    chapters: [{ title: '第一章', content: [{ type: 'paragraph', text: '段落' }] }]
  };
}

// ════════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════════

describe('generateZipBytes("data") — data 模式', () => {
  test('zip 文件清单 = manifest.json + shelf.json + books/<id>/{book.json, userdata.json}，不含 original.pdf/book.ext', async () => {
    var bookId = 'imported-123-abc';
    var book = makeTxtBook(bookId, '数据模式测试书');
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId, title: '数据模式测试书' }],
      progress: [{ bookId: bookId, value: '0.5' }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    // 预期清单
    assert.ok(names.indexOf('manifest.json') !== -1, '必须有 manifest.json');
    assert.ok(names.indexOf('shelf.json') !== -1, '必须有 shelf.json');
    assert.ok(names.indexOf('books/' + bookId + '/book.json') !== -1, '必须有 book.json');
    assert.ok(names.indexOf('books/' + bookId + '/userdata.json') !== -1, '必须有 userdata.json');
    // data 模式不应含 original.pdf 或 book.ext
    assert.ok(names.indexOf('books/' + bookId + '/original.pdf') === -1, 'data 模式不应含 original.pdf');
    assert.ok(!names.some(function (n) { return /book\.(txt|md|epub)$/.test(n); }), 'data 模式不应含 book.<ext>');
  });

  test('shelf.json 内容 = BKShelf.all() 原样数组', async () => {
    var bookId = 'imported-1';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;
    var shelf = [
      { id: bookId, title: '书A', addedAt: 1700000000000 },
      { id: 'other-book', title: '书B', addedAt: 1700000000001 }
    ];

    var env = setupMockEnv({
      shelf: shelf,
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var shelfData = JSON.parse(fk.files['shelf.json']);
    assert.deepEqual(shelfData, shelf);
  });

  test('data 模式也输出 book.json（v4 与 v3 的关键差异）', async () => {
    var bookId = 'imported-2';
    var book = makeTxtBook(bookId, '含元数据');
    book.author = '张三';
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var bookJson = JSON.parse(fk.files['books/' + bookId + '/book.json']);
    assert.equal(bookJson.id, bookId);
    assert.equal(bookJson.title, '含元数据');
    assert.equal(bookJson.author, '张三');
  });

  test('userdata.json 含 schema、progress、bookmarks、highlights、scroll', async () => {
    var bookId = 'imported-3';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      progress: [{ bookId: bookId, value: '0.75', ts: '1700000001000' }],
      chapterReads: [{ bookId: bookId, chNum: '1' }],
      scroll: [{ bookId: bookId, chNum: '1', value: '300' }],
      epubBookmarks: [{ bookId: bookId, cfi: 'epub-cfi-1' }],
      highlights: [{ key: '/' + bookId + '/1', text: '高亮文本' }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var ud = JSON.parse(fk.files['books/' + bookId + '/userdata.json']);
    assert.ok(ud.schema !== undefined, 'userdata 必须有 schema 字段');
    assert.equal(ud.progress, '0.75');
    assert.equal(ud.lastReadTs, '1700000001000');
    assert.ok(Array.isArray(ud.chapterReads) && ud.chapterReads.indexOf('1') !== -1);
    assert.ok(ud.scroll && ud.scroll['1'] === '300');
    assert.ok(Array.isArray(ud.bookmarks) && ud.bookmarks.length === 1);
    assert.ok(Array.isArray(ud.highlights) && ud.highlights.length === 1);
  });
});

describe('generateZipBytes("full") — full 模式', () => {
  test('PDF 书 full 模式含 original.pdf', async () => {
    var bookId = 'imported-pdf-1';
    var book = makePdfBook(bookId, 'PDF 完整导出');
    var pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      progress: [{ bookId: bookId, value: '0.3' }],
      importStoreData: { ['imported_book:' + bookId]: book },
      pdfStoreData: { ['pdf:' + bookId]: pdfBytes }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + bookId + '/original.pdf') !== -1, 'full 模式 PDF 书必须有 original.pdf');
    // original.pdf 应为 PDF 二进制
    var stored = fk.files['books/' + bookId + '/original.pdf'];
    assert.ok(stored, 'original.pdf 有内容');
  });

  test('TXT 书 full 模式含 book.txt', async () => {
    var bookId = 'imported-txt-1';
    var book = makeTxtBook(bookId, 'TXT 完整导出');
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + bookId + '/book.txt') !== -1, 'full 模式 TXT 书必须有 book.txt');
  });

  test('MD 书 full 模式含 book.md', async () => {
    var bookId = 'imported-md-1';
    var book = makeTxtBook(bookId, 'MD 完整导出');
    book.format = 'md';
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + bookId + '/book.md') !== -1, 'full 模式 MD 书必须有 book.md');
  });

  test('EPUB 书 full 模式含 book.epub', async () => {
    var bookId = 'imported-epub-1';
    var book = makeEpubBook(bookId, 'EPUB 完整导出');
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + bookId + '/book.epub') !== -1, 'full 模式 EPUB 书必须有 book.epub');
  });

  test('full 模式仍包含 manifest + shelf + book.json + userdata', async () => {
    var bookId = 'imported-full-1';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('manifest.json') !== -1);
    assert.ok(names.indexOf('shelf.json') !== -1);
    assert.ok(names.indexOf('books/' + bookId + '/book.json') !== -1);
    assert.ok(names.indexOf('books/' + bookId + '/userdata.json') !== -1);
  });

  test('多书混合：TXT + PDF + EPUB 全量文件清单', async () => {
    var txtId = 'imported-mix-txt';
    var pdfId = 'imported-mix-pdf';
    var epubId = 'imported-mix-epub';
    var txtBook = makeTxtBook(txtId, '混合TXT');
    var pdfBook = makePdfBook(pdfId, '混合PDF');
    var epubBook = makeEpubBook(epubId, '混合EPUB');
    var pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [
        { id: txtId }, { id: pdfId }, { id: epubId }
      ],
      importStoreData: {
        ['imported_book:' + txtId]: txtBook,
        ['imported_book:' + pdfId]: pdfBook,
        ['imported_book:' + epubId]: epubBook
      },
      pdfStoreData: { ['pdf:' + pdfId]: pdfBytes }
    });

    await SC.generateZipBytes('full', {
      bookIds: [txtId, pdfId, epubId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    // 每本书都有 book.json + userdata.json
    [txtId, pdfId, epubId].forEach(function (id) {
      assert.ok(names.indexOf('books/' + id + '/book.json') !== -1, id + ' 应有 book.json');
      assert.ok(names.indexOf('books/' + id + '/userdata.json') !== -1, id + ' 应有 userdata.json');
    });
    // TXT → book.txt, PDF → original.pdf, EPUB → book.epub
    assert.ok(names.indexOf('books/' + txtId + '/book.txt') !== -1);
    assert.ok(names.indexOf('books/' + pdfId + '/original.pdf') !== -1);
    assert.ok(names.indexOf('books/' + epubId + '/book.epub') !== -1);
  });
});

describe('manifest 断言', () => {
  test('version === 4', async () => {
    var bookId = 'imported-mf-1';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.version, 4);
  });

  test('mode = "data" 时 manifest.mode === "data"', async () => {
    var bookId = 'imported-mf-2';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.mode, 'data');
  });

  test('mode = "full" 时 manifest.mode === "full"', async () => {
    var bookId = 'imported-mf-3';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.mode, 'full');
  });

  test('exportedAt 为 ISO 字符串', async () => {
    var bookId = 'imported-mf-4';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.ok(typeof manifest.exportedAt === 'string');
    assert.match(manifest.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('deviceName 取 localStorage bk_device_name', async () => {
    var bookId = 'imported-mf-5';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      deviceName: '我的iPad-Pro',
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.deviceName, '我的iPad-Pro');
  });

  test('deviceName 缺失时有合理回退', async () => {
    var bookId = 'imported-mf-6';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });
    // 删除设备名
    win.localStorage.removeItem('bk_device_name');

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.ok(manifest.deviceName, 'deviceName 应有回退值');
    assert.ok(typeof manifest.deviceName === 'string');
  });
});

describe('书城书（zl-data 来源）导出', () => {
  test('full 模式：书城书也导出原件（book.json + book.ext 或 original.pdf）', async () => {
    var cityBookId = 'books-2-2082'; // 非 imported- 前缀
    var cityBook = makeTxtBook(cityBookId, '书城TXT书');
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: cityBookId, title: '书城TXT书' }],
      zlStoreData: { ['zl_book:' + cityBookId]: cityBook }
    });

    await SC.generateZipBytes('full', {
      bookIds: [cityBookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + cityBookId + '/book.json') !== -1, '书城书 full 应有 book.json');
    assert.ok(names.indexOf('books/' + cityBookId + '/book.txt') !== -1, '书城书 full 应有 book.txt');
  });

  test('data 模式：书城书只导 userdata（不含 book.ext/original.pdf）', async () => {
    var cityBookId = 'books-3-1001';
    var cityBook = makeEpubBook(cityBookId, '书城EPUB');
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: cityBookId }],
      progress: [{ bookId: cityBookId, value: '0.4' }],
      zlStoreData: { ['zl_book:' + cityBookId]: cityBook }
    });

    await SC.generateZipBytes('data', {
      bookIds: [cityBookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + cityBookId + '/userdata.json') !== -1, '书城书 data 应有 userdata.json');
    assert.ok(names.indexOf('books/' + cityBookId + '/book.epub') === -1, '书城书 data 不应含 book.epub');
  });

  test('书城 PDF 书 full 模式含 original.pdf', async () => {
    var cityPdfId = 'books-5-999';
    var cityPdfBook = makePdfBook(cityPdfId, '书城PDF');
    var pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: cityPdfId }],
      zlStoreData: { ['zl_book:' + cityPdfId]: cityPdfBook },
      pdfStoreData: { ['pdf:' + cityPdfId]: pdfBytes }
    });

    await SC.generateZipBytes('full', {
      bookIds: [cityPdfId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var names = Object.keys(fk.files).sort();
    assert.ok(names.indexOf('books/' + cityPdfId + '/original.pdf') !== -1, '书城 PDF full 应有 original.pdf');
  });
});

describe('generateZipBytes 返回值与参数校验', () => {
  test('返回 Uint8Array（透传 generateAsync 结果）', async () => {
    var bookId = 'imported-rv-1';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    var result = await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    assert.ok(result instanceof Uint8Array);
    assert.equal(result, fk.genResult, '应透传 generateAsync 返回值');
  });

  test('generateAsync 参数：type=uint8array + compression=DEFLATE', async () => {
    var bookId = 'imported-rv-2';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var opts = fk.getGenOpts();
    assert.equal(opts.type, 'uint8array');
    assert.equal(opts.compression, 'DEFLATE');
  });

  test('默认 mode 为 data（不传 mode 参数）', async () => {
    var bookId = 'imported-rv-3';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    // 不传 mode，应默认 data
    await SC.generateZipBytes(undefined, {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.mode, 'data');
  });

  test('非法 mode 报错', async () => {
    await assert.rejects(
      function () {
        return SC.generateZipBytes('invalid', { bookIds: ['x'] });
      },
      /无效|mode/i
    );
  });

  test('JSZip 未加载时 reject', async () => {
    var saved = win.JSZip;
    delete win.JSZip;
    try {
      await assert.rejects(
        function () { return SC.generateZipBytes('data', { bookIds: ['x'] }); },
        /JSZip/
      );
    } finally {
      win.JSZip = saved;
    }
  });
});

describe('exportData(mode) — 生成字节 + exportBinary 写出', () => {
  test('exportData("data") 调用 BK.Export.exportBinary 写出', async () => {
    var bookId = 'imported-ed-1';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.exportData('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    assert.equal(env.exportedFiles.length, 1, '应调用 exportBinary 一次');
    var ef = env.exportedFiles[0];
    assert.ok(ef.filename.indexOf('bk-book-') === 0, '文件名应以 bk-book- 开头');
    assert.ok(ef.filename.indexOf('.zip') !== -1, '文件名应以 .zip 结尾');
    assert.equal(ef.mime, 'application/zip');
    assert.equal(ef.bytes, fk.genResult, '写出字节 = generateAsync 返回值');
    assert.ok(ef.options && ef.options.chooseDestination, '应有 chooseDestination');
  });

  test('文件名格式 bk-book-<YYYY-MM-DD>.zip', async () => {
    var bookId = 'imported-ed-2';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.exportData('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var filename = env.exportedFiles[0].filename;
    assert.match(filename, /^bk-book-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  test('exportData("full") 写出且 mode 正确', async () => {
    var bookId = 'imported-ed-3';
    var book = makeTxtBook(bookId);
    var fk = makeFakeJSZip();
    win.JSZip = fk.JSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    await SC.exportData('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    assert.equal(env.exportedFiles.length, 1);
    // 内部 manifest mode 应为 full
    var manifest = JSON.parse(fk.files['manifest.json']);
    assert.equal(manifest.mode, 'full');
  });
});

describe('真 JSZip 冒烟测试', () => {
  test('generateZipBytes 返回合法 zip 字节流（PK 魔数 + 可解包验证）', async () => {
    var RealJSZip = require('jszip');
    var bookId = 'imported-smoke-1';
    var book = makeTxtBook(bookId, '冒烟测试书');
    win.JSZip = RealJSZip;

    var env = setupMockEnv({
      deviceName: '冒烟设备',
      shelf: [{ id: bookId, title: '冒烟测试书' }],
      progress: [{ bookId: bookId, value: '0.5', ts: '1700000000000' }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    var bytes = await SC.generateZipBytes('data', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    // PK 魔数
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);
    assert.equal(bytes[0], 0x50, '首字节 P');
    assert.equal(bytes[1], 0x4B, '次字节 K');

    // 解包验证
    var zip = await RealJSZip.loadAsync(bytes);
    var fileList = Object.keys(zip.files).sort();
    assert.ok(fileList.indexOf('manifest.json') !== -1, '解包后含 manifest.json');
    assert.ok(fileList.indexOf('shelf.json') !== -1, '解包后含 shelf.json');
    assert.ok(fileList.indexOf('books/' + bookId + '/book.json') !== -1, '解包后含 book.json');
    assert.ok(fileList.indexOf('books/' + bookId + '/userdata.json') !== -1, '解包后含 userdata.json');

    // manifest 内容验证
    var manifestStr = await zip.file('manifest.json').async('string');
    var manifest = JSON.parse(manifestStr);
    assert.equal(manifest.version, 4);
    assert.equal(manifest.mode, 'data');
    assert.equal(manifest.deviceName, '冒烟设备');

    // book.json 内容验证
    var bookJsonStr = await zip.file('books/' + bookId + '/book.json').async('string');
    var bookJson = JSON.parse(bookJsonStr);
    assert.equal(bookJson.title, '冒烟测试书');

    // shelf.json 内容验证
    var shelfStr = await zip.file('shelf.json').async('string');
    var shelfData = JSON.parse(shelfStr);
    assert.equal(shelfData.length, 1);
    assert.equal(shelfData[0].id, bookId);
  });

  test('full 模式真 JSZip 冒烟：含 book.txt', async () => {
    var RealJSZip = require('jszip');
    var bookId = 'imported-smoke-2';
    var book = makeTxtBook(bookId, 'Full冒烟');
    win.JSZip = RealJSZip;

    var env = setupMockEnv({
      shelf: [{ id: bookId }],
      importStoreData: { ['imported_book:' + bookId]: book }
    });

    var bytes = await SC.generateZipBytes('full', {
      bookIds: [bookId],
      importStore: env.importStore,
      zlStore: env.zlStore,
      pdfStore: env.pdfStore
    });

    var zip = await RealJSZip.loadAsync(bytes);
    var fileList = Object.keys(zip.files).sort();
    assert.ok(fileList.indexOf('books/' + bookId + '/book.txt') !== -1, 'full 冒烟应含 book.txt');

    var manifestStr = await zip.file('manifest.json').async('string');
    var manifest = JSON.parse(manifestStr);
    assert.equal(manifest.mode, 'full');
  });
});

