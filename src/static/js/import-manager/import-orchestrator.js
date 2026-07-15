'use strict';

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

  // ── 内置书籍资源加载 ──────────────────────────────────────────────────
  // 从 resource/books/ 构建产物加载内置书籍，解析后合并到书城展示
  // 每个子目录 = 一个系列，可混合 .epub/.md/.txt 文件
  // 与 importBooks 不同：bundled MD/TXT books 不写入 IndexedDB，每次启动重新加载
  // EPUB 则走 importFromBuffer 持久化路径（已有的 loadEpubResources 机制）
  var _bundledBooksCache = null;

  /**
   * 加载 books-manifest.json，返回 {series: [...]} 结构
   * 每个系列包含 {id, name, files: [{file, format, size}]}
   */
  function _fetchBooksManifest() {
    return fetch('books/books-manifest.json').then(function (resp) {
      if (!resp.ok) throw new Error('books-manifest.json 加载失败: ' + resp.status);
      return resp.json();
    }).then(function (data) {
      if (!data || !data.series || !data.series.length) return null;
      return data;
    }).catch(function (err) {
      console.warn('[ImportManager] books-manifest.json 加载失败:', err.message);
      return null;
    });
  }

  /**
   * 生成内置书籍稳定 ID
   * 格式：bundle-{seriesId}/{filenameWithoutExt}
   * 例如：bundle-内置书库/阅读的艺术
   */
  function _bundleBookId(seriesId, filePath) {
    var fileName = filePath.split('/').pop();
    var stem = fileName.replace(/\.(md|markdown|txt|epub)$/i, '');
    // ★ 使用 :: 分隔 seriesId 和 stem，避免 / 与 URL 路由冲突
    return 'bundle-' + seriesId + '::' + stem;
  }

  function loadBundledBooks() {
    if (_bundledBooksCache) return Promise.resolve(_bundledBooksCache);
    return _fetchBooksManifest().then(function (data) {
      if (!data) return { books: [], seriesMap: {} };

      var allBooks = [];
      var seriesMap = {};  // seriesId → {id, name, type, bookCount}

      // 收集所有非 EPUB 的文件条目（MD + TXT），逐个 fetch + parse
      var promises = [];
      for (var si = 0; si < data.series.length; si++) {
        var series = data.series[si];
        seriesMap[series.id] = { id: series.id, name: series.name, type: 'bundle', bookCount: 0 };

        for (var fi = 0; fi < series.files.length; fi++) {
          (function (entry, seriesId) {
            // EPUB 跳过，由 loadEpubResources 单独处理
            if (entry.format === 'epub') return;

            var fileUrl = 'books/' + entry.file.split('/').map(encodeURIComponent).join('/');
            var fileName = entry.file.split('/').pop();
            var bookId = _bundleBookId(seriesId, entry.file);

            promises.push(fetch(fileUrl).then(function (resp) {
              if (!resp.ok) throw new Error('加载 ' + entry.file + ' 失败: ' + resp.status);
              return resp.text();
            }).then(function (textContent) {
              var book;
              if (entry.format === 'md' || entry.format === 'markdown') {
                book = parseMd(textContent, fileName);
              } else {
                // txt 及其他格式默认用 parseTxt
                book = parseTxt(textContent, fileName);
              }
              book.id = bookId;
              book.series = seriesId;
              book._bundled = true;
              // ★ 如果 manifest 中指定了 title，优先使用（覆盖解析器自动检测的标题）
              if (entry.title) book.title = entry.title;
              seriesMap[seriesId].bookCount++;
              return book;
            }).catch(function (err) {
              console.warn('[ImportManager] 加载内置资源失败:', entry.file, err.message);
              return null;
            }));
          })(series.files[fi], series.id);
        }
      }

      return Promise.all(promises).then(function (results) {
        var books = results.filter(function (b) { return b != null; });
        var result = { books: books, seriesMap: seriesMap };
        _bundledBooksCache = result;
        return result;
      });
    });
  }

  /**
   * 获取单本内置书籍数据（供 renderer.loadBook 调用）
   * bookId 前缀为 'bundle-' 时命中；返回 Promise<book|null>
   */
  function getBundledBook(bookId) {
    if (!bookId || bookId.indexOf('bundle-') !== 0) return Promise.resolve(null);
    return loadBundledBooks().then(function (result) {
      if (!result || !result.books) return null;
      for (var i = 0; i < result.books.length; i++) {
        if (result.books[i].id === bookId) return result.books[i];
      }
      return null;
    });
  }

  // ── EPUB 资源自动导入 ────────────────────────────────────────────────
  // 从 books-manifest.json 中发现 EPUB 条目，
  // 自动 fetch 二进制 → importFromBuffer() → 持久化到 IndexedDB。
  // 幂等：已在 imported_ids 中的书籍自动跳过。
  function loadEpubResources() {
    return _fetchBooksManifest().then(function (data) {
      if (!data) return [];

      // 收集所有 EPUB 条目
      var epubEntries = [];
      for (var si = 0; si < data.series.length; si++) {
        var series = data.series[si];
        for (var fi = 0; fi < series.files.length; fi++) {
          var entry = series.files[fi];
          if (entry.format === 'epub') {
            entry._seriesId = series.id;
            epubEntries.push(entry);
          }
        }
      }
      if (!epubEntries.length) return [];

      // 获取已导入书籍列表，用于幂等去重
      return getImportedBooks().then(function (imported) {
        var importedIds = {};
        for (var i = 0; i < imported.length; i++) {
          importedIds[imported[i].id] = true;
        }

        // 过滤掉已导入的 EPUB（按稳定 bookId 判断）
        var toImport = [];
        for (var k = 0; k < epubEntries.length; k++) {
          var entry = epubEntries[k];
          // 从文件路径提取文件名
          var fileName = entry.file.split('/').pop();
          // 稳定 ID：imported-epub-{seriesId}::{filenameWithoutExt}
          // ★ 使用 :: 分隔，与 bundle bookId 保持一致，避免 / 与 URL 路由冲突
          var stem = entry._seriesId + '::' + fileName.replace(/\.epub$/i, '');
          var stableId = 'imported-epub-' + stem;
          if (importedIds[stableId]) {
            console.log('[EPUB资源] 已存在，跳过: ' + fileName + ' (id=' + stableId + ')');
          } else {
            entry._stableId = stableId;
            entry._fileName = fileName;
            toImport.push(entry);
          }
        }

        if (!toImport.length) {
          console.log('[EPUB资源] 均已导入，无需处理');
          return [];
        }

        var promises = [];
        for (var j = 0; j < toImport.length; j++) {
          (function (entry) {
            var fileUrl = 'books/' + entry.file.split('/').map(encodeURIComponent).join('/');
            // ★ 通过 opts.extra 持久化 series、title、_bundled 到 IndexedDB
            var extra = { _bundled: true };
            if (entry._seriesId) extra.series = entry._seriesId;
            if (entry.title) extra.title = entry.title;
            promises.push(
              fetch(fileUrl).then(function (resp) {
                if (!resp.ok) throw new Error('下载 ' + entry._fileName + ' 失败: ' + resp.status);
                return resp.arrayBuffer();
              }).then(function (arrayBuffer) {
                return importFromBuffer(
                  { name: entry._fileName, arrayBuffer: arrayBuffer },
                  { bookId: entry._stableId, source: { type: 'resource' }, extra: extra }
                ).then(function (book) {
                  console.log('[EPUB资源] 新导入: ' + book.title + ' (id=' + book.id + ', series=' + book.series + ')');
                  return book;
                });
              }).catch(function (err) {
                console.warn('[ImportManager] EPUB资源导入失败:', entry._fileName, err.message);
                return null;
              })
            );
          })(toImport[j]);
        }

        return Promise.all(promises).then(function (results) {
          var imported = results.filter(function (r) { return r != null; });
          if (imported.length > 0) {
            console.log('[EPUB资源] 完成：' + imported.length + ' 本新导入');
          }
          return imported;
        });
      });
    }).catch(function (err) {
      if (err.message && err.message.indexOf('404') >= 0) return [];
      console.warn('[ImportManager] EPUB资源加载失败:', err.message);
      return [];
    });
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
    getPdfDataStore: getPdfDataStore,
    loadBundledBooks: loadBundledBooks,
    getBundledBook: getBundledBook,
    loadEpubResources: loadEpubResources
  };
