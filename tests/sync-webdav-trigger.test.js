'use strict';
/**
 * sync-webdav-trigger 同步状态事件单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-webdav-trigger.js 新增的状态事件机制
 *   - onSyncStateChange(cb)   订阅同步状态变化（返回取消订阅函数）
 *   - getSyncState()          读当前状态快照
 *   - runSync()               开始/结束/失败时向订阅者广播状态
 *
 * 状态对象形状（供任务 6 中心页订阅）：
 *   { running: boolean, lastSyncTs: number|null, lastResult: object|null,
 *     lastError: string|null }
 *
 * 测试策略：mock BK.SyncWebDAV.sync / WebDavManager.getActiveConfig，
 * 不碰真网络；只验证状态转换与订阅广播的纯逻辑。
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

// mock：document.readyState='complete' 避免模块加载时绑 DOMContentLoaded init
// （init 内部 addEventListener 与 console.log 无害，且 __syncWebDavTriggerInit 守卫幂等）

// 先清空依赖，模块加载后才注入 mock
win.BK = win.BK || {};
win.BK.SyncWebDAV = null;
win.WebDavManager = null;

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'sync-webdav-trigger.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const TRIGGER = win.BK.SyncWebDAVTrigger;
assert.ok(TRIGGER, 'sync-webdav-trigger.js 必须暴露 win.BK.SyncWebDAVTrigger');

// ── 辅助：等待微任务队列排空（flush 所有 promise chain）──────────────────
function flushMicrotasks() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// ── mock 注入 ────────────────────────────────────────────────────────────
function installMocks(syncImpl) {
  win.BK.SyncWebDAV = {
    sync: syncImpl || function () { return Promise.resolve({ pulled: 0, pushed: 0, errors: [] }); }
  };
  win.WebDavManager = {
    getActiveConfig: function () { return { id: 'wd_test', url: 'https://dav.example.com' }; }
  };
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe('onSyncStateChange 订阅机制', () => {
  test('初始状态：未运行、无历史', () => {
    var st = TRIGGER.getSyncState();
    assert.equal(typeof st.running, 'boolean');
    assert.equal(st.running, false);
    assert.equal(st.lastSyncTs, null);
    assert.equal(st.lastError, null);
  });

  test('订阅返回取消函数；取消后不再收到广播', async () => {
    installMocks();
    var received = [];
    var off = TRIGGER.onSyncStateChange(function (st) { received.push(st); });
    assert.equal(typeof off, 'function');

    await TRIGGER.runSync();
    var before = received.length;
    assert.ok(before >= 2, '至少收到 running=true 与 running=false 两次广播');

    off();
    await TRIGGER.runSync();
    assert.equal(received.length, before, '取消订阅后不再广播');
  });

  test('runSync 成功：广播 running true → false，lastSyncTs 更新，lastResult 携带结果', async () => {
    installMocks(function () {
      return Promise.resolve({ pulled: 2, pushed: 1, errors: [] });
    });
    var states = [];
    TRIGGER.onSyncStateChange(function (st) { states.push(Object.assign({}, st)); });

    await TRIGGER.runSync();

    assert.equal(states.length, 2);
    assert.equal(states[0].running, true);
    assert.equal(states[1].running, false);
    assert.ok(states[1].lastSyncTs, 'lastSyncTs 已记录');
    assert.deepEqual(states[1].lastResult, { pulled: 2, pushed: 1, errors: [] });
    assert.equal(states[1].lastError, null);

    var snap = TRIGGER.getSyncState();
    assert.equal(snap.running, false);
    assert.deepEqual(snap.lastResult, { pulled: 2, pushed: 1, errors: [] });
  });

  test('runSync 失败：广播 running true → false，lastError 记录信息', async () => {
    installMocks(function () {
      return Promise.reject(new Error('网络不可达'));
    });
    var states = [];
    TRIGGER.onSyncStateChange(function (st) { states.push(Object.assign({}, st)); });

    await TRIGGER.runSync();

    assert.equal(states.length, 2);
    assert.equal(states[1].running, false);
    assert.equal(states[1].lastError, '网络不可达');
    // 失败时 lastResult 置空
    assert.equal(states[1].lastResult, null);
    assert.equal(TRIGGER.getSyncState().lastError, '网络不可达');
  });

  test('runSync 完成但含错误条目：lastError 汇总错误信息（视作失败广播）', async () => {
    installMocks(function () {
      return Promise.resolve({ pulled: 0, pushed: 0, errors: [{ id: 'b1', error: 'boom' }] });
    });
    await TRIGGER.runSync();
    var st = TRIGGER.getSyncState();
    assert.equal(st.lastError !== null && st.lastError.indexOf('boom') >= 0, true);
  });

  test('WebDAV 未配置：不进入同步、不广播 running 状态', async () => {
    win.WebDavManager = {
      getActiveConfig: function () { return null; }
    };
    var received = [];
    TRIGGER.onSyncStateChange(function (st) { received.push(st); });
    await TRIGGER.runSync();
    assert.equal(received.length, 0, '未配置时不广播');
    assert.equal(TRIGGER.getSyncState().running, false);
  });

  test('并发守卫：同步进行中再次 runSync 直接跳过', async () => {
    var resolveFirst;
    installMocks(function () {
      return new Promise(function (r) { resolveFirst = r; });
    });
    var states = [];
    TRIGGER.onSyncStateChange(function (st) { states.push(st); });

    var p1 = TRIGGER.runSync();
    await flushMicrotasks();
    assert.equal(TRIGGER.getSyncState().running, true);

    var p2 = TRIGGER.runSync(); // 进行中 → 跳过
    await flushMicrotasks();
    assert.equal(TRIGGER.getSyncState().running, true, '第二次调用不影响进行中的同步');

    resolveFirst({ pulled: 0, pushed: 0, errors: [] });
    await p1;
    await p2;
    assert.equal(TRIGGER.getSyncState().running, false);
  });
});
