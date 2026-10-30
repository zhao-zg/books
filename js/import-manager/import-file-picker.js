'use strict';

  // ── APK 大文件导入防闪退（2026-10）────────────────────────────────────
  // 根因：FilePicker readData:true 在选文件瞬间原生层全量读入+base64，
  // 多选时所有文件同时进内存，大 ZIP 备份包直接 OOM 被 LMK 杀进程（App 整体退出）。
  // 修复：readData:false 只拿元信息（name/mimeType/path(=content uri)/size），
  // 导入时再逐个串行 readFile，且超过阈值的大文件直接拒绝并引导去数据同步中心。
  // ⚠ FilePicker 返回结构无 uri 字段，content uri 在 path 字段（旧代码 f.uri 恒为 undefined）。
  var MAX_INLINE_FILE_BYTES = 40 * 1024 * 1024; // 单文件惰性读取上限 40MB

  function _nativeFilesystem() {
    return win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.Filesystem;
  }

  // FilePicker 返回条目 → 统一 fileInfo（不读数据，仅元信息 + 惰性读取器）
  // 返回结构保持向后兼容：{ name, mime, uri, size, data(arrayBuffer 填充后), arrayBuffer, text }
  function _lazyFromPickEntry(f) {
    var uri = f.uri || f.path || ''; // readData:false 时 uri 字段不存在，取 path（content://）
    var info = {
      name: f.name,
      mime: f.mimeType,
      uri: uri,
      size: typeof f.size === 'number' ? f.size : 0,
      _lazyUri: uri, // 惰性读取标记：导入时才读数据
      _read: function() { return _readLazyUri(uri, this.name, this.size); }
    };
    return info;
  }

  // 惰性读取 content uri：二进制走 Filesystem.readFile base64，文本走 utf8
  function _readLazyUri(uri, name, size) {
    var Filesystem = _nativeFilesystem();
    if (!Filesystem || !uri) {
      return Promise.reject(new Error('当前环境不支持读取所选文件'));
    }
    // 大小预检：超限直接拒绝（避免任何形式的整读）
    if (size && size > MAX_INLINE_FILE_BYTES) {
      return Promise.reject(new Error('文件过大（' + formatSize(size) + '），超出书架导入上限 40MB'));
    }
    var ext = (name || '').split('.').pop().toLowerCase();
    var isBinary = (ext === 'epub' || ext === 'pdf' || ext === 'zip');
    var opts = { path: uri }; // directory 不传 → content:// 走 ContentResolver
    if (!isBinary) opts.encoding = 'utf8';
    return Filesystem.readFile(opts).then(function(result) {
      if (!result || typeof result.data !== 'string') {
        return Promise.reject(new Error('无法读取文件数据'));
      }
      if (isBinary) return { data: result.data, size: size || 0 };
      return { text: result.data, size: size || 0 };
    });
  }

  // 将惰性 fileInfo 转为传统可直接导入的形态（填充 data/text 字段，供消费方 arrayBuffer||data / text||decodeBase64(data) 使用）
  function _materializeLazy(info) {
    if (!info || !info._lazyUri) return Promise.resolve(info); // 非惰性（Web 路径）直接返回
    return info._read().then(function(read) {
      info.data = read.data;       // base64（二进制）
      info.text = read.text;       // 文本
      info.size = read.size;
      info._read = null;           // 释放闭包
      return info;
    });
  }

  // 多文件选择：惰性读取（串行，防内存叠加）
  function _materializeAllLazy(infos) {
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < infos.length; i++) {
      (function(info) {
        chain = chain.then(function() {
          return _materializeLazy(info).then(function(mat) {
            out.push(mat);
          }).catch(function(err) {
            // 单文件读取失败不中断批次：记录带错误的占位（size>0 保留供上层提示）
            out.push({ name: info.name, mime: info.mime, uri: info.uri, size: info.size,
                       _lazyError: (err && err.message) || '文件读取失败' });
          });
        });
      })(infos[i]);
    }
    return chain.then(function() { return out; });
  }

  // ── 多文件选择 ──
  function pickFiles() {
    // 判断是否在 Capacitor 原生环境
    var isNative = !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
    var FilePicker = win.Capacitor &&
      win.Capacitor.Plugins &&
      win.Capacitor.Plugins.FilePicker;

    if (isNative && FilePicker) {
      return FilePicker.pickFiles({
        types: [
          'text/plain',
          'application/epub+zip',
          'text/markdown',
          'application/pdf',
          'application/zip',
          'application/octet-stream'
        ],
        readData: false, // ★ 防闪退：只拿元信息（name/path/size），数据导入时再串行读
        limit: 0
      }).then(function(result) {
        if (!result || !result.files || !result.files.length) return [];
        var infos = result.files.map(_lazyFromPickEntry);
        return _materializeAllLazy(infos);
      });
    }

    // Web 环境：创建 input[type=file][multiple]
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.epub,.md,.markdown,.pdf,.zip';
      input.multiple = true;
      input.style.display = 'none';
      input.onchange = function(e) {
        var files = e.target.files;
        if (!files || !files.length) { resolve([]); return; }
        var tasks = [];
        for (var fi = 0; fi < files.length; fi++) {
          (function(file) {
            tasks.push(new Promise(function(res, rej) {
              var reader = new FileReader();
              if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name) || /\.zip$/i.test(file.name)) {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, arrayBuffer: ev.target.result, size: file.size });
                };
                reader.onerror = function() {
                  rej(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
                };
                reader.readAsArrayBuffer(file);
              } else {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, text: ev.target.result, size: file.size });
                };
                reader.onerror = function() {
                  rej(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
                };
                reader.readAsText(file, 'utf-8');
              }
            }));
          })(files[fi]);
        }
        Promise.all(tasks).then(resolve, reject);
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // ── 单文件选择（兼容旧接口）──
  function pickFile() {
    // 判断是否在 Capacitor 原生环境
    var isNative = !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
    var FilePicker = win.Capacitor &&
      win.Capacitor.Plugins &&
      win.Capacitor.Plugins.FilePicker;

    if (isNative && FilePicker) {
      return FilePicker.pickFiles({
        types: [
          'text/plain',
          'application/epub+zip',
          'text/markdown',
          'application/pdf',
          'application/zip',
          'application/octet-stream'
        ],
        readData: false // ★ 防闪退：只拿元信息，数据导入时再读（返回后立即惰性物化）
      }).then(function(result) {
        if (!result || !result.files || !result.files.length) return null;
        var info = _lazyFromPickEntry(result.files[0]);
        return _materializeLazy(info);
      });
    }

    // Web 环境降级：创建 input[type=file]
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.epub,.md,.markdown,.pdf,.zip';
      input.style.display = 'none';
      input.onchange = function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) { resolve(null); return; }
        var reader = new FileReader();
        if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name) || /\.zip$/i.test(file.name)) {
          reader.onload = function(ev) {
            resolve({ name: file.name, mime: file.type, arrayBuffer: ev.target.result });
          };
          reader.onerror = function() {
            reject(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
          };
          reader.readAsArrayBuffer(file);
        } else {
          reader.onload = function(ev) {
            resolve({ name: file.name, mime: file.type, text: ev.target.result });
          };
          reader.onerror = function() {
            reject(new Error('文件读取失败: ' + (reader.error && reader.error.message || '未知错误')));
          };
          reader.readAsText(file, 'utf-8');
        }
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // ── 扫描文件夹（自动识别可导入文件）──
  var IMPORTABLE_EXT = ['.txt', '.epub', '.md', '.markdown', '.pdf', '.zip'];

  function isImportableFile(name) {
    var ext = (name || '').split('.').pop().toLowerCase();
    return IMPORTABLE_EXT.indexOf('.' + ext) >= 0;
  }

  function scanDirectory(opts) {
    opts = opts || {};
    var recursive = !!opts.recursive;

    // 方案0：Capacitor 原生环境（APK）— 真正的文件夹选择 + 遍历扫描
    var isNative = !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
    var FilePicker = win.Capacitor &&
      win.Capacitor.Plugins &&
      win.Capacitor.Plugins.FilePicker;
    var Filesystem = win.Capacitor &&
      win.Capacitor.Plugins &&
      win.Capacitor.Plugins.Filesystem;

    if (isNative && FilePicker) {
      // 优先使用 pickDirectory 让用户选择文件夹
      if (typeof FilePicker.pickDirectory === 'function') {
        return FilePicker.pickDirectory().then(function(result) {
          if (!result || !result.path) return [];
          var dirPath = _contentUriToFsPath(result.path);
          return _scanNativeDir(dirPath, recursive, Filesystem);
        }).catch(function() {
          return []; // 用户取消
        });
      }
      // 不支持 pickDirectory，降级到多选文件
      return _pickFilesAsScanFallback(FilePicker);
    }

    // 方案1：File System Access API (showDirectoryPicker)
    if (typeof win.showDirectoryPicker === 'function') {
      return win.showDirectoryPicker().then(function(dirHandle) {
        return _scanDirHandle(dirHandle, recursive);
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return []; // 用户取消
        // 不支持则降级到 input[webkitdirectory]
        return _scanViaInput(recursive);
      });
    }

    // 方案2：input[webkitdirectory] 降级（桌面 Firefox 等）
    var testInput = document.createElement('input');
    if ('webkitdirectory' in testInput) {
      return _scanViaInput(recursive);
    }

    // 方案3：以上都不支持（iOS Safari 等），降级为普通多选文件
    return _pickFilesWebFallback();
  }

  // content:// URI 转文件系统路径（Android SAF 返回的是 content URI）
  function _contentUriToFsPath(uri) {
    if (!uri || typeof uri !== 'string' || uri.indexOf('content://') !== 0) return uri;
    // content://com.android.externalstorage.documents/tree/primary%3ADocuments%2Fsub
    var match = uri.match(/tree\/(.+)$/);
    if (match) {
      var decoded = decodeURIComponent(match[1]);
      // primary:Documents/sub -> /storage/emulated/0/Documents/sub
      if (decoded.indexOf('primary:') === 0) {
        return '/storage/emulated/0/' + decoded.substring('primary:'.length);
      }
    }
    return uri; // 无法转换，返回原值让 readdir 自行处理
  }

  // 原生环境递归遍历目录
  function _scanNativeDir(dirPath, recursive, Filesystem, basePath) {
    if (!Filesystem) return Promise.resolve([]);
    basePath = basePath || '';
    return Filesystem.readdir({ path: dirPath }).then(function(result) {
      if (!result || !result.files || !result.files.length) return [];
      var filePromises = [];
      var dirPromises = [];
      for (var i = 0; i < result.files.length; i++) {
        var entry = result.files[i];
        var entryPath = dirPath + '/' + entry.name;
        var entryName = basePath ? (basePath + '/' + entry.name) : entry.name;
        if (entry.type === 'file' && isImportableFile(entry.name)) {
          filePromises.push(_readNativeFile(entryPath, entryName, Filesystem));
        } else if (entry.type === 'directory' && recursive) {
          dirPromises.push(_scanNativeDir(entryPath, recursive, Filesystem, entryName));
        }
      }
      return Promise.all(dirPromises).then(function(subResults) {
        return Promise.all(filePromises).then(function(fileResults) {
          var all = [];
          for (var i = 0; i < fileResults.length; i++) {
            if (fileResults[i]) all.push(fileResults[i]);
          }
          for (var d = 0; d < subResults.length; d++) {
            if (subResults[d] && subResults[d].length) {
              for (var s = 0; s < subResults[d].length; s++) {
                all.push(subResults[d][s]);
              }
            }
          }
          return all;
        });
      });
    }).catch(function() {
      return []; // readdir 失败（路径不兼容等）
    });
  }

  // 原生环境读取文件内容
  function _readNativeFile(filePath, fileName, Filesystem) {
    var ext = (fileName || '').split('.').pop().toLowerCase();
    var isBinary = (ext === 'epub' || ext === 'pdf' || ext === 'zip');
    if (isBinary) {
      // 二进制文件：返回 base64 数据
      return Filesystem.readFile({ path: filePath }).then(function(result) {
        return { name: fileName, data: result.data, size: 0 };
      }).catch(function() { return null; });
    } else {
      // 文本文件：返回 UTF-8 字符串
      return Filesystem.readFile({ path: filePath, encoding: 'utf8' }).then(function(result) {
        return { name: fileName, text: result.data, size: 0 };
      }).catch(function() { return null; });
    }
  }

  // 降级：用多选文件替代扫描文件夹
  function _pickFilesAsScanFallback(FilePicker) {
    return FilePicker.pickFiles({
      types: [
        'text/plain',
        'application/epub+zip',
        'text/markdown',
        'application/pdf',
        'application/zip',
        'application/octet-stream'
      ],
      readData: false, // ★ 防闪退：同 pickFiles 惰性策略
      limit: 0
    }).then(function(result) {
      if (!result || !result.files || !result.files.length) return [];
      var infos = result.files.map(_lazyFromPickEntry);
      return _materializeAllLazy(infos);
    }).catch(function() { return []; });
  }

  // Web 环境降级：普通多选文件（iOS Safari 等不支持文件夹选择的浏览器）
  function _pickFilesWebFallback() {
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.epub,.md,.markdown,.pdf,.zip';
      input.multiple = true;
      input.style.display = 'none';
      input.onchange = function(e) {
        var files = e.target.files;
        if (!files || !files.length) { resolve([]); return; }
        var tasks = [];
        for (var fi = 0; fi < files.length; fi++) {
          (function(file) {
            tasks.push(new Promise(function(res, rej) {
              var reader = new FileReader();
              if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name) || /\.zip$/i.test(file.name)) {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, arrayBuffer: ev.target.result, size: file.size });
                };
                reader.onerror = function() { res(null); };
                reader.readAsArrayBuffer(file);
              } else {
                reader.onload = function(ev) {
                  res({ name: file.name, mime: file.type, text: ev.target.result, size: file.size });
                };
                reader.onerror = function() { res(null); };
                reader.readAsText(file, 'utf-8');
              }
            }));
          })(files[fi]);
        }
        Promise.all(tasks).then(function(results) {
          var filtered = [];
          for (var i = 0; i < results.length; i++) {
            if (results[i]) filtered.push(results[i]);
          }
          resolve(filtered);
        });
      };
      input.addEventListener('cancel', function() { resolve([]); });
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // 通过 File System Access API 递归扫描
  function _scanDirHandle(dirHandle, recursive, basePath) {
    basePath = basePath || '';
    var filePromises = [];  // 收集文件读取 Promise
    var dirPromises = [];   // 收集子目录扫描 Promise

    // 遍历目录：手动消费异步迭代器（兼容 ES5 风格）
    function iterateEntries(iter, cb) {
      (function next() {
        iter.next().then(function(result) {
          if (result.done) { cb(); return; }
          var entry = result.value;
          var entryPath = basePath ? (basePath + '/' + entry.name) : entry.name;

          if (entry.kind === 'file') {
            if (isImportableFile(entry.name)) {
              filePromises.push(
                entry.getFile().then(function(file) {
                  return _readFileEntry(file, entryPath);
                }).catch(function() { return null; })
              );
            }
          } else if (entry.kind === 'directory' && recursive) {
            dirPromises.push(_scanDirHandle(entry, recursive, entryPath));
          }
          next();
        }).catch(function() { cb(); });
      })();
    }

    return new Promise(function(resolve) {
      var iter;
      try { iter = dirHandle.values(); } catch (e) { resolve([]); return; }
      iterateEntries(iter, function() {
        // 遍历完成，等待所有子目录扫描和文件读取结束
        Promise.all(dirPromises).then(function(subResults) {
          return Promise.all(filePromises).then(function(fileResults) {
            var all = [];
            // 添加文件结果
            for (var i = 0; i < fileResults.length; i++) {
              if (fileResults[i]) all.push(fileResults[i]);
            }
            // 添加子目录结果
            for (var d = 0; d < subResults.length; d++) {
              if (subResults[d] && subResults[d].length) {
                for (var s = 0; s < subResults[d].length; s++) {
                  all.push(subResults[d][s]);
                }
              }
            }
            resolve(all);
          });
        }).catch(function() { resolve([]); });
      });
    });
  }

  // 通过 input[webkitdirectory] 降级扫描
  function _scanViaInput(recursive) {
    return new Promise(function(resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      // 也设置 accept 但 webkitdirectory 模式下浏览器可能忽略
      input.accept = '.txt,.epub,.md,.markdown,.pdf,.zip';
      input.style.display = 'none';
      input.onchange = function(e) {
        var files = e.target.files;
        if (!files || !files.length) { resolve([]); return; }
        var importable = [];
        var tasks = [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (!isImportableFile(file.name)) continue;
          // 非 recursive 模式下过滤掉子目录文件（webkitRelativePath 包含路径）
          if (!recursive && file.webkitRelativePath) {
            var parts = file.webkitRelativePath.split('/');
            if (parts.length > 2) continue; // 超过 "文件夹/文件" 层级
          }
          (function(f) {
            tasks.push(_readFileEntry(f).then(function(info) {
              if (info) importable.push(info);
            }).catch(function() {}));
          })(file);
        }
        Promise.all(tasks).then(function() { resolve(importable); });
      };
      // 用户取消时不会触发 onchange，需要处理
      input.addEventListener('cancel', function() { resolve([]); });
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  // 读取单个 File 对象为 fileInfo
  function _readFileEntry(file, virtualPath) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      var name = virtualPath || file.name;
      if (/\.epub$/i.test(file.name) || /\.pdf$/i.test(file.name) || /\.zip$/i.test(file.name)) {
        reader.onload = function(ev) {
          resolve({ name: name, mime: file.type, arrayBuffer: ev.target.result, size: file.size });
        };
        reader.onerror = function() { resolve(null); };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = function(ev) {
          resolve({ name: name, mime: file.type, text: ev.target.result, size: file.size });
        };
        reader.onerror = function() { resolve(null); };
        reader.readAsText(file, 'utf-8');
      }
    });
  }
