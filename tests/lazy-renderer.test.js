'use strict';
/**
 * lazy-renderer 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/renderer/lazy-renderer.js 的纯函数部分：
 *   - isLongChapterCandidate 阈值判定（content 项数 + 预估文本量双条件）
 *   - estimateContentHeight  按 item 类型估算渲染高度（占位 div 高度来源）
 *   - buildSlices            按 content 项逐个切片，附带累计偏移
 *
 * 加载方式：与被测代码同构的 JSDOM + vm.runInThisContext，
 * 只加载 lazy-renderer.js 自身（它不依赖其他 renderer 模块）。
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
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.Text = dom.window.Text;

const lazySrc = join(__dirname, '..', 'src', 'static', 'js', 'renderer', 'lazy-renderer.js');
const lazyCode = readFileSync(lazySrc, 'utf-8');
vm.runInThisContext(lazyCode, { filename: lazySrc, displayErrors: true });

// 被测函数通过 win.BKLazyRenderer 暴露（与现有 BKRenderer.__test 钩子同风格）
const LR = win.BKLazyRenderer;
assert.ok(LR, 'lazy-renderer.js 必须暴露 win.BKLazyRenderer');

// ── 辅助构造 ────────────────────────────────────────────────────────────
function mkPara(text) { return { type: 'paragraph', text: text || '内容' }; }
function mkHeading(text) { return { type: 'heading', level: 2, text: text || '标题' }; }
function mkImage() { return { type: 'image', src: 'x.png', attrs: { alt: '' } }; }
function mkCode(lines) {
  return { type: 'code', text: Array(lines).fill('code line').join('\n') };
}
function mkTable(rows, cols) {
  const t = { type: 'table', rows: [] };
  for (let r = 0; r < rows; r++) {
    const row = { cells: [] };
    for (let c = 0; c < cols; c++) row.cells.push({ text: 'x' });
    t.rows.push(row);
  }
  return t;
}

describe('isLongChapterCandidate 阈值判定', () => {
  test('空章节不触发', () => {
    assert.equal(LR.isLongChapterCandidate([], 0), false);
  });
  test('普通章节（少项数、少文本）不触发', () => {
    const arr = Array.from({ length: 50 }, () => mkPara());
    assert.equal(LR.isLongChapterCandidate(arr, arr.length), false);
  });
  test('项数超阈值但文本量不足不触发', () => {
    const arr = Array.from({ length: 600 }, () => mkPara('短'));
    assert.equal(LR.isLongChapterCandidate(arr, 600), false);
  });
  test('文本量超阈值但项数不足不触发', () => {
    const arr = Array.from({ length: 10 }, () => mkPara('长'.repeat(5000)));
    assert.equal(LR.isLongChapterCandidate(arr, 10), false);
  });
  test('项数与文本量双达标触发', () => {
    const arr = Array.from({ length: 600 }, () => mkPara('内容'.repeat(30)));
    assert.equal(LR.isLongChapterCandidate(arr, 600), true);
  });
  test('阈值边界：恰好达标应触发', () => {
    const arr = Array.from({ length: 500 }, () => mkPara('内容'.repeat(20)));
    assert.equal(LR.isLongChapterCandidate(arr, 500), true);
  });
  test('图片多时文本量少也应触发（项数+图片算渲染量）', () => {
    const arr = Array.from({ length: 600 }, (_, i) => i % 3 === 0 ? mkImage() : mkPara('x'));
    assert.equal(LR.isLongChapterCandidate(arr, 600), true);
  });
});

describe('estimateContentHeight 占位高度估算', () => {
  test('段落按每行约 24px 估算', () => {
    const h = LR.estimateContentHeight(mkPara('内容'.repeat(30)));
    assert.ok(h > 0);
  });
  test('标题估算高度', () => {
    const h = LR.estimateContentHeight(mkHeading());
    assert.ok(h > 0);
  });
  test('图片按固定高度估算', () => {
    const h = LR.estimateContentHeight(mkImage());
    assert.ok(h > 0);
  });
  test('代码块按行数估算', () => {
    const h = LR.estimateContentHeight(mkCode(10));
    assert.ok(h > 0);
  });
  test('表格按行数估算', () => {
    const h = LR.estimateContentHeight(mkTable(10, 3));
    assert.ok(h > 0);
  });
  test('未知类型返回默认高度', () => {
    const h = LR.estimateContentHeight({ type: 'unknown-type' });
    assert.ok(h > 0);
  });
  test('null 返回 0', () => {
    assert.equal(LR.estimateContentHeight(null), 0);
  });
});

describe('buildSlices 切片', () => {
  test('空数组返回空', () => {
    assert.deepEqual(LR.buildSlices([]), []);
  });
  test('按项逐个切片且保留偏移', () => {
    const arr = [mkPara('a'), mkPara('b'), mkHeading()];
    const slices = LR.buildSlices(arr);
    assert.equal(slices.length, 3);
    assert.equal(slices[0].index, 0);
    assert.equal(slices[1].index, 1);
    assert.equal(slices[2].index, 2);
    assert.ok(slices[0].offset < slices[1].offset);
    assert.ok(slices[1].offset < slices[2].offset);
  });
  test('图片切片偏移与估算高度一致', () => {
    const arr = [mkPara('a'), mkImage()];
    const slices = LR.buildSlices(arr);
    const paraH = LR.estimateContentHeight(arr[0]);
    assert.equal(slices[1].offset, paraH);
    assert.equal(slices[1].height, LR.estimateContentHeight(arr[1]));
  });
  test('累积偏移等于各项估算高度之和', () => {
    const arr = [mkPara('a'), mkPara('b'), mkCode(5), mkTable(3, 2)];
    const slices = LR.buildSlices(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      assert.equal(slices[i].offset, sum);
      sum += LR.estimateContentHeight(arr[i]);
    }
    assert.equal(slices[slices.length - 1].offset + slices[slices.length - 1].height, sum);
  });
});

describe('buildBlocks 块分组', () => {
  test('空切片返回空', () => {
    assert.deepEqual(LR.buildBlocks([]), []);
  });
  test('按默认块大小 100 合并切片', () => {
    const arr = Array.from({ length: 250 }, () => mkPara('a'));
    const slices = LR.buildSlices(arr);
    const blocks = LR.buildBlocks(slices);
    assert.equal(blocks.length, 3); // 100 + 100 + 50
    assert.equal(blocks[0].start, 0);
    assert.equal(blocks[1].start, 100);
    assert.equal(blocks[2].start, 200);
  });
  test('块高度为块内切片高度之和', () => {
    const arr = Array.from({ length: 10 }, () => mkPara('内容'));
    const slices = LR.buildSlices(arr);
    const blocks = LR.buildBlocks(slices, 5);
    assert.equal(blocks.length, 2);
    let sum0 = 0, sum1 = 0;
    for (let i = 0; i < 5; i++) sum0 += slices[i].height;
    for (let i = 5; i < 10; i++) sum1 += slices[i].height;
    assert.equal(blocks[0].height, sum0);
    assert.equal(blocks[1].height, sum1);
  });
  test('块 offset 与首切片 offset 一致', () => {
    const arr = [mkPara('a'), mkImage(), mkHeading(), mkPara('b'), mkCode(3)];
    const slices = LR.buildSlices(arr);
    const blocks = LR.buildBlocks(slices, 2);
    assert.equal(blocks[0].offset, slices[0].offset);
    assert.equal(blocks[1].offset, slices[2].offset);
    assert.equal(blocks[2].offset, slices[4].offset);
  });
  test('少于块大小的内容合并为一块', () => {
    const arr = Array.from({ length: 3 }, () => mkPara('a'));
    const blocks = LR.buildBlocks(LR.buildSlices(arr), 100);
    assert.equal(blocks.length, 1);
  });
});