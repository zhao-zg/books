'use strict';

  // ── Markdown 解析 ──
  function parseMd(text, fileName) {
    // 提取 YAML frontmatter（循环剥离多个连续的 ---...--- 块，含 AIGC 水印等）
    var meta = {};
    var mdContent = text;
    var fmMatch;
    while ((fmMatch = mdContent.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/))) {
      // 简单解析 YAML key: value
      var yamlLines = fmMatch[1].split(/\r?\n/);
      for (var yi = 0; yi < yamlLines.length; yi++) {
        var ym = yamlLines[yi].match(/^(\w+)\s*:\s*(.+)$/);
        if (ym) meta[ym[1].trim()] = ym[2].trim().replace(/^['"]|['"]$/g, '');
      }
      mdContent = fmMatch[2];
    }

    // 清理尾部 AIGC 水印引用块（如 "> AI生成"、"> AI 生成"、"?> AI生成内容" 等）
    // 全局清除所有 AIGC 水印行（可能在文档中多处出现）
    mdContent = mdContent.replace(/^\s*>+\s*AI\s*生[成成].*$/gim, '');

    var bookTitle = meta.title || fileName.replace(/\.md$/i, '');
    var author = meta.author || '';
    var description = meta.description || '';

    // 用 marked 转 HTML
    var html = '';
    if (win.marked) {
      // ── KaTeX 预处理：在 marked 之前保护 $...$ 和 $$...$$ ──
      var mathSpans = [];
      var mathProtected = mdContent.replace(/\$\$([\s\S]+?)\$\$/g, function(m) {
        mathSpans.push({ display: true, expr: m.slice(2, -2) });
        return '%%MATH' + (mathSpans.length - 1) + '%%';
      });
      mathProtected = mathProtected.replace(/\$([^\$\n]+?)\$/g, function(m, p1) {
        mathSpans.push({ display: false, expr: p1 });
        return '%%MATH' + (mathSpans.length - 1) + '%%';
      });

      // ── 脚注预处理：两遍扫描 ──
      // 第一遍：提取所有脚注定义 [^label]: content，并替换为空行
      var footnotes = {};
      var fnIndex = 0;
      var fnReplaced = mathProtected.replace(/^\[\^([^\]]+)\]\:\s*(.+)$/gm, function(m, label, text) {
        if (!footnotes[label]) {
          footnotes[label] = { id: ++fnIndex, text: text.trim() };
        }
        return '';  // 定义行移除，不留痕迹
      });

      // 第二遍：将 [^label] 引用替换为带标记的 HTML（在 marked 之前处理）
      fnReplaced = fnReplaced.replace(/\[\^([^\]]+)\]/g, function(m, label) {
        if (footnotes[label]) {
          var fid = footnotes[label].id;
          return '<sup class="bk-fn-ref"><a href="#fn-' + fid + '">' + fid + '</a></sup>';
        }
        return m;  // 未定义的脚注保持原样
      });

      // ── Tab 缩进预处理：防止行首 \t 被 marked 误判为代码块 ──
      // 策略：保护已有的 fenced code block，将非代码块中的行首 \t 替换为缩进标记
      var fencedBlocks = [];
      var tabSafe = fnReplaced.replace(/```[\s\S]*?```/g, function(m) {
        fencedBlocks.push(m);
        return '%%FENCED' + (fencedBlocks.length - 1) + '%%';
      });
      // 将行首的 \t 替换为缩进标记（保留缩进层级信息）
      tabSafe = tabSafe.replace(/^(\t+)(.+)$/gm, function(m, tabs, content) {
        var level = tabs.length;
        return '%%INDENT' + level + '%%' + content;
      });
      // 恢复 fenced code blocks
      for (var fbi = 0; fbi < fencedBlocks.length; fbi++) {
        tabSafe = tabSafe.replace('%%FENCED' + fbi + '%%', fencedBlocks[fbi]);
      }

      // ── ++text++ 特殊格式预处理：转为 <mark> 标签 ──
      var markProcessed = tabSafe.replace(/\+\+(.+?)\+\+/g, '<mark class="bk-mark-highlight">$1</mark>');

      // ── 中文大纲编号预处理：为中文编号行添加层级缩进标记 ──
      // 检测常见的中文大纲编号模式：壹/贰/叁/肆(1级)、一/二/三/四(2级)、1/2/3/4(3级)、a/b/c(4级)
      var outlineProcessed = markProcessed.replace(/^((?:壹|貳|叁|肆|伍|陸|柒|捌|玖|拾|壹|贰|叁|肆|伍|陆|柒|捌|玖|拾)[\s、．\.].+)$/gm, function(m) {
        return '%%OUTLINE1%%' + m;
      });
      outlineProcessed = outlineProcessed.replace(/^((?:一|二|三|四|五|六|七|八|九|十)[\s、．\.].+)$/gm, function(m) {
        return '%%OUTLINE2%%' + m;
      });
      outlineProcessed = outlineProcessed.replace(/^(\d+[\s、．\.].+)$/gm, function(m) {
        return '%%OUTLINE3%%' + m;
      });
      outlineProcessed = outlineProcessed.replace(/^([a-z][\s、．\.].+)$/gm, function(m) {
        return '%%OUTLINE4%%' + m;
      });

      // ── 配置 marked.use()：代码高亮 ──
      var markedOpts = {
        gfm: true,
        breaks: true   // 单个换行符产生 <br>，避免连续行被合并为一个段落
      };

      // 代码高亮：调用 highlight.js
      if (win.hljs) {
        markedOpts.highlight = function(code, lang) {
          if (lang && win.hljs.getLanguage(lang)) {
            try { return win.hljs.highlight(code, { language: lang }).value; } catch (e) {}
          }
          try { return win.hljs.highlightAuto(code).value; } catch (e) {}
          return code;
        };
      }

      try {
        win.marked.use(markedOpts);
      } catch (e) {
        // marked.use 失败时降级
      }

      var parsedHtml = typeof win.marked.parse === 'function'
        ? win.marked.parse(outlineProcessed)
        : win.marked(outlineProcessed);

      // ── KaTeX 后处理：将 %%MATHN%% 替换为渲染后的 HTML ──
      if (win.katex && mathSpans.length) {
        parsedHtml = parsedHtml.replace(/%%MATH(\d+)%%/g, function(m, idx) {
          var span = mathSpans[parseInt(idx, 10)];
          if (!span) return m;
          try {
            return win.katex.renderToString(span.expr, {
              displayMode: span.display,
              throwOnError: false
            });
          } catch (e) {
            return (span.display ? '$$' + span.expr + '$$' : '$' + span.expr + '$').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }
        });
      }

      // ── 缩进后处理：将 %%INDENTN%% 替换为缩进 HTML 元素 ──
      parsedHtml = parsedHtml.replace(/%%INDENT(\d+)%%/g, function(m, level) {
        var lvl = parseInt(level, 10);
        var indent = '';
        for (var ii = 0; ii < lvl; ii++) indent += '\u2003';  // em space (U+2003)
        return '<span class="bk-indent bk-indent-' + lvl + '">' + indent + '</span>';
      });

      // ── 大纲层级后处理：将 %%OUTLINEN%% 替换为层级缩进 ──
      parsedHtml = parsedHtml.replace(/%%OUTLINE(\d)%%/g, function(m, level) {
        var lvl = parseInt(level, 10);
        // 层级缩进：1级不缩进，2级1em，3级2em，4级3em
        if (lvl <= 1) return '';
        var indent = '';
        for (var oi = 1; oi < lvl; oi++) indent += '\u2003';  // em space
        return '<span class="bk-outline-indent bk-outline-' + lvl + '">' + indent + '</span>';
      });

      // ── 脚注后处理：附加脚注区域 ──
      var fnKeys = Object.keys(footnotes);
      if (fnKeys.length) {
        parsedHtml += '<section class="bk-footnotes-section"><h3 class="bk-footnotes-title">脚注</h3>';
        for (var fki = 0; fki < fnKeys.length; fki++) {
          var fk = fnKeys[fki];
          parsedHtml += '<div class="bk-footnote" id="fn-' + String(footnotes[fk].id).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '">' +
            '<span class="bk-fn-number">' + String(footnotes[fk].id).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
            '<span class="bk-fn-text">' + footnotes[fk].text + '</span></div>';
        }
        parsedHtml += '</section>';
      }

      html = parsedHtml;
    } else {
      // marked 不可用时的降级：简单转 HTML
      html = mdContent.split(/\r?\n/).map(function(line) {
        var s = line.trim();
        if (!s) return '';
        var hm = s.match(/^(#{1,6})\s+(.+)$/);
        if (hm) return '<h' + hm[1].length + '>' + hm[2] + '</h' + hm[1].length + '>';
        return '<p>' + s + '</p>';
      }).join('\n');
    }

    // HTML → Content
    var allContents = htmlToContents(html);

    // 按 h1/h2 分割章节
    var splitLevel = 0;
    var headingLevels = {};
    for (var hi = 0; hi < allContents.length; hi++) {
      if (allContents[hi].type === 'heading') headingLevels[allContents[hi].level] = true;
    }
    if (headingLevels[1]) splitLevel = 1;
    else if (headingLevels[2]) splitLevel = 2;

    var chapters = [];
    if (splitLevel > 0) {
      var currentTitle = '', currentContents = [];
      for (var ci = 0; ci < allContents.length; ci++) {
        if (allContents[ci].type === 'heading' && allContents[ci].level === splitLevel) {
          if (currentContents.length) {
            chapters.push({
              number: chapters.length + 1,
              title: currentTitle || ('第' + (chapters.length + 1) + '章'),
              content: currentContents,
              footnotes: []
            });
          }
          currentTitle = allContents[ci].text;
          currentContents = [];
        } else {
          currentContents.push(allContents[ci]);
        }
      }
      if (currentContents.length) {
        chapters.push({
          number: chapters.length + 1,
          title: currentTitle || ('第' + (chapters.length + 1) + '章'),
          content: currentContents,
          footnotes: []
        });
      }
    }

    if (!chapters.length) {
      chapters.push({
        number: 1,
        title: bookTitle,
        content: allContents.length ? allContents : [{ type: 'paragraph', text: '（无内容）' }],
        footnotes: []
      });
    }

    return {
      id: generateId(),
      title: bookTitle,
      author: author,
      format: 'md',
      cover: '',
      language: 'zh',
      description: description,
      chapters: chapters
    };
  }
