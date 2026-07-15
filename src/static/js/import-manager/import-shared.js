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

  // ── 章节分割正则（移植自 txt_parser.py）──
  var chapterPatterns = [
    /^第[零一二三四五六七八九十百千\d]+[章节回部篇集卷]\s*(.*)$/,
    /^第\s*[零一二三四五六七八九十百千\d]+\s*[章节回部篇集卷]\s*(.*)$/,
    /^(?:CHAPTER|Chapter|chapter)\s+\d+\s*(.*)$/
  ];
  var separatorRe = /^[=\-—–]{3,}\s*$/;

  function matchChapterHeading(line) {
    var stripped = line.trim();
    if (!stripped) return null;
    for (var p = 0; p < chapterPatterns.length; p++) {
      if (chapterPatterns[p].test(stripped)) return stripped;
    }
    return null;
  }
