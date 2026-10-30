  // ── localforage 辅助 ─────────────────────────────────────────────────

  /**
   * 安全地写入 localforage
   */
  function storeSet(key, value) {
    if (!store) {
      console.warn('[DataManager] localforage 不可用');
      return Promise.resolve();
    }
    return store.setItem(key, value).catch(function (err) {
      console.error('[DataManager] 存储写入失败: ' + key, err);
      throw new Error('存储空间不足，请清理后重试');
    });
  }

  /**
   * 安全地读取 localforage
   */
  function storeGet(key) {
    if (!store) return Promise.resolve(null);
    return store.getItem(key).catch(function (err) {
      console.error('[DataManager] 存储读取失败: ' + key, err);
      return null;
    });
  }

  /**
   * 安全地删除 localforage 条目
   */
  function storeRemove(key) {
    if (!store) return Promise.resolve();
    return store.removeItem(key).catch(function (err) {
      console.error('[DataManager] 存储删除失败: ' + key, err);
    });
  }

  // ── 已下载列表管理 ───────────────────────────────────────────────────

  function getDownloadedIdsList() {
    return storeGet(KEY_DOWNLOADED).then(function (list) {
      var ids = Array.isArray(list) ? list : [];
      // 初始化内存缓存
      if (!_downloadedIdCache) {
        _downloadedIdCache = new Set(ids);
      }
      return ids;
    });
  }

  function saveDownloadedIdsList(list) {
    // 同步更新内存缓存
    _downloadedIdCache = new Set(list);
    return storeSet(KEY_DOWNLOADED, list);
  }

  function addDownloadedId(bookId) {
    // ★ 并发适配：直接操作内存缓存（Set.add 天然幂等且原子），
    //   再从缓存序列化写回 IndexedDB，杜绝 read-modify-write 竞态。
    //   旧代码先读再写，3路并发时 Worker 2 读到旧列表覆盖 Worker 1 的写入，
    //   导致约 1/3 的书籍 ID 丢失（下载了但不记录为"已下载"）。
    if (!_downloadedIdCache) {
      // 缓存未初始化，先初始化再操作
      return getDownloadedIdsList().then(function () {
        return addDownloadedId(bookId);
      });
    }
    _downloadedIdCache.add(bookId);
    // 从内存缓存序列化写回，保证包含所有已添加的 ID
    return saveDownloadedIdsList(Array.from(_downloadedIdCache));
  }

  function removeDownloadedId(bookId) {
    // ★ 并发适配：直接操作内存缓存，杜绝 read-modify-write 竞态
    if (!_downloadedIdCache) {
      return getDownloadedIdsList().then(function () {
        return removeDownloadedId(bookId);
      });
    }
    _downloadedIdCache.delete(bookId);
    return saveDownloadedIdsList(Array.from(_downloadedIdCache));
  }

