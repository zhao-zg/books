#!/usr/bin/env node
/**
 * convert-bundled.js — 使用前端 JS 同款逻辑将内置资源（MD/EPUB/TXT）转为 ysz JSON 格式
 *
 * 用法: node src/convert-bundled.js <input_file> <book_id> <series_id>
 * 输出: JSON 到 stdout
 */

'use strict';

const { readFileSync } = require('fs');
const { basename, extname } = require('path');

// ── 第三方依赖 ──
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
// marked 是纯 ESM 包，需动态 import
let MarkedClass;
(async () => { const { Marked } = await import('marked'); MarkedClass = Marked; })();

// ── 工具函数（来自 import-shared.js）──

/**
 * 清理零宽字符和不可见控制字符
 * U+200B Zero Width Space, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM/ZWNBSP, U+2060 Word Joiner
 */
function cleanInvisibleChars(str) {
  if (!str) return str;
  return str.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, '');
}

function generateId() {
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

// ── EPUB CSS 解析（来自 import-epub-style.js）──
const CSS_VISUAL_PROPS = {
  'color': 1, 'font-weight': 1, 'font-style': 1, 'text-decoration': 1,
  'font-size': 1, 'font-family': 1, 'text-align': 1, 'text-indent': 1,
  'background-color': 1, 'border': 1, 'border-top': 1, 'border-bottom': 1,
  'border-left': 1, 'border-right': 1, 'line-height': 1,
  'margin-left': 1, 'margin-right': 1, 'padding-left': 1, 'padding-right': 1,
  'letter-spacing': 1, 'word-spacing': 1, 'vertical-align': 1
};

function parseStyleStr(str) {
  const map = {};
  if (!str) return map;
  const parts = str.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (!p) continue;
    const ci = p.indexOf(':');
    if (ci < 0) continue;
    map[p.substring(0, ci).trim()] = p.substring(ci + 1).trim();
  }
  return map;
}

function buildStyleStr(map) {
  const parts = [];
  for (const k in map) { parts.push(k + ':' + map[k]); }
  return parts.join(';');
}

function mergeStyles(existing, newStyle) {
  const map = parseStyleStr(existing);
  const newMap = parseStyleStr(newStyle);
  for (const k in newMap) { map[k] = newMap[k]; }
  return buildStyleStr(map);
}

function mapEpubColor(propName, propValue) {
  const v = (propValue || '').toLowerCase().trim();
  if (propName === 'color') {
    if (v === '#000000' || v === '#000' || v === 'black') return 'var(--text)';
  } else if (propName === 'background-color' || propName === 'background') {
    if (v === '#ffffff' || v === '#fff' || v === 'white') return 'var(--surface)';
  }
  return propValue;
}

function parseEpubCss(cssText) {
  const cssMap = {};
  if (!cssText) return cssMap;
  cssText = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  cssText = cssText.replace(/@font-face\s*\{[^}]*\}/g, '');
  cssText = cssText.replace(/@media[^{]*\{[^{}]*\{[^{}]*\}[^{}]*\}/g, '');
  cssText = cssText.replace(/@\w+[^{]*\{[^}]*\}/g, '');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(cssText)) !== null) {
    const selectorText = match[1].trim();
    const declarations = match[2].trim();
    if (!declarations) continue;
    const styleParts = [];
    const props = declarations.split(';');
    for (let pi = 0; pi < props.length; pi++) {
      const prop = props[pi].trim();
      if (!prop) continue;
      const colonIdx = prop.indexOf(':');
      if (colonIdx < 0) continue;
      const propName = prop.substring(0, colonIdx).trim().toLowerCase();
      let propValue = prop.substring(colonIdx + 1).trim();
      propValue = propValue.replace(/\s*!important\s*/gi, '');
      if (CSS_VISUAL_PROPS[propName] && propValue) {
        propValue = mapEpubColor(propName, propValue);
        styleParts.push(propName + ':' + propValue);
      }
    }
    if (!styleParts.length) continue;
    const styleStr = styleParts.join(';');
    const selectors = selectorText.split(',');
    for (let si = 0; si < selectors.length; si++) {
      const sel = selectors[si].trim();
      if (/^\.[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(sel)) {
        const classes = sel.substring(1).split('.').sort();
        const key = classes.join(' ');
        cssMap[key] = cssMap[key] ? mergeStyles(cssMap[key], styleStr) : styleStr;
      }
    }
  }
  return cssMap;
}

function lookupCssStyle(cssMap, classNames) {
  if (!cssMap || !classNames) return '';
  const classes = classNames.trim().split(/\s+/).sort();
  const styleMap = {};
  for (let i = 0; i < classes.length; i++) {
    const s = cssMap[classes[i]];
    if (s) { const m = parseStyleStr(s); for (const k in m) styleMap[k] = m[k]; }
  }
  if (classes.length > 1) {
    const combined = classes.join(' ');
    const multi = cssMap[combined];
    if (multi) { const mm = parseStyleStr(multi); for (const kk in mm) styleMap[kk] = mm[kk]; }
  }
  return buildStyleStr(styleMap);
}

const INLINE_TAGS = { b:1, i:1, u:1, em:1, strong:1, a:1, sup:1, sub:1, span:1, mark:1, del:1, small:1, code:1, br:1 };

function extractInlineHtml(node, cssMap, spineHrefMap, currentBasename) {
  let result = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 3) {
      result += child.textContent || '';
    } else if (child.nodeType === 1) {
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'br') {
        result += '<br>';
      } else if (INLINE_TAGS[tag]) {
        const inner = extractInlineHtml(child, cssMap, spineHrefMap, currentBasename);
        if (tag === 'a') {
          const href = child.getAttribute('href') || '';
          if (child.classList && child.classList.contains('duokan-footnote')) {
            const fnRefId = href.replace(/^#/, '') || '';
            result += '<sup class="bk-epub-fn-ref" data-fn-id="' + escAttr(fnRefId) + '">†</sup>';
          } else {
            let linkedChapterNum = 0;
            if (spineHrefMap && href && !href.startsWith('#') && !href.startsWith('http')) {
              const linkFile = href.split('#')[0];
              const linkBasename = decodeURIComponent(linkFile.split('/').pop());
              if (linkBasename && linkBasename !== currentBasename && spineHrefMap[linkBasename]) {
                linkedChapterNum = spineHrefMap[linkBasename];
              }
            }
            if (!linkedChapterNum) {
              const chapterMatch = href.match(/chapter-(\d+)\.xhtml/i);
              if (chapterMatch) linkedChapterNum = parseInt(chapterMatch[1], 10);
            }
            if (linkedChapterNum) {
              result += '<a href="#" data-chapter-link="' + escHtml(String(linkedChapterNum)) + '">' + inner + '</a>';
            } else {
              result += '<a href="' + escHtml(href) + '">' + inner + '</a>';
            }
          }
        } else if (tag === 'span') {
          const cls = child.getAttribute('class') || '';
          const style = (cssMap && cls) ? lookupCssStyle(cssMap, cls) : '';
          if (style) {
            result += '<span style="' + escHtml(style) + '">' + inner + '</span>';
          } else if (cls) {
            result += '<span class="' + escHtml(cls) + '">' + inner + '</span>';
          } else {
            result += '<span>' + inner + '</span>';
          }
        } else if (tag === 'mark') {
          const mkCls = child.getAttribute('class') || '';
          if (mkCls) {
            result += '<mark class="' + escHtml(mkCls) + '">' + inner + '</mark>';
          } else {
            result += '<mark>' + inner + '</mark>';
          }
        } else {
          const genericCls = child.getAttribute('class') || '';
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

// ── htmlToContents（来自 import-html-converter.js）──
function htmlToContents(htmlStr, cssMap, spineHrefMap, currentBasename) {
  // EPUB 章节可能是完整的 XHTML 文档（含 <?xml?> 声明、<html>/<head>/<body>），
  // 也可能是 HTML 片段。如果是完整文档，需要先提取 body 内容再解析，
  // 否则直接包在 <div> 中用 text/html 解析会导致标签嵌套混乱，
  // 尤其 <?xml?> 声明会被当作文本，<head> 中的 <title> 可能混入内容。
  const isFullDoc = /^\s*<\?xml[\s>]/i.test(htmlStr) ||
                    /^\s*<html[\s>]/i.test(htmlStr);
  let fragmentHtml;
  if (isFullDoc) {
    const fullDom = new JSDOM(htmlStr, { contentType: 'application/xhtml+xml' });
    const fullBody = fullDom.window.document.getElementsByTagName('body')[0];
    if (fullBody) {
      fragmentHtml = fullBody.innerHTML;
    } else {
      const bodyMatch = htmlStr.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      fragmentHtml = bodyMatch ? bodyMatch[1] : htmlStr;
    }
  } else {
    fragmentHtml = htmlStr;
  }

  const dom = new JSDOM('<div>' + fragmentHtml + '</div>', { contentType: 'text/html' });
  const doc = dom.window.document;
  const root = doc.body.firstChild || doc.body;
  const contents = [];
  const epubFootnotes = [];
  let epubFnCounter = 0;
  let insideEpubFootnote = false;

  function getNodeStyle(node) {
    if (!cssMap) return '';
    const cls = node.getAttribute('class') || '';
    return cls ? lookupCssStyle(cssMap, cls) : '';
  }

  function detectEpubClass(node) {
    const cls = (node.getAttribute('class') || '').split(/\s+/);
    for (let i = 0; i < cls.length; i++) {
      switch (cls[i]) {
        case 'calibre_text_dadian':    return 'dadian';
        case 'calibre_text_zhongdian': return 'zhongdian';
        case 'calibre_text_xiaodian':  return 'xiaodian';
        case 'calibre_text_zimudian':  return 'zimudian';
        case 'calibre_text_kuohaodian': return 'kuohaodian';
        case 'calibre_text_gangmu_wn': return 'gangmu_wn';
        case 'calibre_text_chenxing_content_wn':  return 'chenxing_wn';
        case 'calibre_text_chenxing_content_wyxd': return 'chenxing_wyxd';
        case 'calibre_text_chenxing_verse': return 'chenxing_verse';
        case 'calibre_text_chenxing_content': return 'chenxing_content';
        case 'calibre_verse': return 'verse';
        case 'calibre_text_verse': return 'verse_text';
        case 'calibre_zongti': return 'zongti';
        case 'calibre_content_title': return 'content_title';
        case 'calibre7': return 'chenxing_box';
      }
    }
    return '';
  }

  function walk(node) {
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim();
      if (t) contents.push({ type: 'paragraph', text: t });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.tagName || '').toLowerCase();

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = parseInt(tag.charAt(1), 10);
        const hText = (node.textContent || '').trim();
        const hHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
        const hStyle = getNodeStyle(node);
        if (hText) contents.push({ type: 'heading', text: hText, html: hHtml, level, style: hStyle });
        break;
      }
      case 'p': {
        const img = node.querySelector('img');
        let imgIsDecorative = false;
        if (img) {
          const imgParent = img.parentElement;
          if (imgParent && imgParent.tagName && imgParent.tagName.toLowerCase() === 'a') {
            const aRel = imgParent.getAttribute('epub:type') || '';
            const aCls = imgParent.className || '';
            if (aRel === 'noteref' || /\bduokan-footnote\b/.test(aCls)) imgIsDecorative = true;
          }
          const imgCls = img.className || '';
          const imgAlt = (img.getAttribute('alt') || '').toLowerCase();
          if (/\bfootnote_img\b/.test(imgCls) || imgAlt === 'note') imgIsDecorative = true;
        }
        if (img && !imgIsDecorative) {
          let imgLinkUrl = '';
          const imgParentA = img.parentElement;
          if (imgParentA && imgParentA.tagName && imgParentA.tagName.toLowerCase() === 'a') {
            const aHref = imgParentA.getAttribute('href') || '';
            const aType = imgParentA.getAttribute('epub:type') || '';
            const aCls = imgParentA.className || '';
            if (aHref && aType !== 'noteref' && !/\bduokan-footnote\b/.test(aCls)) imgLinkUrl = aHref;
          }
          contents.push({ type: 'image', src: img.getAttribute('src') || '', attrs: { alt: img.getAttribute('alt') || '' }, linkUrl: imgLinkUrl || undefined });
        } else {
          const katexDisplay = node.querySelector('.katex-display');
          let isPureMath = false;
          if (katexDisplay) {
            const childNodes = node.childNodes;
            let hasSignificantText = false;
            for (let ci = 0; ci < childNodes.length; ci++) {
              const cn = childNodes[ci];
              if (cn.nodeType === 3 && cn.textContent.trim().length > 0) { hasSignificantText = true; break; }
            }
            isPureMath = !hasSignificantText;
          }
          if (isPureMath) {
            const mathHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            if (mathHtml) contents.push({ type: 'math', html: mathHtml });
          } else {
            const pText = (node.textContent || '').trim();
            const pHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
            const pStyle = getNodeStyle(node);
            const epubCls = detectEpubClass(node);
            if (pText) {
              const pItem = { type: 'paragraph', text: pText, html: pHtml, style: pStyle };
              if (epubCls) pItem.epubClass = epubCls;
              if (epubCls === 'zongti' || epubCls === 'content_title') {
                pItem.type = 'heading'; pItem.level = epubCls === 'zongti' ? 2 : 3;
              } else if (epubCls === 'chenxing_wyxd') {
                pItem.type = 'heading'; pItem.level = 3;
              } else if (epubCls === 'chenxing_wn' || epubCls === 'gangmu_wn') {
                pItem.type = 'heading'; pItem.level = 4;
              } else if (epubCls === 'chenxing_verse') {
                pItem.type = 'quote';
              }
              contents.push(pItem);
            }
          }
        }
        break;
      }
      case 'div': case 'span': {
        const dsText = (node.textContent || '').trim();
        if (dsText) {
          const dsEpubCls = detectEpubClass(node);
          let hasBlock = false;
          for (let ci = 0; ci < node.children.length; ci++) {
            const ct = node.children[ci].tagName.toLowerCase();
            if (['p','div','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','pre','hr','table'].indexOf(ct) >= 0) {
              hasBlock = true; break;
            }
          }
          if (hasBlock) {
            if (dsEpubCls === 'chenxing_box') {
              const boxStart = contents.length;
              for (let ci2 = 0; ci2 < node.childNodes.length; ci2++) walk(node.childNodes[ci2]);
              for (let bi = boxStart; bi < contents.length; bi++) {
                if (!contents[bi].epubClass) contents[bi].epubClass = 'chenxing_box';
              }
            } else {
              for (let ci2 = 0; ci2 < node.childNodes.length; ci2++) walk(node.childNodes[ci2]);
            }
          } else {
            const dsStyle = getNodeStyle(node);
            const dsItem = { type: 'paragraph', text: dsText, html: extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim(), style: dsStyle };
            if (dsEpubCls) dsItem.epubClass = dsEpubCls;
            contents.push(dsItem);
          }
        }
        break;
      }
      case 'blockquote': {
        const qText = (node.textContent || '').trim();
        const qHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
        const qStyle = getNodeStyle(node);
        if (qText) contents.push({ type: 'quote', text: qText, html: qHtml, style: qStyle });
        break;
      }
      case 'img':
        contents.push({ type: 'image', src: node.getAttribute('src') || '', attrs: { alt: node.getAttribute('alt') || '' } });
        break;
      case 'ul': case 'ol': {
        if (insideEpubFootnote) {
          for (let oli = 0; oli < node.childNodes.length; oli++) walk(node.childNodes[oli]);
          break;
        }
        const items = []; const itemHtmls = []; let checkboxes = null;
        const olStyle = (node.getAttribute('style') || '').toLowerCase();
        const forceUnordered = tag === 'ol' && /\blist-style\s*:\s*none\b/.test(olStyle);
        const lis = node.querySelectorAll('li');
        for (let li = 0; li < lis.length; li++) {
          const cbInput = lis[li].querySelector('input[type="checkbox"]');
          if (cbInput) {
            if (!checkboxes) checkboxes = [];
            checkboxes.push(!!cbInput.checked);
          }
          const liText = (lis[li].textContent || '').trim();
          const liHtml = extractInlineHtml(lis[li], cssMap, spineHrefMap, currentBasename).trim();
          if (liText) { items.push(liText); itemHtmls.push(liHtml); }
        }
        if (items.length) {
          const listItem = { type: 'list', items, itemHtmls, attrs: { ordered: tag === 'ol' && !forceUnordered } };
          if (checkboxes && checkboxes.length === items.length) listItem.checkboxes = checkboxes;
          contents.push(listItem);
        }
        break;
      }
      case 'pre': {
        const codeEl = node.querySelector('code');
        const codeText = codeEl ? (codeEl.textContent || '') : (node.textContent || '');
        let codeLang = '';
        if (codeEl) {
          const codeClasses = (codeEl.getAttribute('class') || '').split(/\s+/);
          for (let cli = 0; cli < codeClasses.length; cli++) {
            const clm = codeClasses[cli].match(/^language-(.+)$/);
            if (clm) { codeLang = clm[1]; break; }
          }
        }
        if (codeLang === 'mermaid') {
          contents.push({ type: 'mermaid', text: codeText.trim() });
          break;
        }
        const codeHtml = (codeEl && codeEl.innerHTML) ? codeEl.innerHTML : '';
        contents.push({ type: 'code', text: codeText.trim(), html: codeHtml, attrs: { language: codeLang } });
        break;
      }
      case 'code':
        if (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre') {
          contents.push({ type: 'paragraph', text: '`' + (node.textContent || '').trim() + '`' });
        }
        break;
      case 'hr':
        contents.push({ type: 'separator' });
        break;
      case 'table': {
        const trs = node.querySelectorAll('tr');
        const tRows = [];
        for (let ri = 0; ri < trs.length; ri++) {
          const tCells = trs[ri].querySelectorAll('th, td');
          const rowData = []; let rowIsHeader = false;
          for (let ci3 = 0; ci3 < tCells.length; ci3++) {
            const cellEl = tCells[ci3];
            const cellTag = (cellEl.tagName || '').toLowerCase();
            if (cellTag === 'th') rowIsHeader = true;
            rowData.push({ text: (cellEl.textContent || '').trim(), html: extractInlineHtml(cellEl, cssMap, spineHrefMap, currentBasename).trim() });
          }
          if (rowData.length) tRows.push({ header: rowIsHeader, cells: rowData });
        }
        if (tRows.length) contents.push({ type: 'table', rows: tRows });
        break;
      }
      case 'br': {
        const brLast = contents.length ? contents[contents.length - 1] : null;
        if (brLast && brLast.type === 'paragraph' && brLast.html) {
          brLast.html += '<br>';
        } else {
          contents.push({ type: 'linebreak' });
        }
        break;
      }
      case 'aside': {
        const isEpubFn = (node.getAttribute('epub:type') === 'footnote') ||
                         (node.classList && node.classList.contains('duokan-footnote'));
        if (isEpubFn) {
          epubFnCounter++;
          const fnId = node.getAttribute('id') || ('epubfn' + epubFnCounter);
          // 用 splice 方式隔离脚注内容：walk 写入 contents，
          // 完成后用 splice 提取脚注期间新增的条目
          const fnStartIdx = contents.length;
          const savedInsideFn = insideEpubFootnote;
          insideEpubFootnote = true;
          for (let afi = 0; afi < node.childNodes.length; afi++) walk(node.childNodes[afi]);
          const fnItems = contents.splice(fnStartIdx);
          insideEpubFootnote = savedInsideFn;
          epubFootnotes.push({ id: fnId, content: fnItems });
          break;
        }
        for (let asi = 0; asi < node.childNodes.length; asi++) walk(node.childNodes[asi]);
        break;
      }
      case 'section':
        if (node.classList && node.classList.contains('bk-footnotes-section')) {
          const fnHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          if (fnHtml) contents.push({ type: 'footnotes_section', html: fnHtml });
          break;
        }
        for (let si = 0; si < node.childNodes.length; si++) walk(node.childNodes[si]);
        break;
      case 'sup':
        if (node.classList && node.classList.contains('bk-fn-ref')) {
          const fnRefHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          contents.push({ type: 'footnote_ref', html: fnRefHtml });
          break;
        }
        for (let supi = 0; supi < node.childNodes.length; supi++) walk(node.childNodes[supi]);
        break;
      case 'a': {
        const isDuokanFnRef = node.classList && node.classList.contains('duokan-footnote');
        if (isDuokanFnRef) {
          const fnRefHref = node.getAttribute('href') || '';
          const fnRefId = fnRefHref.replace(/^#/, '') || '';
          const fnRefText = (node.textContent || '').trim();
          contents.push({ type: 'footnote_ref', footnoteId: fnRefId, text: fnRefText, html: '<sup class="bk-epub-fn-ref" data-fn-id="' + escAttr(fnRefId) + '">' + escHtml(fnRefText) + '</sup>' });
          break;
        }
        const aText = (node.textContent || '').trim();
        if (aText) {
          const aHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          const lastItem = contents.length ? contents[contents.length - 1] : null;
          if (lastItem && lastItem.type === 'paragraph' && lastItem.html) {
            lastItem.html += ' ' + aHtml;
            lastItem.text += ' ' + aText;
          } else {
            contents.push({ type: 'paragraph', text: aText, html: aHtml, style: '' });
          }
        }
        break;
      }
      case 'span':
        if (node.classList && node.classList.contains('katex')) {
          const katexHtml = extractInlineHtml(node, cssMap, spineHrefMap, currentBasename).trim();
          if (katexHtml) contents.push({ type: 'math', html: katexHtml });
          break;
        }
        // fallthrough
      case 'script': case 'style': case 'noscript': case 'head': case 'meta': case 'link':
        break;
      default:
        for (let di = 0; di < node.childNodes.length; di++) walk(node.childNodes[di]);
    }
  }

  for (let i = 0; i < root.childNodes.length; i++) walk(root.childNodes[i]);

  // EPUB footnote post-processing
  if (epubFootnotes.length) {
    const fnItems = [];
    for (let fi = 0; fi < epubFootnotes.length; fi++) {
      const efn = epubFootnotes[fi];
      let efnHtml = '';
      for (let eci = 0; eci < efn.content.length; eci++) {
        const ecItem = efn.content[eci];
        if (ecItem.type === 'paragraph') {
          const pCls = ecItem.epubClass ? ' class="bk-epub-' + ecItem.epubClass + '"' : '';
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
      const efnFallbackText = efn.content.map(c => c.text || '').join(' ');
      if (efnHtml || efn.content.length) {
        fnItems.push({ type: 'footnote', attrs: { id: efn.id }, text: efnFallbackText, html: efnHtml || efnFallbackText });
      }
    }
    if (fnItems.length) contents.push({ type: 'footnotes_section', footnoteRefs: fnItems });
    const fnIdMap = {};
    for (let fmi = 0; fmi < epubFootnotes.length; fmi++) fnIdMap[epubFootnotes[fmi].id] = fmi + 1;
    for (let ci6 = 0; ci6 < contents.length; ci6++) {
      if (contents[ci6].type === 'footnote_ref' && contents[ci6].footnoteId) {
        const fnNum = fnIdMap[contents[ci6].footnoteId];
        if (fnNum) contents[ci6].html = '<sup class="bk-epub-fn-ref" data-fn-id="' + escAttr(contents[ci6].footnoteId) + '">' + fnNum + '</sup>';
      }
      if (contents[ci6].type === 'paragraph' && contents[ci6].html) {
        contents[ci6].html = contents[ci6].html.replace(/<sup class="bk-epub-fn-ref" data-fn-id="([^"]+)">†<\/sup>/g, (m, fnId) => {
          const num = fnIdMap[fnId];
          return '<sup class="bk-epub-fn-ref" data-fn-id="' + fnId + '">' + (num || '') + '</sup>';
        });
      }
    }
  }

  return contents;
}

// ── Markdown 解析（使用 marked 转 HTML，再 htmlToContents 转结构化内容）──
function parseMdSimple(text, fileName) {
  if (!MarkedClass) throw new Error('Marked 模块未加载完成');
  // 提取 YAML frontmatter
  let meta = {};
  let mdContent = text;
  let fmMatch;
  while ((fmMatch = mdContent.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/))) {
    const yamlLines = fmMatch[1].split(/\r?\n/);
    for (let yi = 0; yi < yamlLines.length; yi++) {
      const ym = yamlLines[yi].match(/^(\w+)\s*:\s*(.+)$/);
      if (ym) meta[ym[1].trim()] = ym[2].trim().replace(/^['"]|['"]$/g, '');
    }
    mdContent = fmMatch[2];
  }

  // 清理 AIGC 水印
  mdContent = mdContent.replace(/^\s*>+\s*AI\s*生[成成].*$/gim, '');

  const bookTitle = meta.title || fileName.replace(/\.md$/i, '');
  const author = meta.author || '';
  const description = meta.description || '';

  // ── 预处理：与前端 import-markdown.js 的 parseMd() 保持一致 ──

  // 脚注预处理：两遍扫描
  const footnotes = {};
  let fnIndex = 0;
  let fnReplaced = mdContent.replace(/^\[\^([^\]]+)\]\:\s*(.+)$/gm, (m, label, fnText) => {
    if (!footnotes[label]) {
      footnotes[label] = { id: ++fnIndex, text: fnText.trim() };
    }
    return '';
  });
  fnReplaced = fnReplaced.replace(/\[\^([^\]]+)\]/g, (m, label) => {
    if (footnotes[label]) {
      const fid = footnotes[label].id;
      return '<sup class="bk-fn-ref"><a href="#fn-' + fid + '">' + fid + '</a></sup>';
    }
    return m;
  });

  // Tab 缩进预处理：防止行首 \t 被 marked 误判为代码块
  const fencedBlocks = [];
  let tabSafe = fnReplaced.replace(/```[\s\S]*?```/g, (m) => {
    fencedBlocks.push(m);
    return '%%FENCED' + (fencedBlocks.length - 1) + '%%';
  });
  tabSafe = tabSafe.replace(/^(\t+)(.+)$/gm, (m, tabs, content) => {
    return '%%INDENT' + tabs.length + '%%' + content;
  });
  for (let fbi = 0; fbi < fencedBlocks.length; fbi++) {
    tabSafe = tabSafe.replace('%%FENCED' + fbi + '%%', fencedBlocks[fbi]);
  }

  // ++text++ 特殊格式预处理：转为 <mark> 标签
  const markProcessed = tabSafe.replace(/\+\+(.+?)\+\+/g, '<mark class="bk-mark-highlight">$1</mark>');

  // 中文大纲编号预处理：为中文编号行添加层级缩进标记
  const outlineLines = markProcessed.split('\n');
  const mdListRe = /^\d+\.\s/;
  const outlinePatterns = [
    { level: 1, re: /^(?:壹|貳|叁|肆|伍|陸|柒|捌|玖|拾|壹|贰|叁|肆|伍|陆|柒|捌|玖|拾)[\s、．\.]/ },
    { level: 2, re: /^(?:一|二|三|四|五|六|七|八|九|十)[\s、．\.]/ },
    { level: 3, re: /^\d+[\s、．\.]/ },
    { level: 4, re: /^[a-z][\s、．\.]/ }
  ];
  for (let oli = 0; oli < outlineLines.length; oli++) {
    const line = outlineLines[oli];
    let matchedLevel = 0;
    for (let opi = 0; opi < outlinePatterns.length; opi++) {
      if (outlinePatterns[opi].re.test(line)) {
        matchedLevel = outlinePatterns[opi].level;
        break;
      }
    }
    if (!matchedLevel) continue;
    if (matchedLevel === 3 && mdListRe.test(line)) {
      let hasListNeighbor = false;
      for (let di = -1; di <= 1; di += 2) {
        let ni = oli + di;
        while (ni >= 0 && ni < outlineLines.length && /^\s*$/.test(outlineLines[ni])) {
          ni += di;
        }
        if (ni >= 0 && ni < outlineLines.length && mdListRe.test(outlineLines[ni])) {
          hasListNeighbor = true;
          break;
        }
      }
      if (hasListNeighbor) continue;
    }
    outlineLines[oli] = '%%OUTLINE' + matchedLevel + '%%' + line;
  }
  const outlineProcessed = outlineLines.join('\n');

  // 用 marked 转 HTML
  const marked = new MarkedClass({ gfm: true, breaks: true });
  let html = marked.parse(outlineProcessed);

  // ── 后处理 ──

  // 缩进后处理：将 %%INDENTN%% 替换为缩进 HTML 元素
  html = html.replace(/%%INDENT(\d+)%%/g, (m, level) => {
    const lvl = parseInt(level, 10);
    let indent = '';
    for (let ii = 0; ii < lvl; ii++) indent += '\u2003';
    return '<span class="bk-indent bk-indent-' + lvl + '">' + indent + '</span>';
  });

  // 大纲层级后处理：将 %%OUTLINEN%% 替换为层级缩进
  html = html.replace(/%%OUTLINE(\d)%%/g, (m, level) => {
    const lvl = parseInt(level, 10);
    if (lvl <= 1) return '';
    let indent = '';
    for (let oi = 1; oi < lvl; oi++) indent += '\u2003';
    return '<span class="bk-outline-indent bk-outline-' + lvl + '">' + indent + '</span>';
  });

  // 脚注后处理：附加脚注区域
  const fnKeys = Object.keys(footnotes);
  if (fnKeys.length) {
    html += '<section class="bk-footnotes-section"><h3 class="bk-footnotes-title">脚注</h3>';
    for (let fki = 0; fki < fnKeys.length; fki++) {
      const fk = fnKeys[fki];
      html += '<div class="bk-footnote" id="fn-' + String(footnotes[fk].id).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '">' +
        '<span class="bk-fn-number">' + String(footnotes[fk].id).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
        '<span class="bk-fn-text">' + footnotes[fk].text + '</span></div>';
    }
    html += '</section>';
  }

  // HTML → Content
  const allContents = htmlToContents(html);

  // 按 h1/h2 分割章节
  let splitLevel = 0;
  const headingLevels = {};
  for (let hi = 0; hi < allContents.length; hi++) {
    if (allContents[hi].type === 'heading') headingLevels[allContents[hi].level] = true;
  }
  if (headingLevels[1]) splitLevel = 1;
  else if (headingLevels[2]) splitLevel = 2;

  const chapters = [];
  if (splitLevel > 0) {
    let currentTitle = '', currentContents = [];
    for (let ci = 0; ci < allContents.length; ci++) {
      if (allContents[ci].type === 'heading' && allContents[ci].level === splitLevel) {
        if (currentContents.length) {
          chapters.push({ number: chapters.length + 1, title: currentTitle || ('第' + (chapters.length + 1) + '章'), content: currentContents, footnotes: [] });
        }
        currentTitle = allContents[ci].text;
        currentContents = [];
      } else {
        currentContents.push(allContents[ci]);
      }
    }
    if (currentContents.length) {
      chapters.push({ number: chapters.length + 1, title: currentTitle || ('第' + (chapters.length + 1) + '章'), content: currentContents, footnotes: [] });
    }
  }

  if (!chapters.length) {
    chapters.push({ number: 1, title: bookTitle, content: allContents.length ? allContents : [{ type: 'paragraph', text: '（无内容）' }], footnotes: [] });
  }

  return { id: generateId(), title: bookTitle, author, format: 'md', cover: '', language: 'zh', description, chapters };
}

// ── TXT 解析（整篇作为 1 章）──
function parseTxt(text, fileName) {
  const content = cleanInvisibleChars(text).trim();
  if (!content) return null;
  const bookTitle = fileName.replace(/\.txt$/i, '');
  const paragraphs = content.split(/\r?\n/).filter(l => l.trim());
  const allContents = paragraphs.map(p => ({ type: 'paragraph', text: p.trim() }));
  return {
    id: generateId(), title: bookTitle, author: '', format: 'txt',
    cover: '', language: 'zh', description: '',
    chapters: [{ number: 1, title: bookTitle, content: allContents, footnotes: [] }]
  };
}

// ── EPUB TOC 解析（NCX/nav）── 对齐前端 import-epub.js 的 parseEpubToc()
// 构建侧用 JSDOM 替代浏览器 DOMParser，逻辑等价
async function parseEpubTocNode(zip, opfDoc, manifest, opfDir) {
  const tocMap = {};

  // 查找 NCX (EPUB2): spine toc 属性 或 manifest media-type
  let ncxId = '';
  const spineEl = opfDoc.querySelector('spine');
  if (spineEl) ncxId = spineEl.getAttribute('toc') || '';
  if (!ncxId) {
    for (const id in manifest) {
      if (manifest[id].mediaType === 'application/x-dtbncx+xml') { ncxId = id; break; }
    }
  }

  // 查找 nav (EPUB3): manifest item properties="nav"
  let navId = '';
  const navItem = opfDoc.querySelector('item[properties~="nav"]');
  if (navItem) navId = navItem.getAttribute('id');

  // 解析 NCX
  if (ncxId && manifest[ncxId]) {
    const ncxHref = opfDir ? (opfDir + '/' + manifest[ncxId].href) : manifest[ncxId].href;
    try {
      const ncxText = await zip.file(ncxHref).async('string');
      const ncxDom = new JSDOM(ncxText, { contentType: 'application/xml' });
      const ncxDoc = ncxDom.window.document;
      const navPoints = ncxDoc.querySelectorAll('navPoint');
      navPoints.forEach(np => {
        const labelEl = np.querySelector('text');
        const contentEl = np.querySelector('content');
        if (labelEl && contentEl) {
          const title = (labelEl.textContent || '').trim();
          const src = (contentEl.getAttribute('src') || '').split('#')[0];
          if (title && src) {
            const baseName = src.split('/').pop();
            tocMap[baseName] = title;
            tocMap[src] = title;
          }
        }
      });
    } catch (e) { /* skip missing NCX */ }
  }

  // 解析 nav (EPUB3)
  if (navId && manifest[navId]) {
    const navHref = opfDir ? (opfDir + '/' + manifest[navId].href) : manifest[navId].href;
    try {
      const navText = await zip.file(navHref).async('string');
      const navDom = new JSDOM(navText, { contentType: 'text/html' });
      const navDoc = navDom.window.document;
      const navEl = navDoc.querySelector('nav[epub\\:type="toc"]') ||
                    navDoc.querySelector('nav[role="doc-toc"]') ||
                    navDoc.querySelector('nav');
      if (navEl) {
        const links = navEl.querySelectorAll('a');
        links.forEach(a => {
          const href = (a.getAttribute('href') || '').split('#')[0];
          const title = (a.textContent || '').trim();
          if (title && href) {
            const baseName = href.split('/').pop();
            tocMap[baseName] = title;
            tocMap[href] = title;
          }
        });
      }
    } catch (e) { /* skip missing nav */ }
  }

  return tocMap;
}

// ── EPUB 解析（使用 JSZip + JSDOM DOMParser）──
async function parseEpubNode(data, fileName) {
  const zip = await JSZip.loadAsync(data);

  // 查找 OPF 文件
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const containerDom = new JSDOM(containerXml, { contentType: 'application/xhtml+xml' });
  const rootfileEl = containerDom.window.document.querySelector('rootfile');
  const opfPath = rootfileEl ? rootfileEl.getAttribute('full-path') : 'OEBPS/content.opf';

  // 解析 OPF
  const opfText = await zip.file(opfPath).async('string');
  const opfDom = new JSDOM(opfText, { contentType: 'application/xhtml+xml' });
  const opfDoc = opfDom.window.document;
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')) : '';

  // 提取元数据
  const titleEls = opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title');
  const title = titleEls.length > 0 ? titleEls[0].textContent : fileName.replace(/\.epub$/i, '');
  const creatorEls = opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator');
  const author = creatorEls.length > 0 ? creatorEls[0].textContent : '';

  // 构建 manifest
  const manifest = {};
  const items = opfDoc.querySelectorAll('manifest > item');
  items.forEach(item => {
    manifest[item.getAttribute('id')] = {
      href: item.getAttribute('href'),
      mediaType: item.getAttribute('media-type'),
      properties: item.getAttribute('properties') || ''
    };
  });

  // spine 顺序
  const spineItems = [];
  const idrefs = opfDoc.querySelectorAll('spine > itemref');
  idrefs.forEach(ir => spineItems.push(ir.getAttribute('idref')));

  // 构建 spineHrefMap
  const spineHrefMap = {};
  for (let i = 0; i < spineItems.length; i++) {
    const item = manifest[spineItems[i]];
    if (item && item.href) {
      const basename = decodeURIComponent(item.href.split('/').pop());
      spineHrefMap[basename] = i + 1;
    }
  }

  // 提取 CSS
  const cssTexts = [];
  for (const id in manifest) {
    const item = manifest[id];
    if (item.mediaType === 'text/css') {
      const cssPath = opfDir ? (opfDir + '/' + item.href) : item.href;
      try {
        const cssText = await zip.file(cssPath).async('string');
        cssTexts.push(cssText);
      } catch (e) { /* skip missing CSS */ }
    }
  }
  const cssMap = cssTexts.length ? parseEpubCss(cssTexts.join('\n')) : null;

  // 提取 TOC（NCX/nav）— 章节标题优先使用 TOC，与前端导入对齐
  const tocMap = await parseEpubTocNode(zip, opfDoc, manifest, opfDir);

  // 处理图片 → base64
  const imageMap = {};
  for (const id in manifest) {
    const item = manifest[id];
    if (item.mediaType && item.mediaType.startsWith('image/')) {
      const imgPath = opfDir ? (opfDir + '/' + item.href) : item.href;
      try {
        const imgData = await zip.file(imgPath).async('base64');
        imageMap[item.href] = 'data:' + item.mediaType + ';base64,' + imgData;
      } catch (e) { /* skip */ }
    }
  }

  // 逐章处理
  const chapters = [];
  for (let si = 0; si < spineItems.length; si++) {
    const item = manifest[spineItems[si]];
    if (!item || item.mediaType !== 'application/xhtml+xml') continue;

    const filePath = opfDir ? (opfDir + '/' + item.href) : item.href;
    try {
      const htmlContent = await zip.file(filePath).async('string');
      const basename = decodeURIComponent(item.href.split('/').pop());

      // 替换图片 src 为 base64
      let processedHtml = htmlContent;
      for (const imgHref in imageMap) {
        processedHtml = processedHtml.replace(
          new RegExp('src="' + imgHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'g'),
          'src="' + imageMap[imgHref] + '"'
        );
      }

      const chapterContents = htmlToContents(processedHtml, cssMap, spineHrefMap, basename);
      if (chapterContents.length) {
        // 章节标题：优先从 TOC 查找，其次从内容中的 heading 提取
        // 与前端 import-epub.js 逻辑对齐
        let chTitle = tocMap[basename] || '';
        if (!chTitle) {
          for (let ci = 0; ci < chapterContents.length; ci++) {
            if (chapterContents[ci].type === 'heading' && chapterContents[ci].level <= 2) {
              chTitle = chapterContents[ci].text;
              break;
            }
          }
        }
        if (!chTitle) chTitle = '第' + (chapters.length + 1) + '章';

        chapters.push({
          number: chapters.length + 1,
          title: chTitle,
          content: chapterContents,
          footnotes: []
        });
      }
    } catch (e) {
      console.error('EPUB chapter parse error:', filePath, e.message);
    }
  }

  if (!chapters.length) {
    chapters.push({ number: 1, title: title, content: [{ type: 'paragraph', text: '（无内容）' }], footnotes: [] });
  }

  return { id: generateId(), title, author, format: 'epub', cover: '', language: 'zh', description: '', chapters };
}

// ── 主入口 ──
async function main() {
  // 确保动态 import 完成
  if (!MarkedClass) {
    const { Marked } = await import('marked');
    MarkedClass = Marked;
  }

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
    bookData = await parseEpubNode(data, fileName);
  } else if (ext === '.md' || ext === '.markdown') {
    const text = cleanInvisibleChars(readFileSync(inputFile, 'utf-8'));
    bookData = parseMdSimple(text, fileName);
  } else if (ext === '.txt') {
    const text = readFileSync(inputFile, 'utf-8');
    bookData = parseTxt(text, fileName);
  } else {
    console.error('不支持的格式:', ext);
    process.exit(1);
  }

  // 覆盖 ID 为指定的 bookId
  bookData.id = bookId;

  // 输出为 ysz 格式的单书 JSON
  const output = {
    id: bookData.id,
    title: bookData.title,
    format: bookData.format,
    series: seriesId,
    chapters: bookData.chapters
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
