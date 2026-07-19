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
        // 失效占用缓存（书籍数据已变更）
        _invalidateBookSizeCache();
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
        // 失效占用缓存（书籍数据已变更）
        _invalidateBookSizeCache();
        console.log('[DataManager] 已删除: ' + bookId);
      });
  }

  /**
   * 获取存储统计信息
   * 返回 {
   *   downloadedCount,
   *   totalSizeBytes,         // zl-data 中书籍数据的估算占用（带内存缓存，写操作后失效）
   *   totalSizeFormatted,
   *   originUsageBytes,       // 浏览器整体占用（IndexedDB + Cache Storage，覆盖 PDF/资源包等所有源）
   *   originUsageFormatted,
   *   usageBreakdown          // [{ storageType, usage }] 或 null（仅 Chrome 92+ 可用）
   * }
   */
  function getStorageStats() {
    return getDownloadedIdsList().then(function (ids) {
      var count = ids.length;

      // 1) zl-data 书籍数据占用估算（带内存缓存，cacheBook/deleteBook/downloadBook/clearAllBooks 后失效）
      var bookSizePromise;
      if (!store || !count) {
        _bookBytesCache = 0;
        bookSizePromise = Promise.resolve(0);
      } else if (_bookBytesCache !== null) {
        // 命中缓存，跳过 O(N) 遍历
        bookSizePromise = Promise.resolve(_bookBytesCache);
      } else {
        bookSizePromise = Promise.all(ids.map(function (id) {
          return storeGet(KEY_BOOK_PREFIX + id).then(function (data) {
            if (!data) return 0;
            // 使用 Blob.size 获取精确的 UTF-8 字节数
            try {
              return new Blob([JSON.stringify(data)]).size;
            } catch (e) {
              return 0;
            }
          });
        })).then(function (sizes) {
          var total = 0;
          for (var i = 0; i < sizes.length; i++) total += sizes[i];
          _bookBytesCache = total;  // 写入缓存
          return total;
        });
      }

      // 2) 浏览器整体占用：navigator.storage.estimate() 一次拿到 origin 级总占用，
      //    天然覆盖 IndexedDB 所有库 + Cache Storage，无需逐库遍历，性能好且无遗漏。
      //    这相当于把导入书二进制与索引(imported-data / imported-pdf-data)、
      //    资源包解压文件(bk-main Cache)、书签/划线等全部计入。
      var originSizePromise;
      if (win.navigator && win.navigator.storage && typeof win.navigator.storage.estimate === 'function') {
        originSizePromise = win.navigator.storage.estimate().then(function (est) {
          // Chrome 92+ 提供 usageBreakdown：[{ storageType: 'indexeddb', usage: N }, ...]
          // 保存 breakdown 供 UI 层按需展示分项（如 IndexedDB / Cache Storage 分别多少）
          var usage = (est && est.usage) || 0;
          var breakdown = (est && Array.isArray(est.usageBreakdown) && est.usageBreakdown.length)
            ? est.usageBreakdown : null;
          return { usage: usage, breakdown: breakdown };
        }).catch(function () { return { usage: 0, breakdown: null }; });
      } else {
        originSizePromise = Promise.resolve({ usage: 0, breakdown: null });
      }

      return Promise.all([bookSizePromise, originSizePromise]).then(function (results) {
        var bookBytes = results[0];
        var originResult = results[1];
        var originBytes = originResult.usage;
        var breakdown = originResult.breakdown;
        return {
          downloadedCount: count,
          totalSizeBytes: bookBytes,
          totalSizeFormatted: formatSize(bookBytes),
          originUsageBytes: originBytes,
          originUsageFormatted: formatSize(originBytes),
          usageBreakdown: breakdown
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

