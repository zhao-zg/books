/**
 * downloadFile 超时逻辑单元测试
 * 
 * 运行方式：node --test tests/test_download.js
 * 
 * 由于 downloadFile 在 IIFE 内无法直接导入，
 * 本测试提取核心超时逻辑进行独立验证。
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

/**
 * 提取 downloadFile 中 fetch 路径的核心超时逻辑
 * 模拟流式读取 + AbortController + readTimeout + totalTimeout
 */
async function downloadWithTimeout(mockReader, options) {
    options = options || {};
    var controller, timeoutId;
    if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timeoutId = setTimeout(function() { controller.abort(); }, options.totalTimeout || 300000);
    }

    var chunkReadTimeoutMs = options.readTimeout || 30000;
    var chunks = [];

    try {
        while (true) {
            var readPromise = mockReader.read(controller ? controller.signal : null);
            var result;
            if (controller) {
                var readTimerId;
                var readTimeoutPromise = new Promise(function(_, reject) {
                    readTimerId = setTimeout(function() { reject(new Error('读取超时')); }, chunkReadTimeoutMs);
                });
                result = await Promise.race([readPromise, readTimeoutPromise]);
                clearTimeout(readTimerId);
            } else {
                var fallbackTimerId;
                var fallbackTimeout = new Promise(function(_, reject) {
                    fallbackTimerId = setTimeout(function() { reject(new Error('读取超时')); }, chunkReadTimeoutMs);
                });
                try {
                    result = await Promise.race([readPromise, fallbackTimeout]);
                } catch (e) {
                    clearTimeout(fallbackTimerId);
                    throw e;
                }
                clearTimeout(fallbackTimerId);
            }
            if (result.done) break;
            chunks.push(result.value);
        }
        return chunks;
    } catch (error) {
        if (error.message === '读取超时') {
            try { mockReader.cancel(); } catch(e) {}
            if (controller) controller.abort();
            throw new Error('下载超时（读取无响应），请检查网络连接后重试');
        }
        if (error.name === 'AbortError') {
            throw new Error('下载超时，请检查网络连接后重试');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ==================== 测试用例 ====================

test('正常下载：多块数据成功读取', async function() {
    var callCount = 0;
    var mockReader = {
        read: function() {
            callCount++;
            if (callCount <= 3) {
                return Promise.resolve({ done: false, value: Buffer.from('chunk' + callCount) });
            }
            return Promise.resolve({ done: true, value: undefined });
        },
        cancel: function() {}
    };

    var result = await downloadWithTimeout(mockReader, { readTimeout: 5000, totalTimeout: 10000 });
    assert.equal(result.length, 3);
    assert.equal(callCount, 4); // 3 reads + 1 done
});

test('readTimeout 触发：单块读取超时报错', async function() {
    var mockReader = {
        read: function() {
            // 永不 resolve，模拟网络卡死
            return new Promise(function() {});
        },
        cancel: function() {}
    };

    await assert.rejects(
        function() { return downloadWithTimeout(mockReader, { readTimeout: 100, totalTimeout: 5000 }); },
        function(error) {
            assert.equal(error.message, '下载超时（读取无响应），请检查网络连接后重试');
            return true;
        }
    );
});

test('totalTimeout 触发：总超时后 AbortError', async function() {
    var readCount = 0;
    var pendingResolve = null;
    var mockReader = {
        read: function(signal) {
            readCount++;
            return new Promise(function(resolve, reject) {
                // 每次读取很慢但能在 readTimeout 内完成
                var timer = setTimeout(function() {
                    resolve({ done: false, value: Buffer.from('slow') });
                }, 50);
                // 模拟 abort 行为
                if (signal) {
                    signal.addEventListener('abort', function() {
                        clearTimeout(timer);
                        var err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        },
        cancel: function() {}
    };

    // readTimeout=200ms（每块不会超时），totalTimeout=150ms（总超时先触发）
    await assert.rejects(
        function() { return downloadWithTimeout(mockReader, { readTimeout: 200, totalTimeout: 150 }); },
        function(error) {
            assert.equal(error.message, '下载超时，请检查网络连接后重试');
            return true;
        }
    );
    // 至少读取了一些块
    assert.ok(readCount > 0);
});

test('readTimeout 优先于 totalTimeout：单块卡死时 readTimeout 先触发', async function() {
    var mockReader = {
        read: function(signal) {
            return new Promise(function(resolve, reject) {
                // 永不 resolve，但支持 abort
                if (signal) {
                    signal.addEventListener('abort', function() {
                        var err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        },
        cancel: function() {}
    };

    // readTimeout=100ms < totalTimeout=5000ms
    await assert.rejects(
        function() { return downloadWithTimeout(mockReader, { readTimeout: 100, totalTimeout: 5000 }); },
        function(error) {
            // 应该是 readTimeout 先触发（读取超时），而非 totalTimeout（AbortError）
            assert.equal(error.message, '下载超时（读取无响应），请检查网络连接后重试');
            return true;
        }
    );
});

test('非超时错误：网络错误原样传播', async function() {
    var mockReader = {
        read: function() {
            return Promise.reject(new Error('Network failure'));
        },
        cancel: function() {}
    };

    await assert.rejects(
        function() { return downloadWithTimeout(mockReader, { readTimeout: 5000 }); },
        function(error) {
            assert.equal(error.message, 'Network failure');
            return true;
        }
    );
});

test('reader.cancel() 在 readTimeout 时被调用', async function() {
    var cancelCalled = false;
    var mockReader = {
        read: function() {
            return new Promise(function() {}); // 永不 resolve
        },
        cancel: function() {
            cancelCalled = true;
        }
    };

    try {
        await downloadWithTimeout(mockReader, { readTimeout: 50, totalTimeout: 5000 });
    } catch (e) {
        // expected
    }

    assert.equal(cancelCalled, true);
});

test('无 AbortController 降级：readTimeout 仍然生效', async function() {
    // 临时移除 AbortController
    var origAbortController = globalThis.AbortController;
    globalThis.AbortController = undefined;

    var mockReader = {
        read: function() {
            return new Promise(function() {}); // 永不 resolve
        },
        cancel: function() {}
    };

    try {
        await assert.rejects(
            function() { return downloadWithTimeout(mockReader, { readTimeout: 100 }); },
            function(error) {
                assert.equal(error.message, '下载超时（读取无响应），请检查网络连接后重试');
                return true;
            }
        );
    } finally {
        // 恢复 AbortController
        globalThis.AbortController = origAbortController;
    }
});
