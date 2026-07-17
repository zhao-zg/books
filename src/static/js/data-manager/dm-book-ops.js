  // ── 书籍读取 ─────────────────────────────────────────────────────────

  /**
   * 获取书籍数据（优先本地缓存，无缓存则在线获取并缓存）
   * 返回转换后的书籍数据（content 为结构化数组）
   * @param {string} bookId
   * @param {string} series
   */
  function getBook(bookId, series) {
    // 先尝试本地缓存
    return storeGet(KEY_BOOK_PREFIX + bookId).then(function (cached) {
      if (cached) {
        console.log('[DataManager] 从本地缓存读取: ' + bookId);
        return cached;
      }
      // 本地无缓存，在线获取并缓存
      console.log('[DataManager] 本地无缓存，在线获取: ' + bookId);
      if (!series) {
        // 使用公共方法查找 series
        return findSeriesByBookId(bookId).then(function (resolvedSeries) {
          if (!resolvedSeries) {
            return Promise.reject(new Error('未找到书籍 ' + bookId + ' 所属系列'));
          }
          return downloadBook(bookId, resolvedSeries);
        });
      }
      return downloadBook(bookId, series);
    });
  }

  /**
   * 检查书籍是否已下载到本地
   * 优先查内存缓存，避免每次查询 IndexedDB 的 I/O 开销
   * @param {string} bookId
   */
  function isBookDownloaded(bookId) {
    if (_downloadedIdCache) {
      return Promise.resolve(_downloadedIdCache.has(bookId));
    }
    // 缓存未初始化，先初始化再查询
    return getDownloadedIdsList().then(function () {
      return _downloadedIdCache ? _downloadedIdCache.has(bookId) : false;
    });
  }

  /**
   * 获取所有已下载书籍的 ID 列表
   */
  function getDownloadedBookIds() {
    return getDownloadedIdsList();
  }

  /**
   * 将书籍数据写入本地缓存（IndexedDB + 已下载列表）
   * 用于内置书籍、导入书籍等已有数据的本地化，使其与普通下载书籍统一管理
   * @param {string} bookId
   * @param {object} bookData  转换后的书籍数据
   */
  function cacheBook(bookId, bookData) {
    console.log('[DataManager] 缓存书籍到本地: ' + bookId);
    return storeSet(KEY_BOOK_PREFIX + bookId, bookData)
      .then(function () { return addDownloadedId(bookId); })
      .then(function () {
        // 为已缓存的书构建全文内容索引（不阻塞返回）
        buildContentIndex(bookData);
        // 同步加入书目索引
        addToBookIndex(bookData);
        console.log('[DataManager] 书籍缓存完成: ' + bookId);
        return bookData;
      });
  }

  // ── 存储管理 ─────────────────────────────────────────────────────────

  /**
   * 删除本地缓存的书籍
   * @param {string} bookId
   */
  function deleteBook(bookId) {
    console.log('[DataManager] 删除本地缓存: ' + bookId);
    return storeRemove(KEY_BOOK_PREFIX + bookId)
      .then(function () {
        return removeDownloadedId(bookId);
      })
      .then(function () {
        // 同步清理内容索引和书目索引
        removeContentIndex(bookId);
        removeFromBookIndex(bookId);
        console.log('[DataManager] 已删除: ' + bookId);
      });
  }

  /**
   * 获取存储统计信息
   * 返回 { downloadedCount, totalSizeBytes, totalSizeFormatted }
   */
  function getStorageStats() {
    return getDownloadedIdsList().then(function (ids) {
      var count = ids.length;
      // 估算总大小：遍历所有已存储的书籍数据
      if (!store || !count) {
        return {
          downloadedCount: count,
          totalSizeBytes: 0,
          totalSizeFormatted: '0 B'
        };
      }

      var sizePromises = ids.map(function (id) {
        return storeGet(KEY_BOOK_PREFIX + id).then(function (data) {
          if (!data) return 0;
          // 使用 Blob.size 获取精确的 UTF-8 字节数
          try {
            return new Blob([JSON.stringify(data)]).size;
          } catch (e) {
            return 0;
          }
        });
      });

      return Promise.all(sizePromises).then(function (sizes) {
        var totalBytes = 0;
        for (var i = 0; i < sizes.length; i++) {
          totalBytes += sizes[i];
        }
        return {
          downloadedCount: count,
          totalSizeBytes: totalBytes,
          totalSizeFormatted: formatSize(totalBytes)
        };
      });
    });
  }

  // ── 下载队列控制 ─────────────────────────────────────────────────────

  /**
   * 暂停当前批量下载
   */
  function pauseDownload() {
    if (_isDownloading && !_isPaused) {
      _isPaused = true;
      console.log('[DataManager] 下载已暂停');
    }
  }

  /**
   * 恢复暂停的批量下载
   */
  function resumeDownload() {
    if (_isDownloading && _isPaused) {
      _isPaused = false;
      // resolve 挂起的 Promise，唤醒等待中的 worker
      if (_pauseResolve) {
        var r = _pauseResolve;
        _pauseResolve = null;
        r();
      }
      console.log('[DataManager] 下载已恢复');
    }
  }

  /**
   * 取消当前批量下载
   */
  function cancelDownload() {
    if (_isDownloading) {
      _isCancelled = true;
      _isPaused = false;
      _isDownloading = false; // 立即重置，避免暂停中取消长时间不重置
      // 唤醒可能挂起的暂停 Promise
      if (_pauseResolve) {
        var r = _pauseResolve;
        _pauseResolve = null;
        r();
      }
      console.log('[DataManager] 下载已取消');
    }
  }

  /**
   * 获取下载状态
   * 返回 { isDownloading, isPaused, progress: { completed, total, currentTitle } }
   */
  function getDownloadStatus() {
    return {
      isDownloading: _isDownloading,
      isPaused: _isPaused,
      isCancelled: _isCancelled,
      progress: {
        completed: _dlCompleted,
        total: _dlTotal,
        currentTitle: _dlCurrentTitle
      }
    };
  }

