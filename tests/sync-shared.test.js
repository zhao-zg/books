'use strict';
/**
 * sync-shared 共享工具单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-shared.js
 *   - isCityBookId(id)         书城书 ID 前缀/格式判定（纯函数）
 *   - resolveCityBook(idx, id) 防误判二次校验（索引未就绪不误判）
 *   - isPdfBookData(data)      PDF 书数据判定（纯函数）
 *   - generateBookId()         生成 imported-<ts>-<rand> 格式 ID
 *   - getBookData(bookId, deps) 从三 store 路由读取（依赖注入 fake forage）
 *
 * 加载方式：与 lazy-renderer.test.js 同构的 JSDOM + vm.runInThisContext
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

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-shared.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const SS = win.BK.SyncShared;
assert.ok(SS, 'sync-shared.js 必须暴露 win.BK.SyncShared');

// ── 辅助：构造 fake forage store ────────────────────────────────────────
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

// ── 测试 ────────────────────────────────────────────────────────────────

describe('isCityBookId 纯前缀判定', () => {
  test('imported- 前缀 ID 返回 false', () => {
    assert.equal(SS.isCityBookId('imported-1234567890-abcde'), false);
    assert.equal(SS.isCityBookId('imported-1'), false);
  });
  test('空/null/undefined 返回 false', () => {
    assert.equal(SS.isCityBookId(''), false);
    assert.equal(SS.isCityBookId(null), false);
    assert.equal(SS.isCityBookId(undefined), false);
  });
  test('非 imported- 前缀的 ID 返回 true（仅做前缀判定，不查索引）', () => {
    // isCityBookId 是「可能是书城书」的前缀筛选：
    // 非 imported- 前缀 → 可能是书城书，返回 true 交由 resolveCityBook 确认
    assert.equal(SS.isCityBookId('books-2-2082'), true);
    assert.equal(SS.isCityBookId('some-random-id'), true);
  });
});

describe('resolveCityBook 防误判二次校验', () => {
  test('索引未就绪（null/undefined/空 books）返回 false，不误判', () => {
    assert.equal(SS.resolveCityBook(null, 'books-2-2082'), false);
    assert.equal(SS.resolveCityBook(undefined, 'books-2-2082'), false);
    assert.equal(SS.resolveCityBook({}, 'books-2-2082'), false);
    assert.equal(SS.resolveCityBook({ books: [] }, 'books-2-2082'), false);
    assert.equal(SS.resolveCityBook({ books: null }, 'books-2-2082'), false);
  });

  test('索引存在且命中返回 true', () => {
    var idx = { books: [{ id: 'books-2-2082' }, { id: 'books-3-1001' }] };
    assert.equal(SS.resolveCityBook(idx, 'books-2-2082'), true);
    assert.equal(SS.resolveCityBook(idx, 'books-3-1001'), true);
  });

  test('索引存在但未命中返回 false', () => {
    var idx = { books: [{ id: 'books-2-2082' }] };
    assert.equal(SS.resolveCityBook(idx, 'books-3-1001'), false);
    assert.equal(SS.resolveCityBook(idx, 'nonexistent'), false);
  });

  test('imported- 前缀的 ID 直接返回 false（不走索引查找）', () => {
    var idx = { books: [{ id: 'imported-123-abc' }] };
    assert.equal(SS.resolveCityBook(idx, 'imported-123-abc'), false);
  });

  test('空/无效 bookId 返回 false', () => {
    var idx = { books: [{ id: 'books-1-1' }] };
    assert.equal(SS.resolveCityBook(idx, ''), false);
    assert.equal(SS.resolveCityBook(idx, null), false);
    assert.equal(SS.resolveCityBook(idx, undefined), false);
  });
});

describe('isPdfBookData PDF 数据判定', () => {
  test('format === "pdf" 返回 true', () => {
    assert.equal(SS.isPdfBookData({ format: 'pdf' }), true);
    assert.equal(SS.isPdfBookData({ format: 'pdf', chapters: [] }), true);
  });

  test('chapters 内含 pdf_page 类型返回 true', () => {
    var data = {
      chapters: [{
        content: [{ type: 'pdf_page', pageNumber: 1, pdfBookId: 'x' }]
      }]
    };
    assert.equal(SS.isPdfBookData(data), true);
  });

  test('chapters 内多类型混合时含 pdf_page 返回 true', () => {
    var data = {
      chapters: [{
        content: [
          { type: 'paragraph', text: 'hello' },
          { type: 'pdf_page', pageNumber: 2 },
          { type: 'heading', text: '标题' }
        ]
      }]
    };
    assert.equal(SS.isPdfBookData(data), true);
  });

  test('普通 EPUB/TXT 数据返回 false', () => {
    assert.equal(SS.isPdfBookData({
      chapters: [{ content: [{ type: 'paragraph', text: 'text' }] }]
    }), false);
    assert.equal(SS.isPdfBookData({
      format: 'epub',
      chapters: [{ content: 'plain text' }]
    }), false);
  });

  test('空/null/undefined 返回 false', () => {
    assert.equal(SS.isPdfBookData(null), false);
    assert.equal(SS.isPdfBookData(undefined), false);
    assert.equal(SS.isPdfBookData({}), false);
    assert.equal(SS.isPdfBookData({ chapters: [] }), false);
  });

  test('chapters 无 content 或 content 非 Array 不崩溃', () => {
    assert.equal(SS.isPdfBookData({ chapters: [{ title: 'no content' }] }), false);
    assert.equal(SS.isPdfBookData({ chapters: [{ content: 'string' }] }), false);
  });
});

describe('generateBookId ID 格式', () => {
  test('生成以 imported- 开头', () => {
    var id = SS.generateBookId();
    assert.ok(id.indexOf('imported-') === 0, 'ID 应以 imported- 开头: ' + id);
  });

  test('格式为 imported-<timestamp>-<random>', () => {
    var id = SS.generateBookId();
    // imported-<digits>-<base36>
    assert.match(id, /^imported-\d+-[0-9a-z]+$/);
  });

  test('连续调用生成不同 ID', () => {
    var ids = new Set();
    for (var i = 0; i < 100; i++) {
      ids.add(SS.generateBookId());
    }
    assert.equal(ids.size, 100, '100 次调用应生成 100 个不同 ID');
  });
});

describe('getBookData 三 store 路由读取', () => {
  test('imported- 前缀的书从 imported-data store 读取', async () => {
    var importedData = makeFakeStore({
      'imported_book:imported-123-abc': { id: 'imported-123-abc', title: '导入书' }
    });
    var deps = {
      importStore: importedData,
      pdfStore: makeFakeStore(),
      zlStore: makeFakeStore()
    };
    var result = await SS.getBookData('imported-123-abc', deps);
    assert.deepEqual(result, { id: 'imported-123-abc', title: '导入书' });
  });

  test('非 imported- 前缀的书从 zl-data store 读取', async () => {
    var zlData = makeFakeStore({
      'zl_book:books-2-2082': { id: 'books-2-2082', title: '书城书' }
    });
    var deps = {
      importStore: makeFakeStore(),
      pdfStore: makeFakeStore(),
      zlStore: zlData
    };
    var result = await SS.getBookData('books-2-2082', deps);
    assert.deepEqual(result, { id: 'books-2-2082', title: '书城书' });
  });

  test('imported- 前缀但 imported-data 未命中时降级到 zl-data', async () => {
    var zlData = makeFakeStore({
      'zl_book:imported-123-abc': { id: 'imported-123-abc', title: '缓存的书城导入书' }
    });
    var deps = {
      importStore: makeFakeStore(),
      pdfStore: makeFakeStore(),
      zlStore: zlData
    };
    var result = await SS.getBookData('imported-123-abc', deps);
    assert.deepEqual(result, { id: 'imported-123-abc', title: '缓存的书城导入书' });
  });

  test('三 store 都未命中返回 null', async () => {
    var deps = {
      importStore: makeFakeStore(),
      pdfStore: makeFakeStore(),
      zlStore: makeFakeStore()
    };
    var result = await SS.getBookData('nonexistent', deps);
    assert.equal(result, null);
  });

  test('空 bookId 返回 null', async () => {
    var deps = {
      importStore: makeFakeStore(),
      pdfStore: makeFakeStore(),
      zlStore: makeFakeStore()
    };
    assert.equal(await SS.getBookData('', deps), null);
    assert.equal(await SS.getBookData(null, deps), null);
    assert.equal(await SS.getBookData(undefined, deps), null);
  });

  test('deps 缺失 store 时不崩溃，返回 null', async () => {
    var result = await SS.getBookData('any-id', {});
    assert.equal(result, null);
  });
});

describe('resolveSharedDeps store 依赖构造（收编 _syncSharedDeps）', () => {
  test('ImportManager/DataManager 可用时注入两个 store', () => {
    var fakeImportStore = { marker: 'import' };
    var fakeZlStore = { marker: 'zl' };
    var fakeWin = {
      ImportManager: { getImportStore: () => fakeImportStore },
      DataManager: { getZlStore: () => fakeZlStore }
    };
    var deps = SS.resolveSharedDeps(fakeWin);
    assert.equal(deps.importStore, fakeImportStore);
    assert.equal(deps.zlStore, fakeZlStore);
  });

  test('管理器缺失时跳过对应依赖', () => {
    var fakeWin = {
      ImportManager: { getImportStore: () => ({}) }
      // DataManager 缺失
    };
    var deps = SS.resolveSharedDeps(fakeWin);
    assert.ok(deps.importStore, 'importStore 应存在');
    assert.equal(deps.zlStore, undefined, 'zlStore 应缺失');
  });

  test('getImportStore 抛异常时吞错降级', () => {
    var fakeWin = {
      ImportManager: { getImportStore: () => { throw new Error('store 未初始化'); } },
      DataManager: { getZlStore: () => ({}) }
    };
    var deps = SS.resolveSharedDeps(fakeWin);
    assert.equal(deps.importStore, undefined);
    assert.ok(deps.zlStore, 'zlStore 不受影响');
  });

  test('getZlStore 抛异常时吞错降级', () => {
    var fakeWin = {
      ImportManager: { getImportStore: () => ({}) },
      DataManager: { getZlStore: () => { throw new Error('store 未初始化'); } }
    };
    var deps = SS.resolveSharedDeps(fakeWin);
    assert.ok(deps.importStore, 'importStore 不受影响');
    assert.equal(deps.zlStore, undefined);
  });

  test('不传 win 时默认用全局 win（真实调用形态）', () => {
    // 保存原值，测试后恢复
    var savedIM = win.ImportManager;
    var savedDM = win.DataManager;
    var fakeImportStore = { marker: 'import' };
    var fakeZlStore = { marker: 'zl' };
    win.ImportManager = { getImportStore: () => fakeImportStore };
    win.DataManager = { getZlStore: () => fakeZlStore };
    try {
      var deps = SS.resolveSharedDeps();
      assert.equal(deps.importStore, fakeImportStore);
      assert.equal(deps.zlStore, fakeZlStore);
    } finally {
      win.ImportManager = savedIM;
      win.DataManager = savedDM;
    }
  });

  test('两个管理器都缺失时返回空对象', () => {
    var deps = SS.resolveSharedDeps({});
    assert.deepEqual(deps, {});
  });
});
