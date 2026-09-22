'use strict';

  // ── EPUB CSS 解析（将 CSS class 规则转为 {className: styleString} 映射）──
  var CSS_VISUAL_PROPS = {
    'color': 1, 'font-weight': 1, 'font-style': 1, 'text-decoration': 1,
    'font-size': 1, 'font-family': 1, 'text-align': 1, 'text-indent': 1,
    'background-color': 1, 'border': 1, 'border-top': 1, 'border-bottom': 1,
    'border-left': 1, 'border-right': 1, 'line-height': 1,
    'margin-left': 1, 'margin-right': 1, 'padding-left': 1, 'padding-right': 1,
    'letter-spacing': 1, 'word-spacing': 1, 'vertical-align': 1
  };

  // 将 styleString 解析为 {prop: value} 对象
  function parseStyleStr(str) {
    var map = {};
    if (!str) return map;
    var parts = str.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var ci = p.indexOf(':');
      if (ci < 0) continue;
      map[p.substring(0, ci).trim()] = p.substring(ci + 1).trim();
    }
    return map;
  }

  // 将 {prop: value} 对象转为 styleString
  function buildStyleStr(map) {
    var parts = [];
    for (var k in map) { parts.push(k + ':' + map[k]); }
    return parts.join(';');
  }

  // 合并两个 styleString（后者覆盖前者）
  function mergeStyles(existing, newStyle) {
    var map = parseStyleStr(existing);
    var newMap = parseStyleStr(newStyle);
    for (var k in newMap) { map[k] = newMap[k]; }
    return buildStyleStr(map);
  }

  // 将 EPUB 中硬编码的黑/白颜色映射为 CSS 变量，使其在深色模式下自动适配
  function mapEpubColor(propName, propValue) {
    var v = (propValue || '').toLowerCase().trim();
    if (propName === 'color') {
      if (v === '#000000' || v === '#000' || v === 'black') return 'var(--text)';
    } else if (propName === 'background-color' || propName === 'background') {
      if (v === '#ffffff' || v === '#fff' || v === 'white') return 'var(--surface)';
    }
    return propValue;
  }

  // 解析 CSS 文本，构建 {className: styleString} 映射
  function parseEpubCss(cssText) {
    var cssMap = {};
    if (!cssText) return cssMap;

    // 去除注释
    cssText = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    // 去除 @font-face（无嵌套大括号）
    cssText = cssText.replace(/@font-face\s*\{[^}]*\}/g, '');
    // 去除 @media（含一层嵌套）
    cssText = cssText.replace(/@media[^{]*\{[^{}]*\{[^{}]*\}[^{}]*\}/g, '');
    // 去除其他 @-rules
    cssText = cssText.replace(/@\w+[^{]*\{[^}]*\}/g, '');

    // 解析规则 selector { declarations }
    var ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    var match;
    while ((match = ruleRe.exec(cssText)) !== null) {
      var selectorText = match[1].trim();
      var declarations = match[2].trim();
      if (!declarations) continue;

      // 只保留视觉属性
      var styleParts = [];
      var props = declarations.split(';');
      for (var pi = 0; pi < props.length; pi++) {
        var prop = props[pi].trim();
        if (!prop) continue;
        var colonIdx = prop.indexOf(':');
        if (colonIdx < 0) continue;
        var propName = prop.substring(0, colonIdx).trim().toLowerCase();
        var propValue = prop.substring(colonIdx + 1).trim();
        // 去除 !important
        propValue = propValue.replace(/\s*!important\s*/gi, '');
        if (CSS_VISUAL_PROPS[propName] && propValue) {
          propValue = mapEpubColor(propName, propValue);
          styleParts.push(propName + ':' + propValue);
        }
      }
      if (!styleParts.length) continue;
      var styleStr = styleParts.join(';');

      // 处理逗号分隔的选择器
      var selectors = selectorText.split(',');
      for (var si = 0; si < selectors.length; si++) {
        var sel = selectors[si].trim();
        // 只处理纯 class 选择器：.cls1.cls2...
        if (/^\.[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(sel)) {
          var classes = sel.substring(1).split('.').sort();
          var key = classes.join(' ');
          if (cssMap[key]) {
            cssMap[key] = mergeStyles(cssMap[key], styleStr);
          } else {
            cssMap[key] = styleStr;
          }
        }
      }
    }
    return cssMap;
  }

  // 根据 class 属性值查找 CSS 规则，返回合并后的 styleString
  function lookupCssStyle(cssMap, classNames) {
    if (!cssMap || !classNames) return '';
    var classes = classNames.trim().split(/\s+/).sort();
    var styleMap = {};

    // 逐个 class 查找
    for (var i = 0; i < classes.length; i++) {
      var s = cssMap[classes[i]];
      if (s) { var m = parseStyleStr(s); for (var k in m) styleMap[k] = m[k]; }
    }
    // 多 class 组合查找
    if (classes.length > 1) {
      var combined = classes.join(' ');
      var multi = cssMap[combined];
      if (multi) { var mm = parseStyleStr(multi); for (var kk in mm) styleMap[kk] = mm[kk]; }
    }
    return buildStyleStr(styleMap);
  }

  // ── 内联HTML提取（保留加粗/斜体/下划线/链接等格式，应用 CSS 内联样式）──
  var INLINE_TAGS = { b:1, i:1, u:1, em:1, strong:1, a:1, sup:1, sub:1, span:1, mark:1, del:1, small:1, code:1, br:1 };

  function extractInlineHtml(node, cssMap, spineHrefMap, currentBasename) {
    var result = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) {
        result += child.textContent || '';
      } else if (child.nodeType === 1) {
        var tag = (child.tagName || '').toLowerCase();
        if (tag === 'br') {
          result += '<br>';
        } else if (tag === 'img') {
          // img 是 void element，保留 src/class/alt（后续 processEpubImages 会将 src 替换为 data URI）
          // alt 属性保留用于无障碍访问（屏幕阅读器可读取图片描述）
          var inlineImgSrc = child.getAttribute('src') || '';
          var inlineImgCls = child.getAttribute('class') || '';
          var inlineImgAlt = child.getAttribute('alt') || '';
          var inlineImgAttrs = '';
          if (inlineImgCls) inlineImgAttrs += ' class="' + escAttr(inlineImgCls) + '"';
          if (inlineImgAlt) inlineImgAttrs += ' alt="' + escAttr(inlineImgAlt) + '"';
          if (inlineImgSrc) {
            result += '<img' + inlineImgAttrs + ' src="' + escAttr(inlineImgSrc) + '">';
          }
        } else if (INLINE_TAGS[tag]) {
          var inner = extractInlineHtml(child, cssMap, spineHrefMap, currentBasename);
          if (tag === 'a') {
            var href = child.getAttribute('href') || '';
            // EPUB duokan-footnote 行内引用：渲染为 <sup> 而非 <a>
            if (child.classList && child.classList.contains('duokan-footnote')) {
              var fnRefId = href.replace(/^#/, '') || '';
              // 保留原始 <a> 内部的 <img> 图标（含 alt/src/class）；若无则回退为 <span>†</span>
              // 使用公共函数避免与 import-html-converter.js 的重复逻辑
              var fnRefInnerHtml = extractDuokanFnRefInner(child);
              result += '<sup class="bk-epub-fn-ref" data-fn-id="' + escAttr(fnRefId) + '">' + fnRefInnerHtml + '</sup>';
            } else {
              // Detect cross-chapter links:
              // 1. Use spineHrefMap (file basename → chapter number) for general EPUB links
              // 2. Fallback: match "chapter-N.xhtml" pattern for legacy EPUBs
              var linkedChapterNum = 0;
              if (spineHrefMap && href && !href.startsWith('#') && !href.startsWith('http')) {
                var linkFile = href.split('#')[0]; // strip fragment
                var linkBasename = decodeURIComponent(linkFile.split('/').pop());
                if (linkBasename && linkBasename !== currentBasename && spineHrefMap[linkBasename]) {
                  linkedChapterNum = spineHrefMap[linkBasename];
                }
              }
              if (!linkedChapterNum) {
                // Legacy fallback: chapter-N.xhtml pattern
                var chapterMatch = href.match(/chapter-(\d+)\.xhtml/i);
                if (chapterMatch) linkedChapterNum = parseInt(chapterMatch[1], 10);
              }
              if (linkedChapterNum) {
                result += '<a href="#" data-chapter-link="' + escHtml(String(linkedChapterNum)) + '">' + inner + '</a>';
              } else {
                result += '<a href="' + escHtml(href) + '">' + inner + '</a>';
              }
            }
          } else if (tag === 'span') {
            var cls = child.getAttribute('class') || '';
            var style = (cssMap && cls) ? lookupCssStyle(cssMap, cls) : '';
            if (style) {
              result += '<span style="' + escHtml(style) + '">' + inner + '</span>';
            } else if (cls) {
              result += '<span class="' + escHtml(cls) + '">' + inner + '</span>';
            } else {
              result += '<span>' + inner + '</span>';
            }
          } else if (tag === 'mark') {
            var mkCls = child.getAttribute('class') || '';
            if (mkCls) {
              result += '<mark class="' + escHtml(mkCls) + '">' + inner + '</mark>';
            } else {
              result += '<mark>' + inner + '</mark>';
            }
          } else {
            var genericCls = child.getAttribute('class') || '';
            if (genericCls) {
              result += '<' + tag + ' class="' + escHtml(genericCls) + '">' + inner + '</' + tag + '>';
            } else {
              result += '<' + tag + '>' + inner + '</' + tag + '>';
            }
          }
        } else {
          result += extractInlineHtml(child, cssMap, spineHrefMap, currentBasename);
        }
      }
    }
    return result;
  }

  // 将 DOM 节点序列化为 HTML 字符串。
  // 浏览器原生支持 outerHTML，Node.js 的 @xmldom/xmldom 不支持，
  // 需回退到 XMLSerializer，最终兜底 textContent。
  function serializeNode(node) {
    if (node.outerHTML) return node.outerHTML;
    if (typeof XMLSerializer !== 'undefined') {
      try { return new XMLSerializer().serializeToString(node); } catch (e) {}
    }
    return node.textContent || '';
  }
