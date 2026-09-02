'use strict';
/**
 * webdav-manager setActiveConfig 预置分支缓存测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/webdav-manager.js 的 setActiveConfig(id) / getActiveConfig()
 *   - 切换到预置 id（_presets 内、getConfigs 不含）时 _activeConfigCache 也须更新，
 *     会话内 getActiveConfig 应返回预置配置对象（任务 7 审查 P3 缺陷）
 *
 * 测试策略：与 webdav-manager-delete.test.js 相同范式——
 * JSDOM 提供真实 localStorage；预置经 win.BK_WEBDAV_PRESETS 注入；
 * indexedDB/crypto 缺失走模块内降级路径，纯逻辑断言缓存一致性。
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
assert.equal(typeof DM.setActiveConfig, 'function', '必须暴露 setActiveConfig');
assert.equal(typeof DM.getActiveConfig, 'function', '必须暴露 getActiveConfig');

// ── 测试数据 ────────────────────────────────────────────────────────────
const CFG_A = { id: 'wd_a', name: 'A', url: 'https://a.example.com/dav', username: 'u1', password: 'p1' };

function seedStorage(configs, activeId) {
  win.localStorage.clear();
  win.localStorage.setItem('bk_webdav_configs', JSON.stringify(configs));
  if (activeId) win.localStorage.setItem('bk_webdav_active', activeId);
  else win.localStorage.removeItem('bk_webdav_active');
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe('setActiveConfig 预置分支缓存一致性', () => {
  test('先激活用户配置，再切换到预置 id → getActiveConfig 返回预置配置对象', () => {
    seedStorage([CFG_A], 'wd_a');
    // 先激活用户配置（缓存指向 wd_a）
    DM.setActiveConfig('wd_a');
    var before = DM.getActiveConfig();
    assert.ok(before, '用户配置激活后应能读到');
    assert.equal(before.id, 'wd_a');

    // 切换到预置 id（getConfigs 不含预置，旧实现不更新缓存）
    DM.setActiveConfig('preset-x');
    assert.equal(win.localStorage.getItem('bk_webdav_active'), 'preset-x', '激活 id 应写入存储');
    var after = DM.getActiveConfig();
    assert.ok(after, '切换预置后 getActiveConfig 不应为 null');
    assert.equal(after.id, 'preset-x', 'getActiveConfig 应返回预置配置');
    assert.equal(after.name, '预置服务器A');
    assert.equal(after.preset, true, '预置配置须带 preset 标记');
  });

  test('直接激活预置 id（无前置用户配置）→ getActiveConfig 返回预置配置', () => {
    seedStorage([CFG_A], null);
    DM.setActiveConfig('preset-x');
    var cfg = DM.getActiveConfig();
    assert.ok(cfg, '预置激活后应能读到配置');
    assert.equal(cfg.id, 'preset-x');
    assert.equal(cfg.username, 'pu', '预置凭据应已解码');
  });

  test('预置 → 用户配置来回切换，缓存始终与激活 id 一致', () => {
    seedStorage([CFG_A], null);
    DM.setActiveConfig('preset-x');
    assert.equal(DM.getActiveConfig().id, 'preset-x');

    DM.setActiveConfig('wd_a');
    assert.equal(DM.getActiveConfig().id, 'wd_a');

    DM.setActiveConfig('preset-x');
    assert.equal(DM.getActiveConfig().id, 'preset-x');
  });

  test('清空激活（null）→ 缓存清空，getActiveConfig 返回 null', () => {
    seedStorage([CFG_A], 'preset-x');
    DM.setActiveConfig('preset-x');
    DM.setActiveConfig(null);
    assert.equal(win.localStorage.getItem('bk_webdav_active'), null);
    assert.equal(DM.getActiveConfig(), null);
  });

  test('预置激活后 getConfigs 仍不含预置（存储不落预置条目）', () => {
    seedStorage([CFG_A], null);
    DM.setActiveConfig('preset-x');
    var saved = DM.getConfigs();
    for (var i = 0; i < saved.length; i++) {
      assert.notEqual(saved[i].id, 'preset-x', '预置不应写入用户配置存储');
    }
    // getAllConfigs 含预置（既有行为不变）
    var all = DM.getAllConfigs();
    var found = false;
    for (var k = 0; k < all.length; k++) if (all[k].id === 'preset-x') found = true;
    assert.ok(found, 'getAllConfigs 应含预置');
  });
});
