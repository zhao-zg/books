'use strict';

  // ── PDF 解析 ──────────────────────────────────────────────────────────
  // 使用 pdf.js (pdfjsLib) 解析 PDF：
  //   1. 尝试从 PDF 书签/大纲（outline）提取章节结构
  //   2. 若无书签，则每页作为一个章节
  //   3. 每页内容存储为 { type: 'pdf_page', pageNumber, pdfBookId } 类型
  //   4. PDF 原始数据另存到 imported-pdf-data 存储区，渲染时按需取页
  //
  // data: ArrayBuffer | Uint8Array | base64 string
  // fileName: 原始文件名
  function parsePdf(data, fileName) {
    if (!win.pdfjsLib) {
      throw new Error('pdf.js 未加载，无法解析 PDF');
    }

    // 将 base64 转为 ArrayBuffer
    var pdfData;
    if (typeof data === 'string') {
      // base64
      var raw = atob(data);
      pdfData = new Uint8Array(raw.length);
      for (var bi = 0; bi < raw.length; bi++) pdfData[bi] = raw.charCodeAt(bi);
    } else if (data instanceof ArrayBuffer) {
      pdfData = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      pdfData = data;
    } else {
      throw new Error('不支持的 PDF 数据类型');
    }

    var bookTitle = fileName.replace(/\.pdf$/i, '');
    var bookId = generateId();

    // 先保存 PDF 原始数据副本，再传给 pdf.js（getDocument 可能 transfer/detach ArrayBuffer）
    var pdfRawForStorage = pdfData.buffer.slice(pdfData.byteOffset, pdfData.byteOffset + pdfData.byteLength);

    // 用 pdf.js 加载文档
    var loadingTask = win.pdfjsLib.getDocument({ data: pdfData });
    return loadingTask.promise.then(function(pdf) {
      var totalPages = pdf.numPages;

      // 存储原始 PDF 数据（供渲染时按页取图）
      return getPdfDataStore().setItem('pdf:' + bookId, pdfRawForStorage).then(function() {
        // 尝试提取 PDF 大纲/书签
        return pdf.getOutline().then(function(outline) {
          var chapters = [];

          if (outline && outline.length > 0) {
            // ── 有书签：按书签分章 ──
            // 同步注入 outline 树到 BKPdf 阅读器（供目录抽屉使用，异步不阻塞主流程）
            if (win.BKPdf && typeof win.BKPdf.setOutline === 'function') {
              _buildOutlineTreeForReader(pdf, outline).then(function(tree) {
                try { win.BKPdf.setOutline(bookId, tree); } catch (e) { console.warn('[PDF] setOutline 注入失败:', e); }
              }).catch(function() { /* 静默失败，不影响导入 */ });
            }
            // 获取每页文字用于提取页码范围
            return resolveOutlineChapters(pdf, outline, bookId, totalPages).then(function(outlineChapters) {
              return outlineChapters;
            }).catch(function() {
              // 大纲解析失败，回退到逐页模式
              return buildPerPageChapters(bookId, totalPages);
            });
          } else {
            // ── 无书签：每页一章 ──
            chapters = buildPerPageChapters(bookId, totalPages);
          }

          return chapters;
        });
      }).then(function(chapters) {
        if (!chapters.length) {
          chapters.push({
            number: 1,
            title: bookTitle,
            content: [{ type: 'paragraph', text: '（PDF 无页面）' }],
            footnotes: []
          });
        }

        // 尝试从第一页提取元数据
        return extractPdfMeta(pdf).then(function(meta) {
          return {
            id: bookId,
            title: bookTitle,
            author: meta.author || '',
            format: 'pdf',
            cover: '',           // PDF 封面暂不提取，后续可扩展
            language: (meta.language || 'zh').substring(0, 2),
            description: (meta.subject || '').substring(0, 500),
            chapters: chapters,
            _pdfTotalPages: totalPages   // 内部标记，供渲染优化
          };
        });
      });
    });
  }

  // PDF 数据存储区（与 imported-data 分开，避免大块二进制污染主索引）
  var _pdfDataStore = null;
  function getPdfDataStore() {
    if (!_pdfDataStore) {
      _pdfDataStore = localforage.createInstance({
        name: 'books',
        storeName: 'imported-pdf-data'
      });
    }
    return _pdfDataStore;
  }

  /**
   * 清理指定书的 PDF 原始二进制数据。
   * 该 store 写入路径唯一（parsePdf 内 setItem('pdf:' + bookId)），此前无任何删除入口，
   * 导致移出书架后 PDF 文件永久驻留——此函数补齐该缺口。
   * @param {string} bookId
   * @returns {Promise<boolean>} 是否成功删除（无对应记录也返回 true）
   */
  function removePdfData(bookId) {
    if (!bookId) return Promise.resolve(false);
    try {
      return getPdfDataStore().removeItem('pdf:' + bookId).then(function () {
        console.log('[PDF] 已清理 PDF 原始数据: ' + bookId);
        return true;
      }).catch(function (e) {
        console.warn('[PDF] 清理 PDF 数据失败:', e);
        return false;
      });
    } catch (e) {
      console.warn('[PDF] 清理 PDF 数据失败:', e);
      return Promise.resolve(false);
    }
  }

  // 无大纲时：每页生成一个章节
  function buildPerPageChapters(bookId, totalPages) {
    var chapters = [];
    for (var p = 1; p <= totalPages; p++) {
      chapters.push({
        number: p,
        title: '第 ' + p + ' 页',
        content: [{ type: 'pdf_page', pageNumber: p, pdfBookId: bookId }],
        footnotes: []
      });
    }
    return chapters;
  }

  // 有大纲时：按书签条目分章
  // 需要解析书签指向的页码，然后确定每个书签覆盖的页范围
  function resolveOutlineChapters(pdf, outline, bookId, totalPages) {
    // 递归展平大纲为 {title, pageNumber} 数组
    var flatItems = [];
    function flattenOutline(items, depth) {
      for (var i = 0; i < items.length; i++) {
        flatItems.push({ title: items[i].title, dest: items[i].dest, depth: depth });
        if (items[i].items && items[i].items.length) {
          flattenOutline(items[i].items, depth + 1);
        }
      }
    }
    flattenOutline(outline, 0);

    // 解析每个书签的页码
    var pagePromises = flatItems.map(function(item) {
      if (!item.dest) return Promise.resolve(null);
      // dest 可能是 string (named destination) 或 array (explicit destination)
      if (typeof item.dest === 'string') {
        return pdf.getDestination(item.dest).then(function(dest) {
          if (!dest || !dest[0]) return null;
          return pdf.getPageIndex(dest[0]).then(function(idx) { return idx + 1; });
        }).catch(function() { return null; });
      } else if (Array.isArray(item.dest) && item.dest[0]) {
        return pdf.getPageIndex(item.dest[0]).then(function(idx) { return idx + 1; }).catch(function() { return null; });
      }
      return Promise.resolve(null);
    });

    return Promise.all(pagePromises).then(function(pageNumbers) {
      // 构建书签-页码对，过滤无效条目
      var bookmarks = [];
      for (var i = 0; i < flatItems.length; i++) {
        if (pageNumbers[i] != null) {
          bookmarks.push({ title: flatItems[i].title, pageNumber: pageNumbers[i], depth: flatItems[i].depth });
        }
      }

      if (!bookmarks.length) {
        // 所有大纲条目都没解析出页码，回退逐页
        return buildPerPageChapters(bookId, totalPages);
      }

      // 按页码排序（有些 PDF 大纲顺序和页码不一致）
      bookmarks.sort(function(a, b) { return a.pageNumber - b.pageNumber; });

      // 去重：同一页多个书签只保留第一个
      var unique = [];
      var lastPage = 0;
      for (var bi = 0; bi < bookmarks.length; bi++) {
        if (bookmarks[bi].pageNumber !== lastPage) {
          unique.push(bookmarks[bi]);
          lastPage = bookmarks[bi].pageNumber;
        }
      }
      bookmarks = unique;

      // 只取顶级书签(depth=0)作为章节划分；若全是 depth>0 则按实际来
      var topBookmarks = bookmarks.filter(function(b) { return b.depth === 0; });
      if (topBookmarks.length > 0) bookmarks = topBookmarks;

      // 生成章节：每个书签覆盖从其页码到下一书签页码之前的所有页
      var chapters = [];
      for (var ci = 0; ci < bookmarks.length; ci++) {
        var startPage = bookmarks[ci].pageNumber;
        var endPage = (ci + 1 < bookmarks.length) ? bookmarks[ci + 1].pageNumber - 1 : totalPages;
        var content = [];
        for (var pg = startPage; pg <= endPage; pg++) {
          content.push({ type: 'pdf_page', pageNumber: pg, pdfBookId: bookId });
        }
        chapters.push({
          number: chapters.length + 1,
          title: bookmarks[ci].title || ('第 ' + startPage + ' 页'),
          content: content,
          footnotes: []
        });
      }

      // 若书签未覆盖开头页面，补充一个前置章节
      if (bookmarks.length && bookmarks[0].pageNumber > 1) {
        var preContent = [];
        for (var pp = 1; pp < bookmarks[0].pageNumber; pp++) {
          preContent.push({ type: 'pdf_page', pageNumber: pp, pdfBookId: bookId });
        }
        chapters.unshift({
          number: 1,
          title: '前言',
          content: preContent,
          footnotes: []
        });
        // 重新编号
        for (var ri = 0; ri < chapters.length; ri++) chapters[ri].number = ri + 1;
      }

      return chapters.length ? chapters : buildPerPageChapters(bookId, totalPages);
    });
  }

  /**
   * 构建 BKPdf 阅读器目录抽屉所需的 outline 树结构。
   * 递归遍历 pdf.js 返回的原始 outline（每节点用 .items 作为子项），
   * 为每个节点解析出 pageNumber，输出格式：
   *   [{ title, dest, pageNumber, children: [...] }]
   * 与 resolveOutlineChapters 互补——后者只生成主章节列表，保留递归层级信息供侧边抽屉展开。
   * 失败静默：目录可用为加分项，不影响导入。
   */
  function _buildOutlineTreeForReader(pdf, outline) {
    if (!outline || !outline.length) return Promise.resolve([]);

    function visitNode(node) {
      var title = node.title || '';
      var dest = node.dest;
      var pagePromise;
      if (!dest) {
        pagePromise = Promise.resolve(0);
      } else if (typeof dest === 'string') {
        pagePromise = pdf.getDestination(dest).then(function (d) {
          if (!d || !d[0]) return 0;
          return pdf.getPageIndex(d[0]).then(function (idx) { return idx + 1; });
        }).catch(function () { return 0; });
      } else if (Array.isArray(dest) && dest[0]) {
        pagePromise = pdf.getPageIndex(dest[0]).then(function (idx) { return idx + 1; }).catch(function () { return 0; });
      } else {
        pagePromise = Promise.resolve(0);
      }
      return pagePromise.then(function (pageNumber) {
        var childPromise = (node.items && node.items.length)
          ? Promise.all(node.items.map(visitNode))
          : Promise.resolve([]);
        return childPromise.then(function (children) {
          return { title: title, dest: dest, pageNumber: pageNumber, children: children };
        });
      });
    }

    return Promise.all(outline.map(visitNode));
  }

  // 提取 PDF 元数据（title, author, subject, language）
  function extractPdfMeta(pdf) {
    return pdf.getMetadata().then(function(info) {
      var meta = info && info.info || {};
      return {
        title: meta.Title || meta.title || '',
        author: meta.Author || meta.author || '',
        subject: meta.Subject || meta.subject || '',
        language: meta.Language || ''
      };
    }).catch(function() {
      return { title: '', author: '', subject: '', language: '' };
    });
  }
