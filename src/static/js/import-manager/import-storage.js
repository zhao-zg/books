'use strict';

  // ── 存储 API ──
  // opts: { bookId?, source? } —— 用于 WebDAV 重同步时保留原 id 并持久化来源
  function saveBook(book, opts) {
    opts = opts || {};
    // 复用指定 id（重同步 / 覆盖写）
    if (opts.bookId) book.id = opts.bookId;
    // 持久化来源信息（如 WebDAV：{type, serverId, remotePath, serverName}）
    if (opts.source) book.source = opts.source;
    // 持久化额外字段（如 series, _bundled 等，用于内置 EPUB 资源标记）
    if (opts.extra) {
      for (var k in opts.extra) {
        if (opts.extra.hasOwnProperty(k)) book[k] = opts.extra[k];
      }
    }
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
