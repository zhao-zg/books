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
      return Array.isArray(list) ? list : [];
    });
  }

  function saveDownloadedIdsList(list) {
    return storeSet(KEY_DOWNLOADED, list);
  }

  function addDownloadedId(bookId) {
    return getDownloadedIdsList().then(function (list) {
      if (list.indexOf(bookId) === -1) {
        list.push(bookId);
      }
      return saveDownloadedIdsList(list);
    });
  }

  function removeDownloadedId(bookId) {
    return getDownloadedIdsList().then(function (list) {
      var idx = list.indexOf(bookId);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      return saveDownloadedIdsList(list);
    });
  }

