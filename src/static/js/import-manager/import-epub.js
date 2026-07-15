'use strict';

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

            // 预建 spine href → 章节序号映射（basename → 1-based index），
            // 用于解析跨章节链接时将文件名映射到正确的章节号
            var spineHrefMap = {};
            for (var si = 0; si < spineItems.length; si++) {
              var _idref = spineItems[si].getAttribute('idref');
              var _mItem = manifest[_idref];
              if (_mItem) {
                var _baseName = decodeURIComponent(_mItem.href.split('/').pop());
                if (!spineHrefMap[_baseName]) {
                  spineHrefMap[_baseName] = si + 1; // 1-based chapter number
                }
              }
            }

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
                    var hrefBasename = decodeURIComponent(fileHref.split('/').pop());
                    var contents = htmlToContents(html, cssMap, spineHrefMap, hrefBasename);
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
