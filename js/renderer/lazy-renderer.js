'use strict';

  /* ═══════════════════════════════════════════════════════════════════
   * lazy-renderer.js — 超长文本章节「视口懒渲染 + 回收」调度模块
   *
   * 背景：文本章节（EPUB/MD/TXT）整章一次性渲染成 DOM。当章节超长时
   * （如背经辅助 2 节版单章 6 万段），一次性 innerHTML 会造成明显卡顿、
   * 渲染截断、内存峰值。PDF 章节已有成熟懒渲染，文本章节此前无优化。
   *
   * 本模块策略（用户已确认）：
   *   - 调度层：新建独立模块，renderer-api / renderer-carousel 仅接入；
   *   - 切片粒度：按 content 项逐个切片（逻辑切片，不建 DOM）；
   *   - 阈值判定：content 项数 + 预估文本量 双条件，超阈值才启用；
   *   - 占位策略：未渲染块用占位 div，高度按 item 类型估算。
   *
   * 渲染模型（关键设计）：
   *   切片（slice）是纯逻辑单位：一个 content item 一片，含估算偏移。
   *   块（block）是 DOM 单位：每 _BLOCK_SIZE 个切片合并为一块 div。
   *   - 未渲染块：空 div，高度=块内估算高度之和（占位，保持可滚动）
   *   - 已渲染块：填入真实内容，高度由内容撑开（实际高度）
   *   - 回收块：清空内容，恢复估算高度（保持滚动连续性，无跳变）
   *   滚动时只渲染视口附近块（含缓冲带），视口外已渲染块可回收。
   *   因为块 div 始终在文档流中、高度被保持，滚动进度/书签
   *   基于 scrollHeight 计算天然连续，配合 renderer-progress 的
   *   _retryCheckScrollCompletion 重试机制兜底即可。
   *
   * 依赖：renderer-content.js 的 renderContentItem / _applyMdEnhancements
   *       renderer-utils.js 的 escAttr / escText
   * 挂载：win.BKLazyRenderer（供调用方与测试使用）
   * ═══════════════════════════════════════════════════════════════════ */

  // ── 阈值常量 ─────────────────────────────────────────────────────────
  // 项数阈值：content 数组超过此数才考虑懒渲染（普通章节平均几十项）
  var _LONG_CHAPTER_ITEM_THRESHOLD = 500;
  // 预估文本量阈值（字符）：文本+html 总长超过此数才考虑
  // 避免"项数多但都是极短句"的章节被误判为超长
  var _LONG_CHAPTER_TEXT_THRESHOLD = 10000;
  // 图片/表格等富媒体按 1 项折算若干字符（渲染开销远大于纯文本）
  var _RICH_ITEM_CHAR_WEIGHT = 80;

  // ── 估算常量（占位高度，单位 px）────────────────────────────────────
  var _EST = {
    lineHeight: 24,        // 段落基准行高
    paraCharsPerLine: 36,  // 一屏约 36 个中文字符/行（移动端正文 18px）
    heading: 48,           // 标题基准高度（含 margin）
    quote: 64,             // 引用块基准高度
    image: 220,            // 图片基准高度（figure 含 caption）
    list: 24,              // 列表行高
    code: 20,              // 代码行高
    mermaid: 240,          // Mermaid 图基准高度
    math: 48,              // 公式基准高度
    tableRow: 28,          // 表格行高
    footnote: 48,          // 脚注基准高度
    separator: 16,         // 分隔线
    linebreak: 24,         // 换行
    default: 28            // 未知类型兜底
  };

  // 估算单个 content item 的渲染高度（纯函数，供占位高度与切片偏移使用）
  function estimateContentHeight(item) {
    if (!item) return 0;
    var type = item.type || 'paragraph';
    var text = item.text || '';
    var len = text.length;

    switch (type) {
      case 'heading':
        return 48 + (len > 40 ? Math.ceil((len - 40) / 40) * 12 : 0); // 长标题折行增量
      case 'quote':
        return Math.max(_EST.quote, Math.ceil(len / _EST.paraCharsPerLine) * _EST.lineHeight);
      case 'image':
        return _EST.image;
      case 'list': {
        var items = item.items || [];
        var listH = 0;
        for (var li = 0; li < items.length; li++) {
          var it = items[li];
          listH += Math.max(_EST.list, Math.ceil(String(it || '').length / _EST.paraCharsPerLine) * _EST.list);
        }
        return Math.max(_EST.list, listH);
      }
      case 'code': {
        var lines = text.split('\n').length;
        return Math.max(24, lines * _EST.code + 16);
      }
      case 'mermaid':
        return _EST.mermaid;
      case 'math':
        return _EST.math;
      case 'table': {
        var rows = item.rows || [];
        return Math.max(24, rows.length * _EST.tableRow);
      }
      case 'footnote':
      case 'footnotes_section':
        return _EST.footnote + Math.ceil(len / _EST.paraCharsPerLine) * _EST.lineHeight;
      case 'separator':
        return _EST.separator;
      case 'linebreak':
        return _EST.linebreak;
      default:
        // paragraph 与未知类型：按行数估高
        return Math.max(_EST.lineHeight, Math.ceil(len / _EST.paraCharsPerLine) * _EST.lineHeight);
    }
  }

  // 估算单个 item 的"渲染量"（字符当量，用于阈值判定）
  function estimateItemWeight(item) {
    if (!item) return 0;
    var type = item.type || 'paragraph';
    if (type === 'image' || type === 'mermaid' || type === 'math' || type === 'table') {
      return _RICH_ITEM_CHAR_WEIGHT;
    }
    var items = item.items;
    if (items) {
      var w = 0;
      for (var i = 0; i < items.length; i++) w += String(items[i] || '').length;
      return w;
    }
    return (item.text || '').length;
  }

  // 阈值判定：content 数组项数 + 预估文本量双条件
  function isLongChapterCandidate(contentArr, contentLen) {
    if (!contentArr || !contentArr.length) return false;
    var len = contentLen != null ? contentLen : contentArr.length;
    if (len < _LONG_CHAPTER_ITEM_THRESHOLD) return false;
    var total = 0;
    for (var i = 0; i < contentArr.length; i++) {
      total += estimateItemWeight(contentArr[i]);
      if (total >= _LONG_CHAPTER_TEXT_THRESHOLD) return true;  // 提前退出
    }
    return total >= _LONG_CHAPTER_TEXT_THRESHOLD;
  }

  // 按 content 项逐个切片，附带累计估算偏移（纯函数）
  function buildSlices(contentArr) {
    if (!contentArr || !contentArr.length) return [];
    var slices = [];
    var offset = 0;
    for (var i = 0; i < contentArr.length; i++) {
      var h = estimateContentHeight(contentArr[i]);
      slices.push({ index: i, offset: offset, height: h });
      offset += h;
    }
    return slices;
  }

  // 块大小：每块包含的切片数（DOM 节点数由块数决定，而非切片数）。
  // 6 万段章节 → 600 个块 div，而非 6 万个小 div，避免 DOM 节点爆炸。
  var _BLOCK_SIZE = 100;

  // 将切片按固定数量合并为块（纯函数）：块 = { start, end, sliceCount, offset, height }
  // start：块内首个切片的 content index；end：切片下标终止（[start, end) 对应切片范围）
  function buildBlocks(slices, blockSize) {
    if (!slices || !slices.length) return [];
    var size = blockSize || _BLOCK_SIZE;
    var blocks = [];
    for (var i = 0; i < slices.length; i += size) {
      var end = Math.min(i + size, slices.length);
      var h = 0;
      for (var j = i; j < end; j++) h += slices[j].height;
      blocks.push({
        start: slices[i].index,
        end: end,
        sliceCount: end - i,
        offset: slices[i].offset,
        height: h
      });
    }
    return blocks;
  }

  /* ═══════════════════════════════ 调度器 ═══════════════════════════════
   * 以下为 DOM 调度部分（依赖真实 DOM / rAF / 滚动容器），
   * 通过浏览器集成验证；纯逻辑部分（上方）已由单元测试覆盖。
   * ═══════════════════════════════════════════════════════════════════ */

  var _active = null;   // 当前活跃懒渲染实例（切章/退出时销毁）
  var _instances = [];  // 全部活跃实例（carousel 三页各自可能超长，多实例并存）

  // 配置常量
  var _VIEW_BUFFER = 800;      // 视口上下缓冲带（px），提前渲染
  var _RECYCLE_MARGIN = 1200;  // 回收安全边际：视口外超过此值才回收（避免抖动）
  var _BATCH = 2;              // 每帧最多渲染块数（一块含最多 _BLOCK_SIZE 个 item）

  // 批次级 DOM 增强回调（由 renderer-content.js 在加载完成后注入）：
  // _applyMdEnhancements / annotateInlineRefs 每次新块渲染后只处理新块内元素
  var _enhanceBlock = null;
  function setEnhanceBlock(fn) { _enhanceBlock = fn || null; }

  // 创建懒渲染实例状态
  function createLazyRender(chapter, container, opts) {
    var contentArr = chapter && Array.isArray(chapter.content) ? chapter.content : [];
    if (!contentArr.length) return null;
    var slices = buildSlices(contentArr);
    var blocks = buildBlocks(slices);
    var state = {
      chapter: chapter,
      container: container || null,
      eager: !!(opts && opts.eager),
      renderItem: (opts && opts.renderItem) || null,
      onRender: (opts && opts.onRender) || null,   // 每批渲染后回调（如 _applyMdEnhancements）
      slices: slices,
      blocks: blocks,
      renderedSet: {},        // block index -> true（当前已渲染内容）
      destroyed: false,
      scrollEl: null,         // 实际滚动容器
      scrollHandler: null,
      rafTimer: null,
      blockEls: []            // 各块 div 引用（按块 index 索引）
    };
    return state;
  }

  // 找到纵向滚动容器：优先向上找已知滚动类，否则 window
  function _findScrollEl(container) {
    var el = container;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.classList && (el.classList.contains('bk-carousel-page') ||
          el.classList.contains('bk-reader-content') || el.classList.contains('bk-reader-body'))) {
        return el;
      }
      el = el.parentElement;
    }
    return win;
  }

  // 初始化：创建实例（不自动销毁其他实例，由调用方管理生命周期）。
  function initLazyRender(chapter, container, opts) {
    var state = createLazyRender(chapter, container, opts || {});
    if (!state) return null;
    _active = state;
    _instances.push(state);

    var holder = state.container;
    if (!holder) return state;

    // 清空容器，注入所有块 div（占位高度），顺序排列
    holder.innerHTML = '';
    holder.setAttribute('data-bk-lazy', '1');
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      var div = document.createElement('div');
      div.className = 'bk-lazy-block';
      div.setAttribute('data-block-index', i);
      div.style.height = b.height + 'px';
      div.style.visibility = 'hidden';  // 空占位不显示内容
      holder.appendChild(div);
      state.blockEls.push(div);
    }

    // 首屏渲染：视口范围内（scrollTop=0 → 视口顶=0）
    state.scrollEl = _findScrollEl(holder);
    _tick(state);

    // 首屏渲染完成：对已渲染块执行依赖 DOM 的增强（md 高亮/经文标注等）
    if (_enhanceBlock) {
      for (var ei = 0; ei < state.blocks.length; ei++) {
        if (state.renderedSet[ei] && state.blockEls[ei]) _enhanceBlock(state.blockEls[ei]);
      }
    }

    // 滚动监听（rAF 合并）
    state.scrollHandler = function () {
      if (state.rafTimer) cancelAnimationFrame(state.rafTimer);
      state.rafTimer = requestAnimationFrame(function () {
        state.rafTimer = null;
        if (state.destroyed) return;
        _tick(state);
      });
    };
    var scrollEl = state.scrollEl;
    if (scrollEl) scrollEl.addEventListener('scroll', state.scrollHandler, { passive: true });

    return state;
  }

  // 调度循环：渲染视口附近块 + 回收视口外块
  function _tick(state) {
    if (!state || state.destroyed) return;
    if (!state.blocks.length || !state.container) return;
    var scrollEl = state.scrollEl || win;
    var viewTop = 0, viewBottom = 0;
    if (scrollEl === win) {
      viewTop = win.scrollY || 0;
      viewBottom = viewTop + (win.innerHeight || 0);
    } else {
      viewTop = scrollEl.scrollTop || 0;
      viewBottom = viewTop + (scrollEl.clientHeight || 0);
    }
    var top = viewTop - _VIEW_BUFFER;
    var bottom = viewBottom + _VIEW_BUFFER;

    // 用真实 DOM 位置（offsetTop）判断视口关系：
    // 占位块保持估算高度，渲染块由内容撑开，offsetTop 反映实际布局。
    // 注意：读取 offsetTop 会触发布局，但块数有限（几百个），每帧可接受。
    var toRender = [];
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.renderedSet[i]) continue;
      var el = state.blockEls[i];
      if (!el) continue;
      var elTop = el.offsetTop;
      var elBottom = elTop + el.offsetHeight;
      if (elBottom < top || elTop > bottom) continue;
      toRender.push(i);
    }

    // 回收已渲染但远离视口的块（清空内容恢复占位高度）。
    // 注意：必须同时处理视口上方与下方——顺序滚动只产生上方离屏块，
    // 但进度条/书签跳变会让下方旧块瞬间离屏，若不回收会残留渲染内容。
    var recycleTop = viewTop - _RECYCLE_MARGIN;
    var recycleBottom = viewBottom + _RECYCLE_MARGIN;
    for (var ri = 0; ri < state.blocks.length; ri++) {
      if (!state.renderedSet[ri]) continue;
      var rel = state.blockEls[ri];
      if (!rel) continue;
      var rTop = rel.offsetTop;
      var rBottom = rTop + rel.offsetHeight;
      if (rBottom < recycleTop || rTop > recycleBottom) _recycleBlock(state, ri);
    }

    // 优先渲染（靠近视口中心的先）
    if (toRender.length) {
      var midY = (viewTop + viewBottom) / 2;
      toRender.sort(function (a, b) {
        var ba = state.blockEls[a], bb = state.blockEls[b];
        var da = Math.abs((ba.offsetTop + ba.offsetHeight / 2) - midY);
        var db = Math.abs((bb.offsetTop + bb.offsetHeight / 2) - midY);
        return da - db;
      });
      _renderBatch(state, toRender, 0);
    }
  }

  // 分批渲染（rAF 每帧最多 _BATCH 块）
  function _renderBatch(state, toRender, idx) {
    if (state.destroyed) return;
    var count = Math.min(_BATCH, toRender.length - idx);
    var any = false;
    for (var i = 0; i < count; i++) {
      if (_renderBlock(state, toRender[idx + i])) any = true;
    }
    if (state.onRender && any) {
      try { state.onRender(state.container); } catch (e) {}
    }
    // 块级增强：仅处理本批新渲染的块（md 高亮/经文标注等），避免全容器重复扫描
    if (_enhanceBlock) {
      for (var bi = 0; bi < count; bi++) {
        var bIdx = toRender[idx + bi];
        if (state.renderedSet[bIdx] && state.blockEls[bIdx]) {
          try { _enhanceBlock(state.blockEls[bIdx]); } catch (e) {}
        }
      }
    }
    idx += count;
    if (idx < toRender.length) {
      state.rafTimer = requestAnimationFrame(function () {
        state.rafTimer = null;
        if (state.destroyed) return;
        _renderBatch(state, toRender, idx);
      });
    }
  }

  // 渲染单个块：填充内容（块内所有切片），取消占位高度
  function _renderBlock(state, blockIdx) {
    var div = state.blockEls[blockIdx];
    if (!div) return false;
    if (state.renderedSet[blockIdx]) return true;
    var b = state.blocks[blockIdx];
    var html = '';
    for (var si = b.start; si < b.end && si < state.slices.length; si++) {
      var slice = state.slices[si];
      var item = state.chapter.content[slice.index];
      var itemHtml = state.renderItem ? state.renderItem(item, slice.index) : '';
      if (itemHtml) html += itemHtml;
    }
    if (!html) return false;
    div.innerHTML = html;
    div.style.height = '';          // 由内容撑开
    div.style.visibility = 'visible';
    state.renderedSet[blockIdx] = true;
    return true;
  }

  // 回收单个块：清空内容，恢复占位高度（保持总高连续）
  function _recycleBlock(state, blockIdx) {
    var div = state.blockEls[blockIdx];
    if (!div) return;
    if (!state.renderedSet[blockIdx]) return;
    div.innerHTML = '';
    div.style.height = state.blocks[blockIdx].height + 'px';
    div.style.visibility = 'hidden';
    delete state.renderedSet[blockIdx];
  }

  // 销毁：移除滚动监听、清理 rAF、恢复容器。
  // 传 null/undefined → 销毁全部实例（退出阅读视图时）；
  // 传 DOM 元素 → 销毁绑定在该容器上的实例（carousel 重填某页时）；
  // 传实例对象 → 只销毁该实例。
  function destroyLazyRender(state) {
    var targets = [];
    if (!state) {
      targets = _instances.slice();
    } else if (state.nodeType === 1 || (state && state.tagName)) {
      for (var mi = 0; mi < _instances.length; mi++) {
        if (_instances[mi].container === state) targets.push(_instances[mi]);
      }
      if (!targets.length) return;
    } else {
      targets = [state];
    }
    for (var ti = 0; ti < targets.length; ti++) {
      var t = targets[ti];
      if (!t) continue;
      t.destroyed = true;
      if (t.rafTimer) cancelAnimationFrame(t.rafTimer);
      if (t.scrollHandler && t.scrollEl) {
        t.scrollEl.removeEventListener('scroll', t.scrollHandler);
      }
      if (t.container && t.container.getAttribute('data-bk-lazy')) {
        t.container.removeAttribute('data-bk-lazy');
      }
      var _idx = _instances.indexOf(t);
      if (_idx >= 0) _instances.splice(_idx, 1);
      if (_active === t) _active = null;
    }
  }

  // 暴露给全局（与 BKRenderer.__test 同风格）
  var BKLazyRenderer = {
    _thresholds: {
      items: _LONG_CHAPTER_ITEM_THRESHOLD,
      text: _LONG_CHAPTER_TEXT_THRESHOLD
    },
    isLongChapterCandidate: isLongChapterCandidate,
    estimateContentHeight: estimateContentHeight,
    estimateItemWeight: estimateItemWeight,
    buildSlices: buildSlices,
    buildBlocks: buildBlocks,
    createLazyRender: createLazyRender,
    initLazyRender: initLazyRender,
    destroyLazyRender: destroyLazyRender,
    setEnhanceBlock: setEnhanceBlock,
    _tick: _tick,
    _getActive: function () { return _active; },
    _getInstances: function () { return _instances.slice(); }
  };

  // 挂载全局（浏览器环境 window 与顶层 var win 均可用）
  if (typeof window !== 'undefined') window.BKLazyRenderer = BKLazyRenderer;
  if (typeof win !== 'undefined') win.BKLazyRenderer = BKLazyRenderer;