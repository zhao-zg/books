#!/usr/bin/env node
/**
 * convert-bundled.js — 直接复用前端 import-manager 解析逻辑
 *
 * 用法: node src/convert-bundled.js <input_file> <book_id> <series_id>
 * 输出: JSON 到 stdout（ysz 格式：{id, title, format, series, chapters}）
 *
 * 实现原理：
 *   前端 import-manager/*.js 是"无 IIFE 全局脚本"风格，<script defer> 顺序
 *   加载、函数跨文件共享全局作用域。本脚本在 Node.js 端用 JSDOM 构建伪
 *   浏览器环境，按顺序用 vm.runInThisContext 加载前端 6 个核心 JS 文件，
 *   让 parseEpub/parseMd/parseTxt/htmlToContents 等函数自然挂到 global，
 *   本脚本只负责入口分发和输出格式适配，不复制任何解析逻辑。
 *
 *   前端依赖：window/document/DOMParser/window.JSZip/window.marked/localforage
 *   本脚本 polyfill：JSDOM 提供 DOM 系列，require('jszip') 注入 JSZip，
 *   动态 import('marked') 实例化后注入 win.marked，localforage 用 stub。
 */

'use strict';

const { readFileSync } = require('fs');
const { basename, extname, join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');

// ── 1. 构建伪浏览器环境 ──
// JSDOM 提供 window/document/DOMParser/XMLSerializer/Node/Element 等
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.Text = dom.window.Text;
global.DocumentFragment = dom.window.DocumentFragment;

// JSZip：前端 import-epub.js 用全局 JSZip
global.JSZip = JSZip;
dom.window.JSZip = JSZip;

// localforage：import-shared.js L15 加载时调用 createInstance，构建端不存到 IndexedDB
const localforageStub = {
  createInstance: () => ({
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    clear: () => Promise.resolve()
  })
};
global.localforage = localforageStub;
dom.window.localforage = localforageStub;

// ── 2. 按顺序加载前端 import-manager 核心 6 个文件 ──
// 顺序与 src/static/index.html L281-290 一致，跳过 UI/存储/PDF 相关文件
const importMgrDir = join(__dirname, 'static', 'js', 'import-manager');
const frontFiles = [
  'import-shared.js',           // 工具函数 + chapterPatterns 正则
  'import-txt.js',              // parseTxt + 3 个分章函数
  'import-epub-style.js',       // CSS 解析（mergeStyles/parseEpubCss/lookupCssStyle/extractInlineHtml）
  'import-html-converter.js',   // htmlToContents（EPUB 与 MD 共用核心）
  'import-epub.js',             // parseEpub + parseEpubToc（依赖 JSZip）
  'import-markdown.js'          // parseMd（依赖 win.marked）
];
for (const f of frontFiles) {
  const code = readFileSync(join(importMgrDir, f), 'utf-8');
  try {
    vm.runInThisContext(code, { filename: f, displayErrors: true });
  } catch (e) {
    console.error('[convert-bundled] 加载前端文件失败:', f, e.message);
    throw e;
  }
}

// 验证关键函数已挂到 global
const requiredFns = ['parseEpub', 'parseMd', 'parseTxt', 'htmlToContents',
                     'generateId', 'escHtml', 'escAttr'];
for (const fn of requiredFns) {
  if (typeof global[fn] !== 'function') {
    console.error('[convert-bundled] 关键函数未挂到 global:', fn);
    process.exit(1);
  }
}

// ── 3. 工具：清理零宽字符（构建端独有预处理，前端无此函数）──
// 在 main 里对 MD/TXT 输入文本调用，与旧版行为一致
function cleanInvisibleChars(str) {
  if (!str) return str;
  return str.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, '');
}

// ── 4. 主入口 ──
async function main() {
  // marked 是 ESM-only 包，动态 import；实例化后注入到 win.marked。
  // 注意：前端 import-markdown.js::parseMd 会调用 win.marked.use({gfm:true, breaks:true})
  // 覆盖此处的默认配置；此处初始化仅作为兜底，避免 marked 实例被直接使用时未配置。
  // 与前端语义保持一致使用 breaks: true，不要写成 false（会被 parseMd 覆盖，是误导性死代码）。
  const { Marked } = await import('marked');
  const markedInstance = new Marked();
  if (typeof markedInstance.use === 'function') {
    markedInstance.use({ gfm: true, breaks: true });
  }
  dom.window.marked = markedInstance;

  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('用法: node src/convert-bundled.js <input_file> <book_id> <series_id>');
    process.exit(1);
  }
  const [inputFile, bookId, seriesId] = args;
  const ext = extname(inputFile).toLowerCase();
  const fileName = basename(inputFile);

  let bookData;
  if (ext === '.epub') {
    const data = readFileSync(inputFile);
    bookData = await parseEpub(data, fileName);
  } else if (ext === '.md' || ext === '.markdown') {
    const text = cleanInvisibleChars(readFileSync(inputFile, 'utf-8'));
    bookData = parseMd(text, fileName);
  } else if (ext === '.txt') {
    const text = cleanInvisibleChars(readFileSync(inputFile, 'utf-8'));
    bookData = parseTxt(text, fileName);
  } else {
    console.error('不支持的格式:', ext);
    process.exit(1);
  }

  // 覆盖 ID，输出 ysz 格式（与旧版输出结构一致）
  bookData.id = bookId;
  const output = {
    id: bookData.id,
    title: bookData.title,
    format: bookData.format,    // epub/md/txt，由 merge_zl_data.py 强转 'html'
    series: seriesId,
    chapters: bookData.chapters
  };

  console.log(JSON.stringify(output, null, 2));

  // 显式关闭 JSDOM 实例，释放底层资源（虽然是一次性 CLI 进程，
  // 但显式 close 是更规范的实践，避免未来改为常驻进程时的潜在泄漏）
  dom.window.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
