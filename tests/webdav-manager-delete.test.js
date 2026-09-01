'use strict';
/**
 * webdav-manager deleteConfig 集成测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/webdav-manager.js 暴露的 deleteConfig(id)
 *   - 预置服务器（preset:true，随包下发）不可删 → false
 *   - 删除用户配置：bk_webdav_configs 移除 + 解密缓存同步
 *   - 删除激活项：激活 id 回退（剩余第一个 / 清空置 null）+ DEV-2 激活缓存同步
 *
 * 测试策略：JSDOM 提供真实 localStorage；indexedDB 缺失走模块内降级路径；
 * 纯逻辑（删除/回退）由 sync/webdav-config.js 提供并在其单测覆盖。
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

// 预置服务器须在 manager 加载前注入（IIFE 内 decodePresets 读取）
win.BK_WEBDAV_PRESETS = [{
  id: 'preset-x',
  name: '预置服务器A',
  note: '随包下发',
  secret: Buffer.from('{"username":"pu","password":"pp"}').toString('base64')
}];

function loadModule(rel) {
  const p = join(__dirname, '..', 'src', 'static', 'js', rel);
  vm.runInThisContext(readFileSync(p, 'utf-8'), { filename: p, displayErrors: true });
}

loadModule(join('sync', 'webdav-config.js'));
loadModule('webdav-manager.js');

const DM = win.WebDavManager;
assert.ok(DM, 'webdav-manager.js 必须暴露 win.WebDavManager');
assert.equal(typeof DM.deleteConfig, 'function', '必须暴露 deleteConfig');

// ── 测试数据 ────────────────────────────────────────────────────────────
const CFG_A = { id: 'wd_a', name: 'A', url: 'https://a.example.com/dav', username: 'u1', password: 'p1' };
const CFG_B = { id: 'wd_b', name: 'B', url: 'https://b.example.com/dav', username: 'u2', password: 'p2' };

function seedStorage(configs, activeId) {
  win.localStorage.clear();
  win.localStorage.setItem('bk_webdav_configs', JSON.stringify(configs));
  if (activeId) win.localStorage.setItem('bk_webdav_active', activeId);
  else win.localStorage.removeItem('bk_webdav_active');
}

function readStoredConfigs() {
  try {
    var parsed = JSON.parse(win.localStorage.getItem('bk_webdav_configs') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe('deleteConfig 预置服务器保护', () => {
  test('预置 id → 返回 false，预置仍在 getAllConfigs 中', () => {
    seedStorage([CFG_A], null);
    assert.equal(DM.deleteConfig('preset-x'), false);
    var all = DM.getAllConfigs();
    var found = false;
    for (var i = 0; i < all.length; i++) if (all[i].id === 'preset-x') found = true;
    assert.ok(found, '预置服务器不应被删除');
  });
});

describe('deleteConfig 删除用户配置', () => {
  test('非激活项 → true；存储移除；激活 id 不变；剩余配置保留', () => {
    seedStorage([CFG_A, CFG_B], 'wd_b');
    assert.equal(DM.deleteConfig('wd_a'), true);
    var stored = readStoredConfigs();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'wd_b');
    assert.equal(win.localStorage.getItem('bk_webdav_active'), 'wd_b');
  });

  test('未存在的 id / 空 id → false', () => {
    seedStorage([CFG_A], 'wd_a');
    assert.equal(DM.deleteConfig('nope'), false);
    assert.equal(DM.deleteConfig(''), false);
    assert.equal(DM.deleteConfig(null), false);
  });

  test('激活项且剩余非空 → true；激活 id 回退到剩余第一个；getActiveConfig 同步', async () => {
    seedStorage([CFG_A, CFG_B], 'wd_a');
    await DM.ensureCryptoReady();
    assert.equal(DM.deleteConfig('wd_a'), true);
    assert.equal(win.localStorage.getItem('bk_webdav_active'), 'wd_b');
    var act = DM.getActiveConfig();
    assert.ok(act, '激活配置不应悬空');
    assert.equal(act.id, 'wd_b');
  });

  test('激活项且列表清空 → true；激活 id 移除；getActiveConfig 为 null', async () => {
    seedStorage([CFG_A], 'wd_a');
    await DM.ensureCryptoReady();
    assert.equal(DM.deleteConfig('wd_a'), true);
    assert.equal(win.localStorage.getItem('bk_webdav_active'), null);
    assert.equal(DM.getActiveConfig(), null);
  });

  test('删除后解密缓存同步：getConfigs 不再含被删项', async () => {
    seedStorage([CFG_A, CFG_B], null);
    await DM.ensureCryptoReady();
    assert.equal(DM.deleteConfig('wd_a'), true);
    var cached = DM.getConfigs();
    for (var i = 0; i < cached.length; i++) {
      assert.notEqual(cached[i].id, 'wd_a', '解密缓存中不应残留被删项');
    }
    assert.equal(cached.length, 1);
  });
});
