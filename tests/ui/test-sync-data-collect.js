'use strict';
/**
 * sync-data-collect 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-data-collect.js 暴露的
 *   win.BK.SyncData.collectUserData(bookId)
 *
 * 加载方式：与 tests/lazy-renderer.test.js 同构
 *   JSDOM + vm.runInThisContext 加载被测模块源码，
 *   使用 JSDOM 自带 localStorage 直接注入 key。
 */

const { test, describe, beforeEach } = require('node:test');
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

const syncSrc = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'sync-data-collect.js');
const syncCode = readFileSync(syncSrc, 'utf-8');
vm.runInThisContext(syncCode, { filename: syncSrc, displayErrors: true });

const collect = win.BK.SyncData.collectUserData;
assert.ok(typeof collect === 'function', 'sync-data-collect.js 必须暴露 win.BK.SyncData.collectUserData');

// ── 测试数据 ────────────────────────────────────────────────────────────
const BOOK_ID = 'pop-abc123';

function seedAllData(ls) {
  ls.setItem('bk_progress:' + BOOK_ID, '42');
  ls.setItem('bk_lastread_ts:' + BOOK_ID, '1700000000000');
  ls.setItem('bk_pdf_pos:' + BOOK_ID, '7');
  ls.setItem('bk_pdf_bm:' + BOOK_ID, '[{"page":3,"label":"mark"}]');
  ls.setItem('bk_pdf_hl:' + BOOK_ID, '[{"page":5,"text":"highlight"}]');
  ls.setItem('bk_chapter_read:' + BOOK_ID + '/3', '1');
  ls.setItem('bk_chapter_read:' + BOOK_ID + '/5', '1');
}

describe('BK.SyncData.collectUserData', () => {
  beforeEach(() => {
    win.localStorage.clear();
  });

  test('注入全部数据时返回完整字段，chapterReads 收集已读章节号', () => {
    seedAllData(win.localStorage);

    const data = collect(BOOK_ID);
    assert.ok(data, '应返回数据对象');
    assert.equal(data.progress, '42');
    assert.equal(data.lastReadTs, '1700000000000');
    assert.equal(data.pdfPos, '7');
    assert.equal(data.pdfBookmarks, '[{"page":3,"label":"mark"}]');
    assert.equal(data.pdfHighlights, '[{"page":5,"text":"highlight"}]');
    assert.deepEqual(data.chapterReads, ['3', '5']);
  });

  test('无任何数据时返回 null', () => {
    assert.equal(collect(BOOK_ID), null);
  });

  test('progress 值为 0 时仍算有效数据', () => {
    win.localStorage.setItem('bk_progress:' + BOOK_ID, '0');

    const data = collect(BOOK_ID);
    assert.ok(data, 'progress=0 时应返回数据对象');
    assert.equal(data.progress, '0');
  });

  test('其他书的 key 不影响目标书收集', () => {
    const ls = win.localStorage;
    ls.setItem('bk_progress:other-book', '99');
    ls.setItem('bk_chapter_read:other-book/1', '1');

    assert.equal(collect(BOOK_ID), null);
  });

  test('未读标记（值为 0）不计入 chapterReads', () => {
    const ls = win.localStorage;
    ls.setItem('bk_progress:' + BOOK_ID, '10');
    ls.setItem('bk_chapter_read:' + BOOK_ID + '/3', '0');
    ls.setItem('bk_chapter_read:' + BOOK_ID + '/5', '1');

    const data = collect(BOOK_ID);
    assert.deepEqual(data.chapterReads, ['5']);
  });

  test('只读章节标记而无进度等其他数据时仍返回对象', () => {
    win.localStorage.setItem('bk_chapter_read:' + BOOK_ID + '/7', '1');

    const data = collect(BOOK_ID);
    assert.ok(data, 'chapterReads 也属于有效数据');
    assert.deepEqual(data.chapterReads, ['7']);
    assert.equal(data.progress, undefined);
  });
});