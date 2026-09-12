'use strict';

  // ── 批量导入（给定 fileInfo 数组，逐个调用 importFromBuffer）──
  function importBatch(fileInfos, opts) {
    opts = opts || {};
    var results = [];
    var chain = Promise.resolve();
    for (var i = 0; i < fileInfos.length; i++) {
      (function(info, idx) {
        chain = chain.then(function() {
          return importFromBuffer(info, { source: { type: 'local' } }).then(function(book) {
            results.push({ success: true, book: book, name: info.name });
          }).catch(function(err) {
            results.push({ success: false, error: (err && err.message) || '未知错误', name: info.name });
          });
        });
      })(fileInfos[i], i);
    }
    return chain.then(function() { return results; });
  }

  // ── TXT 解析 ──
  function parseTxt(text, fileName) {
    var lines = text.split(/\r?\n/);
    if (!lines.length) throw new Error('TXT 文件为空');

    // ★ 清理 AIGC 水印行和零宽字符行（开发环境自动注入）
    // 1. 移除仅含零宽字符/不可见字符的行
    // 2. 移除 "> AI生成" 等标记行
    // 3. 移除纯元数据行（作者、来源等）——仅清理首部出现的
    for (var ci = 0; ci < lines.length; ci++) {
      var cl = lines[ci].trim();
      // 零宽字符行（整行无可见字符）
      if (cl && !cl.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g, '')) {
        lines[ci] = '';
        continue;
      }
      // 首部元数据行（作者、来源等）
      if (/^(作者|author|来源|source|整理|编者)\s*[：:]/i.test(cl)) {
        lines[ci] = '';
        continue;
      }
      // AIGC 水印行（首部）
      if (/^\s*>?\s*AI\s*生[成成]/i.test(cl)) {
        lines[ci] = '';
        continue;
      }
      // 遇到第一个非空非元数据行，停止首部清理
      if (cl) break;
    }
    // 清除尾部 AIGC 水印（"AI生成"、"AI 生成"等）
    for (var ci2 = lines.length - 1; ci2 >= 0; ci2--) {
      var cl2 = lines[ci2].trim();
      if (/^\s*>?\s*AI\s*生[成成]/i.test(cl2)) {
        lines[ci2] = '';
      } else if (cl2) {
        break;
      }
    }

    // ★ 书名直接使用文件名（去扩展名），不再从内容中智能检测
    // （内容检测容易把无关短行误识别为书名，导致乱码或错误标题）
    var bookTitle = fileName.replace(/\.txt$/i, '');
    var contentLines = lines;

    // ★ 跳过第一个章节标题之前的所有前导行
    // （可能是 AIGC 水印、元数据等，不应成为独立章节）
    var firstHeadingIdx = -1;
    for (var fhi = 0; fhi < contentLines.length; fhi++) {
      if (matchChapterHeading(contentLines[fhi])) {
        firstHeadingIdx = fhi;
        break;
      }
    }
    // 只在有2个以上章节标题时才跳过前导行（避免把无章节结构的整本书截断）
    if (firstHeadingIdx > 0) {
      var headingCount = 0;
      for (var hci = firstHeadingIdx; hci < contentLines.length; hci++) {
        if (matchChapterHeading(contentLines[hci])) headingCount++;
      }
      if (headingCount >= 2) {
        contentLines = contentLines.slice(firstHeadingIdx);
      }
    }

    // 按章节标题、分隔线、双空行依次尝试分割
    var segments = splitByHeading(contentLines);
    if (!segments) segments = splitBySeparator(contentLines);
    if (!segments) segments = splitByDoubleBlank(contentLines);

    // 构建 Book 对象
    var bookId = generateId();
    var chapters = [];
    if (segments) {
      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        var contents = linesToContents(seg.lines);
        if (contents.length) {
          chapters.push({
            number: chapters.length + 1,
            title: seg.title || ('第' + (chapters.length + 1) + '章'),
            content: contents,
            footnotes: []
          });
        }
      }
    }

    if (!chapters.length) {
      chapters.push({
        number: 1,
        title: bookTitle,
        content: linesToContents(contentLines),
        footnotes: []
      });
    }

    return {
      id: bookId,
      title: bookTitle,
      author: '',
      format: 'txt',
      cover: '',
      language: 'zh',
      description: '',
      chapters: chapters
    };
  }

  // TXT 内部辅助：按章节标题分割
  function splitByHeading(lines) {
    var segments = [], currentTitle = '', currentLines = [];
    for (var i = 0; i < lines.length; i++) {
      var heading = matchChapterHeading(lines[i]);
      if (heading) {
        if (currentLines.length) segments.push({ title: currentTitle, lines: currentLines });
        currentTitle = heading;
        currentLines = [];
      } else {
        currentLines.push(lines[i]);
      }
    }
    if (currentLines.length) segments.push({ title: currentTitle, lines: currentLines });
    var matchedCount = 0;
    for (var j = 0; j < segments.length; j++) {
      if (segments[j].title) matchedCount++;
    }
    return matchedCount >= 2 ? segments : null;
  }

  // TXT 内部辅助：按分隔线分割
  function splitBySeparator(lines) {
    var segments = [], currentLines = [];
    for (var i = 0; i < lines.length; i++) {
      if (separatorRe.test(lines[i].trim())) {
        if (currentLines.length) segments.push({ title: '', lines: currentLines });
        currentLines = [];
      } else {
        currentLines.push(lines[i]);
      }
    }
    if (currentLines.length) segments.push({ title: '', lines: currentLines });
    if (segments.length < 2) return null;
    // 提取标题：每段第一行非空行
    for (var j = 0; j < segments.length; j++) {
      if (!segments[j].title) {
        for (var k = 0; k < segments[j].lines.length; k++) {
          var s = segments[j].lines[k].trim();
          if (s) {
            segments[j].title = s;
            segments[j].lines = segments[j].lines.slice(k + 1);
            break;
          }
        }
      }
    }
    return segments;
  }

  // TXT 内部辅助：按双空行分割
  function splitByDoubleBlank(lines) {
    var segments = [], currentLines = [], blankCount = 0;
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) {
        blankCount++;
        if (blankCount >= 2 && currentLines.length) {
          segments.push({ title: '', lines: currentLines });
          currentLines = [];
          blankCount = 0;
        } else {
          currentLines.push(lines[i]);
        }
      } else {
        blankCount = 0;
        currentLines.push(lines[i]);
      }
    }
    if (currentLines.length) segments.push({ title: '', lines: currentLines });
    // 提取标题
    for (var j = 0; j < segments.length; j++) {
      for (var k = 0; k < segments[j].lines.length; k++) {
        var s = segments[j].lines[k].trim();
        if (s) {
          if (!segments[j].title) segments[j].title = s;
          break;
        }
      }
    }
    return segments;
  }

  // TXT 内部辅助：行列表转 content 数组
  function linesToContents(lines) {
    var contents = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line) contents.push({ type: 'paragraph', text: line });
    }
    return contents;
  }
