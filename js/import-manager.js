/**
 * import-manager.js
 * 外部书籍导入管理模块：支持 TXT、EPUB、Markdown 格式
 * 依赖：localforage、JSZip、marked（需在 index.html 中先于本文件加载）
 */
(function(win) {
  'use strict';

  // ── 存储 ──
  var importStore = localforage.createInstance({
    name: 'books',
    storeName: 'imported-data'
  });
  var KEY_IDS = 'imported_ids';
  var KEY_PREFIX = 'imported_book:';

  // ── 工具函数 ──
  function generateId() {
    return 'imported-' + Date.now();
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;')
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

  // ── 文件选择 ──
  function pickFile() {
    // 判断是否在 Capacitor 原生环境
    var isNative = !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
    var FilePicker = win.Capacitor &&
      win.Capacitor.Plugins &&
      win.Capacitor.Plugins.FilePicker;

    if (isNative && FilePicker) {
      return FilePicker.pickFiles({
        types: [
          'text/plain',
          'application/epub+zip',
          'text/markdown',
          'application/octet-stream'
        ],
        readData: true  // 返回 base64 数据
      }).then(function(result) {
        if (!result || !result.files || !result.files.length) return null;
        var f = result.files[0];
        return { name: f.name, mime: f.mimeType, data: f.data, uri: f.uri };
      });
    }

    // Web 环境降级：创建 input[type=file]
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.epub,.md,.markdown';
      input.style.display = 'none';
      input.onchange = function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) { resolve(null); return; }
        var reader = new FileReader();
        if (/\.epub$/i.test(file.name)) {
          reader.onload = function(ev) {
            resolve({ name: file.name, mime: file.type, arrayBuffer: ev.target.result });
          };
          reader.onerror = function() {
            reject(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
          };
          reader.readAsArrayBuffer(file);
        } else {
          reader.onload = function(ev) {
            resolve({ name: file.name, mime: file.type, text: ev.target.result });
          };
          reader.onerror = function() {
            reject(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
          };
          reader.readAsText(file, 'utf-8');
        }
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // ── TXT 解析 ──
  function parseTxt(text, fileName) {
    var lines = text.split(/\r?\n/);
    if (!lines.length) throw new Error('TXT 文件为空');

    // 书名检测：前 5 行中短行（<50字符、无标点结尾）
    var bookTitle = fileName.replace(/\.txt$/i, '');
    var titleLineIdx = -1;
    for (var i = 0; i < Math.min(5, lines.length); i++) {
      var s = lines[i].trim();
      if (s && s.length <= 50 && !/[。！？.!?,，;；:：]$/.test(s)) {
        var puncCount = 0;
        for (var ci = 0; ci < s.length; ci++) {
          if ('，。！？,.!?;；:：、'.indexOf(s[ci]) >= 0) puncCount++;
        }
        if (puncCount <= s.length * 0.3) {
          bookTitle = s;
          titleLineIdx = i;
          break;
        }
      }
    }

    var contentLines = titleLineIdx >= 0 ? lines.slice(titleLineIdx + 1) : lines;

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

  // ── EPUB 解析 ──
  function parseEpub(data, fileName) {
    // data 可以是 base64 字符串（FilePicker readData）或 ArrayBuffer（web FileReader）
    return JSZip.loadAsync(data).then(function(zip) {
      // 1. 读 container.xml 找 OPF 路径
      var containerFile = zip.file('META-INF/container.xml');
      if (!containerFile) {
        throw new Error('无效的 EPUB 文件：缺少 META-INF/container.xml');
      }
      return containerFile.async('string').then(function(xml) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(xml, 'application/xml');
        var rootfile = doc.querySelector('rootfile');
        var opfPath = rootfile ? rootfile.getAttribute('full-path') : 'content.opf';
        var opfDir = opfPath.indexOf('/') >= 0
          ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1)
          : '';

        // 2. 读 OPF 文件
        var opfFile = zip.file(opfPath);
        if (!opfFile) {
          throw new Error('无效的 EPUB 文件：找不到 OPF 文件 ' + opfPath);
        }
        return opfFile.async('string').then(function(opfXml) {
          var opfDoc = parser.parseFromString(opfXml, 'application/xml');

          // 提取元数据
          var title = getTextContent(opfDoc, 'dc\\:title, title') || fileName.replace(/\.epub$/i, '');
          var author = getTextContent(opfDoc, 'dc\\:creator, creator') || '';
          var language = getTextContent(opfDoc, 'dc\\:language, language') || 'zh';
          var description = getTextContent(opfDoc, 'dc\\:description, description') || '';

          // 构建 manifest 映射 {id: {href, mediaType}}
          var manifest = {};
          var manifestItems = opfDoc.querySelectorAll('manifest item');
          for (var i = 0; i < manifestItems.length; i++) {
            var item = manifestItems[i];
            manifest[item.getAttribute('id')] = {
              href: item.getAttribute('href'),
              mediaType: item.getAttribute('media-type')
            };
          }

          // 3. 按 spine 顺序读取章节
          var spineItems = opfDoc.querySelectorAll('spine itemref');
          var chapters = [];
          var promises = [];

          for (var si = 0; si < spineItems.length; si++) {
            var idref = spineItems[si].getAttribute('idref');
            var mItem = manifest[idref];
            if (!mItem) continue;
            var href = opfDir + mItem.href;
            // 处理 URL 编码路径
            var zipFile = zip.file(href) || zip.file(decodeURIComponent(href));
            if (!zipFile) continue;

            (function(chapterIndex, fileHref) {
              promises.push(
                zipFile.async('string').then(function(html) {
                  var contents = htmlToContents(html);
                  // 处理图片：将 EPUB 内图片转为 base64 data URI
                  return processEpubImages(zip, contents, fileHref, opfDir).then(function(processedContents) {
                    // 提取章节标题：第一个 h1/h2
                    var chapterTitle = '';
                    for (var ci = 0; ci < processedContents.length; ci++) {
                      if (processedContents[ci].type === 'heading' && processedContents[ci].level <= 2) {
                        chapterTitle = processedContents[ci].text;
                        break;
                      }
                    }
                    return {
                      index: chapterIndex,
                      title: chapterTitle,
                      content: processedContents
                    };
                  });
                })
              );
            })(chapters.length, href);
          }

          return Promise.all(promises).then(function(results) {
            // 按 index 排序
            results.sort(function(a, b) { return a.index - b.index; });
            for (var ri = 0; ri < results.length; ri++) {
              if (results[ri].content.length) {
                chapters.push({
                  number: chapters.length + 1,
                  title: results[ri].title || ('第' + (chapters.length + 1) + '章'),
                  content: results[ri].content,
                  footnotes: []
                });
              }
            }

            if (!chapters.length) {
              chapters.push({
                number: 1,
                title: title,
                content: [{ type: 'paragraph', text: '（无内容）' }],
                footnotes: []
              });
            }

            return {
              id: generateId(),
              title: title,
              author: author,
              format: 'epub',
              cover: '',
              language: (language || 'zh').substring(0, 2),
              description: description.substring(0, 500),
              chapters: chapters
            };
          });
        });
      });
    });
  }

  // EPUB 辅助：获取元素文本内容
  function getTextContent(doc, selector) {
    var el = doc.querySelector(selector);
    return el ? (el.textContent || '').trim() : '';
  }

  // EPUB 辅助：处理图片转为 base64 data URI
  function processEpubImages(zip, contents, htmlFilePath, opfDir) {
    // 找到 HTML 文件所在目录（用于解析相对路径）
    var htmlDir = htmlFilePath.indexOf('/') >= 0
      ? htmlFilePath.substring(0, htmlFilePath.lastIndexOf('/') + 1)
      : '';
    var imagePromises = [];

    for (var i = 0; i < contents.length; i++) {
      if (contents[i].type === 'image' && contents[i].src) {
        var src = contents[i].src;
        if (src.indexOf('data:') === 0) continue; // 已经是 data URI
        // 解析相对路径
        var imgPath;
        if (src.indexOf('/') === 0) {
          imgPath = src.substring(1);
        } else {
          imgPath = htmlDir + src;
        }
        // 规范化路径（处理 ../）
        imgPath = normalizePath(imgPath);

        (function(index, path) {
          var zipFile = zip.file(path) || zip.file(decodeURIComponent(path));
          if (zipFile) {
            imagePromises.push(
              zipFile.async('base64').then(function(b64) {
                var ext = path.split('.').pop().toLowerCase();
                var mimeMap = {
                  jpg: 'image/jpeg', jpeg: 'image/jpeg',
                  png: 'image/png', gif: 'image/gif',
                  webp: 'image/webp', svg: 'image/svg+xml'
                };
                var mime = mimeMap[ext] || 'image/jpeg';
                contents[index].src = 'data:' + mime + ';base64,' + b64;
              })
            );
          }
        })(i, imgPath);
      }
    }

    return Promise.all(imagePromises).then(function() { return contents; });
  }

  // 路径规范化（处理 ../ 和 ./ 相对路径）
  function normalizePath(path) {
    var parts = path.split('/');
    var result = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') { result.pop(); }
      else if (parts[i] !== '.' && parts[i] !== '') { result.push(parts[i]); }
    }
    return result.join('/');
  }

  // ── HTML→Content 转换（EPUB 和 MD 共用）──
  function htmlToContents(htmlStr) {
    var parser = new DOMParser();
    var doc = parser.parseFromString('<div>' + htmlStr + '</div>', 'text/html');
    var root = doc.body.firstChild || doc.body;
    var contents = [];

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
          if (hText) contents.push({ type: 'heading', text: hText, level: level });
          break;
        case 'p':
          var img = node.querySelector('img');
          if (img) {
            contents.push({
              type: 'image',
              src: img.getAttribute('src') || '',
              attrs: { alt: img.getAttribute('alt') || '' }
            });
          } else {
            var pText = (node.textContent || '').trim();
            if (pText) contents.push({ type: 'paragraph', text: pText });
          }
          break;
        case 'div':
        case 'span':
          var dsText = (node.textContent || '').trim();
          if (dsText) {
            // div/span 可能只是容器，递归子节点
            var hasBlock = false;
            for (var ci = 0; ci < node.children.length; ci++) {
              var ct = node.children[ci].tagName.toLowerCase();
              if (['p','div','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','pre','hr','table'].indexOf(ct) >= 0) {
                hasBlock = true; break;
              }
            }
            if (hasBlock) {
              for (var ci2 = 0; ci2 < node.childNodes.length; ci2++) walk(node.childNodes[ci2]);
            } else {
              contents.push({ type: 'paragraph', text: dsText });
            }
          }
          break;
        case 'blockquote':
          var qText = (node.textContent || '').trim();
          if (qText) contents.push({ type: 'quote', text: qText });
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
          var items = [];
          var lis = node.querySelectorAll('li');
          for (var li = 0; li < lis.length; li++) {
            var liText = (lis[li].textContent || '').trim();
            if (liText) items.push(liText);
          }
          if (items.length) {
            contents.push({ type: 'list', items: items, attrs: { ordered: tag === 'ol' } });
          }
          break;
        case 'pre':
          var codeEl = node.querySelector('code');
          var codeText = codeEl ? (codeEl.textContent || '') : (node.textContent || '');
          contents.push({ type: 'code', text: codeText.trim(), attrs: { language: '' } });
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
          // 简单处理表格：每行转为一行文本
          var rows = node.querySelectorAll('tr');
          for (var ri = 0; ri < rows.length; ri++) {
            var cells = rows[ri].querySelectorAll('th, td');
            var rowText = [];
            for (var ci3 = 0; ci3 < cells.length; ci3++) {
              rowText.push((cells[ci3].textContent || '').trim());
            }
            if (rowText.join('').trim()) {
              contents.push({ type: 'paragraph', text: rowText.join(' | ') });
            }
          }
          break;
        case 'br':
          // 忽略 br
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

    return contents;
  }

  // ── Markdown 解析 ──
  function parseMd(text, fileName) {
    // 提取 YAML frontmatter
    var meta = {};
    var mdContent = text;
    var fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
      // 简单解析 YAML key: value
      var yamlLines = fmMatch[1].split(/\r?\n/);
      for (var yi = 0; yi < yamlLines.length; yi++) {
        var ym = yamlLines[yi].match(/^(\w+)\s*:\s*(.+)$/);
        if (ym) meta[ym[1].trim()] = ym[2].trim().replace(/^['"]|['"]$/g, '');
      }
      mdContent = fmMatch[2];
    }

    var bookTitle = meta.title || fileName.replace(/\.md$/i, '');
    var author = meta.author || '';
    var description = meta.description || '';

    // 用 marked 转 HTML
    var html = '';
    if (win.marked) {
      html = typeof win.marked.parse === 'function'
        ? win.marked.parse(mdContent)
        : win.marked(mdContent);
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

    // 按 h1/h2 分割章节（与 md_parser.py 的 _split_by_headings 一致）
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

  // ── 存储 API ──
  function saveBook(book) {
    return importStore.setItem(KEY_PREFIX + book.id, book).then(function() {
      return importStore.getItem(KEY_IDS).then(function(ids) {
        ids = ids || [];
        if (ids.indexOf(book.id) < 0) ids.push(book.id);
        return importStore.setItem(KEY_IDS, ids);
      });
    }).then(function() { return book; });
  }

  function getImportedBook(bookId) {
    if (bookId.indexOf('imported-') !== 0) return Promise.resolve(null);
    return importStore.getItem(KEY_PREFIX + bookId);
  }

  function getImportedBooks() {
    return importStore.getItem(KEY_IDS).then(function(ids) {
      if (!ids || !ids.length) return [];
      var promises = [];
      for (var i = 0; i < ids.length; i++) {
        promises.push(importStore.getItem(KEY_PREFIX + ids[i]));
      }
      return Promise.all(promises).then(function(books) {
        return books.filter(function(b) { return b != null; });
      });
    });
  }

  function getImportedBookIds() {
    return importStore.getItem(KEY_IDS).then(function(ids) { return ids || []; });
  }

  function deleteImportedBook(bookId) {
    return importStore.removeItem(KEY_PREFIX + bookId).then(function() {
      return importStore.getItem(KEY_IDS).then(function(ids) {
        ids = ids || [];
        var idx = ids.indexOf(bookId);
        if (idx >= 0) ids.splice(idx, 1);
        return importStore.setItem(KEY_IDS, ids);
      });
    });
  }

  // ── Base64 解码（处理 UTF-8 中文）──
  function decodeBase64(b64) {
    try {
      // 处理 UTF-8 编码的 base64
      var binaryStr = atob(b64);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return atob(b64);
    }
  }

  // ── 主入口 ──
  function pickAndImport() {
    console.log('[导入] 开始选择文件...');
    return pickFile().then(function(fileInfo) {
      if (!fileInfo) { console.log('[导入] 用户取消'); return null; }
      console.log('[导入] 已选择:', fileInfo.name);

      var ext = (fileInfo.name || '').split('.').pop().toLowerCase();
      var bookData;

      if (ext === 'epub') {
        // EPUB：需要二进制数据
        var epubData = fileInfo.arrayBuffer || fileInfo.data; // arrayBuffer(web) 或 base64(native)
        if (!epubData) throw new Error('无法读取 EPUB 文件数据');
        return parseEpub(epubData, fileInfo.name).then(function(book) {
          return saveBook(book);
        }).then(function(book) {
          console.log('[导入] EPUB 解析完成:', book.title, book.chapters.length + '章');
          return book;
        });
      } else if (ext === 'md' || ext === 'markdown') {
        var mdText = fileInfo.text || '';
        if (!mdText && fileInfo.data) {
          // base64 解码
          mdText = decodeBase64(fileInfo.data);
        }
        if (!mdText) throw new Error('无法读取 Markdown 文件内容');
        bookData = parseMd(mdText, fileInfo.name);
        return saveBook(bookData).then(function(book) {
          console.log('[导入] MD 解析完成:', book.title, book.chapters.length + '章');
          return book;
        });
      } else {
        // 默认为 TXT
        var txtText = fileInfo.text || '';
        if (!txtText && fileInfo.data) {
          txtText = decodeBase64(fileInfo.data);
        }
        if (!txtText) throw new Error('无法读取文件内容');
        bookData = parseTxt(txtText, fileInfo.name);
        return saveBook(bookData).then(function(book) {
          console.log('[导入] TXT 解析完成:', book.title, book.chapters.length + '章');
          return book;
        });
      }
    });
  }

  // ── 暴露 ──
  win.ImportManager = {
    pickAndImport: pickAndImport,
    getImportedBook: getImportedBook,
    getImportedBooks: getImportedBooks,
    getImportedBookIds: getImportedBookIds,
    deleteImportedBook: deleteImportedBook
  };
}(window));
