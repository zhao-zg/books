'use strict';

  // ── HTML→Content 转换（EPUB 和 MD 共用）──
  function htmlToContents(htmlStr, cssMap, spineHrefMap, currentBasename) {
    var parser = new DOMParser();

    // EPUB 章节可能是完整的 XHTML 文档（含 <?xml?> 声明、<html>/<head>/<body>），
    // 也可能是 HTML 片段。如果是完整文档，需要先提取 body 内容再解析，
    // 否则直接包在 <div> 中用 text/html 解析会导致标签嵌套混乱，
    // 尤其 <?xml?> 声明会被当作文本，<head> 中的 <title> 可能混入内容。
    var isFullDoc = /^\s*<\?xml[\s>]/i.test(htmlStr) ||
                    /^\s*<html[\s>]/i.test(htmlStr);
    var fragmentHtml;
    if (isFullDoc) {
      // 优先用正则提取 <body>...</body> 之间的内容。
      // 原因：JSDOM 的 outerHTML/XMLSerializer 在序列化 application/xhtml+xml
      // 解析出的节点时，会把带命名空间前缀的属性（如 epub:type）重映射为
      // 自动生成的前缀（如 ns1:type），导致后续 text/html 解析无法识别
      // aside[epub:type="footnote"]，脚注被误判为普通 list。
      // 正则提取保留原始属性名，在浏览器和 JSDOM 中行为一致。
      var bodyMatch = htmlStr.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        fragmentHtml = bodyMatch[1];
      } else {
        // fallback: 用 application/xhtml+xml 解析完整 XHTML 文档，提取 body
        var xdoc = parser.parseFromString(htmlStr, 'application/xhtml+xml');
        var xbody = xdoc.getElementsByTagName('body')[0];
        if (xbody) {
          // 序列化 body 内容为 HTML 字符串
          fragmentHtml = '';
          for (var bi = 0; bi < xbody.childNodes.length; bi++) {
            fragmentHtml += serializeNode(xbody.childNodes[bi]);
          }
        } else {
          fragmentHtml = htmlStr;
        }
      }
    } else {
      fragmentHtml = htmlStr;
    }

    var doc = parser.parseFromString('<div>' + fragmentHtml + '</div>', 'text/html');
    var root = doc.body.firstChild || doc.body;
    var contents = [];
    // EPUB duokan-footnote 收集数组：<aside epub:type="footnote"> 提取后暂存于此，
    // walk 完成后统一追加为章节脚注区域
    var epubFootnotes = [];
    var epubFnCounter = 0;
    // 标记是否在 aside footnote 内部：此时 ol/li 不做列表聚合，递归子节点以保留 p 结构
    var insideEpubFootnote = false;

    function getNodeStyle(node) {
      if (!cssMap) return '';
      var cls = node.getAttribute('class') || '';
      return cls ? lookupCssStyle(cssMap, cls) : '';
    }

    // 从节点的 class 列表中检测 EPUB 特殊语义类（calibre_* 系列），
    // 返回语义标签（如 'dadian','zhongdian' 等）或空字符串
    function detectEpubClass(node) {
      var cls = (node.getAttribute('class') || '').split(/\s+/);
      for (var i = 0; i < cls.length; i++) {
        switch (cls[i]) {
          case 'calibre_text_dadian':    return 'dadian';      // 大点 壹贰叁
          case 'calibre_text_zhongdian': return 'zhongdian';   // 中点 一二三
          case 'calibre_text_xiaodian':  return 'xiaodian';    // 小点 1 2 3
          case 'calibre_text_zimudian':  return 'zimudian';    // 字母点 a b c
          case 'calibre_text_kuohaodian': return 'kuohaodian'; // 括号点
          case 'calibre_text_gangmu_wn': return 'gangmu_wn';   // 周几导航标签
          case 'calibre_text_chenxing_content_wn':  return 'chenxing_wn';  // 晨兴周几标签
          case 'calibre_text_chenxing_content_wyxd': return 'chenxing_wyxd'; // 晨兴喂养/信息选读标题
          case 'calibre_text_chenxing_verse': return 'chenxing_verse'; // 禱读经文
          case 'calibre_text_chenxing_content': return 'chenxing_content'; // 晨兴正文
          case 'calibre_verse': return 'verse';          // 脚注经文内容
          case 'calibre_text_verse': return 'verse_text';     // 读经行
          case 'calibre_zongti': return 'zongti';             // 总题
          case 'calibre_content_title': return 'content_title'; // 篇题
          case 'calibre7': return 'chenxing_box';              // 晨兴喂养背景框
        }
      }
      return '';
    }

    function walk(node) {
      if (node.nodeType === 3) { // 文本节点
        var t = (node.textContent || '').trim();
        if (t) contents.push({ type: 'paragraph', text: t });
        return;
      }
      if (node.nodeType !== 1) return; // 非元素节点

      var tag = (node.tagName || '').toLowerCase();
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          var level = parseInt(tag.charAt(1), 10);
          var hText = (node.textContent || '').trim();
          var hHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          var hStyle = getNodeStyle(node);
          if (hText) contents.push({ type: 'heading', text: hText, html: hHtml, level: level, style: hStyle });
          break;
        case 'p':
          var img = node.querySelector('img');
          // 判断 img 是否只是装饰性图标（如 EPUB 脚注引用图标）而非段落主内容
          var imgIsDecorative = false;
          if (img) {
            // 脚注引用图标通常嵌套在 <a epub:type="noteref"> 或 <a class="duokan-footnote"> 内，
            // 且常有 class="footnote_img" 或 alt="note"
            var imgParent = img.parentElement;
            if (imgParent && imgParent.tagName && imgParent.tagName.toLowerCase() === 'a') {
              var aRel = imgParent.getAttribute('epub:type') || '';
              var aCls = imgParent.className || '';
              if (aRel === 'noteref' || /\bduokan-footnote\b/.test(aCls)) {
                imgIsDecorative = true;
              }
            }
            // 也检查 img 自身的 class/alt
            var imgCls = img.className || '';
            var imgAlt = (img.getAttribute('alt') || '').toLowerCase();
            if (/\bfootnote_img\b/.test(imgCls) || imgAlt === 'note') {
              imgIsDecorative = true;
            }
          }
          if (img && !imgIsDecorative) {
            // 检查 img 是否被 <a> 包裹（如 MD 图片链接 [![alt](src)](href)）
            var imgLinkUrl = '';
            var imgParentA = img.parentElement;
            if (imgParentA && imgParentA.tagName && imgParentA.tagName.toLowerCase() === 'a') {
              var aHref = imgParentA.getAttribute('href') || '';
              var aType = imgParentA.getAttribute('epub:type') || '';
              var aCls = imgParentA.className || '';
              // 排除脚注链接，只保留普通链接
              if (aHref && aType !== 'noteref' && !/\bduokan-footnote\b/.test(aCls)) {
                imgLinkUrl = aHref;
              }
            }
            contents.push({
              type: 'image',
              src: img.getAttribute('src') || '',
              attrs: { alt: img.getAttribute('alt') || '' },
              linkUrl: imgLinkUrl || undefined
            });
          } else {
            // 检查是否为纯 KaTeX display math 段落
            // 仅当段落只包含 .katex-display 元素时，才作为 math 类型
            // 行内公式（.katex 非 .katex-display）与文字混合时作为普通段落
            var katexDisplay = node.querySelector('.katex-display');
            var isPureMath = false;
            if (katexDisplay) {
              // 检查段落是否几乎全是公式（只有空白/换行文字）
              var plainText = (node.textContent || '').replace(/[\s\n\r]/g, '');
              // 如果去掉空白后文字很短（display math 通常只有很少的纯文本），视为纯公式
              // 更可靠的方式：检查直接子节点是否只有 .katex-display
              var childNodes = node.childNodes;
              var hasSignificantText = false;
              for (var ci = 0; ci < childNodes.length; ci++) {
                var cn = childNodes[ci];
                if (cn.nodeType === 3 && cn.textContent.trim().length > 0) {
                  hasSignificantText = true;
                  break;
                }
              }
              isPureMath = !hasSignificantText;
            }
            if (isPureMath) {
              var mathHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
              if (mathHtml) contents.push({ type: 'math', html: mathHtml });
            } else {
              var pText = (node.textContent || '').trim();
              var pHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
              var pStyle = getNodeStyle(node);
              // 检测 EPUB 特殊 CSS 类，语义化映射
              var epubCls = detectEpubClass(node);
              if (pText) {
                var pItem = { type: 'paragraph', text: pText, html: pHtml, style: pStyle };
                if (epubCls) pItem.epubClass = epubCls;
                // 语义类型提升：特定 EPUB 类映射到更合适的 Content 类型
                if (epubCls === 'zongti' || epubCls === 'content_title') {
                  pItem.type = 'heading';
                  pItem.level = epubCls === 'zongti' ? 2 : 3;
                } else if (epubCls === 'chenxing_wyxd') {
                  pItem.type = 'heading';
                  pItem.level = 3;
                } else if (epubCls === 'chenxing_wn' || epubCls === 'gangmu_wn') {
                  pItem.type = 'heading';
                  pItem.level = 4;
                } else if (epubCls === 'chenxing_verse') {
                  pItem.type = 'quote';
                }
                contents.push(pItem);
              }
            }
          }
          break;
        case 'div':
        case 'span':
          var dsText = (node.textContent || '').trim();
          if (dsText) {
            // 检测 EPUB 特殊语义类（如 calibre7 晨兴喂养背景框）
            var dsEpubCls = detectEpubClass(node);
            // div/span 可能只是容器，递归子节点
            var hasBlock = false;
            for (var ci = 0; ci < node.children.length; ci++) {
              var ct = node.children[ci].tagName.toLowerCase();
              if (['p','div','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','pre','hr','table'].indexOf(ct) >= 0) {
                hasBlock = true; break;
              }
            }
            if (hasBlock) {
              // 晨兴喂养背景框：标记容器边界，子项继承 epubClass
              if (dsEpubCls === 'chenxing_box') {
                var boxStart = contents.length;
                for (var ci2 = 0; ci2 < node.childNodes.length; ci2++) walk(node.childNodes[ci2]);
                // 为 box 内的子项添加背景框标记
                for (var bi = boxStart; bi < contents.length; bi++) {
                  if (!contents[bi].epubClass) contents[bi].epubClass = 'chenxing_box';
                }
              } else {
                for (var ci2 = 0; ci2 < node.childNodes.length; ci2++) walk(node.childNodes[ci2]);
              }
            } else {
              var dsStyle = getNodeStyle(node);
              var dsItem = { type: 'paragraph', text: dsText, html: extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim(), style: dsStyle };
              if (dsEpubCls) dsItem.epubClass = dsEpubCls;
              contents.push(dsItem);
            }
          }
          break;
        case 'blockquote':
          var qText = (node.textContent || '').trim();
          var qHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          var qStyle = getNodeStyle(node);
          if (qText) contents.push({ type: 'quote', text: qText, html: qHtml, style: qStyle });
          break;
        case 'img':
          contents.push({
            type: 'image',
            src: node.getAttribute('src') || '',
            attrs: { alt: node.getAttribute('alt') || '' }
          });
          break;
        case 'ul':
        case 'ol':
          // 在 EPUB 脚注内部，ol/li 直接递归子节点，不做列表聚合
          // （脚注内容是 <ol><li><p> 结构，需要保留 p 的段落结构）
          if (insideEpubFootnote) {
            for (var oli = 0; oli < node.childNodes.length; oli++) walk(node.childNodes[oli]);
            break;
          }
          var items = [];
          var itemHtmls = [];
          var checkboxes = null; // 任务列表 checkbox 状态
          // 检查 ol 是否带有 list-style:none（如 duokan-footnote-content），有则视为无序
          var olStyle = (node.getAttribute('style') || '').toLowerCase();
          var forceUnordered = tag === 'ol' && /\blist-style\s*:\s*none\b/.test(olStyle);
          var lis = node.querySelectorAll('li');
          for (var li = 0; li < lis.length; li++) {
            // 任务列表：检测 <input type="checkbox">
            var cbInput = lis[li].querySelector('input[type="checkbox"]');
            if (cbInput) {
              if (!checkboxes) checkboxes = [];
              checkboxes.push(!!cbInput.checked);
            }
            var liText = (lis[li].textContent || '').trim();
            var liHtml = extractInlineHtml(lis[li], cssMap, spineHrefMap, currentBasename).trim();
            if (liText) { items.push(liText); itemHtmls.push(liHtml); }
          }
          if (items.length) {
            var listItem = { type: 'list', items: items, itemHtmls: itemHtmls, attrs: { ordered: tag === 'ol' && !forceUnordered } };
            if (checkboxes && checkboxes.length === items.length) listItem.checkboxes = checkboxes;
            contents.push(listItem);
          }
          break;
        case 'pre':
          var codeEl = node.querySelector('code');
          var codeText = codeEl ? (codeEl.textContent || '') : (node.textContent || '');
          // 提取语言类名 (language-xxx)
          var codeLang = '';
          if (codeEl) {
            var codeClasses = (codeEl.getAttribute('class') || '').split(/\s+/);
            for (var cli = 0; cli < codeClasses.length; cli++) {
              var clm = codeClasses[cli].match(/^language-(.+)$/);
              if (clm) { codeLang = clm[1]; break; }
            }
          }
          // Mermaid 图表：创建 mermaid 内容项，延迟渲染
          if (codeLang === 'mermaid') {
            contents.push({ type: 'mermaid', text: codeText.trim() });
            break;
          }
          // 保留 hljs 高亮后的 innerHTML（如果有的话）
          var codeHtml = (codeEl && codeEl.innerHTML) ? codeEl.innerHTML : '';
          contents.push({ type: 'code', text: codeText.trim(), html: codeHtml, attrs: { language: codeLang } });
          break;
        case 'code':
          // 不在 pre 内的 inline code
          if (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre') {
            contents.push({ type: 'paragraph', text: '`' + (node.textContent || '').trim() + '`' });
          }
          break;
        case 'hr':
          contents.push({ type: 'separator' });
          break;
        case 'table':
          var trs = node.querySelectorAll('tr');
          var tRows = [];
          for (var ri = 0; ri < trs.length; ri++) {
            var tCells = trs[ri].querySelectorAll('th, td');
            var rowData = [];
            var rowIsHeader = false;
            for (var ci3 = 0; ci3 < tCells.length; ci3++) {
              var cellEl = tCells[ci3];
              var cellTag = (cellEl.tagName || '').toLowerCase();
              if (cellTag === 'th') rowIsHeader = true;
              rowData.push({
                text: (cellEl.textContent || '').trim(),
                    html: extractInlineHtml(cellEl, cssMap, spineHrefMap, currentBasename).trim()
              });
            }
            if (rowData.length) {
              tRows.push({ header: rowIsHeader, cells: rowData });
            }
          }
          if (tRows.length) {
            contents.push({ type: 'table', rows: tRows });
          }
          break;
        case 'br':
          // 保留换行：追加 linebreak 内容项
          // 如果前一项是 paragraph，可直接在其 html 末尾追加 <br>
          var brLast = contents.length ? contents[contents.length - 1] : null;
          if (brLast && brLast.type === 'paragraph' && brLast.html) {
            brLast.html += '<br>';
          } else {
            contents.push({ type: 'linebreak' });
          }
          break;
        case 'aside':
          // EPUB duokan-footnote：<aside epub:type="footnote"> 或 class 含 duokan-footnote
          var isEpubFn = (node.getAttribute('epub:type') === 'footnote') ||
                         (node.classList && node.classList.contains('duokan-footnote'));
          if (isEpubFn) {
            epubFnCounter++;
            var fnId = node.getAttribute('id') || ('epubfn' + epubFnCounter);
            // 提取脚注内容：将子节点递归为 Content 项
            var fnContents = [];
            var savedContents = contents;
            var savedInsideFn = insideEpubFootnote;
            contents = fnContents;
            insideEpubFootnote = true;
            for (var afi = 0; afi < node.childNodes.length; afi++) {
              walk(node.childNodes[afi]);
            }
            contents = savedContents;
            insideEpubFootnote = savedInsideFn;
            epubFootnotes.push({ id: fnId, content: fnContents });
            break;
          }
          // 非 duokan-footnote 的 aside，递归子节点
          for (var asi = 0; asi < node.childNodes.length; asi++) walk(node.childNodes[asi]);
          break;
        case 'section':
          // 脚注区域 (.bk-footnotes-section)
          if (node.classList && node.classList.contains('bk-footnotes-section')) {
            var fnHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            if (fnHtml) {
              contents.push({ type: 'footnotes_section', html: fnHtml });
            }
            break;
          }
          // 其他 section 递归子节点
          for (var si = 0; si < node.childNodes.length; si++) walk(node.childNodes[si]);
          break;
        case 'sup':
          // 脚注引用 (.bk-fn-ref)
          if (node.classList && node.classList.contains('bk-fn-ref')) {
            var fnRefHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            contents.push({ type: 'footnote_ref', html: fnRefHtml });
            break;
          }
          // 其他 sup 递归
          for (var supi = 0; supi < node.childNodes.length; supi++) walk(node.childNodes[supi]);
          break;
        case 'a':
          // EPUB duokan-footnote 行内引用：<a class="duokan-footnote" href="#fn1">
          var isDuokanFnRef = node.classList && node.classList.contains('duokan-footnote');
          if (isDuokanFnRef) {
            var fnRefHref = node.getAttribute('href') || '';
            var fnRefId = fnRefHref.replace(/^#/, '') || '';
            // 保留原始 EPUB 的脚注引用标记：提取 <a> 内部的 <img> 图标（如 MDC 的 verse.png）
            // 若无 img 子节点则回退为 † 占位文本
            var fnRefInner = '';
            var fnRefImg = null;
            for (var fri = 0; fri < node.childNodes.length; fri++) {
              var fnChild = node.childNodes[fri];
              if (fnChild.nodeType === 1 && (fnChild.tagName || '').toLowerCase() === 'img') {
                fnRefImg = fnChild;
                break;
              }
            }
            if (fnRefImg) {
              var imgSrc = fnRefImg.getAttribute('src') || '';
              var imgClass = fnRefImg.getAttribute('class') || '';
              var imgClsAttr = imgClass ? ' class="' + escAttr(imgClass) + '"' : '';
              fnRefInner = '<img' + imgClsAttr + ' src="' + escAttr(imgSrc) + '">';
            } else {
              fnRefInner = '†';
            }
            contents.push({
              type: 'footnote_ref',
              footnoteId: fnRefId,
              text: '',
              html: '<sup class="bk-epub-fn-ref" data-fn-id="' + escAttr(fnRefId) + '">' + fnRefInner + '</sup>'
            });
            break;
          }
          // 普通 <a> 链接：保留行内 HTML（含 href），作为段落内联内容
          var aText = (node.textContent || '').trim();
          if (aText) {
            var aHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            // 如果已有前一个 paragraph 项，尝试追加到其 html 末尾
            var lastItem = contents.length ? contents[contents.length - 1] : null;
            if (lastItem && lastItem.type === 'paragraph' && lastItem.html) {
              lastItem.html += ' ' + aHtml;
              lastItem.text += ' ' + aText;
            } else {
              contents.push({ type: 'paragraph', text: aText, html: aHtml, style: '' });
            }
          }
          break;
        case 'span':
          // KaTeX 渲染后的 .katex 元素
          if (node.classList && node.classList.contains('katex')) {
            var katexHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            if (katexHtml) contents.push({ type: 'math', html: katexHtml });
            break;
          }
          // 其他 span 走通用 div/span 逻辑
          var spText = (node.textContent || '').trim();
          if (spText) {
            var spStyle = getNodeStyle(node);
            contents.push({ type: 'paragraph', text: spText, html: extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim(), style: spStyle });
          }
          break;
        case 'script':
        case 'style':
        case 'noscript':
        case 'head':
        case 'meta':
        case 'link':
          // 跳过非内容标签
          break;
        default:
          // 未知标签，递归子节点
          for (var di = 0; di < node.childNodes.length; di++) walk(node.childNodes[di]);
      }
    }

    for (var i = 0; i < root.childNodes.length; i++) {
      walk(root.childNodes[i]);
    }

    // EPUB duokan-footnote 收尾：将收集的脚注作为章节脚注区域追加
    // 关联行内 footnote_ref 的 footnoteId 与 epubFootnotes 的 id
    if (epubFootnotes.length) {
      var fnItems = [];
      for (var fi = 0; fi < epubFootnotes.length; fi++) {
        var efn = epubFootnotes[fi];
        // 将脚注子内容渲染为 HTML 片段
        var efnHtml = '';
        for (var eci = 0; eci < efn.content.length; eci++) {
          var ecItem = efn.content[eci];
          if (ecItem.type === 'paragraph') {
            // 段落用 <p> 包裹，保留 epubClass
            var pCls = ecItem.epubClass ? ' class="bk-epub-' + ecItem.epubClass + '"' : '';
            efnHtml += '<p' + pCls + '>' + (ecItem.html || ecItem.text || '') + '</p>';
          } else if (ecItem.type === 'heading') {
            efnHtml += '<strong>' + (ecItem.html || ecItem.text || '') + '</strong><br>';
          } else if (ecItem.type === 'linebreak') {
            efnHtml += '<br>';
          } else if (ecItem.html) {
            efnHtml += ecItem.html;
          } else if (ecItem.text) {
            efnHtml += ecItem.text;
          }
        }
        var efnFallbackText = efn.content.map(function(c) { return c.text || ''; }).join(' ');
        if (efnHtml || efn.content.length) {
          fnItems.push({
            type: 'footnote',
            attrs: { id: efn.id },
            text: efnFallbackText,
            html: efnHtml || efnFallbackText
          });
        }
      }
      if (fnItems.length) {
        contents.push({ type: 'footnotes_section', footnoteRefs: fnItems });
      }
      // 为行内 footnote_ref 关联脚注编号（用于渲染时对应）
      // 保留原始引用标记（<img> 图标或 † 回退文本），不做覆盖
      var fnIdMap = {};
      for (var fmi = 0; fmi < epubFootnotes.length; fmi++) {
        fnIdMap[epubFootnotes[fmi].id] = fmi + 1;
      }
      for (var ci6 = 0; ci6 < contents.length; ci6++) {
        if (contents[ci6].type === 'footnote_ref' && contents[ci6].footnoteId) {
          // 仅验证存在对应脚注并记录编号，保留原始引用标记（img 图标或 † 回退）
          if (fnIdMap[contents[ci6].footnoteId]) {
            contents[ci6].footnoteRefIndex = fnIdMap[contents[ci6].footnoteId];
          }
        }
      }
    }

    return contents;
  }
