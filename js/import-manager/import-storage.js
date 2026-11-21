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
      // 为导入的书构建全文内容索引 + 加入书目索引，使搜索可命中
      try {
        if (win.DataManager) {
          if (win.DataManager.buildContentIndex) win.DataManager.buildContentIndex(book);
          if (win.DataManager.addToBookIndex) win.DataManager.addToBookIndex(book);
        }
      } catch (e) { console.warn('[ImportManager] 更新内容索引失败:', e); }
      return book;
    });
  }

  /**
   * 移除导入的书籍：彻底清理 imported-data / imported-pdf-data / zl-data / 书架记录 / 内容&书目索引。
   * 该函数为「移出书架即彻底清理」的核心，补齐此前缺失的 PDF 二进制数据清理（此前无任何删除入口）。
   * @param {string} bookId
   * @returns {Promise<Object|string|undefined>} 被删除的书籍对象（无记录时返回 bookId）
   */
  function removeImportedBook(bookId) {
    return importStore.getItem(KEY_PREFIX + bookId).then(function (book) {
      return importStore.removeItem(KEY_PREFIX + bookId).then(function () {
        return importStore.getItem(KEY_IDS).then(function (ids) {
          ids = ids || [];
          var idx = ids.indexOf(bookId);
          if (idx !== -1) ids.splice(idx, 1);
          return importStore.setItem(KEY_IDS, ids);
        });
      }).then(function () {
        // 移出书架
        try { if (win.BKShelf && win.BKShelf.remove) win.BKShelf.remove(bookId); } catch (e) {}
        // 同步清理内容索引和书目索引
        try {
          if (win.DataManager) {
            if (win.DataManager.removeContentIndex) win.DataManager.removeContentIndex(bookId);
            if (win.DataManager.removeFromBookIndex) win.DataManager.removeFromBookIndex(bookId);
          }
        } catch (e) {}
        // 同步清理 DataManager 缓存（zl-data + 索引 + 占用缓存）
        // ★ 修复：必须 return deleteBook 的 Promise，否则 removeImportedBook 的 Promise 链
        //   不等待 zl-data 删除完成就 resolve，导致 purgeBook 后续检查 isBookDownloaded
        //   时缓存仍未被清除（竞态），书被误判为"已下载"而复活。
        var dmPromise = Promise.resolve();
        try {
          if (win.DataManager && win.DataManager.deleteBook) dmPromise = Promise.resolve(win.DataManager.deleteBook(bookId));
        } catch (e) { console.warn('[ImportManager] deleteBook 调用失败:', e); }
        return dmPromise.then(function () {
          // 清理 PDF 原始二进制数据（此前无任何删除入口，此调用补齐缺口）
          try {
            if (typeof removePdfData === 'function') return Promise.resolve(removePdfData(bookId));
          } catch (e) { console.warn('[ImportManager] 清理 PDF 数据失败:', e); }
          console.log('[ImportManager] 已移除导入书: ' + bookId);
          return book || bookId;
        });
      });
    });
  }

  function getImportedBook(bookId) {
    if (bookId.indexOf('imported-') !== 0) return Promise.resolve(null);
    return importStore.getItem(KEY_PREFIX + bookId);
  }

  /**
   * 判断某 bookId 是否在导入库中（imported_ids 有记录）。
   * 仅对 imported- 前缀的导入书返回 true；ZIP 导入的书城书（_importCityBook）
   * 不写入 imported_ids，因此返回 false，purgeBook 时走「书城书分支」。
   * @param {string} bookId
   * @returns {Promise<boolean>}
   */
  function isImportedBook(bookId) {
    if (!bookId) return Promise.resolve(false);
    return importStore.getItem(KEY_IDS).then(function (ids) {
      return !!(ids && ids.indexOf(bookId) !== -1);
    }).catch(function () {
      return false;
    });
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
