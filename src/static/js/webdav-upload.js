/**
 * webdav-upload.js — WebDAV 上传模块（将书籍上传到 WebDAV 服务器）
 *
 * 功能：
 *   1. 选择目标 WebDAV 服务器（预置 / 已保存 / 手动输入）
 *   2. 对预置服务器要求用户输入/确认密码（写操作安全校验）
 *   3. 浏览远程目录，选择上传路径
 *   4. 将书籍以原始格式上传（PDF → .pdf, EPUB → .epub, TXT/MD → .txt/.md）
 *   5. 支持批量上传（多本书同时上传）
 *   6. 进度反馈 + 错误分类提示
 *
 * 依赖：
 *   - WebDavManager (webdav-manager.js) — 上传核心 + 配置管理
 *   - BK.Export (export-core.js / export-book.js) — 书籍数据获取
 *   - BK.openDialog (back-stack.js) — 弹窗系统
 *   - JSZip (vendor/jszip.min.js) — ZIP 打包（批量导出时）
 *
 * 挂载：window.BK.WebDavUpload
 *   .showUploadDialog(bookIds)       单本/批量上传入口
 */
(function (win) {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────────────────────
  var UPLOADABLE_FORMATS = ['pdf', 'txt', 'md', 'epub'];

  // ── 路径转换：将 WebDAV entry 的 remotePath（完整URL）转为相对路径 ──
  // 例如："https://webdav.example.com/dav/books/" → "/books"
  //       "https://webdav.example.com/dav/" → ""
  function _toRelativePath(remoteUrl, baseUrl) {
    if (!remoteUrl || !baseUrl) return '';
    // 统一用 URL 解析 → 仅比较 pathname 部分（避免域名差异）
    try {
      var baseParsed = new URL(baseUrl.replace(/\/+$/, '') + '/');
      var remoteParsed = new URL(remoteUrl);
      // 解码后按 / 拆分，过滤空段
      var baseSegs = decodeURIComponent(baseParsed.pathname.replace(/\/+$/, '')).split('/').filter(Boolean);
      var remoteSegs = decodeURIComponent(remoteParsed.pathname.replace(/\/+$/, '')).split('/').filter(Boolean);
      if (remoteSegs.length <= baseSegs.length) return '';
      // 验证 base 是 remote 的前缀
      for (var i = 0; i < baseSegs.length; i++) {
        if (baseSegs[i] !== remoteSegs[i]) return '';
      }
      var relSegs = remoteSegs.slice(baseSegs.length);
      return relSegs.length ? '/' + relSegs.join('/') : '';
    } catch (e) { /* ignore */ }
    return '';
  }


  // ── 工具函数 ──────────────────────────────────────────────────────────
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) {
    return escHtml(s);
  }
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (typeof win.formatSize === 'function') return win.formatSize(bytes);
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0, size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  // ── toast ─────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function _toast(msg) {
    if (!msg) return;
    try {
      if (!document.getElementById('bk-wd-upload-toast-style')) {
        var st = document.createElement('style');
        st.id = 'bk-wd-upload-toast-style';
        st.textContent =
          '.bk-wd-upload-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
          'background:rgba(26,25,24,.92);color:#fff;padding:10px 18px;border-radius:22px;' +
          'font-size:14px;z-index:99999;opacity:0;transition:opacity .2s,transform .2s;' +
          'pointer-events:none;max-width:80vw;white-space:nowrap}' +
          '.bk-wd-upload-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
        document.head.appendChild(st);
      }
      var el = document.createElement('div');
      el.className = 'bk-wd-upload-toast';
      el.textContent = String(msg);
      document.body.appendChild(el);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { el.classList.add('show'); });
      } else {
        el.classList.add('show');
      }
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function () {
        el.classList.remove('show');
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 250);
      }, 2400);
    } catch (e) { /* toast 失败不影响主流程 */ }
  }

  // ── 书籍数据获取 ──────────────────────────────────────────────────────
  function _getBookTitle(bookId) {
    var books = win.__bkBooks || [];
    for (var i = 0; i < books.length; i++) {
      if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
        return books[i].title || books[i].name || bookId;
      }
    }
    return bookId;
  }

  function _isPdfBook(bookId) {
    var books = win.__bkBooks || [];
    for (var i = 0; i < books.length; i++) {
      if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
        if (books[i].format === 'pdf') return true;
        var chapters = books[i].chapters || [];
        for (var c = 0; c < chapters.length; c++) {
          var content = chapters[c].content || [];
          for (var j = 0; j < content.length; j++) {
            if (content[j] && content[j].type === 'pdf_page') return true;
          }
        }
        return false;
      }
    }
    return false;
  }

  /**
   * 获取书籍导出数据（用于上传）
   * 返回 { filename, data, mime }
   *   data: Uint8Array | string
   */
  function _getBookUploadData(bookId, format) {
    format = format || (_isPdfBook(bookId) ? 'pdf' : 'txt');

    // PDF 书：读取原始二进制
    if (format === 'pdf') {
      var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
        ? win.ImportManager.getPdfDataStore() : null;
      if (!store) return Promise.reject(new Error('PDF 数据存储不可用'));
      return store.getItem('pdf:' + bookId).then(function (data) {
        if (!data) return Promise.reject(new Error('PDF 数据未找到'));
        var title = _getBookTitle(bookId);
        return { filename: title + '.pdf', data: new Uint8Array(data), mime: 'application/pdf' };
      });
    }

    // 其他格式：通过 export-book 内部逻辑获取书籍数据并转换为对应格式
    return _getBookDataForExport(bookId).then(function (bookData) {
      var title = bookData.title || bookId;
      if (format === 'txt') {
        var text = _bookToText(bookData);
        return { filename: title + '.txt', data: '\uFEFF' + text, mime: 'text/plain;charset=utf-8' };
      }
      if (format === 'md') {
        var md = _bookToMd(bookData);
        return { filename: title + '.md', data: '\uFEFF' + md, mime: 'text/markdown;charset=utf-8' };
      }
      if (format === 'epub') {
        return _bookToEpub(bookData).then(function (bytes) {
          return { filename: title + '.epub', data: bytes, mime: 'application/epub+zip' };
        });
      }
      return Promise.reject(new Error('不支持的格式: ' + format));
    });
  }

  function _getBookDataForExport(bookId) {
    if (win.ImportManager && typeof win.ImportManager.getImportedBook === 'function') {
      return win.ImportManager.getImportedBook(bookId).then(function (book) {
        if (book) return book;
        if (win.DataManager && typeof win.DataManager.getBook === 'function') {
          return win.DataManager.getBook(bookId);
        }
        return null;
      });
    }
    if (win.DataManager && typeof win.DataManager.getBook === 'function') {
      return win.DataManager.getBook(bookId);
    }
    return Promise.resolve(null);
  }

  // ── 文本/Markdown 生成（复用 export-book.js 逻辑）─────────────────────
  function _stripHtml(html) {
    if (!html) return '';
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function _bookToText(bookData) {
    var title = bookData.title || bookData.id || '未知';
    var chapters = bookData.chapters || [];
    var lines = [title, '========================================', ''];
    for (var c = 0; c < chapters.length; c++) {
      var ch = chapters[c];
      lines.push('【' + (ch.title || ('第' + (ch.number || c + 1) + '章')) + '】');
      lines.push('');
      var content = ch.content || [];
      if (typeof content === 'string') { lines.push(content); }
      else {
        for (var i = 0; i < content.length; i++) {
          var item = content[i];
          if (!item) continue;
          var text = item.text || (item.html ? _stripHtml(item.html) : '');
          if (text) lines.push(text);
        }
      }
      lines.push('', '----------------------------------------', '');
    }
    return lines.join('\n');
  }

  function _escMd(s) {
    if (!s) return '';
    return String(s).replace(/([\\`*_{}\[\]()#+\-.!|>~=])/g, '\\$1');
  }

  function _bookToMd(bookData) {
    var title = bookData.title || bookData.id || '未知';
    var author = bookData.author || '';
    var chapters = bookData.chapters || [];
    var lines = ['# ' + _escMd(title)];
    if (author) lines.push('> ' + _escMd(author));
    lines.push('', '---', '');
    for (var c = 0; c < chapters.length; c++) {
      var ch = chapters[c];
      lines.push('## ' + _escMd(ch.title || ('第' + (ch.number || c + 1) + '章')));
      lines.push('');
      var content = ch.content || [];
      if (typeof content === 'string') { lines.push(content); }
      else {
        for (var i = 0; i < content.length; i++) {
          var item = content[i];
          if (!item) continue;
          var text = item.text || (item.html ? _stripHtml(item.html) : '');
          if (text) lines.push(text);
        }
      }
      lines.push('', '---', '');
    }
    return lines.join('\n');
  }

  function _bookToEpub(bookData) {
    var JSZip = win.JSZip;
    if (!JSZip) return Promise.reject(new Error('JSZip 未加载'));
    // 复用 export-book.js 的 EPUB 生成逻辑
    if (win.BK && win.BK.Export && win.BK.Export.exportBook) {
      // 通过 exportBook 生成 EPUB 会触发本地下载，不适合上传
      // 所以这里内联最小 EPUB 生成
    }
    var title = bookData.title || '未知';
    var author = bookData.author || '未知';
    var uid = 'bk-' + Date.now().toString(36);
    var chapters = bookData.chapters || [];
    var zip = new JSZip();

    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n</container>'
    );

    var manifestItems = '  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';
    var spineItems = '';
    for (var c = 0; c < chapters.length; c++) {
      var chId = 'ch' + (c + 1);
      manifestItems += '  <item id="' + chId + '" href="chapter-' + (c + 1) + '.xhtml" media-type="application/xhtml+xml"/>\n';
      spineItems += '  <itemref idref="' + chId + '"/>\n';
    }
    manifestItems += '  <item id="style" href="style.css" media-type="text/css"/>\n';

    var now = new Date();
    var isoDate = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
      ('0' + now.getDate()).slice(-2) + 'T' + ('0' + now.getHours()).slice(-2) + ':' +
      ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2) + 'Z';

    function _escXml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:identifier id="uid">urn:uuid:' + uid + '</dc:identifier>\n' +
      '    <dc:title>' + _escXml(title) + '</dc:title>\n' +
      '    <dc:creator>' + _escXml(author) + '</dc:creator>\n' +
      '    <dc:language>zh</dc:language>\n' +
      '    <meta property="dcterms:modified">' + isoDate + '</meta>\n' +
      '  </metadata>\n' +
      '  <manifest>\n' + manifestItems + '  </manifest>\n' +
      '  <spine>\n' + spineItems + '  </spine>\n</package>'
    );

    zip.file('OEBPS/style.css', 'body{font-family:serif;margin:1em;line-height:1.8}p{text-indent:2em}');

    var navLi = '';
    for (var n = 0; n < chapters.length; n++) {
      var chTitle = chapters[n].title || ('第' + (n + 1) + '章');
      navLi += '    <li><a href="chapter-' + (n + 1) + '.xhtml">' + _escXml(chTitle) + '</a></li>\n';
    }
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">\n' +
      '<head><title>' + _escXml(title) + '</title><link rel="stylesheet" href="style.css"/></head>\n' +
      '<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n' + navLi + '</ol></nav></body></html>'
    );

    for (var ci = 0; ci < chapters.length; ci++) {
      var chapter = chapters[ci];
      var chapterTitle = chapter.title || ('第' + (ci + 1) + '章');
      var bodyHtml = '<h1>' + _escXml(chapterTitle) + '</h1>\n';
      var content = chapter.content || [];
      if (typeof content === 'string') {
        bodyHtml += '<p>' + _escXml(content).replace(/\n\n/g, '</p><p>') + '</p>\n';
      } else {
        for (var j = 0; j < content.length; j++) {
          var item = content[j];
          if (!item) continue;
          var text = item.text || (item.html ? _stripHtml(item.html) : '');
          bodyHtml += '<p>' + _escXml(text) + '</p>\n';
        }
      }
      zip.file('OEBPS/chapter-' + (ci + 1) + '.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">\n' +
        '<head><title>' + _escXml(chapterTitle) + '</title><link rel="stylesheet" href="style.css"/></head>\n' +
        '<body>\n' + bodyHtml + '</body></html>'
      );
    }

    return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip' });
  }

  // ── 上传入口 ──────────────────────────────────────────────────────────

  /**
   * 显示上传对话框
   * @param {string|string[]} bookIds  书籍 ID（单个或多个）
   */
  function showUploadDialog(bookIds) {
    if (!bookIds) return;
    if (typeof bookIds === 'string') bookIds = [bookIds];
    if (!bookIds.length) return;

    if (!win.WebDavManager) {
      _toast('WebDAV 功能未就绪');
      return;
    }
    if (!win.BK || !win.BK.openDialog) {
      _toast('弹窗系统未就绪');
      return;
    }

    // 收集书籍信息
    var bookInfos = [];
    for (var i = 0; i < bookIds.length; i++) {
      var id = bookIds[i];
      bookInfos.push({
        id: id,
        title: _getBookTitle(id),
        isPdf: _isPdfBook(id)
      });
    }

    _renderUploadDialog(bookInfos);
  }

  // ── 对话框渲染 ──────────────────────────────────────────────────────
  function _renderUploadDialog(bookInfos) {
    // 清理残留的旧弹窗（close() 有 220ms 动画延迟，可能在 DOM 中残留）
    var oldEl = document.getElementById('bk-webdav-upload-dialog');
    if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
    var oldDirEl = document.getElementById('bk-webdav-upload-dir-dialog');
    if (oldDirEl && oldDirEl.parentNode) oldDirEl.parentNode.removeChild(oldDirEl);

    var isSingle = bookInfos.length === 1;
    var titleText = isSingle
      ? '上传《' + escHtml(bookInfos[0].title) + '》到 WebDAV'
      : '上传 ' + bookInfos.length + ' 本书到 WebDAV';

    // 格式选择（单本时）
    var formatHtml = '';
    if (isSingle) {
      var isPdf = bookInfos[0].isPdf;
      formatHtml = '<div class="bk-wdu-section"><div class="bk-wdu-label">上传格式</div>' +
        '<div class="bk-wdu-format-row">';
      if (isPdf) {
        formatHtml += '<button class="bk-wdu-format-btn active" data-format="pdf">PDF 原始文件</button>';
      } else {
        formatHtml += '<button class="bk-wdu-format-btn active" data-format="txt">TXT</button>';
        formatHtml += '<button class="bk-wdu-format-btn" data-format="md">Markdown</button>';
        formatHtml += '<button class="bk-wdu-format-btn" data-format="epub">EPUB</button>';
      }
      formatHtml += '</div></div>';
    }

    // 服务器选择
    var configs = win.WebDavManager.getAllConfigs ? win.WebDavManager.getAllConfigs() : [];
    var configOptions = '<option value="">— 手动输入 —</option>';
    for (var i = 0; i < configs.length; i++) {
      var cfg = configs[i];
      var optLabel = cfg.name || cfg.url;
      if (cfg.preset) optLabel = '\u2605 ' + optLabel;
      configOptions += '<option value="' + escAttr(cfg.id) + '">' + escHtml(optLabel) + '</option>';
    }

    var bookListHtml = '';
    if (!isSingle) {
      bookListHtml = '<div class="bk-wdu-section"><div class="bk-wdu-label">待上传书籍</div><div class="bk-wdu-book-list">';
      for (var b = 0; b < bookInfos.length; b++) {
        var bi = bookInfos[b];
        bookListHtml += '<div class="bk-wdu-book-item">' +
          '<span class="bk-wdu-book-title">' + escHtml(bi.title) + '</span>' +
          '<span class="bk-wdu-book-format">' + (bi.isPdf ? 'PDF' : 'TXT') + '</span>' +
          '</div>';
      }
      bookListHtml += '</div></div>';
    }

    // 初始配置：预置服务器时隐藏 URL 和用户名（用 CSS class）
    var _initConfig = win.WebDavManager.getActiveConfig ? win.WebDavManager.getActiveConfig() : null;
    var _isPresetInit = _initConfig && _initConfig.preset;
    var _urlClass = _isPresetInit ? ' bk-field-hidden' : '';
    var _userClass = _isPresetInit ? ' bk-field-hidden' : '';
    var _passPh = _isPresetInit ? '请输入密码' : '密码';

    var html =
      '<div class="bk-dialog" style="width:min(400px,calc(100vw - 40px))">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">' + titleText + '</div>' +
          '<button class="bk-drawer-close" data-action="wdu-close" aria-label="关闭">\u00d7</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-wdu-body">' +
          bookListHtml +
          formatHtml +
          '<div class="bk-wdu-section">' +
            '<div class="bk-wdu-label">目标服务器</div>' +
            '<select class="bk-field bk-wdu-select" id="wduServerSelect">' + configOptions + '</select>' +
            '<div class="bk-wdu-note" id="wduNote" style="display:none"></div>' +
          '</div>' +
          '<div id="wduCredFields">' +
            '<input class="bk-field' + _urlClass + '" id="wduUrl" placeholder="WebDAV 地址" />' +
            '<input class="bk-field' + _userClass + '" id="wduUser" placeholder="用户名" />' +
            '<input class="bk-field" id="wduPass" type="password" placeholder="' + _passPh + '" />' +
          '</div>' +
          '<div class="bk-wdu-section">' +
            '<div class="bk-wdu-label">上传路径</div>' +
            '<div class="bk-wdu-path-row">' +
              '<input class="bk-field" id="wduRemotePath" placeholder="/（默认上传到根目录）" />' +
              '<button class="bk-wdu-browse-btn" data-action="wdu-browse" id="wduBrowseBtn">浏览</button>' +
            '</div>' +
            '<div class="bk-wdu-hint">路径示例：/books 或 /上传/书籍（目录不存在会自动创建）<br>同名文件将被覆盖</div>' +
          '</div>' +
          '<div class="bk-wdu-error" id="wduError" style="display:none"></div>' +
          '<div class="bk-wdu-status" id="wduStatus" style="display:none"></div>' +
          '<div class="bk-wdu-progress-section" id="wduProgress" style="display:none">' +
            '<div class="bk-wdu-progress-text" id="wduProgressText"></div>' +
            '<div class="bk-wdu-progress-bar-wrap">' +
              '<div class="bk-wdu-progress-bar" id="wduProgressBar"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="bk-wdu-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdu-close">取消</button>' +
          '<button class="bk-btn bk-btn-primary" id="wduUploadBtn" data-action="wdu-upload">开始上传</button>' +
        '</div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-webdav-upload-dialog', html: html });
    if (!dlg) return;

    var dialogEl = document.getElementById('bk-webdav-upload-dialog');
    if (!dialogEl) return;

    // ── 状态 ──
    var state = {
      bookInfos: bookInfos,
      selectedConfig: null,
      connectedConfig: null,
      format: bookInfos.length === 1 && bookInfos[0].isPdf ? 'pdf' : 'txt',
      uploading: false,
      browseMode: false,
      browsePath: '',
      browseEntries: []
    };

    // ── 服务器选择 ──
    var serverSelect = dialogEl.querySelector('#wduServerSelect');
    if (serverSelect) {
      serverSelect.addEventListener('change', function () {
        var id = this.value;
        _onServerSelect(id, state, dialogEl);
      });
    }

    // ── 格式选择 ──
    var formatBtns = dialogEl.querySelectorAll('[data-format]');
    for (var fi = 0; fi < formatBtns.length; fi++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          state.format = btn.getAttribute('data-format');
          // 切换 active 样式
          var siblings = btn.parentNode.querySelectorAll('[data-format]');
          for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('active');
          btn.classList.add('active');
        });
      })(formatBtns[fi]);
    }

    // ── 浏览按钮 ──
    var browseBtn = dialogEl.querySelector('[data-action="wdu-browse"]');
    if (browseBtn) {
      browseBtn.addEventListener('click', function () {
        _onBrowse(state, dialogEl, dlg);
      });
    }

    // ── 上传按钮 ──
    var uploadBtn = dialogEl.querySelector('#wduUploadBtn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', function () {
        if (state.uploading) return;
        _doUpload(state, dialogEl, dlg);
      });
    }

    // ── 关闭按钮 ──
    var closeBtns = dialogEl.querySelectorAll('[data-action="wdu-close"]');
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener('click', function () {
        if (dlg && dlg.close) dlg.close();
      });
    }

    // 默认选中激活的配置
    var activeConfig = win.WebDavManager.getActiveConfig ? win.WebDavManager.getActiveConfig() : null;
    if (activeConfig && serverSelect) {
      serverSelect.value = activeConfig.id;
      _onServerSelect(activeConfig.id, state, dialogEl);
    }
  }

  // 从 localStorage 读取预置服务器已保存的写操作密码
  function _getSavedWritePassword(configId) {
    if (!configId) return '';
    try {
      return win.localStorage.getItem('bk_wd_write_pwd_' + configId) || '';
    } catch (e) { return ''; }
  }

  // 保存预置服务器写操作密码到 localStorage
  function _saveWritePassword(configId, pwd) {
    if (!configId || !pwd) return;
    try {
      win.localStorage.setItem('bk_wd_write_pwd_' + configId, pwd);
    } catch (e) { /* ignore */ }
  }

  // 路径记忆：按服务器ID/URL保存上次上传路径
  var WDU_PATH_KEY = 'bk_wdu_last_paths';
  function _saveLastPath(configKey, path) {
    try {
      var map = {};
      try { map = JSON.parse(win.localStorage.getItem(WDU_PATH_KEY) || '{}'); } catch (e) {}
      if (path) { map[configKey] = path; } else { delete map[configKey]; }
      win.localStorage.setItem(WDU_PATH_KEY, JSON.stringify(map));
    } catch (e) { /* ignore */ }
  }
  function _getLastPath(configKey) {
    try {
      var map = JSON.parse(win.localStorage.getItem(WDU_PATH_KEY) || '{}');
      return map[configKey] || '';
    } catch (e) { return ''; }
  }

  // 上传成功后保存账密和路径到本地
  function _saveUploadConfig(uploadConfig, state, remotePath) {
    try {
      var saveCfg = Object.assign({}, uploadConfig);
      var configKey = '';
      if (state.selectedConfig) {
        saveCfg.id = state.selectedConfig.id;
        saveCfg.name = state.selectedConfig.name || '';
        saveCfg.preset = !!state.selectedConfig.preset;
        configKey = state.selectedConfig.id;
      } else {
        configKey = uploadConfig.url || '';
      }
      win.WebDavManager.saveConfig(saveCfg);
      // 记忆上传路径
      if (configKey) _saveLastPath(configKey, remotePath);
    } catch (e) { /* 保存失败不影响主流程 */ }
  }

  // ── 服务器选择处理 ──────────────────────────────────────────────────
  function _onServerSelect(configId, state, dialogEl) {
    var credFields = dialogEl.querySelector('#wduCredFields');
    var urlInput = dialogEl.querySelector('#wduUrl');
    var userInput = dialogEl.querySelector('#wduUser');
    var passInput = dialogEl.querySelector('#wduPass');
    var pathInput = dialogEl.querySelector('#wduRemotePath');
    var noteEl = dialogEl.querySelector('#wduNote');
    var errorEl = dialogEl.querySelector('#wduError');

    if (errorEl) errorEl.style.display = 'none';

    if (!configId) {
      // 手动输入：显示所有字段
      state.selectedConfig = null;
      if (credFields) credFields.style.display = 'block';
      if (urlInput) { urlInput.value = ''; urlInput.classList.remove('bk-field-hidden'); }
      if (userInput) { userInput.value = ''; userInput.classList.remove('bk-field-hidden'); }
      if (passInput) { passInput.value = ''; passInput.classList.remove('bk-field-hidden'); passInput.placeholder = '密码'; }
      if (noteEl) noteEl.style.display = 'none';
      // 手动输入模式：路径也清空
      if (pathInput) pathInput.value = '';
      return;
    }

    // 查找配置
    var configs = win.WebDavManager.getAllConfigs ? win.WebDavManager.getAllConfigs() : [];
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === configId) { cfg = configs[i]; break; }
    }
    if (!cfg) return;

    state.selectedConfig = cfg;

    // 填充表单
    if (credFields) credFields.style.display = 'block';
    if (urlInput) urlInput.value = cfg.url || '';
    if (userInput) userInput.value = cfg.username || '';
    
    // 密码：预置服务器隐藏用户名，只显示密码输入（用 CSS class）
    if (cfg.preset) {
      if (urlInput) urlInput.classList.add('bk-field-hidden');
      if (userInput) userInput.classList.add('bk-field-hidden');
      if (passInput) {
        // 预置服务器：查找本地已保存的写操作密码自动填充
        var savedPwd = _getSavedWritePassword(cfg.id);
        passInput.value = savedPwd || '';
        passInput.placeholder = '请输入密码';
        passInput.required = true;
        passInput.classList.remove('bk-field-hidden');
      }
    } else {
      if (urlInput) urlInput.classList.remove('bk-field-hidden');
      if (userInput) userInput.classList.remove('bk-field-hidden');
      if (passInput) {
        passInput.value = cfg.password || '';
        passInput.placeholder = '密码';
        passInput.required = false;
        passInput.classList.remove('bk-field-hidden');
      }
    }

    // 备注
    if (noteEl) {
      if (cfg.note) {
        noteEl.textContent = '\u5907\u6ce8\uff1a' + cfg.note;
        noteEl.style.display = 'block';
      } else {
        noteEl.style.display = 'none';
      }
    }

    // 恢复上次上传路径
    if (pathInput && cfg.id) {
      var lastPath = _getLastPath(cfg.id);
      pathInput.value = lastPath || '';
    }
  }

  // ── 预置服务器删除密码验证（与 rp-import.js 的 _ensureDeletePassword 一致）──
  function _ensureUploadDeletePassword(state, callback) {
    if (!state.connectedConfig) return;
    if (!state.connectedConfig.preset) {
      callback(state.connectedConfig.password);
      return;
    }
    // 预置服务器：检查已保存的写操作密码
    var savedPwd = _getSavedWritePassword(state.connectedConfig.id);
    if (savedPwd) {
      callback(savedPwd);
      return;
    }
    // 无已保存密码：弹出密码输入框
    var html =
      '<div class="bk-dialog" style="width:min(340px,calc(100vw - 40px))">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">输入密码</div>' +
          '<button class="bk-drawer-close" data-action="wdu-pwd-cancel" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-webdav-del-body">' +
          '<div class="bk-webdav-del-warn">预置服务器删除文件需要密码验证</div>' +
          '<input class="bk-field" id="wduDelPass" type="password" placeholder="请输入密码" style="margin-top:12px" />' +
        '</div>' +
        '<div class="bk-webdav-del-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdu-pwd-cancel">取消</button>' +
          '<button class="bk-btn bk-btn-primary" data-action="wdu-pwd-confirm">确认</button>' +
        '</div>' +
      '</div>';
    var pwdDlg = win.BK.openDialog({ id: 'bk-webdav-upload-pwd-confirm', html: html });
    if (!pwdDlg) return;
    var el = document.getElementById('bk-webdav-upload-pwd-confirm');
    if (!el) return;
    var closePwdDlg = function () { if (pwdDlg && pwdDlg.close) pwdDlg.close(); };
    var cancelBtns = el.querySelectorAll('[data-action="wdu-pwd-cancel"]');
    for (var ci = 0; ci < cancelBtns.length; ci++) {
      cancelBtns[ci].addEventListener('click', closePwdDlg);
    }
    var confirmBtn = el.querySelector('[data-action="wdu-pwd-confirm"]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        var passEl = el.querySelector('#wduDelPass');
        var pwd = passEl ? passEl.value : '';
        if (!pwd) {
          passEl.style.borderColor = '#e74c3c';
          passEl.focus();
          return;
        }
        // 保存写操作密码到本地，下次免输入
        _saveWritePassword(state.connectedConfig.id, pwd);
        closePwdDlg();
        callback(pwd);
      });
    }
    var passInput = el.querySelector('#wduDelPass');
    if (passInput) setTimeout(function () { passInput.focus(); }, 100);
  }

  // ── 浏览远程目录 ──────────────────────────────────────────────────
  function _onBrowse(state, dialogEl, dlg) {
    // 先获取当前表单的配置
    var urlInput = dialogEl.querySelector('#wduUrl');
    var userInput = dialogEl.querySelector('#wduUser');
    var passInput = dialogEl.querySelector('#wduPass');

    var tempConfig = {
      url: urlInput ? urlInput.value.trim() : '',
      username: userInput ? userInput.value.trim() : '',
      password: passInput ? passInput.value : '',
      authType: 'basic',
      urls: null
    };

    // 如果选择了已保存的配置，合并信息
    if (state.selectedConfig) {
      tempConfig.id = state.selectedConfig.id;
      tempConfig.name = state.selectedConfig.name;
      tempConfig.urls = state.selectedConfig.urls || null;
      tempConfig.preset = !!state.selectedConfig.preset;
      if (!tempConfig.url && state.selectedConfig.url) tempConfig.url = state.selectedConfig.url;
    }

    if (!tempConfig.url) {
      _setError(dialogEl, '请先填写 WebDAV 地址');
      return;
    }

    // 测试连接 + 列目录
    _showStatus(dialogEl, '连接中\u2026');
    var browseBtn = dialogEl.querySelector('#wduBrowseBtn');
    if (browseBtn) browseBtn.disabled = true;

    win.WebDavManager.connect(tempConfig, { save: false }).then(function (res) {
      state.connectedConfig = res.config;
      state.browsePath = ''; // 从根目录开始
      _showDirBrowser(state, res.entries, dialogEl, dlg);
    }).catch(function (err) {
      _setError(dialogEl, (err && err.hint) || (err && err.message) || '连接失败');
    }).then(function () {
      if (browseBtn) browseBtn.disabled = false;
      _hideStatus(dialogEl);
    });
  }

  function _showDirBrowser(state, entries, dialogEl, dlg) {
    // 检查目录浏览弹窗是否已存在
    var existingEl = document.getElementById('bk-webdav-upload-dir-dialog');
    if (existingEl) {
      // 就地更新内容，避免 close() + openDialog() 的 history 时序问题
      _updateDirBrowserContent(existingEl, state, entries, dlg);
      return;
    }

    // 首次打开：弹出目录浏览子对话框
    var html = _buildDirBrowserHtml(state, entries);

    var dirDlg = win.BK.openDialog({ id: 'bk-webdav-upload-dir-dialog', html: html });
    if (!dirDlg) return;

    var dirDialogEl = document.getElementById('bk-webdav-upload-dir-dialog');
    if (!dirDialogEl) return;

    _bindDirBrowserEvents(dirDialogEl, state, entries, dialogEl, dlg, dirDlg);
  }

  // 构建目录浏览器 HTML
  function _buildDirBrowserHtml(state, entries) {
    var html = '<div class="bk-dialog" style="width:min(360px,calc(100vw - 40px));max-height:70vh">' +
      '<div class="bk-drawer-header">' +
        '<div class="bk-drawer-title">选择上传目录</div>' +
        '<button class="bk-drawer-close" data-action="wdu-dir-close" aria-label="关闭">\u00d7</button>' +
      '</div>' +
      '<div class="bk-drawer-divider"></div>' +
      '<div class="bk-wdu-dir-body" id="wduDirBody">';

    html += '<div class="bk-wdu-dir-breadcrumb">' +
      '<button class="bk-wdu-dir-up" data-action="wdu-dir-up">\u2190 上级</button>' +
      '<span class="bk-wdu-dir-path">' + escHtml(state.browsePath || '根目录') + '</span>' +
    '</div>';

    html += '<div class="bk-wdu-dir-list" id="wduDirList">';
    html += _buildDirListHtml(entries);
    html += '</div>';

    html += '</div>' +
      '<div class="bk-wdu-footer">' +
        '<button class="bk-btn bk-btn-secondary" data-action="wdu-dir-close">取消</button>' +
        '<button class="bk-btn bk-btn-primary" data-action="wdu-dir-select">选择此目录</button>' +
      '</div>' +
    '</div>';
    return html;
  }

  function _buildDirListHtml(entries) {
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (en.isDir) {
        html += '<div class="bk-wdu-dir-item" data-action="wdu-dir-open" data-path="' + escAttr(en.remotePath) + '">' +
          '<span class="bk-wdu-dir-icon">\ud83d\udcc1</span>' +
          '<span class="bk-wdu-dir-name">' + escHtml(en.name) + '</span>' +
          '<div class="bk-wdu-dir-item-actions">' +
            '<button class="bk-wdu-dir-del-btn" data-action="wdu-dir-delete" data-path="' + escAttr(en.remotePath) + '" data-name="' + escAttr(en.name) + '" title="\u5220\u9664\u76ee\u5f55">\u00d7</button>' +
          '</div>' +
        '</div>';
      }
    }
    for (var fi = 0; fi < entries.length; fi++) {
      var fe = entries[fi];
      if (!fe.isDir) {
        html += '<div class="bk-wdu-dir-item" style="cursor:default;opacity:.85">' +
          '<span class="bk-wdu-dir-icon" style="opacity:.7">\ud83d\udcc4</span>' +
          '<span class="bk-wdu-dir-name" style="font-weight:400">' + escHtml(fe.name) + '</span>' +
          '<span style="font-size:.75rem;color:var(--text-muted,#9A958C);flex-shrink:0">' + (fe.size ? formatSize(fe.size) : '') + '</span>' +
          '<div class="bk-wdu-dir-item-actions">' +
            '<button class="bk-wdu-dir-del-btn" data-action="wdu-dir-delete" data-path="' + escAttr(fe.remotePath) + '" data-name="' + escAttr(fe.name) + '" title="\u5220\u9664\u6587\u4ef6">\u00d7</button>' +
          '</div>' +
        '</div>';
      }
    }
    return html;
  }

  // 就地更新目录浏览器内容（不关闭重建弹窗）
  function _updateDirBrowserContent(dirDialogEl, state, entries, dlg) {
    // 更新面包屑
    var pathEl = dirDialogEl.querySelector('.bk-wdu-dir-path');
    if (pathEl) pathEl.textContent = state.browsePath || '根目录';

    // 更新文件列表
    var listEl = dirDialogEl.querySelector('#wduDirList');
    if (listEl) listEl.innerHTML = _buildDirListHtml(entries);

    // 重新绑定事件
    _bindDirBrowserEvents(dirDialogEl, state, entries, null, dlg, dlg);
  }

  // 绑定目录浏览器事件
  function _bindDirBrowserEvents(dirDialogEl, state, entries, parentDialogEl, parentDlg, dirDlg) {
    // 关闭按钮
    var closeBtns = dirDialogEl.querySelectorAll('[data-action="wdu-dir-close"]');
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener('click', function () {
        if (dirDlg && dirDlg.close) dirDlg.close();
      });
    }

    // 打开子目录
    var dirItems = dirDialogEl.querySelectorAll('[data-action="wdu-dir-open"]');
    for (var di = 0; di < dirItems.length; di++) {
      (function (item) {
        item.addEventListener('click', function () {
          var remotePath = item.getAttribute('data-path');
          if (!state.connectedConfig) return;
          var relPath = _toRelativePath(remotePath, state.connectedConfig.url || '');
          win.WebDavManager.listDir(state.connectedConfig, remotePath).then(function (subEntries) {
            state.browsePath = relPath;
            // 就地更新，不 close + 重建
            var el = document.getElementById('bk-webdav-upload-dir-dialog');
            if (el) {
              _updateDirBrowserContent(el, state, subEntries, parentDlg);
            }
          }).catch(function (err) {
            _toast('加载目录失败');
          });
        });
      })(dirItems[di]);
    }

    // 上级目录
    var upBtn = dirDialogEl.querySelector('[data-action="wdu-dir-up"]');
    if (upBtn) {
      upBtn.addEventListener('click', function () {
        if (!state.connectedConfig) return;
        var parentPath = _parentPath(state.browsePath);
        if (parentPath === null && state.browsePath === '') return;
        state.browsePath = parentPath || '';
        win.WebDavManager.listDir(state.connectedConfig, state.browsePath).then(function (subEntries) {
          var el = document.getElementById('bk-webdav-upload-dir-dialog');
          if (el) {
            _updateDirBrowserContent(el, state, subEntries, parentDlg);
          }
        });
      });
    }

    // 删除文件/目录按钮
    var delBtns = dirDialogEl.querySelectorAll('[data-action="wdu-dir-delete"]');
    for (var dbi = 0; dbi < delBtns.length; dbi++) {
      (function (delBtn) {
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var remotePath = delBtn.getAttribute('data-path');
          var itemName = delBtn.getAttribute('data-name') || '';
          if (!remotePath || !state.connectedConfig) return;
          // 预置服务器删除需要密码验证
          if (state.connectedConfig.preset) {
            _ensureUploadDeletePassword(state, function (pwd) {
              if (!win.confirm('确定删除\u300c' + itemName + '\u300f\uff1f\n\n此操作不可撤销。')) return;
              delBtn.disabled = true;
              // 临时替换密码用于删除请求
              var origPwd = state.connectedConfig.password;
              state.connectedConfig.password = pwd;
              win.WebDavManager.deleteResource(state.connectedConfig, remotePath).then(function () {
                state.connectedConfig.password = origPwd;
                _toast('已删除\u300c' + itemName + '\u300d');
                win.WebDavManager.listDir(state.connectedConfig, state.browsePath).then(function (subEntries) {
                  var el = document.getElementById('bk-webdav-upload-dir-dialog');
                  if (el) {
                    _updateDirBrowserContent(el, state, subEntries, parentDlg);
                  }
                });
              }).catch(function (err) {
                state.connectedConfig.password = origPwd;
                _toast('删除失败：' + ((err && err.hint) || (err && err.message) || ''));
                delBtn.disabled = false;
              });
            });
            return;
          }
          if (!win.confirm('确定删除\u300c' + itemName + '\u300f\uff1f\n\n此操作不可撤销。')) return;
          delBtn.disabled = true;
          win.WebDavManager.deleteResource(state.connectedConfig, remotePath).then(function () {
            _toast('已删除\u300c' + itemName + '\u300d');
            win.WebDavManager.listDir(state.connectedConfig, state.browsePath).then(function (subEntries) {
              var el = document.getElementById('bk-webdav-upload-dir-dialog');
              if (el) {
                _updateDirBrowserContent(el, state, subEntries, parentDlg);
              }
            });
          }).catch(function (err) {
            _toast('删除失败：' + ((err && err.hint) || (err && err.message) || ''));
            delBtn.disabled = false;
          });
        });
      })(delBtns[dbi]);
    }

    // 选择此目录
    var selectBtn = dirDialogEl.querySelector('[data-action="wdu-dir-select"]');
    if (selectBtn && parentDialogEl) {
      selectBtn.addEventListener('click', function () {
        var pathInput = parentDialogEl.querySelector('#wduRemotePath');
        if (pathInput) pathInput.value = state.browsePath || '/';
        if (dirDlg && dirDlg.close) dirDlg.close();
      });
    }
  }

  function _parentPath(path) {
    if (!path) return null;
    var p = path.replace(/^\/+|\/+$/g, '');
    var idx = p.lastIndexOf('/');
    if (idx <= 0) return '';
    return p.substring(0, idx);
  }

  // ── 执行上传 ──────────────────────────────────────────────────────────
  function _doUpload(state, dialogEl, dlg) {
    if (state.uploading) return;

    // 收集配置
    var urlInput = dialogEl.querySelector('#wduUrl');
    var userInput = dialogEl.querySelector('#wduUser');
    var passInput = dialogEl.querySelector('#wduPass');
    var pathInput = dialogEl.querySelector('#wduRemotePath');

    var url = urlInput ? urlInput.value.trim() : '';
    var username = userInput ? userInput.value.trim() : '';
    var password = passInput ? passInput.value : '';
    var remotePath = pathInput ? pathInput.value.trim() : '';

    if (!url) {
      _setError(dialogEl, '请填写 WebDAV 地址');
      return;
    }
    if (!password && state.selectedConfig && state.selectedConfig.preset) {
      _setError(dialogEl, '预置服务器需要输入密码才能上传');
      return;
    }

    // 构建上传配置：优先复用已竞速的 connectedConfig（确保打到最快节点）
    // 若无 connectedConfig（用户没点"浏览"就直接上传），先 connect 竞速
    var uploadConfig;
    if (state.connectedConfig) {
      uploadConfig = Object.assign({}, state.connectedConfig, {
        password: password || state.connectedConfig.password
      });
    } else {
      uploadConfig = {
        url: url,
        username: username,
        password: password,
        authType: (state.selectedConfig && state.selectedConfig.authType) || 'basic',
        urls: (state.selectedConfig && state.selectedConfig.urls) || null
      };
      if (state.selectedConfig) uploadConfig.preset = !!state.selectedConfig.preset;
    }

    // 规范化远程路径：去掉首尾空格，确保以 / 开头
    if (remotePath && remotePath.charAt(0) !== '/') {
      remotePath = '/' + remotePath;
    }

    state.uploading = true;
    var uploadBtn = dialogEl.querySelector('#wduUploadBtn');
    if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = '上传中\u2026'; }
    _hideError(dialogEl);

    var bookInfos = state.bookInfos;
    var total = bookInfos.length;
    var current = 0;
    var errors = [];

    // 若无 connectedConfig，先竞速连接获取最快节点
    var preChain;
    if (state.connectedConfig) {
      preChain = Promise.resolve(uploadConfig);
    } else {
      preChain = win.WebDavManager.connect(uploadConfig, { save: false }).then(function (res) {
        state.connectedConfig = res.config;
        // 用竞速后的 config 替换上传配置（URL 已是最快节点）
        var fastestConfig = Object.assign({}, res.config, {
          password: password || res.config.password
        });
        return fastestConfig;
      });
    }

    // 确保远程路径存在
    var chain = preChain.then(function (resolvedConfig) {
      uploadConfig = resolvedConfig;
      return win.WebDavManager.ensureRemotePath(uploadConfig, remotePath.replace(/^\/+/, ''));
    });

    for (var i = 0; i < bookInfos.length; i++) {
      (function (bookInfo, idx) {
        chain = chain.then(function () {
          current = idx + 1;
          var format = total === 1 ? state.format : (bookInfo.isPdf ? 'pdf' : 'txt');
          _showProgress(dialogEl, current, total, bookInfo.title);

          return _getBookUploadData(bookInfo.id, format).then(function (fileData) {
            // 构建远程文件路径（不预编码，uploadFile 内部的 buildDirUrl 会统一编码）
            var remoteFile = remotePath + '/' + fileData.filename;

            return win.WebDavManager.uploadFile(uploadConfig, remoteFile, fileData.data, fileData.mime);
          }).catch(function (err) {
            errors.push({ title: bookInfo.title, error: (err && err.hint) || (err && err.message) || '上传失败' });
          });
        });
      })(bookInfos[i], i);
    }

    chain.then(function () {
      state.uploading = false;
      if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '开始上传'; }
      _hideProgress(dialogEl);

      if (errors.length === 0) {
        _toast('上传成功：' + total + ' 本书');
        // 上传成功后保存账密到本地（下次不用重复填写）
        _saveUploadConfig(uploadConfig, state, remotePath);
        // 预置服务器：同时保存写操作密码到 bk_wd_write_pwd_{configId}
        if (state.selectedConfig && state.selectedConfig.preset && password) {
          _saveWritePassword(state.selectedConfig.id, password);
        }
        if (dlg && dlg.close) dlg.close();
      } else if (errors.length < total) {
        _toast('上传完成：' + (total - errors.length) + ' 成功，' + errors.length + ' 失败');
        // 显示失败列表
        var errMsg = errors.map(function (e) { return escHtml(e.title) + ': ' + escHtml(e.error); }).join('\n');
        _setError(dialogEl, errMsg);
      } else {
        _setError(dialogEl, '全部上传失败');
      }
    }).catch(function (err) {
      state.uploading = false;
      if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '开始上传'; }
      _hideProgress(dialogEl);
      _setError(dialogEl, (err && err.hint) || (err && err.message) || '上传失败');
    });
  }

  // ── UI 辅助 ──────────────────────────────────────────────────────────
  function _setError(dialogEl, msg) {
    var el = dialogEl.querySelector('#wduError');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg || '';
  }
  function _hideError(dialogEl) {
    var el = dialogEl.querySelector('#wduError');
    if (el) el.style.display = 'none';
  }
  function _showStatus(dialogEl, msg) {
    var el = dialogEl.querySelector('#wduStatus');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg || '';
  }
  function _hideStatus(dialogEl) {
    var el = dialogEl.querySelector('#wduStatus');
    if (el) el.style.display = 'none';
  }
  function _showProgress(dialogEl, current, total, bookTitle) {
    var section = dialogEl.querySelector('#wduProgress');
    var text = dialogEl.querySelector('#wduProgressText');
    var bar = dialogEl.querySelector('#wduProgressBar');
    if (section) section.style.display = 'block';
    if (text) text.textContent = '\u4e0a\u4f20 ' + current + '/' + total + ' \u300a' + bookTitle + '\u300b';
    if (bar) bar.style.width = Math.round((current / total) * 100) + '%';
  }
  function _hideProgress(dialogEl) {
    var section = dialogEl.querySelector('#wduProgress');
    if (section) section.style.display = 'none';
  }

  // ── 暴露 ──────────────────────────────────────────────────────────────
  win.BK = win.BK || {};
  win.BK.WebDavUpload = {
    showUploadDialog: showUploadDialog
  };

})(window);
