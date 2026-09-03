'use strict';
/**
 * export-core Share URI 规范化单元测试（node:test + JSDOM）
 *
 * 背景 BUG：Android 真机导出 full 包报「only file urls are supported」。
 * SaveFile.finishCacheWrite 返回 content:// URI（FileProvider），而 Capacitor
 * Share 插件原生端 shareFiles() 只接受 file:// 前缀，直接 reject。
 *
 * 被测目标：src/static/js/export/export-core.js
 *   - _uriToFileUrl(uri, fallbackPath)  URI → Share 可用的 file://
 *   - _exportNativeShareChunked         分块写缓存后分享时 files 必须是 file://
 *   - _exportNativeShare                小文件 Filesystem.getUri 后分享时 files 必须是 file://
 *
 * 测试策略：mock win.Capacitor（SaveFile / Filesystem / Share），
 * 断言 Share.share 收到的 files 数组元素均为 file:// 前缀。
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
global.btoa = function (s) { return Buffer.from(s, 'binary').toString('base64'); };
global.TextEncoder = TextEncoder || global.TextEncoder;

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'export', 'export-core.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const EXPORT = win.BK.Export;
assert.ok(EXPORT, 'export-core.js 必须暴露 win.BK.Export');

// ── mock 工具 ───────────────────────────────────────────────────────────

/**
 * 构造 Capacitor mock
 * @param {Object} cfg
 *   cacheUri:  finishCacheWrite 返回的 uri（如 content://...）
 *   cachePath: finishCacheWrite 返回的 path（如 /data/user/0/.../cache/bk-export/x.zip）
 *   getUriResult: Filesystem.getUri 返回值（如 { uri: 'content://...' } 或 { uri: 'file://...' }）
 */
function mockCapacitor(cfg) {
  cfg = cfg || {};
  var shared = [];
  var shareCalls = [];

  function makePlugin(methods) {
    var plugin = {};
    Object.keys(methods).forEach(function (name) {
      plugin[name] = function (args) {
        var r = methods[name](args);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      };
    });
    return plugin;
  }

  var SaveFile = makePlugin({
    startCacheWrite: function () { return { started: true, sessionId: 's1' }; },
    writeCacheChunk: function () { return {}; },
    finishCacheWrite: function () {
      return { uri: cfg.cacheUri || '', path: cfg.cachePath || '' };
    }
  });

  var Filesystem = makePlugin({
    writeFile: function () { return {}; },
    getUri: function () { return cfg.getUriResult || { uri: '' }; }
  });

  var Share = makePlugin({
    canShare: function () { return { value: true }; },
    share: function (args) {
      shareCalls.push(args);
      if (cfg.shareError) return cfg.shareError;
      return {};
    }
  });

  global.win.Capacitor = {
    isNativePlatform: function () { return true; },
    Plugins: { SaveFile: SaveFile, Filesystem: Filesystem, Share: Share }
  };

  return {
    shareCalls: function () { return shareCalls; }
  };
}

// 清理 mock，避免污染其他用例
function resetCapacitor() {
  delete global.win.Capacitor;
}

// ── _uriToFileUrl 纯函数 ────────────────────────────────────────────────

describe('_uriToFileUrl URI 规范化', () => {
  test('file:// 前缀：原样返回', () => {
    assert.equal(EXPORT._uriToFileUrl('file:///data/user/0/x.zip', '/data/user/0/x.zip'),
      'file:///data/user/0/x.zip');
  });

  test('content:// + 有 path：转换为 file:// + path', () => {
    assert.equal(
      EXPORT._uriToFileUrl('content://com.books.app.fileprovider/cache/bk-export/x.zip',
        '/data/user/0/com.books.app/cache/bk-export/x.zip'),
      'file:///data/user/0/com.books.app/cache/bk-export/x.zip');
  });

  test('content:// 无 path：返回 null（调用方降级 cache-only）', () => {
    assert.equal(EXPORT._uriToFileUrl('content://com.books.app.fileprovider/cache/x.zip', ''), null);
    assert.equal(EXPORT._uriToFileUrl('content://com.books.app.fileprovider/cache/x.zip', null), null);
    assert.equal(EXPORT._uriToFileUrl('content://com.books.app.fileprovider/cache/x.zip', undefined), null);
  });

  test('空 URI 有 path：直接构造 file:// + path', () => {
    assert.equal(EXPORT._uriToFileUrl('', '/data/local/tmp/a.zip'),
      'file:///data/local/tmp/a.zip');
  });

  test('空 URI 无 path：返回 null', () => {
    assert.equal(EXPORT._uriToFileUrl('', ''), null);
    assert.equal(EXPORT._uriToFileUrl(null, null), null);
    assert.equal(EXPORT._uriToFileUrl(undefined, undefined), null);
  });

  test('未知 scheme（如 https://）：有 path 时仍转换为 file://', () => {
    // SaveFile 只可能返回 content:// 或 file://，但防御性处理：
    // 有 path 就以 path 为准（Share 原生端只认 file://）
    assert.equal(EXPORT._uriToFileUrl('https://example.com/a.zip', '/sdcard/a.zip'),
      'file:///sdcard/a.zip');
  });
});

// ── _exportNativeShareChunked：大文件分块写缓存 + Share ─────────────────

describe('_exportNativeShareChunked 分块分享（真实 BUG 场景）', () => {
  test('finishCacheWrite 返回 content:// 时，Share 收到的必须是 file://', async () => {
    var m = mockCapacitor({
      cacheUri: 'content://com.books.app.fileprovider/cache/bk-export/books-full.zip',
      cachePath: '/data/user/0/com.books.app/cache/bk-export/books-full.zip'
    });
    try {
      // base64 长度须 > CHUNKED_THRESHOLD(512KB) 才走 chunked —— 但该函数可直接调用，绕过阈值
      var base64 = Buffer.from('x'.repeat(1000)).toString('base64');
      var result = await EXPORT._exportNativeShareChunked(base64, 'books-full.zip', 'application/zip');
      assert.ok(result.shared, '应分享成功');
      var calls = m.shareCalls();
      assert.equal(calls.length, 1, 'Share.share 恰好调用一次');
      assert.ok(Array.isArray(calls[0].files), 'files 是数组');
      assert.equal(calls[0].files.length, 1);
      assert.ok(calls[0].files[0].indexOf('file://') === 0,
        'files[0] 必须是 file:// 前缀，实际=' + calls[0].files[0]);
      assert.equal(calls[0].files[0], 'file:///data/user/0/com.books.app/cache/bk-export/books-full.zip');
    } finally {
      resetCapacitor();
    }
  });

  test('finishCacheWrite 返回 file:// 时：原样传递，不重复加前缀', async () => {
    var m = mockCapacitor({
      cacheUri: 'file:///data/user/0/com.books.app/cache/bk-export/b.zip',
      cachePath: '/data/user/0/com.books.app/cache/bk-export/b.zip'
    });
    try {
      var base64 = Buffer.from('y'.repeat(500)).toString('base64');
      var result = await EXPORT._exportNativeShareChunked(base64, 'b.zip', 'application/zip');
      assert.ok(result.shared);
      var calls = m.shareCalls();
      assert.equal(calls[0].files[0], 'file:///data/user/0/com.books.app/cache/bk-export/b.zip');
    } finally {
      resetCapacitor();
    }
  });

  test('content:// 且无 path：降级 cache-only，不调 Share', async () => {
    var m = mockCapacitor({
      cacheUri: 'content://com.books.app.fileprovider/cache/no-path.zip',
      cachePath: ''
    });
    try {
      var base64 = Buffer.from('z'.repeat(100)).toString('base64');
      var result = await EXPORT._exportNativeShareChunked(base64, 'no-path.zip', 'application/zip');
      assert.equal(result.method, 'cache-only', '应降级 cache-only');
      assert.equal(result.shared, false);
      assert.equal(m.shareCalls().length, 0, '不应调用 Share.share');
    } finally {
      resetCapacitor();
    }
  });
});

// ── _exportNativeShare：小文件 Filesystem + Share ───────────────────────

describe('_exportNativeShare 小文件分享', () => {
  test('getUri 返回 file://：原样传递', async () => {
    var m = mockCapacitor({
      getUriResult: { uri: 'file:///data/user/0/com.books.app/cache/bk-export/small.zip' }
    });
    try {
      var base64 = Buffer.from('a'.repeat(100)).toString('base64');
      var result = await EXPORT._exportNativeShare(base64, 'small.zip', 'application/zip');
      assert.ok(result.shared);
      var calls = m.shareCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].files[0], 'file:///data/user/0/com.books.app/cache/bk-export/small.zip');
    } finally {
      resetCapacitor();
    }
  });

  test('getUri 返回 content://：无法转换（无 path）时降级 cache-only', async () => {
    var m = mockCapacitor({
      getUriResult: { uri: 'content://com.books.app.fileprovider/cache/bk-export/s2.zip' }
    });
    try {
      var base64 = Buffer.from('b'.repeat(100)).toString('base64');
      var result = await EXPORT._exportNativeShare(base64, 's2.zip', 'application/zip');
      assert.equal(result.method, 'cache-only', '应降级 cache-only');
      assert.equal(result.shared, false);
      assert.equal(m.shareCalls().length, 0, '不应调用 Share.share');
    } finally {
      resetCapacitor();
    }
  });
});
