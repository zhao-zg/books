  // ── 书籍下载 ─────────────────────────────────────────────────────────

  /**
   * 字节级流式 fetch：读取 Response body 时持续推送字节进度
   * 复用 fetchWithRetry 的重试 + 多地址容灾语义，但走 ReadableStream 读取
   * @param {string} url
   * @param {function} [onByteProgress] (received, total) => {}
   * @param {function} [shouldAbort] () => true 表示已取消
   * @returns {Promise<object>} 解析后的 JSON 对象
   */
  function fetchJsonStreamed(url, onByteProgress, shouldAbort) {
    function attempt(retries) {
      if (shouldAbort && shouldAbort()) throw _makeCancelledErr();
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var ct = r.headers.get('content-type') || '';
          if (ct.indexOf('text/html') !== -1) {
            var htmlErr = new Error('HTML_RESPONSE');
            htmlErr._isHtmlResponse = true;
            throw htmlErr;
          }
          var total = parseInt(r.headers.get('Content-Length') || '0', 10) || 0;
          var received = 0;
          var chunks = [];
          // 不支持 ReadableStream 时 fallback 到 r.text()（仍触发一次进度）
          if (!r.body || typeof r.body.getReader !== 'function') {
            return r.text().then(function (text) {
              if (shouldAbort && shouldAbort()) throw _makeCancelledErr();
              if (onByteProgress) onByteProgress(text.length, total || text.length);
              return JSON.parse(text);
            });
          }
          var reader = r.body.getReader();
          function pump() {
            return reader.read().then(function (result) {
              if (shouldAbort && shouldAbort()) {
                try { reader.cancel(); } catch (e) {}
                throw _makeCancelledErr();
              }
              if (result.done) {
                // 流读取结束：组装 Blob → text → JSON.parse
                var blob = new Blob(chunks, { type: 'application/json' });
                return blob.text().then(function (text) {
                  if (shouldAbort && shouldAbort()) throw _makeCancelledErr();
                  try {
                    return JSON.parse(text);
                  } catch (e) {
                    throw new Error('书籍数据解析失败：' + e.message);
                  }
                });
              }
              received += result.value.length;
              if (onByteProgress) onByteProgress(received, total);
              chunks.push(result.value);
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) {
          // 用户取消：直接抛出，不重试
          if (err && err.code === ERR_CANCELLED) throw err;
          // HTML 响应：跳过重试，尝试切换备用地址
          if (!err._isHtmlResponse && retries > 0) {
            var delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.warn('[DataManager] 流式下载失败，' + delay + 'ms 后重试: ' + url);
            return new Promise(function (resolve) { setTimeout(resolve, delay); })
              .then(function () {
                if (shouldAbort && shouldAbort()) throw _makeCancelledErr();
                return attempt(retries - 1);
              });
          }
          // 切换备用地址
          if (DATA_BASE_URLS.length > 1 && _currentUrlIndex < DATA_BASE_URLS.length - 1) {
            _currentUrlIndex++;
            DATA_BASE_URL = DATA_BASE_URLS[_currentUrlIndex];
            console.warn('[DataManager] 切换到备用地址: ' + DATA_BASE_URL +
              (err._isHtmlResponse ? '（前一个地址返回了 HTML）' : ''));
            var oldBase = DATA_BASE_URLS[_currentUrlIndex - 1].replace(/\/+$/, '');
            var relativePath;
            if (url.indexOf(oldBase + '/') === 0) {
              relativePath = url.substring(oldBase.length + 1);
            } else {
              relativePath = url.substring(url.lastIndexOf('/') + 1);
            }
            var newUrl = DATA_BASE_URL.replace(/\/+$/, '') + '/' + relativePath;
            if (shouldAbort && shouldAbort()) throw _makeCancelledErr();
            return fetchJsonStreamed(newUrl, onByteProgress, shouldAbort);
          }
          throw err._isHtmlResponse
            ? new Error('该书籍数据文件在所有服务器上均不存在')
            : err;
        });
    }
    return attempt(MAX_RETRIES);
  }

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
   *
     * ★ 字节级进度优化：用 ReadableStream 读取 body，按 received/total 实时推送百分比，
     *   在 0%-95% 区间推送字节进度，96-98 解析、98-100 入库，100 完成。
     *   无论单本还是批次下载，都会刷新 _dlBytesReceived/_dlBytesTotal/_dlCurrentBookPercent/_dlStage，
     *   downloadSeries/downloadAll 在 onProgress 里聚合为总进度。
   */
  function downloadBook(bookId, series, onProgress) {
    // capture 当前 token：cancelDownload 推进 _singleDlToken 后，myToken !== _singleDlToken 即表示已被取消
    var myToken = _singleDlToken;
    var isBatch = _dlTotal > 0;  // 是否在批次下载中（影响是否更新全局状态）

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
      _dlStage = '下载中';

      // ★ 字节级流式读取：在 0-95 区间推送百分比
      //   总进度 = 95 * received/total（无 Content-Length 时按 33%~95% 渐进，避免一直 0）
      function _onByteProgress(received, total) {
        _dlBytesReceived = received;
        _dlBytesTotal = total;
        if (total > 0) {
          _dlCurrentBookPercent = Math.min(95, Math.floor(received / total * 95));
        } else {
          // 无 Content-Length：用对数曲线模拟渐进，到 95% 封顶
          _dlCurrentBookPercent = Math.min(95, 33 + Math.floor(Math.log10(received + 1) * 8));
        }
        _calcSpeedBps(isBatch ? _dlBatchBytesReceived + received : received);
        if (isBatch && _dlTotal > 0) {
          _dlTotalPercent = _calcTotalPercent(_dlCompleted, _dlTotal);
        }
        if (onProgress) {
          onProgress(
            _dlCurrentBookPercent,
            '下载中 ' + formatSize(received) + (total > 0 ? ' / ' + formatSize(total) : '')
          );
        }
      }

      return fetchJsonStreamed(url, _onByteProgress, function () {
        return myToken !== _singleDlToken;
      })
        .then(function (rawBook) {
          // ★ 校验取消（流式读取期间可能已被取消）
          if (myToken !== _singleDlToken) throw _makeCancelledErr();
          // 96%：解析数据
          _dlCurrentBookPercent = 96;
          _dlStage = '解析数据';
          if (onProgress) onProgress(96, '解析数据...');
          var converted = convertBookData(rawBook);
          // 98%：写入 IndexedDB
          _dlCurrentBookPercent = 98;
          _dlStage = '写入本地';
          if (onProgress) onProgress(98, '写入本地...');
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
              _dlCurrentBookPercent = 100;
              _dlStage = '完成';
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
    // ★ 重置批次进度状态
    _resetBatchProgressState();

    // 支持单个或多个系列 ID
    var seriesIds = Array.isArray(seriesId) ? seriesId : [seriesId];
    var isPickup = seriesIds.indexOf('sy_auto') !== -1;

    console.log('[DataManager] 开始批量下载系列: ' + seriesIds.join(', '));

    // 内部进度封装：在 downloadBook 流式回调之外，把批次级状态推给业务层
    function _broadcastProgress() {
      if (onProgress) {
        onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
      }
    }

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
          // ★ 字节级进度：在每本任务内部用 onProgress 把单本进度合并到批次总进度，
          //   并主动广播 _broadcastProgress，供 UI 实时刷新
          var tasks = filtered.map(function (book) {
            var fn = function () {
              // 任务开始：重置当前本书进度状态
              _resetBookProgressState();
              _dlCurrentTitle = book.title || book.id;
              _dlStage = '下载中';
              _broadcastProgress();
              return downloadBook(book.id, book.series, function (percent, status) {
                // downloadBook 在 0/96/98/100/字节区间都会回调；percent 是单本百分比
                // 这里不直接更新 _dlCompleted，只刷新 _dlBytesReceived/_dlBytesTotal/_dlCurrentBookPercent（已在 downloadBook 内完成）
                // 重新计算批次总进度并广播
                if (_dlTotal > 0) {
                  _dlTotalPercent = _calcTotalPercent(_dlCompleted, _dlTotal);
                }
                _broadcastProgress();
              });
            };
            fn._bookTitle = book.title || book.id;
            return fn;
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            // 书完成时累加批次字节（用本本的 _dlBytesTotal 近似）
            if (_dlBytesTotal > 0) {
              _dlBatchBytesReceived += _dlBytesTotal;
            }
            _dlTotalPercent = _calcTotalPercent(completed, total);
            _broadcastProgress();
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
              _dlTotalPercent = 100;
              _dlCurrentBookPercent = 100;
              _dlStage = '完成';
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
    // ★ 重置批次进度状态
    _resetBatchProgressState();

    console.log('[DataManager] 开始下载全部书籍');

    // 内部进度封装
    function _broadcastProgress() {
      if (onProgress) {
        onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
      }
    }

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
              _resetBookProgressState();
              _dlCurrentTitle = book.title || book.id;
              _dlStage = '下载中';
              _broadcastProgress();
              return downloadBook(book.id, book.series, function (percent, status) {
                if (_dlTotal > 0) {
                  _dlTotalPercent = _calcTotalPercent(_dlCompleted, _dlTotal);
                }
                _broadcastProgress();
              });
            };
            fn._bookTitle = book.title || book.id;
            return fn;
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            if (_dlBytesTotal > 0) {
              _dlBatchBytesReceived += _dlBytesTotal;
            }
            _dlTotalPercent = _calcTotalPercent(completed, total);
            _broadcastProgress();
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
              _dlTotalPercent = 100;
              _dlCurrentBookPercent = 100;
              _dlStage = '完成';
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

