/*!
 * open-file-handler.js — 外部文件打开处理
 *
 * 当用户从文件管理器或其它应用"打开"txt/epub/md/pdf文件到书报时，
 * Android 原生层（MainActivity）将文件复制到缓存目录，
 * 再通过 JS 注入调用 window.BKOpenFile.handle()，本模块读取文件内容
 * 并调用 ImportManager.importFromBuffer 完成导入。
 *
 * 暴露：window.BKOpenFile
 *   .handle(fileInfoJson)  — 原生层调用入口
 *   .init()               — 初始化（检查 Capacitor App url 事件）
 */
(function (win) {
  'use strict';

  var TAG = '[OpenFile]';
  var Filesystem = null;
  var isNative = false;
  var _handledUris = {}; // 防重复导入：已处理的 URI/路径

  // ── 初始化 ──
  function init() {
    isNative = !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
    if (isNative) {
      Filesystem = win.Capacitor.Plugins && win.Capacitor.Plugins.Filesystem;
    }

    // Capacitor 6+: 监听 App url 事件（Capacitor 处理 intent 后派发）
    if (isNative && win.Capacitor.Plugins && win.Capacitor.Plugins.App) {
      win.Capacitor.Plugins.App.addListener('appUrlOpen', function (data) {
        if (data && data.url) {
          // Capacitor 可能把 content:// URI 直接派发到这里
          var uri = data.url;
          if (uri.indexOf('content://') === 0 || uri.indexOf('file://') === 0) {
            handleUri(uri);
          }
        }
      });
    }

    console.log(TAG + ' 已初始化');
  }

  // ── 原生层调用入口（从 MainActivity JS 注入）──
  // fileInfoJson: "{\"path\":\"/data/.../cache/open_file/book.epub\",\"name\":\"book.epub\"}"
  function handle(fileInfoJson) {
    console.log(TAG + ' handle: ' + fileInfoJson);

    var info;
    try {
      info = typeof fileInfoJson === 'string' ? JSON.parse(fileInfoJson) : fileInfoJson;
    } catch (e) {
      console.error(TAG + ' 解析 fileInfo 失败:', e);
      return;
    }

    if (!info || !info.path) {
      console.error(TAG + ' 无效的文件信息');
      return;
    }

    // 防重复导入
    if (_handledUris[info.path]) {
      console.log(TAG + ' 已在处理中，跳过: ' + info.path);
      return;
    }
    _handledUris[info.path] = true;
    // 10 秒后清除标记（允许同名文件再次打开）
    setTimeout(function () { delete _handledUris[info.path]; }, 10000);

    importFromPath(info.path, info.name || 'unknown');
  }

  // ── 处理 URI（Capacitor App url 事件）──
  function handleUri(uri) {
    console.log(TAG + ' handleUri: ' + uri);

    // 防重复导入
    if (_handledUris[uri]) {
      console.log(TAG + ' 已在处理中，跳过: ' + uri);
      return;
    }
    _handledUris[uri] = true;
    setTimeout(function () { delete _handledUris[uri]; }, 10000);

    // 从 URI 提取文件名
    var segments = uri.split('/');
    var fileName = segments[segments.length - 1] || 'unknown';
    // 对于 content URI，使用 Filesystem.readFile
    importFromUri(uri, fileName);
  }

  // ── 从文件路径导入（MainActivity 已将文件复制到缓存目录）──
  function importFromPath(filePath, fileName) {
    if (!isNative || !Filesystem) {
      console.error(TAG + ' 非原生环境，无法读取文件: ' + filePath);
      return;
    }

    var ext = (fileName || '').split('.').pop().toLowerCase();
    var isBinary = (ext === 'epub' || ext === 'pdf' || ext === 'zip');

    console.log(TAG + ' 开始读取文件: ' + fileName + ' (binary=' + isBinary + ')');

    var readPromise;
    if (isBinary) {
      readPromise = Filesystem.readFile({ path: filePath });
    } else {
      readPromise = Filesystem.readFile({ path: filePath, encoding: 'utf8' });
    }

    readPromise.then(function (result) {
      var fileInfo;
      if (isBinary) {
        fileInfo = { name: fileName, data: result.data }; // base64
      } else {
        fileInfo = { name: fileName, text: result.data }; // utf-8 string
      }

      console.log(TAG + ' 文件读取完成，开始导入: ' + fileName);
      return doImport(fileInfo);
    }).catch(function (err) {
      console.error(TAG + ' 读取文件失败:', err);
      showImportError(fileName, '读取文件失败');
    });
  }

  // ── 从 URI 导入（Capacitor App url 事件 / content://）──
  function importFromUri(uri, fileName) {
    if (!isNative || !Filesystem) {
      console.error(TAG + ' 非原生环境，无法读取 URI: ' + uri);
      return;
    }

    var ext = (fileName || '').split('.').pop().toLowerCase();
    var isBinary = (ext === 'epub' || ext === 'pdf' || ext === 'zip');

    console.log(TAG + ' 开始读取 URI: ' + fileName);

    // 使用 Capacitor Filesystem 读取 content URI
    var readPromise;
    if (isBinary) {
      readPromise = Filesystem.readFile({ path: uri });
    } else {
      readPromise = Filesystem.readFile({ path: uri, encoding: 'utf8' });
    }

    readPromise.then(function (result) {
      var fileInfo;
      if (isBinary) {
        fileInfo = { name: fileName, data: result.data };
      } else {
        fileInfo = { name: fileName, text: result.data };
      }
      return doImport(fileInfo);
    }).catch(function (err) {
      console.error(TAG + ' 读取 URI 失败:', err);
      showImportError(fileName, '读取文件失败');
    });
  }

  // ── 执行导入 ──
  var _importRetries = 0;
  var MAX_IMPORT_RETRIES = 10;

  function doImport(fileInfo) {
    if (!win.ImportManager || !win.ImportManager.importFromBuffer) {
      if (_importRetries >= MAX_IMPORT_RETRIES) {
        console.error(TAG + ' ImportManager 始终未就绪，放弃导入');
        showImportError(fileInfo.name, '应用未就绪');
        _importRetries = 0;
        return;
      }
      _importRetries++;
      setTimeout(function () {
        doImport(fileInfo);
      }, 500);
      return;
    }
    _importRetries = 0;

    return win.ImportManager.importFromBuffer(fileInfo, { source: { type: 'open-with' } })
      .then(function (book) {
        console.log(TAG + ' 导入成功:', book.title, book.chapters.length + '章');
        showImportSuccess(book);
      })
      .catch(function (err) {
        console.error(TAG + ' 导入失败:', err);
        showImportError(fileInfo.name, err.message || '导入失败');
      });
  }

  // ── 导入成功提示 ──
  function showImportSuccess(book) {
    try {
      if (win.BKToast && win.BKToast.show) {
        win.BKToast.show('已导入：' + book.title);
      } else {
        console.log(TAG + ' 已导入：' + book.title);
      }
      // 导入成功后导航到该书
      if (win.BKRouter && win.BKRouter.navigate) {
        win.BKRouter.navigate(book.id);
      }
    } catch (e) {
      // 静默
    }
  }

  // ── 导入失败提示 ──
  function showImportError(fileName, reason) {
    try {
      if (win.BKToast && win.BKToast.show) {
        win.BKToast.show('导入失败：' + (fileName || '') + ' - ' + reason);
      } else {
        console.warn(TAG + ' 导入失败: ' + fileName + ' - ' + reason);
      }
    } catch (e) {
      // 静默
    }
  }

  // ── 暴露 ──
  win.BKOpenFile = {
    handle: handle,
    init: init
  };

  // 自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
