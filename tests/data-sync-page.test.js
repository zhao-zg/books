'use strict';
/**
 * data-sync-page 纯逻辑函数单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/data-sync-page.js 暴露的纯函数
 *   - formatImportResult(result)   导入结果 → 摘要文案
 *   - syncStateText(state)         WebDAV 同步状态 → 状态行文案
 *   - formatSyncTime(ts)           时间戳 → 可读时间（YYYY-MM-DD HH:mm）
 *   - formatSize(bytes)            字节数 → 可读大小
 *
 * 测试策略：只测纯函数，不碰 UI 渲染与网络。
 * 模块须能在 JSDOM mock 环境（无 WebDavManager / SyncCore 等依赖）下加载不报错。
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

// 不注入任何依赖（WebDavManager / SyncCore / SyncWebDAVTrigger / LanSyncPanel 均缺省）
// 模块加载必须容错（show() 前才真正用到它们）

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'data-sync-page.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const PAGE = win.BK.DataSyncPage;
assert.ok(PAGE, 'data-sync-page.js 必须暴露 win.BK.DataSyncPage');
assert.equal(typeof PAGE.show, 'function', '必须暴露 show()');

// ── 测试 ────────────────────────────────────────────────────────────────

describe('formatImportResult 导入结果摘要', () => {
  test('全成功：只显示成功数', () => {
    var s = PAGE.formatImportResult({ success: 3, skipped: 0, failed: 0, errors: [] });
    assert.equal(s, '成功导入 3 本');
  });

  test('成功 + 跳过：两段并列', () => {
    var s = PAGE.formatImportResult({ success: 2, skipped: 1, failed: 0, errors: [] });
    assert.equal(s, '成功导入 2 本，跳过 1 本');
  });

  test('成功 + 跳过 + 失败：三段并列', () => {
    var s = PAGE.formatImportResult({ success: 2, skipped: 1, failed: 1, errors: [{ id: 'b9', error: '损坏' }] });
    assert.equal(s, '成功导入 2 本，跳过 1 本，失败 1 本');
  });

  test('空结果 / null 安全：返回占位文案', () => {
    assert.equal(PAGE.formatImportResult(null), '导入完成');
    assert.equal(PAGE.formatImportResult({}), '导入完成');
    assert.equal(PAGE.formatImportResult(undefined), '导入完成');
  });

  test('全失败：显示失败段', () => {
    var s = PAGE.formatImportResult({ success: 0, skipped: 0, failed: 2, errors: [] });
    assert.equal(s, '失败 2 本');
  });
});

describe('formatImportErrors 失败明细', () => {
  test('返回前 5 条错误，每条格式「id: error」', () => {
    var errs = [];
    for (var i = 0; i < 7; i++) errs.push({ id: 'b' + i, error: 'e' + i });
    var lines = PAGE.formatImportErrors(errs);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], 'b0: e0');
    assert.equal(lines[4], 'b4: e4');
  });

  test('超过 5 条时附「等 N 项」提示行', () => {
    var errs = [];
    for (var i = 0; i < 7; i++) errs.push({ id: 'b' + i, error: 'e' + i });
    var lines = PAGE.formatImportErrors(errs, true);
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '…等 7 项失败');
  });

  test('无错误：返回空数组', () => {
    assert.deepEqual(PAGE.formatImportErrors([]), []);
    assert.deepEqual(PAGE.formatImportErrors(null), []);
    assert.deepEqual(PAGE.formatImportErrors(undefined), []);
  });

  test('条目缺 id / error 时容错', () => {
    var lines = PAGE.formatImportErrors([{ error: 'boom' }, { id: 'x' }]);
    assert.equal(lines[0], 'boom');
    assert.equal(lines[1], 'x: 未知错误');
  });
});

describe('syncStateText WebDAV 同步状态文案', () => {
  test('running：进行中文案', () => {
    var s = PAGE.syncStateText({ running: true });
    assert.ok(s.indexOf('同步中') >= 0);
  });

  test('未配置 WebDAV：提示文案', () => {
    var s = PAGE.syncStateText({ running: false, lastSyncTs: null, lastResult: null, lastError: null }, false);
    assert.ok(s.indexOf('未配置') >= 0 || s.indexOf('未连接') >= 0);
  });

  test('上次成功：显示拉取/推送计数与时间', () => {
    var ts = new Date(2026, 8, 1, 10, 30).getTime();
    var s = PAGE.syncStateText({ running: false, lastSyncTs: ts, lastResult: { pulled: 2, pushed: 1, errors: [] }, lastError: null }, true);
    assert.ok(s.indexOf('拉取 2') >= 0, '含拉取计数: ' + s);
    assert.ok(s.indexOf('推送 1') >= 0, '含推送计数: ' + s);
    assert.ok(s.indexOf('2026-09-01 10:30') >= 0, '含可读时间: ' + s);
  });

  test('上次失败：显示错误文案', () => {
    var ts = Date.now();
    var s = PAGE.syncStateText({ running: false, lastSyncTs: ts, lastResult: null, lastError: '网络不可达' }, true);
    assert.ok(s.indexOf('网络不可达') >= 0);
  });

  test('已配置但从未同步：待同步文案', () => {
    var s = PAGE.syncStateText({ running: false, lastSyncTs: null, lastResult: null, lastError: null }, true);
    assert.ok(s.indexOf('尚未同步') >= 0 || s.indexOf('未同步') >= 0);
  });

  test('null 状态安全：不抛异常', () => {
    assert.doesNotThrow(function () { PAGE.syncStateText(null, false); });
    assert.doesNotThrow(function () { PAGE.syncStateText(null, true); });
  });
});

describe('formatSyncTime 时间格式化', () => {
  test('格式为 YYYY-MM-DD HH:mm', () => {
    var d = new Date(2026, 8, 1, 9, 5);
    assert.equal(PAGE.formatSyncTime(d.getTime()), '2026-09-01 09:05');
  });

  test('跨年与一位数补零', () => {
    var d = new Date(2025, 0, 3, 23, 59);
    assert.equal(PAGE.formatSyncTime(d.getTime()), '2025-01-03 23:59');
  });

  test('无效输入返回空串', () => {
    assert.equal(PAGE.formatSyncTime(null), '');
    assert.equal(PAGE.formatSyncTime(undefined), '');
    assert.equal(PAGE.formatSyncTime(0), '');
    assert.equal(PAGE.formatSyncTime(NaN), '');
  });
});

describe('formatSize 大小格式化', () => {
  test('B / KB / MB 阶梯', () => {
    assert.equal(PAGE.formatSize(0), '0 B');
    assert.equal(PAGE.formatSize(512), '512 B');
    assert.equal(PAGE.formatSize(2048), '2.0 KB');
    assert.equal(PAGE.formatSize(3 * 1024 * 1024), '3.0 MB');
  });

  test('null 安全', () => {
    assert.equal(PAGE.formatSize(null), '0 B');
    assert.equal(PAGE.formatSize(undefined), '0 B');
  });
});

describe('isSyncServer 同步服务器过滤（预设公共书库不可作私人同步目标）', () => {
  test('私人/用户配置 → true', () => {
    assert.equal(PAGE.isSyncServer({ id: 'wd_1', name: '私人', preset: false }), true);
    assert.equal(PAGE.isSyncServer({ id: 'wd_2', name: '私人2' }), true, '未标记 preset 的配置视为私人');
  });

  test('预设服务器（preset:true）→ false', () => {
    assert.equal(PAGE.isSyncServer({ id: 'preset-0', name: '2期追求', preset: true }), false);
  });

  test('null / undefined / 空对象 → false', () => {
    assert.equal(PAGE.isSyncServer(null), false);
    assert.equal(PAGE.isSyncServer(undefined), false);
    assert.equal(PAGE.isSyncServer({}), false);
  });
});

describe('模块加载容错', () => {
  test('依赖缺失时可加载（纯函数可用，show 不炸）', () => {
    assert.equal(typeof PAGE.formatImportResult, 'function');
    assert.equal(typeof PAGE.syncStateText, 'function');
    assert.equal(typeof PAGE.formatSyncTime, 'function');
    assert.equal(typeof PAGE.formatSize, 'function');
    assert.equal(typeof PAGE.hide, 'function');
    // show() 在依赖缺失下不抛异常（内部守卫降级）
    assert.doesNotThrow(function () { PAGE.show(); });
    PAGE.hide();
  });
});
