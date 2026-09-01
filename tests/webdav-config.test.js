'use strict';
/**
 * webdav-config 统一配置读取器单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/webdav-config.js
 *   - getActiveConfigId(ls)      纯函数：读激活配置 id，缺失回退 null
 *   - getSavedConfigs(json)      纯函数：解析已保存配置数组，坏数据回退 []
 *   - getConfigById(configs, id) 纯函数：按 id 查找配置
 *   - resolveActive(configs, id) 纯函数：配置列表 + 激活 id → 激活配置对象
 *
 * 设计原则：
 *   - 键名与数据格式一律不变（bk_webdav_configs / bk_webdav_active），
 *     只统一读取代码路径，不迁移数据
 *   - 模块可在 JSDOM 中独立加载（不依赖 indexedDB / crypto），
 *     纯逻辑测试不碰真网络
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

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'webdav-config.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const WC = win.BK.WebDavConfig;
assert.ok(WC, 'webdav-config.js 必须暴露 win.BK.WebDavConfig');

// ── 辅助数据 ────────────────────────────────────────────────────────────
const CFG_A = { id: 'wd_a', name: 'A', url: 'https://a.example.com/dav', username: 'u1', password: 'p1' };
const CFG_B = { id: 'wd_b', name: 'B', url: 'https://b.example.com/dav', username: 'u2', password: 'p2' };

// ── 测试 ────────────────────────────────────────────────────────────────

describe('常量对齐（键名不迁移）', () => {
  test('KEY_CONFIGS / KEY_ACTIVE 与 webdav-manager 原键一致', () => {
    assert.equal(WC.KEY_CONFIGS, 'bk_webdav_configs');
    assert.equal(WC.KEY_ACTIVE, 'bk_webdav_active');
  });
});

describe('getSavedConfigs 解析已保存配置', () => {
  test('合法 JSON 数组 → 原样返回数组', () => {
    var arr = [CFG_A, CFG_B];
    assert.deepEqual(WC.getSavedConfigs(JSON.stringify(arr)), arr);
  });

  test('空字符串 / null / undefined → []（缺失回退）', () => {
    assert.deepEqual(WC.getSavedConfigs(''), []);
    assert.deepEqual(WC.getSavedConfigs(null), []);
    assert.deepEqual(WC.getSavedConfigs(undefined), []);
  });

  test('坏 JSON（语法错误）→ []，不抛异常', () => {
    assert.deepEqual(WC.getSavedConfigs('{oops'), []);
    assert.deepEqual(WC.getSavedConfigs('not-json'), []);
  });

  test('非数组 JSON（对象/数字/字符串）→ []', () => {
    assert.deepEqual(WC.getSavedConfigs('{"a":1}'), []);
    assert.deepEqual(WC.getSavedConfigs('42'), []);
    assert.deepEqual(WC.getSavedConfigs('"str"'), []);
  });

  test('数组内 null/无效项被过滤，保留有效项', () => {
    var parsed = WC.getSavedConfigs(JSON.stringify([CFG_A, null, 123, CFG_B]));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, 'wd_a');
    assert.equal(parsed[1].id, 'wd_b');
  });
});

describe('getActiveConfigId 读取激活配置 id', () => {
  test('localStorage 有激活 id → 原样返回', () => {
    assert.equal(WC.getActiveConfigId('wd_a'), 'wd_a');
    assert.equal(WC.getActiveConfigId('preset-1'), 'preset-1');
  });

  test('空串 / null / undefined → null', () => {
    assert.equal(WC.getActiveConfigId(''), null);
    assert.equal(WC.getActiveConfigId(null), null);
    assert.equal(WC.getActiveConfigId(undefined), null);
  });
});

describe('getConfigById 按 id 查找', () => {
  test('命中返回配置对象', () => {
    var cfg = WC.getConfigById([CFG_A, CFG_B], 'wd_b');
    assert.equal(cfg, CFG_B);
  });

  test('未命中 / 空 id / 空数组 / null 列表 → null', () => {
    assert.equal(WC.getConfigById([CFG_A, CFG_B], 'nope'), null);
    assert.equal(WC.getConfigById([CFG_A, CFG_B], ''), null);
    assert.equal(WC.getConfigById([], 'wd_a'), null);
    assert.equal(WC.getConfigById(null, 'wd_a'), null);
    assert.equal(WC.getConfigById([CFG_A, CFG_B], null), null);
  });

  test('数组内 null 项不崩溃', () => {
    assert.equal(WC.getConfigById([null, CFG_A], 'wd_a'), CFG_A);
  });
});

describe('resolveActive 配置列表 + 激活 id → 激活配置', () => {
  test('激活 id 命中列表 → 返回对应配置', () => {
    var act = WC.resolveActive([CFG_A, CFG_B], 'wd_a');
    assert.equal(act, CFG_A);
  });

  test('激活 id 未命中列表 → null（不误选第一个）', () => {
    assert.equal(WC.resolveActive([CFG_A, CFG_B], 'ghost'), null);
  });

  test('激活 id 缺失 → null（未配置场景）', () => {
    assert.equal(WC.resolveActive([CFG_A, CFG_B], null), null);
    assert.equal(WC.resolveActive([CFG_A, CFG_B], ''), null);
  });

  test('配置列表为空 → null', () => {
    assert.equal(WC.resolveActive([], 'wd_a'), null);
    assert.equal(WC.resolveActive(null, 'wd_a'), null);
  });
});

describe('readSavedState 从 window.localStorage 读取完整状态', () => {
  test('正常读取：配置数组 + 激活 id', () => {
    win.localStorage.clear();
    win.localStorage.setItem('bk_webdav_configs', JSON.stringify([CFG_A, CFG_B]));
    win.localStorage.setItem('bk_webdav_active', 'wd_b');
    var st = WC.readSavedState(win);
    assert.equal(st.configs.length, 2);
    assert.equal(st.activeId, 'wd_b');
    assert.deepEqual(st.active, CFG_B);
  });

  test('全部缺失 → 空状态（configs=[], activeId=null, active=null）', () => {
    win.localStorage.clear();
    var st = WC.readSavedState(win);
    assert.deepEqual(st, { configs: [], activeId: null, active: null });
  });

  test('坏 JSON → configs 回退 []，激活 id 不受影响', () => {
    win.localStorage.clear();
    win.localStorage.setItem('bk_webdav_configs', '{bad');
    win.localStorage.setItem('bk_webdav_active', 'wd_a');
    var st = WC.readSavedState(win);
    assert.deepEqual(st.configs, []);
    assert.equal(st.activeId, 'wd_a');
    assert.equal(st.active, null);
  });
});
