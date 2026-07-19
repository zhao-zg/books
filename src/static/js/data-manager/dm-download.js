  // ── 书籍下载 ─────────────────────────────────────────────────────────

  /**
   * 下载单本书，返回转换后的书籍数据
   * @param {string} bookId  如 "lee8-01"
   * @param {string} series  如 "lee8"
   * @param {function} [onProgress] 可选回调 (percent, status) => {}
   *
   * ★ 隐患4修复：单本下载也受取消控制。
   *   - capture 当前 _singleDlToken 作为 myToken，cancelDownload 推进 _singleDlToken
   *   - 在 fetch 前/响应后/解析后/写入前/完成前等关键节点校验 myToken === _singleDlToken
   *   - 被取消时抛出带 code: 'CANCELLED' 的错误，UI 层据此做无声清理
   *   - 启动新的单本下载不会推进 _singleDlToken，因此不会误取消其他进行中的单本下载
   */
  function downloadBook(bookId, series, onProgress) {
    // capture 当前 token：cancelDownload 推进 _singleDlToken 后，myToken !== _singleDlToken 即表示已被取消
    var myToken = _singleDlToken;

    // 使用公共方法查找 series
    var resolvePromise = series
      ? Promise.resolve(series)
      : findSeriesByBookId(bookId);

    return resolvePromise.then(function (resolvedSeries) {
      // ★ 校验取消（系列查找期间可能已被取消）
      if (myToken !== _singleDlToken) throw _makeCancelledErr();

      if (!resolvedSeries) {
        var err = new Error('未找到书籍 ' + bookId + ' 所属系列，无法下载');
        if (onProgress) onProgress(-1, err.message);
        throw err;
      }
      var url = buildUrl(resolvedSeries + '/' + bookId + '.json');
      console.log('[DataManager] 下载书籍: ' + bookId + ' → ' + url);
      if (onProgress) onProgress(0, '开始下载...');

      // ★ M1修复：将取消校验下沉到 fetchWithRetry，使其在重试 setTimeout 间隔内
      //   也能提前识别取消，避免用户取消后仍继续发起重试请求浪费网络/时间。
      //   下游各 .then 节点的校验保留作为兜底（应对 fetch 进行中无法中断的限制）。
      return fetchWithRetry(url, undefined, {
        shouldAbort: function () { return myToken !== _singleDlToken; }
      })
        .then(function (r) {
          // ★ 校验取消（fetch 期间可能已被取消）
          if (myToken !== _singleDlToken) throw _makeCancelledErr();
          if (onProgress) onProgress(50, '解析数据...');
          return r.json();
        })
        .then(function (rawBook) {
          // ★ 校验取消（json 解析期间可能已被取消）
          if (myToken !== _singleDlToken) throw _makeCancelledErr();
          var converted = convertBookData(rawBook);
          return storeSet(KEY_BOOK_PREFIX + bookId, converted)
            .then(function () {
              // ★ 校验取消（IndexedDB 写入期间可能已被取消）
              if (myToken !== _singleDlToken) throw _makeCancelledErr();
              return addDownloadedId(bookId);
            })
            .then(function () {
              // ★ 校验取消（addDownloadedId 期间可能已被取消；
              //   若已取消则不再构建索引，避免对已取消的下载做无用功）
              if (myToken !== _singleDlToken) throw _makeCancelledErr();
              // 为下载的书构建全文内容索引（不阻塞返回）
              buildContentIndex(converted);
              addToBookIndex(converted);
              // 失效占用缓存（书籍数据已变更）
              _invalidateBookSizeCache();
              if (onProgress) onProgress(100, '下载完成');
              console.log('[DataManager] 书籍下载完成: ' + bookId);
              return converted;
            });
        });
    }).catch(function (err) {
      // ★ 用户主动取消：单独记日志，不当作失败，onProgress 用 -1 通知 UI（UI 会做无声清理）
      // ★ M5修复：使用 ERR_CANCELLED 常量替代字面量
      if (err && err.code === ERR_CANCELLED) {
        console.log('[DataManager] 书籍下载被取消: ' + bookId);
        if (onProgress) onProgress(-1, '已取消');
        throw err;
      }
      console.error('[DataManager] 下载书籍失败: ' + bookId, err);
      if (onProgress) onProgress(-1, '下载失败: ' + (err.message || err));
      throw err;
    });
  }

  /**
   * 构造「已取消」错误对象
   * @returns {Error} 带 code: ERR_CANCELLED 的 Error
   */
  function _makeCancelledErr() {
    var e = new Error('下载已取消');
    e.code = ERR_CANCELLED;
    return e;
  }

  /**
   * 并发控制器：以最多 maxConcurrent 个并发执行任务列表
   * @param {Array<function>} tasks 返回 Promise 的工厂函数数组
   * @param {number} maxConcurrent
   * @param {function} [onTaskComplete] 每完成一个任务的回调
   * @returns {Promise<{success:number, failed:number, errors:Array}>}
   */
  function runConcurrent(tasks, maxConcurrent, onTaskComplete, runToken) {
    var success = 0;
    var failed = 0;
    var errors = [];
    var failedTasks = [];
    var nextIdx = 0;

    function runNext() {
      // ★ 批次令牌校验：若当前活跃批次已不是本批次（被新批次取代或被取消），立即退出
      //   避免旧 worker 继续消费旧 tasks 数组与新一档并发，或取消后旧任务复活
      if (runToken !== _dlActiveToken) {
        return Promise.resolve();
      }
      // 检查取消（在消费任务前）
      if (_isCancelled) {
        return Promise.resolve();
      }
      // 检查暂停：Promise 挂起，恢复时直接 resolve，无需轮询
      if (_isPaused) {
        return new Promise(function (resolve) {
          _pauseResolve = resolve;
        }).then(function () {
          // ★ 恢复后再次校验批次与取消状态（暂停期间可能被取消或被新批次取代）
          if (runToken !== _dlActiveToken) return Promise.resolve();
          if (_isCancelled) return Promise.resolve();
          return runNext();
        });
      }

      // 所有任务已分发，worker 退出
      if (nextIdx >= tasks.length) {
        return Promise.resolve();
      }

      // 消费当前任务索引（暂停/取消检查已在此之前完成）
      var idx = nextIdx++;
      var taskFn = tasks[idx];

      return taskFn()
        .then(function () {
          // ★ 任务完成后也需校验批次，避免取消后成功回调仍累加计数
          if (runToken !== _dlActiveToken) return;
          success++;
          if (onTaskComplete) onTaskComplete(success + failed, tasks.length);
        })
        .catch(function (err) {
          if (runToken !== _dlActiveToken) return;
          failed++;
          errors.push({ index: idx, error: err.message || String(err) });
          failedTasks.push(tasks[idx]);
          if (onTaskComplete) onTaskComplete(success + failed, tasks.length);
        })
        .then(function () {
          // 递归前再校验一次，防止递归调用时批次已被切换
          if (runToken !== _dlActiveToken) return Promise.resolve();
          return runNext();
        });
    }

    // 启动 maxConcurrent 个并发 worker
    var workers = [];
    for (var w = 0; w < maxConcurrent; w++) {
      workers.push(runNext());
    }
    return Promise.all(workers).then(function () {
      return { success: success, failed: failed, errors: errors, failedTasks: failedTasks };
    });
  }

  /**
   * 对批量下载中的失败任务进行自动重试
   * @param {Array<function>} failedTasks 上一轮失败的任务工厂函数
   * @param {number} maxRounds 最多重试轮数
   * @param {function} onProgress (completed, total, currentTitle) => {}
   * @param {object} acc 累计结果 { success, failed, errors, failedBookNames }
   * @returns {Promise<object>} 累计结果
   */
  function _retryFailed(failedTasks, maxRounds, onProgress, acc, runToken) {
    // ★ 重试同样校验批次令牌：被取消或被新批次取代后不再重试
    if (!failedTasks.length || maxRounds <= 0 || _isCancelled || runToken !== _dlActiveToken) {
      return Promise.resolve(acc);
    }
    console.log('[DataManager] 自动重试 ' + failedTasks.length + ' 个失败任务（剩余 ' + maxRounds + ' 轮）');
    // 重试前等待 2 秒，给网络一个缓冲期
    return new Promise(function (resolve) { setTimeout(resolve, 2000); })
      .then(function () {
        // ★ 等待后再次校验批次状态
        if (runToken !== _dlActiveToken || _isCancelled) return acc;
        return runConcurrent(failedTasks, MAX_CONCURRENT, function (completed, total) {
          if (onProgress) onProgress(acc.success + completed, acc.success + acc.failed, '重试中...');
        }, runToken).then(function (retryResult) {
          acc.success += retryResult.success;
          // 累加 + 去重：不清空已有记录，追加本轮仍失败的书名
          for (var i = 0; i < retryResult.failedTasks.length; i++) {
            var t = retryResult.failedTasks[i];
            if (t._bookTitle && acc.failedBookNames.indexOf(t._bookTitle) === -1) {
              acc.failedBookNames.push(t._bookTitle);
            }
          }
          if (retryResult.failed > 0) {
            return _retryFailed(retryResult.failedTasks, maxRounds - 1, onProgress, acc, runToken);
          }
          acc.failed = 0;
          return acc;
        });
      });
  }

  /**
   * 批量下载某系列（或多个系列）所有书籍
   * 使用全局索引查找书籍列表，避免单独请求系列 index.json
   * 支持拾遗系列 (sy_auto)：自动从全局索引中筛选小系列书籍
   * @param {string|Array<string>} seriesId 如 "lee8" 或 ["lee8", "lee9"]
   * @param {function} [onProgress] (completed, total, currentTitle) => {}
   */
  function downloadSeries(seriesId, onProgress) {
    if (_isDownloading) {
      // ★ 隐患2修复：返回带 code 的错误，使 UI 端能区分是"忙"还是真正的下载出错，
      //   避免误调 _onDownloadError 杀掉当前活跃批次的进度轮询与控件
      var busyErr = new Error('已有下载任务正在进行');
      busyErr.code = 'BUSY';
      return Promise.reject(busyErr);
    }

    // ★ 启动新批次：生成新令牌，使任何上一批残留的 worker 在下一次 runNext 时退出
    var myToken = ++_dlRunToken;
    _dlActiveToken = myToken;
    _isDownloading = true;
    _isPaused = false;
    _isCancelled = false;
    _dlCompleted = 0;
    _dlTotal = 0;
    _dlCurrentTitle = '';

    // 支持单个或多个系列 ID
    var seriesIds = Array.isArray(seriesId) ? seriesId : [seriesId];
    var isPickup = seriesIds.indexOf('sy_auto') !== -1;

    console.log('[DataManager] 开始批量下载系列: ' + seriesIds.join(', '));

    // 使用全局索引查找书籍（已加载，无需额外 HTTP 请求）
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();

    return indexPromise
      .then(function (indexData) {
        var allBooks = indexData.books || [];
        var toDownloadBooks = [];

        if (isPickup) {
          // 拾遗系列：下载所有小系列（< 3 本书）的书籍
          var seriesBookCount = {};
          for (var c = 0; c < allBooks.length; c++) {
            var sid = allBooks[c].series;
            seriesBookCount[sid] = (seriesBookCount[sid] || 0) + 1;
          }
          for (var j = 0; j < allBooks.length; j++) {
            var bookSeries = allBooks[j].series;
            if (bookSeries === 'sy_auto' || (seriesBookCount[bookSeries] < 3 && bookSeries !== 'books')) {
              toDownloadBooks.push(allBooks[j]);
            }
          }
        } else {
          // 指定系列：从全局索引中筛选
          for (var i = 0; i < allBooks.length; i++) {
            if (seriesIds.indexOf(allBooks[i].series) !== -1) {
              toDownloadBooks.push(allBooks[i]);
            }
          }
        }

        if (!toDownloadBooks.length) {
          _isDownloading = false;
          return { success: 0, failed: 0, errors: [] };
        }

        // 获取已下载列表，跳过已下载的
        return getDownloadedIdsList().then(function (downloadedIds) {
          var filtered = toDownloadBooks.filter(function (b) {
            return downloadedIds.indexOf(b.id) === -1;
          });

          _dlTotal = filtered.length;
          console.log('[DataManager] 系列 ' + seriesIds.join(',') + ' 共 ' + toDownloadBooks.length +
            ' 本，已下载 ' + (toDownloadBooks.length - filtered.length) +
            ' 本，待下载 ' + filtered.length + ' 本');

          if (!filtered.length) {
            _isDownloading = false;
            if (onProgress) onProgress(0, 0, '全部已下载');
            return { success: 0, failed: 0, errors: [] };
          }

          // 构建任务列表（downloadBook 会自动查找 series）
          var tasks = filtered.map(function (book) {
            var fn = function () {
              _dlCurrentTitle = book.title || book.id;
              if (onProgress) onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
              return downloadBook(book.id, book.series);
            };
            fn._bookTitle = book.title || book.id;
            return fn;
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            if (onProgress) onProgress(completed, total, _dlCurrentTitle);
          }, myToken).then(function (result) {
            // 收集首轮失败的书名
            var acc = {
              success: result.success,
              failed: result.failed,
              errors: result.errors,
              failedBookNames: []
            };
            for (var i = 0; i < result.failedTasks.length; i++) {
              var t = result.failedTasks[i];
              if (t._bookTitle) acc.failedBookNames.push(t._bookTitle);
            }
            if (result.failed > 0) {
              return _retryFailed(result.failedTasks, 2, onProgress, acc, myToken);
            }
            return acc;
          }).then(function (result) {
            // ★ 只有本批次仍是活跃批次时才复位状态（避免被新批次的状态被覆盖）
            if (myToken === _dlActiveToken) {
              _isDownloading = false;
              _dlCurrentTitle = '';
            }
            console.log('[DataManager] 系列 ' + seriesIds.join(',') + ' 下载完成: 成功=' +
              result.success + ' 失败=' + result.failed);
            return result;
          });
        });
      })
      .catch(function (err) {
        // ★ 仅本批次才复位，避免错误回调覆盖新一档的状态
        if (myToken === _dlActiveToken) {
          _isDownloading = false;
        }
        console.error('[DataManager] 批量下载系列失败: ' + seriesIds.join(','), err);
        throw err;
      });
  }

  /**
   * 下载全部书籍
   * @param {function} [onProgress] (completed, total, currentTitle) => {}
   */
  function downloadAll(onProgress) {
    if (_isDownloading) {
      // ★ 隐患2修复：返回带 code 的错误
      var busyErr = new Error('已有下载任务正在进行');
      busyErr.code = 'BUSY';
      return Promise.reject(busyErr);
    }

    // ★ 启动新批次
    var myToken = ++_dlRunToken;
    _dlActiveToken = myToken;
    _isDownloading = true;
    _isPaused = false;
    _isCancelled = false;
    _dlCompleted = 0;
    _dlTotal = 0;
    _dlCurrentTitle = '';

    console.log('[DataManager] 开始下载全部书籍');

    // 先加载全局索引
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();

    return indexPromise
      .then(function (indexData) {
        var allBooks = indexData.books || [];
        if (!allBooks.length) {
          _isDownloading = false;
          return { success: 0, failed: 0, errors: [] };
        }

        return getDownloadedIdsList().then(function (downloadedIds) {
          var toDownload = allBooks.filter(function (b) {
            return downloadedIds.indexOf(b.id) === -1;
          });

          _dlTotal = toDownload.length;
          console.log('[DataManager] 共 ' + allBooks.length + ' 本书，已下载 ' +
            (allBooks.length - toDownload.length) + ' 本，待下载 ' + toDownload.length + ' 本');

          if (!toDownload.length) {
            _isDownloading = false;
            if (onProgress) onProgress(0, 0, '全部已下载');
            return { success: 0, failed: 0, errors: [] };
          }

          var tasks = toDownload.map(function (book) {
            var fn = function () {
              _dlCurrentTitle = book.title || book.id;
              if (onProgress) onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
              return downloadBook(book.id, book.series);
            };
            fn._bookTitle = book.title || book.id;
            return fn;
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            if (onProgress) onProgress(completed, total, _dlCurrentTitle);
          }, myToken).then(function (result) {
            var acc = {
              success: result.success,
              failed: result.failed,
              errors: result.errors,
              failedBookNames: []
            };
            for (var i = 0; i < result.failedTasks.length; i++) {
              var t = result.failedTasks[i];
              if (t._bookTitle) acc.failedBookNames.push(t._bookTitle);
            }
            if (result.failed > 0) {
              return _retryFailed(result.failedTasks, 2, onProgress, acc, myToken);
            }
            return acc;
          }).then(function (result) {
            if (myToken === _dlActiveToken) {
              _isDownloading = false;
              _dlCurrentTitle = '';
            }
            console.log('[DataManager] 全部下载完成: 成功=' +
              result.success + ' 失败=' + result.failed);
            return result;
          });
        });
      })
      .catch(function (err) {
        if (myToken === _dlActiveToken) {
          _isDownloading = false;
        }
        console.error('[DataManager] 下载全部书籍失败:', err);
        throw err;
      });
  }

