  // ── 索引管理 ─────────────────────────────────────────────────────────

  /**
   * 加载全局索引 books-index.json
   * 策略：本地数据源优先使用缓存（数据随 APK 打包，始终最新）；
   *        远程数据源优先拉取远程（确保数据最新），失败则用缓存。
   * 返回 { series: [...], books: [...] }
   */
  function loadIndex() {
    // 判断当前是否为本地数据源
    var isLocal = DATA_BASE_URL && (DATA_BASE_URL.charAt(0) === '.' || DATA_BASE_URL.charAt(0) === '/');
    if (isLocal) {
      // 本地数据源：缓存优先，后台静默检查更新
      return storeGet(KEY_INDEX).then(function (cached) {
        if (cached) {
          _cachedIndex = cached;
          console.log('[DataManager] 使用缓存索引（' + ((cached.books || []).length) + ' 本书）');
          _silentCheckUpdate();
          return cached;
        }
        return _fetchRemoteIndex();
      });
    }
    // 远程数据源：优先拉取最新数据
    return _fetchRemoteIndex().catch(function (remoteErr) {
      console.warn('[DataManager] 远程加载失败，尝试使用缓存:', remoteErr.message);
      return storeGet(KEY_INDEX).then(function (cached) {
        if (cached) {
          _cachedIndex = cached;
          console.log('[DataManager] 使用缓存索引（' + ((cached.books || []).length) + ' 本书）');
          return cached;
        }
        throw remoteErr;
      });
    });
  }

  /**
   * 远程获取索引并存缓存
   * @param {boolean} [silent=false] 静默模式（不派发更新事件）
   */
  function _fetchRemoteIndex(silent) {
    var url = buildUrl('books-index.json?t=' + Date.now());
    console.log('[DataManager] 远程加载全局索引: ' + url);
    return fetchWithRetry(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var oldCount = _cachedIndex ? (_cachedIndex.books || []).length : 0;
        var newCount = (data.books || []).length;
        _cachedIndex = data;
        return storeSet(KEY_INDEX, data).then(function () {
          console.log('[DataManager] 全局索引加载成功，共 ' +
            newCount + ' 本书，' +
            ((data.series || []).length) + ' 个系列');
          // 非静默模式且数据有变化时，派发更新事件
          if (!silent && oldCount > 0 && oldCount !== newCount) {
            console.log('[DataManager] 索引已更新（' + oldCount + ' → ' + newCount + '），通知渲染器刷新');
            try { document.dispatchEvent(new CustomEvent('zl:index-updated')); } catch(e) {}
          }
          return data;
        });
      })
      .catch(function (err) {
        console.error('[DataManager] 加载全局索引失败:', err);
        // 再次尝试缓存
        return storeGet(KEY_INDEX).then(function (cached) {
          if (cached) {
            _cachedIndex = cached;
            console.log('[DataManager] 使用缓存的全局索引');
            return cached;
          }
          throw new Error('无法加载书籍索引，请检查网络连接');
        });
      });
  }

  /**
   * 后台静默检查索引更新，有新版本则自动拉取
   */
  function _silentCheckUpdate() {
    if (win.__BK_LOCAL_DEV__) return;
    var url = buildUrl('manifest.json?t=' + Date.now());
    fetch(url, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (remoteManifest) {
        if (!remoteManifest) return;
        return storeGet(KEY_MANIFEST).then(function (localManifest) {
          var remoteVer = remoteManifest.version || 0;
          var localVer = (localManifest && localManifest.version) || 0;
          if (remoteVer > localVer) {
            console.log('[DataManager] 发现新版本（' + localVer + ' → ' + remoteVer + '），后台更新索引...');
            _cachedManifest = remoteManifest;
            storeSet(KEY_MANIFEST, remoteManifest);
            _fetchRemoteIndex(false); // 非静默：数据更新后通知渲染器
          }
        });
      })
      .catch(function (e) {
        console.warn('[data-manager] 静默更新检查失败', e);
        // 保留"静默不弹窗"语义；离线时尝试展示已有离线提示条
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          var banner = document.getElementById('bkOfflineBanner');
          if (banner) {
            banner.hidden = false;
            banner.classList.add('bk-offline-visible');
          }
        }
      });
  }

  /**
   * 获取已缓存的索引（同步）
   */
  function getCachedIndex() {
    return _cachedIndex;
  }

  /**
   * 检查索引是否需要更新（通过 manifest.json version）
   * 返回 { needUpdate: boolean, remoteVersion, localVersion }
   */
  function checkIndexUpdate() {
    if (win.__BK_LOCAL_DEV__) return Promise.resolve({ needUpdate: false });
    var url = buildUrl('manifest.json?t=' + Date.now());
    console.log('[DataManager] 检查清单更新: ' + url);
    return fetchWithRetry(url)
      .then(function (r) { return r.json(); })
      .then(function (remoteManifest) {
        return storeGet(KEY_MANIFEST).then(function (localManifest) {
          var remoteVer = remoteManifest.version || 0;
          var localVer = (localManifest && localManifest.version) || 0;
          var needUpdate = remoteVer > localVer;
          console.log('[DataManager] 清单版本: 远程=' + remoteVer + ' 本地=' + localVer +
            ' 需要更新=' + needUpdate);
          // 更新缓存的 manifest
          _cachedManifest = remoteManifest;
          return storeSet(KEY_MANIFEST, remoteManifest).then(function () {
            return {
              needUpdate: needUpdate,
              remoteVersion: remoteVer,
              localVersion: localVer,
              manifest: remoteManifest
            };
          });
        });
      })
      .catch(function (err) {
        console.error('[DataManager] 检查清单更新失败:', err);
        return { needUpdate: false, remoteVersion: 0, localVersion: 0, error: err.message };
      });
  }

