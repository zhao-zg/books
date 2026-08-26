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
        bookData = parseMd(cleanInvisibleChars(mdText), fileInfo.name);
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
        bookData = parseTxt(cleanInvisibleChars(txtText), fileInfo.name);
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
      bookData = parseMd(cleanInvisibleChars(mdText), fileInfo.name);
      return saveBook(bookData, opts);
    } else {
      // 默认按 TXT 处理
      var txtText = fileInfo.text;
      if (!txtText && fileInfo.data) txtText = decodeBase64(fileInfo.data);
      if (!txtText) return Promise.reject(new Error('无法读取文件内容'));
      bookData = parseTxt(cleanInvisibleChars(txtText), fileInfo.name);
      return saveBook(bookData, opts);
    }
  }

  // ── 内置书籍资源加载（已废弃）──────────────────────────────────────────
  // 内置书已由构建侧生成 ysz 格式 JSON，随 zl-data/ 一起下发 CDN，
  // 前端通过 DataManager.downloadBook() / getBook() 统一加载，无需特殊处理。
  // 以下函数保留为空桩，避免其他模块引用报错。

  /**
   * [已废弃] 内置书已走 CDN，此函数返回空结果
   */
  function loadBundledBooks() {
    return Promise.resolve({ books: [], seriesMap: {} });
  }

  /**
   * [已废弃] 内置书已走 CDN，此函数始终返回 null
   */
  function getBundledBook(bookId) {
    return Promise.resolve(null);
  }

  /**
   * [已废弃] 内置书 EPUB 已由构建侧转为 JSON，此函数返回空数组
   */
  function loadEpubResources() {
    return Promise.resolve([]);
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
    isImportedBook: isImportedBook,
    removeImportedBook: removeImportedBook,
    removePdfData: removePdfData,
    getPdfDataStore: getPdfDataStore,
    loadBundledBooks: loadBundledBooks,      // [已废弃] 保留空桩，避免引用报错
    getBundledBook: getBundledBook,          // [已废弃] 保留空桩，避免引用报错
    loadEpubResources: loadEpubResources     // [已废弃] 保留空桩，避免引用报错
  };
