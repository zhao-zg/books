'use strict';
/**
 * book-convert 书籍文本转换共享模块单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/book-convert.js
 *   - bookToText(bookData)          纯文本拼接（类型感知 + 章节分隔）
 *   - bookToMd(bookData)            Markdown 拼接（标题层级 + escMd 转义）
 *   - bookToEpub(bookData, opts)    EPUB 3.0 zip 构建（opts.JSZip 依赖注入）
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

const srcPath = join(__dirname, '..', 'src', 'static', 'js', 'sync', 'book-convert.js');
const srcCode = readFileSync(srcPath, 'utf-8');
vm.runInThisContext(srcCode, { filename: srcPath, displayErrors: true });

const BC = win.BK.BookConvert;
assert.ok(BC, 'book-convert.js 必须暴露 win.BK.BookConvert');

// ── 辅助：fake JSZip（记录 file() 调用序列，不真打包）─────────────────
function makeFakeJSZip() {
  const files = [];
  let genOpts = null;
  const genResult = new Uint8Array([1, 2, 3, 4]);
  function JSZip() {
    return {
      file: function (name, content, options) {
        files.push({ name: name, content: content, options: options || null });
      },
      generateAsync: function (opts) {
        genOpts = opts;
        return Promise.resolve(genResult);
      }
    };
  }
  return { JSZip, files, getGenOpts: function () { return genOpts; }, genResult };
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe('bookToText 纯文本拼接', () => {
  test('单章完整输出：标题 + 40 个 = 分隔 + 【章题】 + 正文 + 40 个 - 分隔', () => {
    var out = BC.bookToText({ title: 'T', chapters: [{ content: '正文' }] });
    assert.equal(out,
      'T\n' +
      '========================================\n' +
      '\n' +
      '【第1章】\n' +
      '\n' +
      '正文\n' +
      '\n' +
      '----------------------------------------\n');
  });

  test('书名回退链：title → id → 未知', () => {
    assert.ok(BC.bookToText({ id: 'book-1', chapters: [] }).indexOf('book-1') === 0);
    assert.ok(BC.bookToText({ chapters: [] }).indexOf('未知') === 0);
  });

  test('章节标题回退：title → 第<number>章 → 第<index+1>章', () => {
    var book = {
      title: 'T',
      chapters: [
        { number: 5, content: 'a' },
        { content: 'b' },
        { title: '有名章', content: 'c' }
      ]
    };
    var out = BC.bookToText(book);
    assert.ok(out.indexOf('【第5章】') !== -1, 'number 优先');
    assert.ok(out.indexOf('【第2章】') !== -1, '无 number 用 index+1');
    assert.ok(out.indexOf('【有名章】') !== -1, 'title 最优先');
  });

  test('paragraph 项：text 优先，无 text 时 stripHtml(html)', () => {
    var out = BC.bookToText({
      title: 'T',
      chapters: [{ content: [
        { type: 'paragraph', text: '纯文本' },
        { type: 'paragraph', html: '<p>加<b>粗</b>文本</p>' }
      ] }]
    });
    assert.ok(out.indexOf('纯文本') !== -1);
    assert.ok(out.indexOf('加粗文本') !== -1);
  });

  test('image 项：[图片: alt] / [图片] 占位', () => {
    var out = BC.bookToText({
      title: 'T',
      chapters: [{ content: [
        { type: 'image', alt: '封面', src: 'a.png' },
        { type: 'image', src: 'b.png' }
      ] }]
    });
    assert.ok(out.indexOf('[图片: 封面]') !== -1);
    assert.ok(out.indexOf('[图片]') !== -1);
  });

  test('list 项：逐行两空格前缀，itemHtmls 优先 stripHtml，回退 items', () => {
    var out = BC.bookToText({
      title: 'T',
      chapters: [{ content: [
        { type: 'list', items: ['甲', '乙'] },
        { type: 'list', items: ['甲', '乙'], itemHtmls: ['<i>丙</i>', null] }
      ] }]
    });
    assert.ok(out.indexOf('  甲\n  乙') !== -1, '纯 items 逐行两空格');
    assert.ok(out.indexOf('  丙\n  乙') !== -1, 'itemHtmls stripHtml 优先，null 回退 items');
  });

  test('table / code / quote / heading 项', () => {
    var out = BC.bookToText({
      title: 'T',
      chapters: [{ content: [
        { type: 'table', text: '表格文本' },
        { type: 'table' },
        { type: 'code', text: 'let a = 1;' },
        { type: 'quote', text: '引文' },
        { type: 'heading', text: '小节标题' }
      ] }]
    });
    assert.ok(out.indexOf('表格文本') !== -1);
    assert.ok(out.indexOf('[表格]') !== -1);
    assert.ok(out.indexOf('let a = 1;') !== -1);
    assert.ok(out.indexOf('引文') !== -1);
    assert.ok(out.indexOf('小节标题') !== -1);
  });

  test('content 为字符串时直接嵌入', () => {
    var out = BC.bookToText({ title: 'T', chapters: [{ title: 'C', content: '第一行\n第二行' }] });
    assert.ok(out.indexOf('第一行\n第二行') !== -1);
  });

  test('空 content 数组与 null 项不产出空行', () => {
    var out = BC.bookToText({ title: 'T', chapters: [{ content: [null, { type: 'paragraph', text: '' }, { type: 'paragraph', text: '唯一' }] }] });
    assert.ok(out.indexOf('【第1章】\n\n唯一') !== -1, '空项被跳过');
  });

  test('无 chapters 时仅输出头部', () => {
    assert.equal(BC.bookToText({ title: 'T', chapters: [] }), 'T\n========================================\n');
    assert.equal(BC.bookToText({ title: 'T' }), 'T\n========================================\n');
  });
});

describe('bookToMd Markdown 拼接', () => {
  test('单章完整输出：# 标题 + > 作者 + --- + ## 章题 + 正文 + ---', () => {
    var out = BC.bookToMd({
      title: 'T',
      author: '作者甲',
      chapters: [{ content: '正文' }]
    });
    assert.equal(out,
      '# T\n' +
      '> 作者甲\n' +
      '\n' +
      '---\n' +
      '\n' +
      '## 第1章\n' +
      '\n' +
      '正文\n' +
      '\n' +
      '---\n');
  });

  test('无 author 时不产出引用行', () => {
    var out = BC.bookToMd({ title: 'T', chapters: [{ content: '正文' }] });
    assert.ok(out.indexOf('> ') !== 0 && out.indexOf('\n> ') === -1, '不应出现作者引用行');
  });

  test('书名与章题 escMd 转义（* # 等特殊字符）', () => {
    var out = BC.bookToMd({
      title: 'A*B',
      chapters: [{ title: '第#章', content: 'x' }]
    });
    assert.ok(out.indexOf('# A\\*B') === 0, '标题转义 *');
    assert.ok(out.indexOf('## 第\\#章') !== -1, '章题转义 #');
  });

  test('heading 项按 level 输出 1-6 个 #，无 level 默认 2，越界 clamp', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [
        { type: 'heading', level: 3, text: '三级' },
        { type: 'heading', text: '默认级' },
        { type: 'heading', level: 9, text: '越上限' },
        { type: 'heading', level: 0, text: '零级' }
      ] }]
    });
    assert.ok(out.indexOf('### 三级') !== -1);
    assert.ok(out.indexOf('## 默认级') !== -1, 'level 缺省走 || 2');
    assert.ok(out.indexOf('###### 越上限') !== -1, 'level>6 clamp 到 6');
    assert.ok(out.indexOf('## 零级') !== -1, 'level 0 为 falsy 走 || 2');
  });

  test('quote 项：> 前缀，多行逐行加前缀', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [{ type: 'quote', text: '一\n二' }] }]
    });
    assert.ok(out.indexOf('> 一\n> 二') !== -1);
  });

  test('list 项：无序 - 前缀，有序 1. 2. 前缀', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [
        { type: 'list', items: ['甲', '乙'] },
        { type: 'list', items: ['丙', '丁'], attrs: { ordered: true } }
      ] }]
    });
    assert.ok(out.indexOf('- 甲\n- 乙') !== -1);
    assert.ok(out.indexOf('1. 丙\n2. 丁') !== -1);
  });

  test('code 项：围栏 + lang', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [{ type: 'code', text: 'var x;', attrs: { lang: 'js' } }] }]
    });
    assert.ok(out.indexOf('```js\nvar x;\n```') !== -1);
  });

  test('image 项：MD 图片语法，alt 缺省为「图片」', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [
        { type: 'image', alt: '图注', src: 'a.png' },
        { type: 'image', src: 'b.png' }
      ] }]
    });
    assert.ok(out.indexOf('![图注](a.png)') !== -1);
    assert.ok(out.indexOf('![图片](b.png)') !== -1);
  });

  test('table 项：text 或 [表格]；paragraph 正文 escMd 转义', () => {
    var out = BC.bookToMd({
      title: 'T',
      chapters: [{ content: [
        { type: 'table', text: '表内容' },
        { type: 'table' },
        { type: 'paragraph', text: 'a_b*c' }
      ] }]
    });
    assert.ok(out.indexOf('表内容') !== -1);
    assert.ok(out.indexOf('[表格]') !== -1);
    assert.ok(out.indexOf('a\\_b\\*c') !== -1, '正文特殊字符转义');
  });

  test('content 为字符串时原样嵌入（不转义）', () => {
    var out = BC.bookToMd({ title: 'T', chapters: [{ content: 'a*b' }] });
    assert.ok(out.indexOf('a*b') !== -1);
  });
});

describe('bookToEpub EPUB 3.0 构建', () => {
  const sampleBook = {
    id: 'bk-src-1',
    title: '测试书',
    author: '作者甲',
    chapters: [
      {
        title: '第一章 起点',
        content: [
          { type: 'paragraph', text: '段落一' },
          { type: 'heading', level: 2, text: '小节' }
        ]
      },
      { content: '整章字符串' }
    ]
  };

  test('mimetype 必须是第一个添加的文件且不压缩', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    assert.equal(fk.files[0].name, 'mimetype', '首个 file() 调用必须是 mimetype');
    assert.equal(fk.files[0].content, 'application/epub+zip');
    assert.deepEqual(fk.files[0].options, { compression: 'STORE' });
  });

  test('固定文件集：container.xml / content.opf / style.css / nav.xhtml 齐全', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    var names = fk.files.map(function (f) { return f.name; });
    assert.ok(names.indexOf('META-INF/container.xml') !== -1);
    assert.ok(names.indexOf('OEBPS/content.opf') !== -1);
    assert.ok(names.indexOf('OEBPS/style.css') !== -1);
    assert.ok(names.indexOf('OEBPS/nav.xhtml') !== -1);
  });

  test('每章生成 chapter-N.xhtml，位于 nav 之后', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    var names = fk.files.map(function (f) { return f.name; });
    assert.ok(names.indexOf('OEBPS/chapter-1.xhtml') !== -1);
    assert.ok(names.indexOf('OEBPS/chapter-2.xhtml') !== -1);
    assert.equal(names.filter(function (n) { return /^OEBPS\/chapter-\d+\.xhtml$/.test(n); }).length, 2);
    assert.ok(names.indexOf('OEBPS/nav.xhtml') < names.indexOf('OEBPS/chapter-1.xhtml'));
  });

  test('content.opf：dc:title/dc:creator 转义、spine itemref 数量与章节数一致、nav+style manifest', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub({ title: 'A&B', author: 'C<D', chapters: sampleBook.chapters }, { JSZip: fk.JSZip });
    var opf = fk.files[2].content;
    assert.ok(opf.indexOf('<dc:title>A&amp;B</dc:title>') !== -1, 'title XML 转义');
    assert.ok(opf.indexOf('<dc:creator>C&lt;D</dc:creator>') !== -1, 'creator XML 转义');
    assert.ok(opf.indexOf('urn:uuid:bk-') !== -1, 'dc:identifier 带 bk- 前缀 uid');
    assert.equal((opf.match(/<itemref /g) || []).length, 2, 'spine itemref 与章节数一致');
    assert.ok(opf.indexOf('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>') !== -1);
    assert.ok(opf.indexOf('<item id="style" href="style.css" media-type="text/css"/>') !== -1);
    assert.match(opf, /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
    assert.ok(opf.indexOf('version="3.0"') !== -1, 'EPUB 3.0');
  });

  test('dc:language 取 bookData.language，缺省 zh', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub({ title: 'T', chapters: [], language: 'en' }, { JSZip: fk.JSZip });
    assert.ok(fk.files[2].content.indexOf('<dc:language>en</dc:language>') !== -1);

    var fk2 = makeFakeJSZip();
    await BC.bookToEpub({ title: 'T', chapters: [] }, { JSZip: fk2.JSZip });
    assert.ok(fk2.files[2].content.indexOf('<dc:language>zh</dc:language>') !== -1);
  });

  test('nav.xhtml：目录含各章标题（含无 title 章的「第N章」回退）', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    var nav = fk.files[4].content;
    assert.ok(nav.indexOf('第一章 起点') !== -1);
    assert.ok(nav.indexOf('第2章') !== -1, '无 title 章回退第N章');
    assert.ok(nav.indexOf('href="chapter-1.xhtml"') !== -1);
    assert.ok(nav.indexOf('href="chapter-2.xhtml"') !== -1);
  });

  test('章节 xhtml：h1 章题、paragraph → p、字符串 content → p 包裹', async () => {
    var fk = makeFakeJSZip();
    await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    var ch1 = fk.files[5].content;
    var ch2 = fk.files[6].content;
    assert.ok(ch1.indexOf('<h1>第一章 起点</h1>') !== -1);
    assert.ok(ch1.indexOf('<p>段落一</p>') !== -1);
    assert.ok(ch1.indexOf('<h2>小节</h2>') !== -1, 'heading 项按层级输出 hN');
    assert.ok(ch2.indexOf('<p>整章字符串</p>') !== -1);
  });

  test('generateAsync 参数：uint8array + application/epub+zip，返回值透传', async () => {
    var fk = makeFakeJSZip();
    var result = await BC.bookToEpub(sampleBook, { JSZip: fk.JSZip });
    assert.deepEqual(fk.getGenOpts(), { type: 'uint8array', mimeType: 'application/epub+zip' });
    assert.equal(result, fk.genResult, 'zip.generateAsync 的返回值原样透传');
  });

  test('JSZip 未加载时 reject', async () => {
    var saved = win.JSZip;
    delete win.JSZip;
    try {
      await assert.rejects(
        function () { return BC.bookToEpub({ title: 'T', chapters: [] }); },
        /JSZip 未加载/
      );
    } finally {
      win.JSZip = saved;
    }
  });

  test('真 JSZip 冒烟：生成合法 zip 字节流（PK 魔数头，不解析内部）', async () => {
    var RealJSZip = require('jszip');
    var bytes = await BC.bookToEpub(
      { title: '冒烟', chapters: [{ title: '一', content: '正文' }] },
      { JSZip: RealJSZip }
    );
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);
    assert.equal(bytes[0], 0x50, '首字节 P');
    assert.equal(bytes[1], 0x4B, '次字节 K');
  });
});
