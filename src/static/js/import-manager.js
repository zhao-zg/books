 /**
 * import-manager.js
 * 外部书籍导入管理模块：支持 TXT、EPUB、Markdown、PDF 格式
 * 依赖：localforage、JSZip、marked、pdfjsLib（需在 index.html 中先于本文件加载）
 */
(function(win) {
  'use strict';

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

  // ── 多文件选择 ──
  function pickFiles() {
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
          'application/pdf',
          'application/octet-stream'
        ],
        readData: true,
        multiple: true
      }).then(function(result) {
        if (!result || !result.files || !result.files.length) return [];
        return result.files.map(function(f) {
          return { name: f.name, mime: f.mimeType, data: f.data, uri: f.uri };
        });
      });
    }

    // Web 环境：创建 input[type=file][multiple]
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.epub,.md,.markdown,.pdf';
      input.multiple = true;
      input.style.display = 'none';
      input.onchange = function(e) {
        var files = e.target.files;
        if (!files || !files.length) { resolve([]); return; }
        var tasks = [];
        for (var fi = 0; fi < files.length; fi++) {
          (function(file) {
            tasks.push(new Promise(function(res, rej) {
              var reader = new FileReader();
              if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name)) {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, arrayBuffer: ev.target.result, size: file.size });
                };
                reader.onerror = function() {
                  rej(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
                };
                reader.readAsArrayBuffer(file);
              } else {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, text: ev.target.result, size: file.size });
                };
                reader.onerror = function() {
                  rej(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
                };
                reader.readAsText(file, 'utf-8');
              }
            }));
          })(files[fi]);
        }
        Promise.all(tasks).then(resolve, reject);
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // ── 单文件选择（兼容旧接口）──
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
          'application/pdf',
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
      input.accept = '.txt,.epub,.md,.markdown,.pdf';
      input.style.display = 'none';
      input.onchange = function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) { resolve(null); return; }
        var reader = new FileReader();
        if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name)) {
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

  // ── 扫描文件夹（自动识别可导入文件）──
  var IMPORTABLE_EXT = ['.txt', '.epub', '.md', '.markdown', '.pdf'];

  function isImportableFile(name) {
    var ext = (name || '').split('.').pop().toLowerCase();
    return IMPORTABLE_EXT.indexOf('.' + ext) >= 0;
  }

  function scanDirectory(opts) {
    opts = opts || {};
    var recursive = !!opts.recursive;

    // 方案1：File System Access API (showDirectoryPicker)
    if (typeof win.showDirectoryPicker === 'function') {
      return win.showDirectoryPicker().then(function(dirHandle) {
        return _scanDirHandle(dirHandle, recursive);
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return []; // 用户取消
        // 不支持则降级到 input[webkitdirectory]
        return _scanViaInput(recursive);
      });
    }

    // 方案2：input[webkitdirectory] 降级
    return _scanViaInput(recursive);
  }

  // 通过 File System Access API 递归扫描
  function _scanDirHandle(dirHandle, recursive, basePath) {
    basePath = basePath || '';
    var filePromises = [];  // 收集文件读取 Promise
    var dirPromises = [];   // 收集子目录扫描 Promise

    // 遍历目录：手动消费异步迭代器（兼容 ES5 风格）
    function iterateEntries(iter, cb) {
      (function next() {
        iter.next().then(function(result) {
          if (result.done) { cb(); return; }
          var entry = result.value;
          var entryPath = basePath ? (basePath + '/' + entry.name) : entry.name;

          if (entry.kind === 'file') {
            if (isImportableFile(entry.name)) {
              filePromises.push(
                entry.getFile().then(function(file) {
                  return _readFileEntry(file, entryPath);
                }).catch(function() { return null; })
              );
            }
          } else if (entry.kind === 'directory' && recursive) {
            dirPromises.push(_scanDirHandle(entry, recursive, entryPath));
          }
          next();
        }).catch(function() { cb(); });
      })();
    }

    return new Promise(function(resolve) {
      var iter;
      try { iter = dirHandle.values(); } catch (e) { resolve([]); return; }
      iterateEntries(iter, function() {
        // 遍历完成，等待所有子目录扫描和文件读取结束
        Promise.all(dirPromises).then(function(subResults) {
          return Promise.all(filePromises).then(function(fileResults) {
            var all = [];
            // 添加文件结果
            for (var i = 0; i < fileResults.length; i++) {
              if (fileResults[i]) all.push(fileResults[i]);
            }
            // 添加子目录结果
            for (var d = 0; d < subResults.length; d++) {
              if (subResults[d] && subResults[d].length) {
                for (var s = 0; s < subResults[d].length; s++) {
                  all.push(subResults[d][s]);
                }
              }
            }
            resolve(all);
          });
        }).catch(function() { resolve([]); });
      });
    });
  }

  // 通过 input[webkitdirectory] 降级扫描
  function _scanViaInput(recursive) {
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      // 也设置 accept 但 webkitdirectory 模式下浏览器可能忽略
      input.accept = '.txt,.epub,.md,.markdown,.pdf';
      input.style.display = 'none';
      input.onchange = function(e) {
        var files = e.target.files;
        if (!files || !files.length) { resolve([]); return; }
        var importable = [];
        var tasks = [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (!isImportableFile(file.name)) continue;
          // 非 recursive 模式下过滤掉子目录文件（webkitRelativePath 包含路径）
          if (!recursive && file.webkitRelativePath) {
            var parts = file.webkitRelativePath.split('/');
            if (parts.length > 2) continue; // 超过 "文件夹/文件" 层级
          }
          (function(f) {
            tasks.push(_readFileEntry(f).then(function(info) {
              if (info) importable.push(info);
            }).catch(function() {}));
          })(file);
        }
        Promise.all(tasks).then(function() { resolve(importable); });
      };
      // 用户取消时不会触发 onchange，需要处理
      input.addEventListener('cancel', function() { resolve([]); });
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // 读取单个 File 对象为 fileInfo
  function _readFileEntry(file, virtualPath) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      var name = virtualPath || file.name;
      if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name)) {
        reader.onload = function(ev) {
          resolve({ name: name, mime: file.type, arrayBuffer: ev.target.result, size: file.size });
        };
        reader.onerror = function() { resolve(null); };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = function(ev) {
          resolve({ name: name, mime: file.type, text: ev.target.result, size: file.size });
        };
        reader.onerror = function() { resolve(null); };
        reader.readAsText(file, 'utf-8');
      }
    });
  }

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

          // 3. 并行提取封面、TOC 和 CSS，然后按 spine 顺序读取章节
          return Promise.all([
            extractEpubCover(zip, opfDoc, manifest, opfDir),
            parseEpubToc(zip, opfDoc, manifest, opfDir),
            extractEpubCss(zip, manifest, opfDir)
          ]).then(function(metaResults) {
            var coverUrl = metaResults[0];
            var tocMap = metaResults[1];
            var cssMap = metaResults[2];

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
                    var contents = htmlToContents(html, cssMap);
                    // 处理图片：将 EPUB 内图片转为 base64 data URI
                    return processEpubImages(zip, contents, fileHref, opfDir).then(function(processedContents) {
                      // 章节标题：优先从 TOC 查找，其次从内容中的 h1/h2 提取
                      var hrefBasename = decodeURIComponent(fileHref.split('/').pop());
                      var chapterTitle = tocMap[hrefBasename] || '';
                      if (!chapterTitle) {
                        for (var ci = 0; ci < processedContents.length; ci++) {
                          if (processedContents[ci].type === 'heading' && processedContents[ci].level <= 2) {
                            chapterTitle = processedContents[ci].text;
                            break;
                          }
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
                cover: coverUrl,
                language: (language || 'zh').substring(0, 2),
                description: description.substring(0, 500),
                chapters: chapters
              };
            });
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

  // EPUB 辅助：提取封面图片，返回 base64 data URI Promise
  function extractEpubCover(zip, opfDoc, manifest, opfDir) {
    var coverItemId = null;

    // 方法1: <meta name="cover" content="id"> (EPUB2)
    var metaCover = opfDoc.querySelector('meta[name="cover"]');
    if (metaCover) {
      coverItemId = metaCover.getAttribute('content');
    }

    // 方法2: <item properties="cover-image"> (EPUB3)
    if (!coverItemId) {
      var coverItem = opfDoc.querySelector('item[properties~="cover-image"]');
      if (coverItem) {
        coverItemId = coverItem.getAttribute('id');
      }
    }

    // 方法3: manifest 中 id 或 href 包含 "cover" 的图片项
    if (!coverItemId) {
      for (var id in manifest) {
        if (manifest[id].mediaType && manifest[id].mediaType.indexOf('image') === 0 &&
            (id.toLowerCase().indexOf('cover') >= 0 || manifest[id].href.toLowerCase().indexOf('cover') >= 0)) {
          coverItemId = id;
          break;
        }
      }
    }

    if (!coverItemId || !manifest[coverItemId]) return Promise.resolve('');

    var coverHref = opfDir + manifest[coverItemId].href;
    var coverFile = zip.file(coverHref) || zip.file(decodeURIComponent(coverHref));
    if (!coverFile) return Promise.resolve('');

    return coverFile.async('base64').then(function(b64) {
      var ext = (manifest[coverItemId].href.split('.').pop() || '').toLowerCase();
      var mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml'
      };
      var mime = mimeMap[ext] || manifest[coverItemId].mediaType || 'image/jpeg';
      return 'data:' + mime + ';base64,' + b64;
    }).catch(function() { return ''; });
  }

  // EPUB 辅助：解析 TOC (NCX/nav) 获取 {href: title} 映射
  function parseEpubToc(zip, opfDoc, manifest, opfDir) {
    var tocMap = {};

    // 查找 NCX (EPUB2): spine toc 属性 或 manifest media-type
    var spineEl = opfDoc.querySelector('spine');
    var ncxId = spineEl ? spineEl.getAttribute('toc') : '';
    if (!ncxId) {
      for (var id in manifest) {
        if (manifest[id].mediaType === 'application/x-dtbncx+xml') {
          ncxId = id;
          break;
        }
      }
    }

    // 查找 nav (EPUB3): manifest item properties="nav"
    var navId = null;
    var navItem = opfDoc.querySelector('item[properties~="nav"]');
    if (navItem) {
      navId = navItem.getAttribute('id');
    }

    var promises = [];

    // 解析 NCX
    if (ncxId && manifest[ncxId]) {
      var ncxHref = opfDir + manifest[ncxId].href;
      var ncxFile = zip.file(ncxHref) || zip.file(decodeURIComponent(ncxHref));
      if (ncxFile) {
        promises.push(
          ncxFile.async('string').then(function(ncxXml) {
            var parser = new DOMParser();
            var ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
            var navPoints = ncxDoc.querySelectorAll('navPoint');
            for (var i = 0; i < navPoints.length; i++) {
              var navLabel = navPoints[i].querySelector('text');
              var navContent = navPoints[i].querySelector('content');
              if (navLabel && navContent) {
                var title = (navLabel.textContent || '').trim();
                var src = (navContent.getAttribute('src') || '').split('#')[0];
                if (title && src) {
                  var baseName = src.split('/').pop();
                  tocMap[baseName] = title;
                  tocMap[src] = title;
                }
              }
            }
          }).catch(function() {})
        );
      }
    }

    // 解析 nav (EPUB3)
    if (navId && manifest[navId]) {
      var navHref = opfDir + manifest[navId].href;
      var navFile = zip.file(navHref) || zip.file(decodeURIComponent(navHref));
      if (navFile) {
        promises.push(
          navFile.async('string').then(function(navHtml) {
            var parser = new DOMParser();
            var navDoc = parser.parseFromString(navHtml, 'text/html');
            var navEl = navDoc.querySelector('nav[epub\\:type="toc"]') ||
                        navDoc.querySelector('nav[role="doc-toc"]') ||
                        navDoc.querySelector('nav');
            if (navEl) {
              var links = navEl.querySelectorAll('a');
              for (var i = 0; i < links.length; i++) {
                var href = (links[i].getAttribute('href') || '').split('#')[0];
                var title = (links[i].textContent || '').trim();
                if (title && href) {
                  var baseName = href.split('/').pop();
                  tocMap[baseName] = title;
                  tocMap[href] = title;
                }
              }
            }
          }).catch(function() {})
        );
      }
    }

    return Promise.all(promises).then(function() { return tocMap; });
  }

  // EPUB 辅助：读取所有 CSS 文件，构建合并的 cssMap
  function extractEpubCss(zip, manifest, opfDir) {
    var cssPromises = [];
    for (var id in manifest) {
      var m = manifest[id];
      if (m.mediaType === 'text/css' || (m.href && /\.css$/i.test(m.href))) {
        var cssHref = opfDir + m.href;
        var cssFile = zip.file(cssHref) || zip.file(decodeURIComponent(cssHref));
        if (cssFile) {
          cssPromises.push(cssFile.async('string'));
        }
      }
    }
    if (!cssPromises.length) return Promise.resolve({});
    return Promise.all(cssPromises).then(function(cssTexts) {
      var mergedMap = {};
      for (var i = 0; i < cssTexts.length; i++) {
        var partial = parseEpubCss(cssTexts[i]);
        for (var key in partial) {
          if (mergedMap[key]) {
            mergedMap[key] = mergeStyles(mergedMap[key], partial[key]);
          } else {
            mergedMap[key] = partial[key];
          }
        }
      }
      return mergedMap;
    });
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

  function extractInlineHtml(node, cssMap) {
    var result = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) {
        result += child.textContent || '';
      } else if (child.nodeType === 1) {
        var tag = (child.tagName || '').toLowerCase();
        if (tag === 'br') {
          result += '<br>';
        } else if (INLINE_TAGS[tag]) {
          var inner = extractInlineHtml(child, cssMap);
          if (tag === 'a') {
            var href = child.getAttribute('href') || '';
            // Detect cross-chapter links (e.g., "chapter-1.xhtml" or "chapter-1.xhtml#anchor")
            var chapterMatch = href.match(/chapter-(\d+)\.xhtml/i);
            if (chapterMatch) {
              result += '<a href="#" data-chapter-link="' + escHtml(chapterMatch[1]) + '">' + inner + '</a>';
            } else {
              result += '<a href="' + escHtml(href) + '">' + inner + '</a>';
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
          } else {
            result += '<' + tag + '>' + inner + '</' + tag + '>';
          }
        } else {
          result += extractInlineHtml(child, cssMap);
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

  // ── HTML→Content 转换（EPUB 和 MD 共用）──
  function htmlToContents(htmlStr, cssMap) {
    var parser = new DOMParser();

    // EPUB 章节可能是完整的 XHTML 文档（含 <?xml?> 声明、<html>/<head>/<body>），
    // 也可能是 HTML 片段。如果是完整文档，需要先提取 body 内容再解析，
    // 否则直接包在 <div> 中用 text/html 解析会导致标签嵌套混乱，
    // 尤其 <?xml?> 声明会被当作文本，<head> 中的 <title> 可能混入内容。
    var isFullDoc = /^\s*<\?xml[\s>]/i.test(htmlStr) ||
                    /^\s*<html[\s>]/i.test(htmlStr);
    var fragmentHtml;
    if (isFullDoc) {
      // 用 application/xhtml+xml 解析完整 XHTML 文档，提取 body
      var xdoc = parser.parseFromString(htmlStr, 'application/xhtml+xml');
      var xbody = xdoc.getElementsByTagName('body')[0];
      if (xbody) {
        // 序列化 body 内容为 HTML 字符串
        fragmentHtml = '';
        for (var bi = 0; bi < xbody.childNodes.length; bi++) {
          fragmentHtml += serializeNode(xbody.childNodes[bi]);
        }
      } else {
        // fallback: 尝试正则提取 <body>...</body> 之间的内容
        var bodyMatch = htmlStr.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        fragmentHtml = bodyMatch ? bodyMatch[1] : htmlStr;
      }
    } else {
      fragmentHtml = htmlStr;
    }

    var doc = parser.parseFromString('<div>' + fragmentHtml + '</div>', 'text/html');
    var root = doc.body.firstChild || doc.body;
    var contents = [];

    function getNodeStyle(node) {
      if (!cssMap) return '';
      var cls = node.getAttribute('class') || '';
      return cls ? lookupCssStyle(cssMap, cls) : '';
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
          var hHtml = extractInlineHtml(node, cssMap).trim();
          var hStyle = getNodeStyle(node);
          if (hText) contents.push({ type: 'heading', text: hText, html: hHtml, level: level, style: hStyle });
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
            var pHtml = extractInlineHtml(node, cssMap).trim();
            var pStyle = getNodeStyle(node);
            if (pText) contents.push({ type: 'paragraph', text: pText, html: pHtml, style: pStyle });
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
              var dsStyle = getNodeStyle(node);
              contents.push({ type: 'paragraph', text: dsText, html: extractInlineHtml(node, cssMap).trim(), style: dsStyle });
            }
          }
          break;
        case 'blockquote':
          var qText = (node.textContent || '').trim();
          var qHtml = extractInlineHtml(node, cssMap).trim();
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
          var items = [];
          var itemHtmls = [];
          // 检查 ol 是否带有 list-style:none（如 duokan-footnote-content），有则视为无序
          var olStyle = (node.getAttribute('style') || '').toLowerCase();
          var forceUnordered = tag === 'ol' && /\blist-style\s*:\s*none\b/.test(olStyle);
          var lis = node.querySelectorAll('li');
          for (var li = 0; li < lis.length; li++) {
            var liText = (lis[li].textContent || '').trim();
            var liHtml = extractInlineHtml(lis[li], cssMap).trim();
            if (liText) { items.push(liText); itemHtmls.push(liHtml); }
          }
          if (items.length) {
            contents.push({ type: 'list', items: items, itemHtmls: itemHtmls, attrs: { ordered: tag === 'ol' && !forceUnordered } });
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
                html: extractInlineHtml(cellEl, cssMap).trim()
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

  // ── PDF 解析 ──────────────────────────────────────────────────────────
  // 使用 pdf.js (pdfjsLib) 解析 PDF：
  //   1. 尝试从 PDF 书签/大纲（outline）提取章节结构
  //   2. 若无书签，则每页作为一个章节
  //   3. 每页内容存储为 { type: 'pdf_page', pageNumber, pdfBookId } 类型
  //   4. PDF 原始数据另存到 imported-pdf-data 存储区，渲染时按需取页
  //
  // data: ArrayBuffer | Uint8Array | base64 string
  // fileName: 原始文件名
  function parsePdf(data, fileName) {
    if (!win.pdfjsLib) {
      throw new Error('pdf.js 未加载，无法解析 PDF');
    }

    // 将 base64 转为 ArrayBuffer
    var pdfData;
    if (typeof data === 'string') {
      // base64
      var raw = atob(data);
      pdfData = new Uint8Array(raw.length);
      for (var bi = 0; bi < raw.length; bi++) pdfData[bi] = raw.charCodeAt(bi);
    } else if (data instanceof ArrayBuffer) {
      pdfData = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      pdfData = data;
    } else {
      throw new Error('不支持的 PDF 数据类型');
    }

    var bookTitle = fileName.replace(/\.pdf$/i, '');
    var bookId = generateId();

    // 先保存 PDF 原始数据副本，再传给 pdf.js（getDocument 可能 transfer/detach ArrayBuffer）
    var pdfRawForStorage = pdfData.buffer.slice(pdfData.byteOffset, pdfData.byteOffset + pdfData.byteLength);

    // 用 pdf.js 加载文档
    var loadingTask = win.pdfjsLib.getDocument({ data: pdfData });
    return loadingTask.promise.then(function(pdf) {
      var totalPages = pdf.numPages;

      // 存储原始 PDF 数据（供渲染时按页取图）
      return getPdfDataStore().setItem('pdf:' + bookId, pdfRawForStorage).then(function() {
        // 尝试提取 PDF 大纲/书签
        return pdf.getOutline().then(function(outline) {
          var chapters = [];

          if (outline && outline.length > 0) {
            // ── 有书签：按书签分章 ──
            // 获取每页文字用于提取页码范围
            return resolveOutlineChapters(pdf, outline, bookId, totalPages).then(function(outlineChapters) {
              return outlineChapters;
            }).catch(function() {
              // 大纲解析失败，回退到逐页模式
              return buildPerPageChapters(bookId, totalPages);
            });
          } else {
            // ── 无书签：每页一章 ──
            chapters = buildPerPageChapters(bookId, totalPages);
          }

          return chapters;
        });
      }).then(function(chapters) {
        if (!chapters.length) {
          chapters.push({
            number: 1,
            title: bookTitle,
            content: [{ type: 'paragraph', text: '（PDF 无页面）' }],
            footnotes: []
          });
        }

        // 尝试从第一页提取元数据
        return extractPdfMeta(pdf).then(function(meta) {
          return {
            id: bookId,
            title: meta.title || bookTitle,
            author: meta.author || '',
            format: 'pdf',
            cover: '',           // PDF 封面暂不提取，后续可扩展
            language: (meta.language || 'zh').substring(0, 2),
            description: (meta.subject || '').substring(0, 500),
            chapters: chapters,
            _pdfTotalPages: totalPages   // 内部标记，供渲染优化
          };
        });
      });
    });
  }

  // PDF 数据存储区（与 imported-data 分开，避免大块二进制污染主索引）
  var _pdfDataStore = null;
  function getPdfDataStore() {
    if (!_pdfDataStore) {
      _pdfDataStore = localforage.createInstance({
        name: 'books',
        storeName: 'imported-pdf-data'
      });
    }
    return _pdfDataStore;
  }

  // 无大纲时：每页生成一个章节
  function buildPerPageChapters(bookId, totalPages) {
    var chapters = [];
    for (var p = 1; p <= totalPages; p++) {
      chapters.push({
        number: p,
        title: '第 ' + p + ' 页',
        content: [{ type: 'pdf_page', pageNumber: p, pdfBookId: bookId }],
        footnotes: []
      });
    }
    return chapters;
  }

  // 有大纲时：按书签条目分章
  // 需要解析书签指向的页码，然后确定每个书签覆盖的页范围
  function resolveOutlineChapters(pdf, outline, bookId, totalPages) {
    // 递归展平大纲为 {title, pageNumber} 数组
    var flatItems = [];
    function flattenOutline(items, depth) {
      for (var i = 0; i < items.length; i++) {
        flatItems.push({ title: items[i].title, dest: items[i].dest, depth: depth });
        if (items[i].items && items[i].items.length) {
          flattenOutline(items[i].items, depth + 1);
        }
      }
    }
    flattenOutline(outline, 0);

    // 解析每个书签的页码
    var pagePromises = flatItems.map(function(item) {
      if (!item.dest) return Promise.resolve(null);
      // dest 可能是 string (named destination) 或 array (explicit destination)
      if (typeof item.dest === 'string') {
        return pdf.getDestination(item.dest).then(function(dest) {
          if (!dest || !dest[0]) return null;
          return pdf.getPageIndex(dest[0]).then(function(idx) { return idx + 1; });
        }).catch(function() { return null; });
      } else if (Array.isArray(item.dest) && item.dest[0]) {
        return pdf.getPageIndex(item.dest[0]).then(function(idx) { return idx + 1; }).catch(function() { return null; });
      }
      return Promise.resolve(null);
    });

    return Promise.all(pagePromises).then(function(pageNumbers) {
      // 构建书签-页码对，过滤无效条目
      var bookmarks = [];
      for (var i = 0; i < flatItems.length; i++) {
        if (pageNumbers[i] != null) {
          bookmarks.push({ title: flatItems[i].title, pageNumber: pageNumbers[i], depth: flatItems[i].depth });
        }
      }

      if (!bookmarks.length) {
        // 所有大纲条目都没解析出页码，回退逐页
        return buildPerPageChapters(bookId, totalPages);
      }

      // 按页码排序（有些 PDF 大纲顺序和页码不一致）
      bookmarks.sort(function(a, b) { return a.pageNumber - b.pageNumber; });

      // 去重：同一页多个书签只保留第一个
      var unique = [];
      var lastPage = 0;
      for (var bi = 0; bi < bookmarks.length; bi++) {
        if (bookmarks[bi].pageNumber !== lastPage) {
          unique.push(bookmarks[bi]);
          lastPage = bookmarks[bi].pageNumber;
        }
      }
      bookmarks = unique;

      // 只取顶级书签(depth=0)作为章节划分；若全是 depth>0 则按实际来
      var topBookmarks = bookmarks.filter(function(b) { return b.depth === 0; });
      if (topBookmarks.length > 0) bookmarks = topBookmarks;

      // 生成章节：每个书签覆盖从其页码到下一书签页码之前的所有页
      var chapters = [];
      for (var ci = 0; ci < bookmarks.length; ci++) {
        var startPage = bookmarks[ci].pageNumber;
        var endPage = (ci + 1 < bookmarks.length) ? bookmarks[ci + 1].pageNumber - 1 : totalPages;
        var content = [];
        for (var pg = startPage; pg <= endPage; pg++) {
          content.push({ type: 'pdf_page', pageNumber: pg, pdfBookId: bookId });
        }
        chapters.push({
          number: chapters.length + 1,
          title: bookmarks[ci].title || ('第 ' + startPage + ' 页'),
          content: content,
          footnotes: []
        });
      }

      // 若书签未覆盖开头页面，补充一个前置章节
      if (bookmarks.length && bookmarks[0].pageNumber > 1) {
        var preContent = [];
        for (var pp = 1; pp < bookmarks[0].pageNumber; pp++) {
          preContent.push({ type: 'pdf_page', pageNumber: pp, pdfBookId: bookId });
        }
        chapters.unshift({
          number: 1,
          title: '前言',
          content: preContent,
          footnotes: []
        });
        // 重新编号
        for (var ri = 0; ri < chapters.length; ri++) chapters[ri].number = ri + 1;
      }

      return chapters.length ? chapters : buildPerPageChapters(bookId, totalPages);
    });
  }

  // 提取 PDF 元数据（title, author, subject, language）
  function extractPdfMeta(pdf) {
    return pdf.getMetadata().then(function(info) {
      var meta = info && info.info || {};
      return {
        title: meta.Title || meta.title || '',
        author: meta.Author || meta.author || '',
        subject: meta.Subject || meta.subject || '',
        language: meta.Language || ''
      };
    }).catch(function() {
      return { title: '', author: '', subject: '', language: '' };
    });
  }

  // ── 存储 API ──
  // opts: { bookId?, source? } —— 用于 WebDAV 重同步时保留原 id 并持久化来源
  function saveBook(book, opts) {
    opts = opts || {};
    // 复用指定 id（重同步 / 覆盖写）
    if (opts.bookId) book.id = opts.bookId;
    // 持久化来源信息（如 WebDAV：{type, serverId, remotePath, serverName}）
    if (opts.source) book.source = opts.source;
    return importStore.setItem(KEY_PREFIX + book.id, book).then(function() {
      return importStore.getItem(KEY_IDS).then(function(ids) {
        ids = ids || [];
        if (ids.indexOf(book.id) < 0) ids.push(book.id);
        return importStore.setItem(KEY_IDS, ids);
      });
    }).then(function() {
      // 导入即入架：让书籍同时出现在「书架」与个人库（统一记录源），
      // 否则 WebDAV/文件导入的书只在书城合并、书架列表读不到。
      try { if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(book.id); } catch (e) {}
      return book;
    });
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
          return saveBook(book, { source: { type: 'local' } });
        }).then(function(book) {
          console.log('[导入] EPUB 解析完成:', book.title, book.chapters.length + '章');
          return book;
        });
      } else if (ext === 'pdf') {
        // PDF：需要二进制数据
        var pdfData = fileInfo.arrayBuffer || fileInfo.data;
        if (!pdfData) throw new Error('无法读取 PDF 文件数据');
        return parsePdf(pdfData, fileInfo.name).then(function(book) {
          return saveBook(book, { source: { type: 'local' } });
        }).then(function(book) {
          console.log('[导入] PDF 解析完成:', book.title, book.chapters.length + '章');
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
        return saveBook(bookData, { source: { type: 'local' } }).then(function(book) {
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
        return saveBook(bookData, { source: { type: 'local' } }).then(function(book) {
          console.log('[导入] TXT 解析完成:', book.title, book.chapters.length + '章');
          return book;
        });
      }
    });
  }

  // ── 从内存缓冲区导入（WebDAV 单向下载 / 重同步复用，不重写解析逻辑）──
  // fileInfo: { name, mime?, text?|arrayBuffer?|data? }
  //   - epub: 需二进制（arrayBuffer / Uint8Array / base64(data)）
  //   - txt / md: 需文本（text）或 base64(data)
  // opts: { bookId?, source? } —— bookId 保留原书 id（覆盖写），source 持久化来源
  // 返回：落库后的 book 对象（Promise）
  function importFromBuffer(fileInfo, opts) {
    opts = opts || {};
    if (!fileInfo || !fileInfo.name) {
      return Promise.reject(new Error('缺少文件信息（name 必填）'));
    }
    var ext = (fileInfo.name.split('.').pop() || '').toLowerCase();
    var bookData;

    if (ext === 'epub') {
      // EPUB：需要二进制数据
      var epubData = fileInfo.arrayBuffer || fileInfo.data; // arrayBuffer(web) / Uint8Array / base64(native)
      if (!epubData) return Promise.reject(new Error('无法读取 EPUB 文件数据'));
      return parseEpub(epubData, fileInfo.name).then(function (book) {
        return saveBook(book, opts);
      });
    } else if (ext === 'pdf') {
      // PDF：需要二进制数据
      var pdfData = fileInfo.arrayBuffer || fileInfo.data;
      if (!pdfData) return Promise.reject(new Error('无法读取 PDF 文件数据'));
      return parsePdf(pdfData, fileInfo.name).then(function (book) {
        return saveBook(book, opts);
      });
    } else if (ext === 'md' || ext === 'markdown') {
      var mdText = fileInfo.text;
      if (!mdText && fileInfo.data) mdText = decodeBase64(fileInfo.data);
      if (!mdText) return Promise.reject(new Error('无法读取 Markdown 文件内容'));
      bookData = parseMd(mdText, fileInfo.name);
      return saveBook(bookData, opts);
    } else {
      // 默认按 TXT 处理
      var txtText = fileInfo.text;
      if (!txtText && fileInfo.data) txtText = decodeBase64(fileInfo.data);
      if (!txtText) return Promise.reject(new Error('无法读取文件内容'));
      bookData = parseTxt(txtText, fileInfo.name);
      return saveBook(bookData, opts);
    }
  }

  // ── 暴露 ──
  win.ImportManager = {
    pickAndImport: pickAndImport,
    pickFiles: pickFiles,
    scanDirectory: scanDirectory,
    importBatch: importBatch,
    importFromBuffer: importFromBuffer,
    isImportableFile: isImportableFile,
    getImportedBook: getImportedBook,
    getImportedBooks: getImportedBooks,
    getPdfDataStore: getPdfDataStore
  };
}(window));
