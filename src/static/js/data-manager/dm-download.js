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
          // ★ 并发适配：加锁防止多个 fetch 同时切换导致 _currentUrlIndex 越界
          if (DATA_BASE_URLS.length > 1 && _currentUrlIndex < DATA_BASE_URLS.length - 1 && !_urlSwitching) {
            _urlSwitching = true;
            _currentUrlIndex++;
            DATA_BASE_URL = DATA_BASE_URLS[_currentUrlIndex];
            _urlSwitching = false;
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

    // ★ 并发适配：每本 downloadBook 占一个独立的 task slot
    var taskId = bookId;
    _activeTasks[taskId] = { received: 0, total: 0, percent: 0, stage: '下载中' };

    // 使用公共方法查找 series
    var resolvePromise = series
      ? Promise.resolve(series)
      : findSeriesByBookId(bookId);

    return resolvePromise.then(function (resolvedSeries) {
      // ★ 校验取消（系列查找期间可能已被取消）
      if (myToken !== _singleDlToken) {
        delete _activeTasks[taskId];
        throw _makeCancelledErr();
      }

      if (!resolvedSeries) {
        delete _activeTasks[taskId];
        var err = new Error('未找到书籍 ' + bookId + ' 所属系列，无法下载');
        if (onProgress) onProgress(-1, err.message);
        throw err;
      }
      var url = buildUrl(resolvedSeries + '/' + bookId + '.json');
      console.log('[DataManager] 下载书籍: ' + bookId + ' → ' + url);
      if (onProgress) onProgress(0, '开始下载...');

      // ★ 字节级流式读取：写入独立 task slot，不再写共享变量
      function _onByteProgress(received, total) {
        var slot = _activeTasks[taskId];
        if (!slot) return; // 任务已结束/取消
        slot.received = received;
        slot.total = total;
        if (total > 0) {
          slot.percent = Math.min(95, Math.floor(received / total * 95));
        } else {
          slot.percent = Math.min(95, 33 + Math.floor(Math.log10(received + 1) * 8));
        }
        slot.stage = '下载中';
        // ★ 并发速度：用聚合字节计算总吞吐
        if (isBatch) {
          var agg = _aggregateTaskBytes();
          _calcSpeedBps(_dlBatchBytesReceived + agg.totalReceived);
          if (_dlTotal > 0) {
            _dlTotalPercent = _calcTotalPercentConcurrent(_dlCompleted, _dlTotal);
          }
        }
        if (onProgress) {
          onProgress(
            slot.percent,
            '下载中 ' + formatSize(received) + (total > 0 ? ' / ' + formatSize(total) : '')
          );
        }
      }

      _dlStage = '下载中';

      return fetchJsonStreamed(url, _onByteProgress, function () {
        return myToken !== _singleDlToken;
      })
        .then(function (rawBook) {
          // ★ 校验取消（流式读取期间可能已被取消）
          if (myToken !== _singleDlToken) {
            delete _activeTasks[taskId];
            throw _makeCancelledErr();
          }
          // 96%：解析数据
          var slot = _activeTasks[taskId];
          if (slot) { slot.percent = 96; slot.stage = '解析数据'; }
          _dlStage = '解析数据';
          if (onProgress) onProgress(96, '解析数据...');
          var converted = convertBookData(rawBook);
          // 98%：写入 IndexedDB
          if (slot) { slot.percent = 98; slot.stage = '写入本地'; }
          _dlStage = '写入本地';
          if (onProgress) onProgress(98, '写入本地...');
          return storeSet(KEY_BOOK_PREFIX + bookId, converted)
            .then(function () {
              // ★ 校验取消（IndexedDB 写入期间可能已被取消）
              if (myToken !== _singleDlToken) {
                delete _activeTasks[taskId];
                throw _makeCancelledErr();
              }
              return addDownloadedId(bookId);
            })
            .then(function () {
              // ★ 校验取消（addDownloadedId 期间可能已被取消；
              //   若已取消则不再构建索引，避免对已取消的下载做无用功）
              if (myToken !== _singleDlToken) {
                delete _activeTasks[taskId];
                throw _makeCancelledErr();
              }
              // 为下载的书构建全文内容索引（不阻塞返回）
              buildContentIndex(converted);
              addToBookIndex(converted);
              // 失效占用缓存（书籍数据已变更）
              _invalidateBookSizeCache();
              // ★ 并发适配：在删除 slot 前读取字节总量，供 onTaskComplete 累加 _dlBatchBytesReceived
              var _bookBytesForBatch = slot ? slot.total : 0;
              delete _activeTasks[taskId];
              _dlStage = '完成';
              if (onProgress) onProgress(100, '下载完成');
              console.log('[DataManager] 书籍下载完成: ' + bookId);
              converted._dlBookBytes = _bookBytesForBatch;
              return converted;
            });
        });
    }).catch(function (err) {
      // ★ 确保任务 slot 被清理（无论成功还是失败）
      delete _activeTasks[taskId];
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
          _pauseResolves.push(resolve);
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
        .then(function (result) {
          // ★ 任务完成后也需校验批次，避免取消后成功回调仍累加计数
          if (runToken !== _dlActiveToken) return;
          success++;
          if (onTaskComplete) onTaskComplete(success + failed, tasks.length, result);
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
   * 逐本下载系列中的待下载书籍（ZIP 通道不可用时的回退路径）
   * @param {Array} filtered  待下载书籍列表
   * @param {Array} downloadedIds  已下载 ID 列表
   * @param {number} myToken  批次令牌
   * @param {function} onProgress  进度回调
   * @param {function} _broadcastProgress  进度广播
   * @returns {Promise<object>}
   */
  function _downloadSeriesBookByBook(filtered, downloadedIds, myToken, onProgress, _broadcastProgress) {
    // 构建任务列表（downloadBook 会自动查找 series）
    // ★ 字节级进度：每本 downloadBook 写入独立的 _activeTasks slot，
    //   不再覆盖共享变量，并发安全。_broadcastProgress 广播聚合结果给 UI。
    var tasks = filtered.map(function (book) {
      var fn = function () {
        _dlCurrentTitle = book.title || book.id;
        _broadcastProgress();
        return downloadBook(book.id, book.series, function (percent, status) {
          // 重新计算批次总进度并广播
          if (_dlTotal > 0) {
            _dlTotalPercent = _calcTotalPercentConcurrent(_dlCompleted, _dlTotal);
          }
          _broadcastProgress();
        });
      };
      fn._bookTitle = book.title || book.id;
      fn._bookId = book.id;
      return fn;
    });

    return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total, taskResult) {
      _dlCompleted = completed;
      // ★ 并发适配：累加已完成书籍的字节总量到 _dlBatchBytesReceived
      if (taskResult && taskResult._dlBookBytes) {
        _dlBatchBytesReceived += taskResult._dlBookBytes;
      }
      _dlTotalPercent = _calcTotalPercentConcurrent(completed, total);
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
      console.log('[DataManager] 下载完成: 成功=' + result.success + ' 失败=' + result.failed);
      return result;
    });
  }

  /**
   * 批量下载某系列（或多个系列）所有书籍
   * 使用全局索引查找书籍列表，避免单独请求系列 index.json
   * 支持拾遗系列 (sy_auto)：自动从全局索引中筛选小系列书籍
   *
   * ★ 混合策略：当待下载本数 >= PACK_THRESHOLD 且系列有对应的 ZIP 包时，
   *   优先走 ZIP 通道（单次 HTTP 请求下载整个系列包并解压入库），
   *   否则回退到逐本下载（3路并发 + 重试）。
   *
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

          // ── 混合策略：尝试走 ZIP 通道 ──────────────────────────────
          // 当待下载本数 >= 阈值且 packs/manifest.json 可用时，
          // 下载整个系列 ZIP 并解压入库，跳过已下载的书籍。
          // 如果 ZIP 不可用或待下载本数较少，回退到逐本下载。
          var _packDl = win.DataManager && win.DataManager._packDl;
          if (_packDl) {
            return _packDl.shouldUsePack(seriesIds[0], filtered.length).then(function (usePack) {
              if (usePack && seriesIds.length === 1) {
                // ZIP 通道
                console.log('[DataManager] 系列 ' + seriesIds[0] + ' 走 ZIP 通道');
                _dlStage = '下载系列包';
                return _packDl.downloadPack(seriesIds[0], {
                  skipIds: downloadedIds,
                  onProgress: function (pct, status) {
                    _dlTotalPercent = pct;
                    _dlStage = status || '下载系列包';
                    _broadcastProgress();
                  },
                  shouldAbort: function () {
                    return _isCancelled || myToken !== _dlActiveToken;
                  },
                  shouldPause: function () {
                    return _isPaused;
                  }
                }).then(function (result) {
                  if (myToken === _dlActiveToken) {
                    _isDownloading = false;
                    _dlCurrentTitle = '';
                    _dlTotalPercent = 100;
                    _dlCurrentBookPercent = 100;
                    _dlStage = '完成';
                  }
                  return {
                    success: result.success,
                    failed: result.failed,
                    errors: result.errors,
                    failedBookNames: []
                  };
                });
              }
              // 逐本通道（ZIP 不可用或多系列场景）
              return _downloadSeriesBookByBook(filtered, downloadedIds, myToken, onProgress, _broadcastProgress);
            });
          }

          // 逐本通道（无 _packDl 模块时的回退）
          return _downloadSeriesBookByBook(filtered, downloadedIds, myToken, onProgress, _broadcastProgress);
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

          // 先计算总本数（ZIP 通道 + 逐本通道），避免后续 _dlTotal 被覆盖
          var _totalBookCount = toDownload.length;

          // ── 混合策略：按系列分组，尝试走 ZIP 通道 ────────────────────
          // 将待下载书籍按系列分组，对大系列走 ZIP，小系列走逐本。
          var _packDl = win.DataManager && win.DataManager._packDl;
          if (_packDl) {
            // 按系列分组
            var seriesGroups = {};
            for (var gi = 0; gi < toDownload.length; gi++) {
              var sid = toDownload[gi].series || '_unknown';
              if (!seriesGroups[sid]) seriesGroups[sid] = [];
              seriesGroups[sid].push(toDownload[gi]);
            }

            // 检查每个系列是否走 ZIP
            var checkPromises = [];
            var seriesIds = Object.keys(seriesGroups);
            for (var si = 0; si < seriesIds.length; si++) {
              (function (sid) {
                checkPromises.push(
                  _packDl.shouldUsePack(sid, seriesGroups[sid].length)
                    .then(function (usePack) { return { id: sid, usePack: usePack }; })
                );
              })(seriesIds[si]);
            }

            return Promise.all(checkPromises).then(function (decisions) {
              var packSeries = [];
              var bookByBookSeries = [];
              var decisionMap = {};
              for (var di = 0; di < decisions.length; di++) {
                decisionMap[decisions[di].id] = decisions[di].usePack;
                if (decisions[di].usePack) {
                  packSeries.push(decisions[di].id);
                } else {
                  bookByBookSeries.push(decisions[di].id);
                }
              }

              if (packSeries.length > 0) {
                console.log('[DataManager] downloadAll: ZIP 通道系列=' + packSeries.join(',') +
                  '，逐本通道系列=' + bookByBookSeries.join(','));
              }

              // 收集所有逐本下载的书籍
              var bookByBookList = [];
              for (var bi = 0; bi < bookByBookSeries.length; bi++) {
                var group = seriesGroups[bookByBookSeries[bi]] || [];
                for (var bj = 0; bj < group.length; bj++) {
                  bookByBookList.push(group[bj]);
                }
              }

              // 保留完整的总本数，不被逐本通道覆盖
              _dlTotal = _totalBookCount;

              // 先执行 ZIP 通道的系列，再逐本下载剩余
              var chain = Promise.resolve({ success: 0, failed: 0, errors: [], failedBookNames: [] });

              // ZIP 通道（顺序执行，避免内存峰值）
              for (var pi = 0; pi < packSeries.length; pi++) {
                (function (sid) {
                  chain = chain.then(function (acc) {
                    if (_isCancelled || myToken !== _dlActiveToken) return acc;
                    _dlCurrentTitle = '下载系列包: ' + sid;
                    _dlStage = '下载系列包';
                    _broadcastProgress();
                    return _packDl.downloadPack(sid, {
                      skipIds: downloadedIds,
                      onProgress: function (pct, status) {
                        _dlStage = status || '下载系列包';
                        _broadcastProgress();
                      },
                      shouldAbort: function () {
                        return _isCancelled || myToken !== _dlActiveToken;
                      },
                      shouldPause: function () {
                        return _isPaused;
                      }
                    }).then(function (result) {
                      acc.success += result.success;
                      acc.failed += result.failed;
                      if (result.errors) {
                        acc.errors = acc.errors.concat(result.errors);
                      }
                      return acc;
                    });
                  });
                })(packSeries[pi]);
              }

              // 逐本通道
              chain = chain.then(function (acc) {
                if (_isCancelled || myToken !== _dlActiveToken) return acc;
                if (!bookByBookList.length) return acc;

                // 不再覆盖 _dlTotal，改为单独跟踪逐本通道的进度
                var bookByBookTotal = bookByBookList.length;
                var tasks = bookByBookList.map(function (book) {
                  var fn = function () {
                    _dlCurrentTitle = book.title || book.id;
                    _broadcastProgress();
                    return downloadBook(book.id, book.series, function (percent, status) {
                      if (bookByBookTotal > 0) {
                        _dlTotalPercent = _calcTotalPercentConcurrent(_dlCompleted, bookByBookTotal);
                      }
                      _broadcastProgress();
                    });
                  };
                  fn._bookTitle = book.title || book.id;
                  fn._bookId = book.id;
                  return fn;
                });

                return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total, taskResult) {
                  _dlCompleted = completed;
                  if (taskResult && taskResult._dlBookBytes) {
                    _dlBatchBytesReceived += taskResult._dlBookBytes;
                  }
                  _dlTotalPercent = _calcTotalPercentConcurrent(completed, total);
                  _broadcastProgress();
                }, myToken).then(function (result) {
                  acc.success += result.success;
                  acc.failed += result.failed;
                  if (result.errors) acc.errors = acc.errors.concat(result.errors);
                  for (var i = 0; i < result.failedTasks.length; i++) {
                    var t = result.failedTasks[i];
                    if (t._bookTitle) acc.failedBookNames.push(t._bookTitle);
                  }
                  if (result.failed > 0) {
                    return _retryFailed(result.failedTasks, 2, onProgress, acc, myToken);
                  }
                  return acc;
                });
              });

              return chain.then(function (result) {
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
          }

          // 逐本通道（无 _packDl 模块时的回退）
          var tasks = toDownload.map(function (book) {
            var fn = function () {
              _dlCurrentTitle = book.title || book.id;
              _broadcastProgress();
              return downloadBook(book.id, book.series, function (percent, status) {
                if (_dlTotal > 0) {
                  _dlTotalPercent = _calcTotalPercentConcurrent(_dlCompleted, _dlTotal);
                }
                _broadcastProgress();
              });
            };
            fn._bookTitle = book.title || book.id;
            fn._bookId = book.id;
            return fn;
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total, taskResult) {
            _dlCompleted = completed;
            // ★ 并发适配：累加已完成书籍的字节总量到 _dlBatchBytesReceived
            if (taskResult && taskResult._dlBookBytes) {
              _dlBatchBytesReceived += taskResult._dlBookBytes;
            }
            _dlTotalPercent = _calcTotalPercentConcurrent(completed, total);
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

