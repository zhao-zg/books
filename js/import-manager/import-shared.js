/*!
 * import-manager.js - import-shared.js
 * External book import manager: supports TXT, EPUB, Markdown, PDF formats.
 * Part of the ImportManager module suite (split from import-manager.js).
 */

'use strict';
var win = window;
  // ── pdf.js worker 配置 ──
  if (win.pdfjsLib && win.pdfjsLib.GlobalWorkerOptions) {
    win.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
  }

  // ── 存储 ──
  var importStore = localforage.createInstance({
    name: 'books',
    storeName: 'imported-data'
  });
  var KEY_IDS = 'imported_ids';
  var KEY_PREFIX = 'imported_book:';

  // ── 工具函数 ──
  function generateId() {
    // 添加随机后缀防止同一毫秒内多次导入产生 ID 碰撞
    return 'imported-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
  }

  function escAttr(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;')
                     .replace(/</g, '&lt;')
                     .replace(/>/g, '&gt;')
                     .replace(/"/g, '&quot;')
                     .replace(/'/g, '&#39;');
  }

  // ── 零宽字符清理（MD/TXT 导入预处理，与构建端 convert-bundled.js 共用）──
  // 清理 BOM（U+FEFF）和零宽空格/连接符等不可见字符，避免渲染异常
  function cleanInvisibleChars(str) {
    if (!str) return str;
    return str.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, '');
  }

  // ── HTML 实体解码（escAttr / escHtml 的逆操作）──
  // 用于 processEpubImages 从 html 字符串提取 img src 后的实体解码，
  // 避免文件名含 & < > " ' 等特殊字符时无法匹配 zip 路径
  function decodeHtmlEntities(s) {
    if (!s) return '';
    return String(s).replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
  }

  // ── duokan-footnote 引用内部 HTML 提取（公共逻辑）──
  // 保留原始 EPUB 的 <img> 图标（含 alt/src/class，alt 用于无障碍访问）；
  // 若 <a> 内无 <img> 子节点则回退为 <span class="bk-epub-fn-ref-text">†</span>
  // 供 import-html-converter.js 和 import-epub-style.js 复用，避免逻辑重复
  function extractDuokanFnRefInner(aNode) {
    var fnRefImg = null;
    for (var i = 0; i < aNode.childNodes.length; i++) {
      var child = aNode.childNodes[i];
      if (child.nodeType === 1 && (child.tagName || '').toLowerCase() === 'img') {
        fnRefImg = child;
        break;
      }
    }
    if (fnRefImg) {
      var src = fnRefImg.getAttribute('src') || '';
      var cls = fnRefImg.getAttribute('class') || '';
      var alt = fnRefImg.getAttribute('alt') || '';
      var attrs = '';
      if (cls) attrs += ' class="' + escAttr(cls) + '"';
      if (alt) attrs += ' alt="' + escAttr(alt) + '"';
      if (src) attrs += ' src="' + escAttr(src) + '"';
      return '<img' + attrs + '>';
    }
    return '<span class="bk-epub-fn-ref-text">†</span>';
  }

  // ── 章节分割正则（移植自 txt_parser.py）──
  // 66卷圣经卷名简称（中文），复合名排在单字名前以避免前缀匹配
  var BIBLE_BOOK_ABBR = '林前|林后|约壹|约贰|约叁|帖前|帖后|提前|提后|彼前|彼后|撒上|撒下|王上|王下|代上|代下|太|可|路|约|徒|罗|加|弗|腓|西|多|门|来|雅|犹|启|创|出|利|民|申|书|士|得|拉|尼|斯|伯|诗|箴|传|歌|赛|耶|哀|结|但|何|珥|摩|俄|拿|弥|鸿|哈|番|该|亚|玛';
  var chapterPatterns = [
    /^第[零一二三四五六七八九十百千\d]+[章节回部篇集卷]\s*(.*)$/,
    /^第\s*[零一二三四五六七八九十百千\d]+\s*[章节回部篇集卷]\s*(.*)$/,
    /^(?:CHAPTER|Chapter|chapter)\s+\d+\s*(.*)$/,
    // 圣经卷名+章号格式（如「太1 «Prev Next»」），要求 «...» 导航标记避免误匹配计划表中的独立「启203」等行
    new RegExp('^(' + BIBLE_BOOK_ABBR + ')(\\d+)\\s*«.*»\\s*$')
  ];
  var separatorRe = /^[=\-—–]{3,}\s*$/;

  function matchChapterHeading(line) {
    var stripped = line.trim();
    if (!stripped) return null;
    for (var p = 0; p < chapterPatterns.length; p++) {
      if (chapterPatterns[p].test(stripped)) {
        // 去除 «Prev Next» 等导航标记，只保留卷名+章号
        return stripped.replace(/\s*«.*»\s*$/, '');
      }
    }
    return null;
  }
