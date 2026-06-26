/**
 * scripture-popup.js
 * ==================
 * 功能：
 *  1. .scripture-ref[data-refs] 点击 → 弹框显示经文
 *  2. 正文自动标注阿拉伯式经文引用
 *  3. 弹框内 {N} 注脚号 → 展开注解（fn-ref）
 *  4. 弹框内 [a] 串珠号 → 展开对应串珠经文列表（xref-ref）
 *  5. 导航栈（返回按钮）
 *  6. 三文件懒加载：bible-text.json / bible-notes.json / bible-xrefs.json
 *
 * 全局变量（fetch 后手动赋值）：
 *   BK_SCRIPTURES_DATA   （bible-text.json）
 *   BK_BIBLE_NOTES       （bible-notes.json）
 *   BK_BIBLE_XREFS       （bible-xrefs.json）
 */
(function () {
  'use strict';

  /* ── 书卷/数字匹配（支持阿拉伯与中文数字） ── */
  var REF_BOOK_RE = '[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚雅玛太可路约徒罗林加弗腓西帖提门多彼犹启来][后前上下壹贰叁参]?';
  /* 只有一章的书卷（犹、俄、门、约贰/约叁），引用时可省略章号 */
  var SINGLE_CHAPTER_BOOKS = { '犹':1, '俄':1, '门':1, '约贰':1, '约叁':1, '约二':1, '约三':1 };
  var REF_NUM_RE = '[0-9一二三四五六七八九十百零〇○]+';
  var RANGE_SEP = '[\\-~～—]';  /* 范围分隔符：- ~ ～ — */
  /* 支持：太4:19 / 太四19 / 太四19-22 / 太4:19~22 / 罗五17～21 / 路九23 */
  var INLINE_REF_RE = new RegExp('(' + REF_BOOK_RE + '(?:' + REF_NUM_RE + ':' + REF_NUM_RE + '(?:' + RANGE_SEP + REF_NUM_RE + ')?[上中下]?|[一二三四五六七八九十百零〇○]+' + REF_NUM_RE + '(?:' + RANGE_SEP + REF_NUM_RE + ')?[上中下]?))', 'g');

  /* ── HTML 转义 ── */
  function esc(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function cnNumToInt(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var m = { '零':0, '〇':0, '○':0, '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };

    if (s.indexOf('百') >= 0 || s.indexOf('十') >= 0) {
      var val = 0;
      var rest = s;
      var i;
      if ((i = rest.indexOf('百')) >= 0) {
        var h = rest.slice(0, i);
        val += (h ? (m[h] || 0) : 1) * 100;
        rest = rest.slice(i + 1);
      }
      if ((i = rest.indexOf('十')) >= 0) {
        var t = rest.slice(0, i);
        val += (t ? (m[t] || 0) : 1) * 10;
        rest = rest.slice(i + 1);
      }
      for (var k = 0; k < rest.length; k++) {
        val += (m[rest.charAt(k)] || 0);
      }
      return val;
    }

    var digits = [];
    for (var j = 0; j < s.length; j++) {
      var d = m[s.charAt(j)];
      if (d === undefined) return null;
      digits.push(d);
    }
    if (digits.length === 1) return digits[0];
    if (digits.length === 2) return digits[0] * 10 + digits[1];
    if (digits.length === 3) return digits[0] * 100 + digits[1] * 10 + digits[2];
    return null;
  }

  function normalizeNumToken(token) {
    var n = cnNumToInt(token);
    return (n === null || isNaN(n)) ? null : String(n);
  }

  function parseBookAndTail(ref) {
    var mBook = ref.match(new RegExp('^(' + REF_BOOK_RE + ')(.*)$'));
    if (!mBook) return null;
    return { book: mBook[1], tail: mBook[2] || '' };
  }

  function getBookFromRef(ref) {
    var bt = parseBookAndTail(ref || '');
    return bt ? bt.book : '';
  }

  function splitRefTokens(refs) {
    return String(refs || '')
      .replace(/[（(]/g, ' ')
      .replace(/[）)]/g, ' ')
      .split(/[\s,，;；、]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function normalizeRef(ref, fallbackBook) {
    ref = (ref || '').trim();
    if (!ref) return '';
    ref = ref
      .replace(/^参+/g, '')
      .replace(/^[见見]/g, '')
      .replace(/\s+/g, '')
      .replace(/：/g, ':')
      .replace(/[－—～~]/g, '-')
      .replace(/[。；，、]$/g, '');

    /* 「书+章+标题」格式：诗二二标题 / 诗22标题 → 诗22:0T */
    if (/标题$/.test(ref)) {
      var titleRef = ref.slice(0, -2); /* 去掉"标题" */
      var btT = parseBookAndTail(titleRef);
      if (btT && btT.book) {
        var chT = normalizeNumToken(btT.tail);
        if (chT) return btT.book + chT + ':0T';
      }
    }

    var bt = parseBookAndTail(ref);
    var book = bt ? bt.book : (fallbackBook || '');
    var tail = bt ? bt.tail : ref;
    if (!book) return ref;

    var m1 = tail.match(new RegExp('^(' + REF_NUM_RE + '):(' + REF_NUM_RE + '(?:-' + REF_NUM_RE + ')?)([上中下]?)$'));
    if (m1) {
      var ch = normalizeNumToken(m1[1]);
      if (!ch) return ref;
      var vr = m1[2];
      var suffix = m1[3] || '';
      if (vr.indexOf('-') >= 0) {
        var ab = vr.split('-', 2);
        var a = normalizeNumToken(ab[0]);
        var b = normalizeNumToken(ab[1]);
        if (!a || !b) return ref;
        return book + ch + ':' + a + '-' + b + suffix;
      }
      var v = normalizeNumToken(vr);
      return v ? (book + ch + ':' + v + suffix) : ref;
    }

    var m2 = tail.match(/^([一二三四五六七八九十百零〇○]+)(\d+(?:-\d+)?)([上中下]?)$/);
    if (m2) {
      var ch2 = normalizeNumToken(m2[1]);
      if (!ch2) return ref;
      var vr2 = m2[2];
      var suffix2 = m2[3] || '';
      if (vr2.indexOf('-') >= 0) {
        var ab2 = vr2.split('-', 2);
        var a2 = normalizeNumToken(ab2[0]);
        var b2 = normalizeNumToken(ab2[1]);
        if (!a2 || !b2) return ref;
        return book + ch2 + ':' + a2 + '-' + b2 + suffix2;
      }
      var v2 = normalizeNumToken(vr2);
      return v2 ? (book + ch2 + ':' + v2 + suffix2) : ref;
    }

    var m3 = tail.match(new RegExp('^(' + REF_NUM_RE + ')([一二三四五六七八九十百零〇○]+)([上中下]?)$'));
    if (m3) {
      var ch3 = normalizeNumToken(m3[1]);
      var v3 = normalizeNumToken(m3[2]);
      var suffix3 = m3[3] || '';
      if (!ch3 || !v3) return ref;
      return book + ch3 + ':' + v3 + suffix3;
    }

    /* 单章书卷：犹20 → 犹1:20，门8 → 门1:8 */
    if (SINGLE_CHAPTER_BOOKS[book]) {
      var m4 = tail.match(/^(\d+(?:-\d+)?)([上中下]?)$/);
      if (m4) {
        var vr4 = m4[1], suffix4 = m4[2] || '';
        if (vr4.indexOf('-') >= 0) {
          var ab4 = vr4.split('-', 2);
          return book + '1:' + ab4[0] + '-' + ab4[1] + suffix4;
        }
        return book + '1:' + vr4 + suffix4;
      }
    }

    return ref;
  }

  function parseAndExpandRefs(refs, bibleDict, contextBook) {
    var tokens = splitRefTokens(refs);
    var lastBook = contextBook || '';
    var lastChapter = '';   // 上一个成功解析的章号（十进制字符串）
    var out = [];
    tokens.forEach(function (token) {
      // 节范围标签前缀剥离：「31-35:出三六35」→「出三六35」
      // 形如「数字(范围):经文引用」，冒号前是段落/节次标签，非经文章节引用
      var _lm = /^\d+(?:[~～\-]\d+)?:([^\d:].*)$/.exec(token);
      if (_lm) token = _lm[1].trim();
      // 纯节号续接（如 8~9、19~24）：仅含数字+范围符，无书卷前缀
      // 此时继承 lastBook + lastChapter，拼成完整引用再解析
      var bareVerse = token.replace(/[～~—\-]/g, '-').match(/^(\d+)(-\d+)?([上中下]?)$/);
      if (bareVerse && lastBook && lastChapter) {
        token = lastBook + lastChapter + ':' + token;
      }
      var nr = normalizeRef(token, lastBook);
      if (!nr) return;
      var bk = getBookFromRef(nr);
      if (bk) lastBook = bk;
      // 更新 lastChapter（从规范化后的 book+章:节 中提取章号）
      var chm = nr.match(/(\d+):/);
      if (chm) lastChapter = chm[1];
      out = out.concat(expandRefToken(nr, bibleDict));
    });
    return out;
  }

  function expandRefToken(ref, bibleDict) {
    var nr = normalizeRef(ref);
    if (!nr) return [];

    // 跨章范围：book c1:v1-c2:v2（如 启10:1-11:13）
    // 展开为区间内所有已收录经节（含上/中/下半节键）
    var mrCross = nr.match(new RegExp('^(' + REF_BOOK_RE + ')(\\d+):(\\d+)-(\\d+):(\\d+)$'));
    if (mrCross) {
      var bC = mrCross[1];
      var c1C = parseInt(mrCross[2], 10), v1C = parseInt(mrCross[3], 10);
      var c2C = parseInt(mrCross[4], 10), v2C = parseInt(mrCross[5], 10);
      if (!isNaN(c1C) && !isNaN(v1C) && !isNaN(c2C) && !isNaN(v2C)
          && (c2C > c1C || (c2C === c1C && v2C >= v1C))) {
        var _rank = { '': 0, '上': 1, '中': 2, '下': 3 };
        var arrC = Object.keys(bibleDict || {})
          .filter(function (k) {
            if (k.slice(-2) === ':0') return false;
            var m = k.match(new RegExp('^' + bC + '(\\d+):(\\d+)([上中下]?)$'));
            if (!m) return false;
            var kc = parseInt(m[1], 10), kv = parseInt(m[2], 10);
            if (kc < c1C || kc > c2C) return false;
            if (kc === c1C && kv < v1C) return false;
            if (kc === c2C && kv > v2C) return false;
            return true;
          })
          .sort(function (a, b) {
            var ma = a.match(new RegExp('^' + bC + '(\\d+):(\\d+)([上中下]?)$'));
            var mb = b.match(new RegExp('^' + bC + '(\\d+):(\\d+)([上中下]?)$'));
            var ca = parseInt(ma[1], 10), va = parseInt(ma[2], 10), sa = ma[3] || '';
            var cb = parseInt(mb[1], 10), vb = parseInt(mb[2], 10), sb = mb[3] || '';
            if (ca !== cb) return ca - cb;
            if (va !== vb) return va - vb;
            return (_rank[sa] || 0) - (_rank[sb] || 0);
          });
        if (arrC.length) return arrC;
      }
      return [bC + c1C + ':' + v1C, bC + c2C + ':' + v2C];
    }

    /* 标题专属引用（:0T）：只显示标题文字，不展开整章 */
    if (nr.slice(-3) === ':0T') {
      return [nr];
    }
    if (nr.slice(-2) === ':0') {
      var prefix = nr.slice(0, -1); /* e.g. "诗133:" */
      var chKeys = Object.keys(bibleDict || {})
        .filter(function (k) { return k.indexOf(prefix) === 0 && k.slice(-2) !== ':0'; })
        .sort(function (a, b) {
          var av = parseInt((a.split(':')[1] || '').replace(/[上中下]/g, ''), 10);
          var bv = parseInt((b.split(':')[1] || '').replace(/[上中下]/g, ''), 10);
          return av - bv;
        });
      // 若该章有标题（":0" 条目有内容），置于列表首位
      if ((bibleDict || {})[nr]) chKeys.unshift(nr);
      return chKeys.length ? chKeys : [nr];
    }

    var mr = nr.match(new RegExp('^(' + REF_BOOK_RE + ')(\\d+):(\\d+)-(\\d+)([上中下]?)$'));
    if (mr && !mr[5]) {
      var book = mr[1], ch = parseInt(mr[2], 10), v1 = parseInt(mr[3], 10), v2 = parseInt(mr[4], 10);
      if (!isNaN(ch) && !isNaN(v1) && !isNaN(v2) && v2 >= v1) {
        var arr = [];
        for (var i = v1; i <= v2; i++) arr.push(book + ch + ':' + i);
        return arr;
      }
    }

    return [nr];
  }

  /* ── 根路径 ── */
  function getRootPath() {
    return (window.BK && window.BK_ROOT) ? window.BK_ROOT : '../';
  }

  /* ── 懒加载 JSON ── */
  function loadJSON(url, onDone) {
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(onDone)
      .catch(function (err) {
        console.warn('[scripture-popup] 加载失败: ' + url, err && err.message || err);
        onDone(null);
      }); /* 加载失败也继续 */
  }

  var _loadingText  = false, _cbText  = [];
  var _loadingNotes = false, _cbNotes = [];
  var _loadingXrefs = false, _cbXrefs = [];
  var _bibleLoaded = false;          /* bible-text.json 是否已加载 */
  var _suppLoadedForPath = null;     /* 上次加载 scriptures-data.json 对应的 BK_BOOK_PATH */

  function ensureBibleText(cb) {
    var tp = window.BK_BOOK_PATH || null; /* e.g. book-id，由 renderer.js 设置 */
    /* 全部就绪：bible 已加载 且 当前训练的补充数据已加载（或无训练） */
    if (_bibleLoaded && _suppLoadedForPath === tp) { cb(); return; }
    _cbText.push(cb);
    if (_loadingText) return;
    _loadingText = true;

    /* 本地导入路径（local-YYYY-NN）：从 localforage 读取补充经文，无需网络 */
    var isLocal = tp && /^local-/.test(tp);
    function loadSupp(onData) {
      if (!tp) { onData(null); return; }
      if (!isLocal) {
        loadJSON(getRootPath() + tp + '/js/scriptures-data.json', onData);
      } else {
        onData(null);
      }
    }

    if (_bibleLoaded) {
      /* bible 已加载，只需重新加载当前训练的补充经文 */
      function applySupp(data) {
        var base = window.BK_BIBLE_TEXT_DATA || {};
        window.BK_SCRIPTURES_DATA = data
          ? Object.assign({}, base, data)
          : Object.assign({}, base);
        _suppLoadedForPath = tp;
        _loadingText = false;
        var cbs = _cbText.slice(); _cbText = [];
        cbs.forEach(function (f) { f(); });
      }
      loadSupp(applySupp);
      return;
    }

    /* bible 尚未加载：bible-text.json 同步加载，补充经文按类型加载 */
    var pending = tp ? 2 : 1, bibleData = null, suppData = null;
    function allDone() {
      if (--pending > 0) return;
      if (bibleData) {
        window.BK_BIBLE_TEXT_DATA = bibleData;  /* 保留全本圣经独立引用，供整章展开使用 */
        window.BK_SCRIPTURES_DATA = Object.assign({}, bibleData);
      }
      /* 训练专属条目最后合并，确保其优先于全本圣经同键条目 */
      if (suppData) {
        window.BK_SCRIPTURES_DATA = Object.assign(window.BK_SCRIPTURES_DATA || {}, suppData);
      }
      _bibleLoaded = true;
      _suppLoadedForPath = tp;
      _loadingText = false;
      window.BK_BIBLE_TEXT_READY = 1;  /* 向后兼容 */
      var cbs = _cbText.slice(); _cbText = [];
      cbs.forEach(function (f) { f(); });
    }
    loadJSON(getRootPath() + 'data/bible-text.json', function (data) {
      bibleData = data; allDone();
    });
    if (tp) {
      loadSupp(function(data) { suppData = data; allDone(); });
    }
  }

  function ensureBibleNotes(cb) {
    if (window.BK_BIBLE_NOTES_READY && window.BK_BIBLE_NOTES) { cb(); return; }
    _cbNotes.push(cb);
    if (_loadingNotes) return;
    _loadingNotes = true;
    loadJSON(getRootPath() + 'data/bible-notes.json', function (data) {
      if (data) {
        window.BK_BIBLE_NOTES = data;
        window.BK_BIBLE_NOTES_READY = 1;
      } else {
        /* 加载失败：重置标志，允许下次重试 */
        _loadingNotes = false;
        window.BK_BIBLE_NOTES_READY = 0;
      }
      var cbs = _cbNotes.slice(); _cbNotes = [];
      cbs.forEach(function (f) { f(); });
    });
  }

  function ensureBibleXrefs(cb) {
    if (window.BK_BIBLE_XREFS_READY && window.BK_BIBLE_XREFS) { cb(); return; }
    _cbXrefs.push(cb);
    if (_loadingXrefs) return;
    _loadingXrefs = true;
    loadJSON(getRootPath() + 'data/bible-xrefs.json', function (data) {
      if (data) {
        window.BK_BIBLE_XREFS = data;
        window.BK_BIBLE_XREFS_READY = 1;
      } else {
        /* 加载失败：重置标志，允许下次重试 */
        _loadingXrefs = false;
        window.BK_BIBLE_XREFS_READY = 0;
      }
      var cbs = _cbXrefs.slice(); _cbXrefs = [];
      cbs.forEach(function (f) { f(); });
    });
  }

  /* ═══════════════════════════ DOM 结构 ═══════════════════════════ */
  function createModal() {
    var overlay = document.createElement('div');
    overlay.id = 'scripture-popup-overlay';
    overlay.className = 'scripture-popup-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var box = document.createElement('div');
    box.className = 'scripture-popup';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    var header = document.createElement('div');
    header.className = 'scripture-popup-header';

    var backBtn = document.createElement('button');
    backBtn.className = 'scripture-popup-back';
    backBtn.setAttribute('aria-label', '返回');
    backBtn.innerHTML = '&#9664;';
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', navBack);

    var title = document.createElement('span');
    title.className = 'scripture-popup-title';
    title.id = 'scripture-popup-title';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'scripture-popup-close';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = '&#10005;';
    closeBtn.addEventListener('click', closeModal);

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'scripture-popup-body';
    body.id = 'scripture-popup-body';

    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    /* 点遮罩空白：优先走 history.back()，让 backStack 决定行为（回退 navStack 层或关闭弹框） */
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { e.stopPropagation(); try { history.back(); } catch(e) {} }
    });

    /* 防滚动穿透 + 触摸点遮罩关闭（mobile touchend → history.back） */
    window.BK.lockOverlayScroll(overlay, function() { try { history.back(); } catch(e) {} });

    return { overlay: overlay, title: title, body: body, backBtn: backBtn };
  }

  var modal = null;
  function getModal() {
    if (!modal) modal = createModal();
    return modal;
  }

  /* ═══════════════════════════ 导航栈 ═══════════════════════════ */
  var navStack = [];

  /* ── makeScriptureStep: 弹 1 层，每层 navPush 各自对应 1 条 backStack 记录 ── */
  function makeScriptureStep() {
    return function step() {
      if (navStack.length > 1) {
        /* 还有上层 → 回退一帧（本条 backStack 记录已消耗，不再 re-push）*/
        navStack.pop();
        renderFrame(navStack[navStack.length - 1]);
      } else {
        /* 最顶层 → 关闭弹框 */
        navStack = [];
        if (modal) {
          modal.overlay.classList.remove('scripture-popup-overlay--open');
          modal.overlay.setAttribute('aria-hidden', 'true');
        }
      }
    };
  }

  /* navPush: 每层都向 backStack 注册 1 条关闭回调 */
  function navPush(frame) {
    /* 保存当前帧的滚动位置，供返回时恢复 */
    if (navStack.length > 0 && modal) {
      navStack[navStack.length - 1]._scrollTop = modal.body.scrollTop;
    }
    navStack.push(frame);
    renderFrame(frame);
    window.BK.backStack.push(makeScriptureStep());
  }

  /* navBack（← 按钮）: 弹 1 层 + 同步消耗对应的 backStack 记录 */
  function navBack() {
    if (navStack.length <= 1) { closeModal(); return; }
    navStack.pop();
    renderFrame(navStack[navStack.length - 1]);
    window.BK.backStack.pop(); // 跳过 fn 回调，仅消耗 history
  }

  /* ═══════════════════════════ 渲染经文帧 ═══════════════════════════ */
  /*
   * frame = { type:'verses', refs:'创1:1,创1:2', label:'...' }
   *       | { type:'footnote', verseKey:'创1:1', num:'1' }
   *       | { type:'xrefs', verseKey:'创1:1', letter:'a' }
   */
  function renderFrame(frame) {
    var m = getModal();
    m.backBtn.style.display = navStack.length > 1 ? '' : 'none';

    if (frame.type === 'verses') {
      m.title.textContent = frame.label || (frame.refs || '').replace(/,/g, '、');
      if (window.BK_BIBLE_TEXT_READY) {
        /* 数据已缓存（预加载），直接渲染，避免 loading→内容 双重 innerHTML 导致闪屏 */
        m.body.innerHTML = renderVerseList(frame.refs, frame.verseKey || '');
        m.body.scrollTop = frame._scrollTop || 0;
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleText(function () {
          m.body.innerHTML = renderVerseList(frame.refs, frame.verseKey || '');
          m.body.scrollTop = frame._scrollTop || 0;
        });
      }
    } else if (frame.type === 'footnote') {
      m.title.textContent = frame.verseKey + ' 注' + frame.num;
      /* renderFootnote: 统一的注解查找与渲染逻辑 */
      function renderFootnote() {
        var notes = window.BK_BIBLE_NOTES || {};
        var noteObj = notes[frame.verseKey] || {};
        /* 若精确键未命中，合并带 上/中/下 后缀的键（如 创1:2 → 创1:2上 + 创1:2下） */
        if (Object.keys(noteObj).length === 0) {
          var suffixes = ['上', '中', '下'];
          var merged = {};
          for (var si = 0; si < suffixes.length; si++) {
            var sk = frame.verseKey + suffixes[si];
            if (notes[sk]) {
              var sObj = notes[sk];
              var sKeys = Object.keys(sObj);
              for (var ski = 0; ski < sKeys.length; ski++) {
                merged[sKeys[ski]] = sObj[sKeys[ski]];
              }
            }
          }
          if (Object.keys(merged).length > 0) noteObj = merged;
        }
        /* 反向回退：若 verseKey 带后缀（如 创1:2上）且未命中，尝试基础键（创1:2） */
        if (Object.keys(noteObj).length === 0 && /[上中下]$/.test(frame.verseKey)) {
          var bk2 = frame.verseKey.replace(/[上中下]$/, '');
          noteObj = notes[bk2] || {};
        }
        /* 尝试多种键格式：原始字符串、去前导零、整数键 */
        var text = noteObj[frame.num];
        if (text === undefined) {
          var parsedNum = parseInt(frame.num, 10);
          text = noteObj[String(parsedNum)];
        }
        if (text === undefined) {
          /* 遍历 noteObj 的键做宽松匹配（兼容数字/字符串键不一致） */
          var numStr = String(parseInt(frame.num, 10));
          var keys = Object.keys(noteObj);
          for (var ki = 0; ki < keys.length; ki++) {
            if (String(parseInt(keys[ki], 10)) === numStr) {
              text = noteObj[keys[ki]];
              break;
            }
          }
        }
        if (text === undefined) {
          var hasData = Object.keys(notes).length > 0;
          text = hasData
            ? '（未找到 ' + frame.verseKey + ' 注' + frame.num + ' 的注解）'
            : '（注解数据加载失败，请稍后重试）';
        }
        return '<div class="scripture-popup-fn-body">' + renderNoteText(text, frame.verseKey) + '</div>';
      }
      if (window.BK_BIBLE_NOTES_READY && window.BK_BIBLE_NOTES) {
        m.body.innerHTML = renderFootnote();
        m.body.scrollTop = frame._scrollTop || 0;
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleNotes(function () {
          m.body.innerHTML = renderFootnote();
          m.body.scrollTop = frame._scrollTop || 0;
        });
      }
    } else if (frame.type === 'xrefs') {
      m.title.textContent = frame.verseKey + ' 串' + frame.letter;
      if (window.BK_BIBLE_XREFS_READY && window.BK_BIBLE_XREFS && window.BK_BIBLE_TEXT_READY) {
        var xrefMap = (window.BK_BIBLE_XREFS || {})[frame.verseKey] || {};
        var refs = xrefMap[frame.letter] || '';
        if (refs) {
          m.body.innerHTML = renderVerseList(refs, frame.verseKey || '');
          m.body.scrollTop = frame._scrollTop || 0;
        } else {
          m.body.innerHTML = '<div class="scripture-popup-empty">（未找到串珠）</div>';
          m.body.scrollTop = 0;
        }
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleXrefs(function () {
          var xrefMap2 = (window.BK_BIBLE_XREFS || {})[frame.verseKey] || {};
          var refs2 = xrefMap2[frame.letter] || '';
          if (refs2) {
            ensureBibleText(function () {
              m.body.innerHTML = renderVerseList(refs2, frame.verseKey || '');
              m.body.scrollTop = frame._scrollTop || 0;
            });
          } else {
            m.body.innerHTML = '<div class="scripture-popup-empty">（未找到串珠）</div>';
            m.body.scrollTop = 0;
          }
        });
      }
    }
  }

  /* 剥除上/下后缀，得到完整节键（用于查找注解/串珠） */
  function baseKey(ref) {
    return ref.replace(/[上中下]$/, '');
  }

  /* 渲染经文列表（支持 {N} → fn-ref, [a] → xref-ref） */
  function renderVerseList(refs, contextRef) {
    var dict = window.BK_SCRIPTURES_DATA || {};
    /* 整章展开只从全本圣经 bible-text.json 里取节列表 */
    var bibleDict = window.BK_BIBLE_TEXT_DATA || dict;
    var contextBook = getBookFromRef(contextRef || '');
    /* 展开整章/区间引用，并规范化中文写法 */
    var refArr = parseAndExpandRefs(refs, bibleDict, contextBook);
    if (!refArr.length) return '<div class="scripture-popup-empty">暂无经文</div>';
    return refArr.map(function (ref) {
      ref = ref.trim();
      if (!ref) return '';
      var nr = normalizeRef(ref) || ref;
      var bk = baseKey(nr);               /* 去掉上/下，用于查注解/串珠 */
      /* 优先用半节文本，若无则退到完整节文本 */
      /* :0T = 标题专属引用，从 :0 键取内容，与普通经节同样渲染（支持注解/串珠） */
      if (nr.slice(-3) === ':0T') {
        var titleKey = nr.slice(0, -1); /* 诗22:0T → 诗22:0 */
        var titleLabel = titleKey.replace(/:0$/, ':标题'); /* 诗22:0 → 诗22:标题 */
        var titleRaw = dict[titleKey] || '';
        if (titleRaw) {
          return '<div class="scripture-popup-verse" data-vkey="' + esc(titleKey) + '">'
            + '<span class="scripture-popup-ref">' + esc(titleLabel) + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(titleRaw, titleKey) + '</span>'
            + '</div>';
        }
        return '<div class="scripture-popup-verse scripture-popup-verse--missing">'
          + '<span class="scripture-popup-ref">' + esc(titleLabel) + '</span>'
          + '<span class="scripture-popup-text">（未收录标题）</span></div>';
      }
      var raw = dict[nr] || (bk !== nr ? dict[bk] : '');
      /* :0 整章引用首位标题行，同样用普通经节样式渲染 */
      if (raw && nr.slice(-2) === ':0') {
        var titleLabel0 = bk.replace(/:0$/, ':标题'); /* 诗22:0 → 诗22:标题 */
        return '<div class="scripture-popup-verse" data-vkey="' + esc(bk) + '">'
          + '<span class="scripture-popup-ref">' + esc(titleLabel0) + '</span>'
          + '<span class="scripture-popup-text">' + renderVerseText(raw, bk) + '</span>'
          + '</div>';
      }
      if (raw) {
        return '<div class="scripture-popup-verse" data-vkey="' + esc(nr) + '">'
          + '<span class="scripture-popup-ref">' + esc(ref) + '</span>'
          + '<span class="scripture-popup-text">' + renderVerseText(raw, bk, nr) + '</span>'
          + '</div>';
      }
      /* 无精确匹配时，尝试上/中/下半节合并显示 */
      if (!/[上中下]$/.test(nr)) {
        var upRaw = dict[nr + '上'], midRaw = dict[nr + '中'], downRaw = dict[nr + '下'];
        if (upRaw || midRaw || downRaw) {
          var combined = '';
          if (upRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '上') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '上') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(upRaw, bk, nr + '上') + '</span></div>';
          if (midRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '中') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '中') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(midRaw, bk, nr + '中') + '</span></div>';
          if (downRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '下') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '下') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(downRaw, bk, nr + '下') + '</span></div>';
          return combined;
        }
      }
      return '<div class="scripture-popup-verse scripture-popup-verse--missing">'
        + '<span class="scripture-popup-ref">' + esc(ref) + '</span>'
        + '<span class="scripture-popup-text">（未收录）</span>'
        + '</div>';
    }).join('');
  }

  /* 把 {N} 转为注脚上标，[a] 转为串珠上标 */
  /* dataVkey: 用于 fn-ref/xref-ref 的 data-vkey（含上中下后缀，精确匹配 notes/xrefs 键） */
  function renderVerseText(raw, verseKey, dataVkey) {
    var vk = dataVkey || verseKey;
    var text = esc(raw);
    /* {N} → fn-ref */
    text = text.replace(/\{(\d+)\}/g, function (_, n) {
      return '<sup class="fn-ref" data-vkey="' + esc(vk) + '" data-fn="' + n + '">' + n + '</sup>';
    });
    /* [a] → xref-ref */
    text = text.replace(/\[([a-z]+)\]/g, function (_, lr) {
      return '<sup class="xref-ref" data-vkey="' + esc(vk) + '" data-xr="' + lr + '">' + lr + '</sup>';
    });
    return text;
  }

  /* 渲染注解文字（内嵌经文引用变为可点击，verseKey 提供书卷上下文） */
  function renderNoteText(text, verseKey) {
    if (window.BKRef && window.BKRef.wrapRefs) {
      return window.BKRef.wrapRefs(text, verseKey || '', { lockBook: true })
        .replace(/\n/g, '<br>');
    }
    return esc(text)
      .replace(
        INLINE_REF_RE,
        '<span class="verse-ref" data-refs="$1">$1</span>'
      )
      .replace(/\n/g, '<br>');
  }

  /* 确保弹框已打开（fn-ref/xref-ref 可能在弹框外点击）*/
  /* backStack push 由后续 navPush 完成，此处只负责打开 overlay */
  function ensureOpen() {
    var m = getModal();
    if (!m.overlay.classList.contains('scripture-popup-overlay--open')) {
      navStack = [];
      m.overlay.classList.add('scripture-popup-overlay--open');
      m.overlay.setAttribute('aria-hidden', 'false');
    }
  }

  /* ═══════════════════════════ 弹框开关 ═══════════════════════════ */
  function openModal(refs, labelText) {
    var m = getModal();
    navStack = [];
    m.overlay.classList.add('scripture-popup-overlay--open');
    m.overlay.setAttribute('aria-hidden', 'false');
    navPush({ type: 'verses', refs: refs, label: labelText || refs.replace(/,/g,'、') });
    /* navPush 内部已调用 backStack.push，无需再次 push */
  }

  function closeModal() {
    if (!modal) return;
    /* 有几层就弹几次，清空对应的 history 记录 */
    var n = navStack.length;
    navStack = [];
    modal.overlay.classList.remove('scripture-popup-overlay--open');
    modal.overlay.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < n; i++) window.BK.backStack.pop();
  }

  /* ── ESC 关闭 ── */
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.keyCode === 27) && modal && modal.overlay.classList.contains('scripture-popup-overlay--open')) {
      closeModal();
    }
  });

  /* ── 平板：点击扩展框外区域关闭 ── */
  document.addEventListener('click', function (e) {
    if (window.innerWidth < 600) return;
    if (!modal || !modal.overlay.classList.contains('scripture-popup-overlay--open')) return;
    /* 点击在弹框本体内 → 不关闭 */
    if (modal.overlay.contains(e.target)) return;
    /* 点击的是经文引用类元素 → 不关闭（由事件委托接管打开新帧） */
    var t = e.target;
    while (t && t !== document) {
      if (t.classList && (
        (t.classList.contains('scripture-ref') && t.dataset && t.dataset.refs) ||
        t.classList.contains('fn-ref') ||
        t.classList.contains('xref-ref')
      )) return;
      t = t.parentNode;
    }
    /* 平板不锁滚动，history.back() 会异步恢复滚动位置，提前保存并还原 */
    var savedScrollY = window.scrollY;
    closeModal();
    /* history.back() 是异步的，用 popstate 之后恢复最可靠 */
    window.addEventListener('popstate', function restoreScroll() {
      window.removeEventListener('popstate', restoreScroll);
      /* 再等一帧，确保浏览器滚动恢复已执行完毕 */
      requestAnimationFrame(function () {
        window.scrollTo(0, savedScrollY);
      });
    }, { once: true });
  }, true); /* capture 保证在事件委托之前执行 */

  /* ═══════════════════════════ 事件委托 ═══════════════════════════ */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      /* fn-ref（注脚号）—— 必须在 scripture-ref 之前检查，
       * 因为 ref-detector 生成的 fn-ref span 同时具有 scripture-ref 和 fn-ref 两个 class */
      if (t.classList && t.classList.contains('fn-ref') && t.dataset && t.dataset.vkey) {
        e.preventDefault(); e.stopPropagation();
        ensureOpen();
        navPush({ type: 'footnote', verseKey: t.dataset.vkey, num: t.dataset.fn });
        return;
      }
      /* xref-ref（串珠号）—— 同理，优先于 scripture-ref */
      if (t.classList && t.classList.contains('xref-ref') && t.dataset && t.dataset.vkey) {
        e.preventDefault(); e.stopPropagation();
        ensureOpen();
        navPush({ type: 'xrefs', verseKey: t.dataset.vkey, letter: t.dataset.xr });
        return;
      }
      /* .scripture-ref[data-refs] → 打开弹框，或若已在弹框内则 navPush 导航 */
      if (t.classList && t.classList.contains('scripture-ref') && t.dataset && t.dataset.refs) {
        e.preventDefault(); e.stopPropagation();
        var overlay = document.getElementById('scripture-popup-overlay');
        var insidePopup = overlay && overlay.contains(t);
        if (insidePopup) {
          navPush({ type: 'verses', refs: t.dataset.refs, label: t.textContent.trim() });
        } else {
          openModal(t.dataset.refs, t.textContent.replace(/^[—─\*\s]+/,'').trim());
        }
        return;
      }
      /* verse-ref（注解内经文引用）*/
      if (t.classList && t.classList.contains('verse-ref') && t.dataset && t.dataset.refs) {
        e.preventDefault(); e.stopPropagation();
        navPush({ type: 'verses', refs: t.dataset.refs, label: t.textContent });
        return;
      }
      t = t.parentNode;
    }
  });

  /* ═══════════════════════════ 自动标注正文 ═══════════════════════════ */
  function annotateInlineRefs() {
    var paras = document.querySelectorAll('.content-text, .bk-paragraph');
    paras.forEach(function (p) {
      // 获取所有文本节点（跳过已有 span 内部的文本）
      var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
      var textNodes = [];
      var node;
      while (node = walker.nextNode()) {
        // 跳过已在 scripture-ref / verse-ref / fn-ref / xref-ref span 内的文本
        var parent = node.parentElement;
        if (parent && parent.closest && parent.closest('.scripture-ref, .verse-ref, .fn-ref, .xref-ref, .bk-highlight')) continue;
        if (node.textContent.length > 0) textNodes.push(node);
      }

      textNodes.forEach(function (tn) {
        var text = tn.textContent;
        INLINE_REF_RE.lastIndex = 0;
        if (!INLINE_REF_RE.test(text)) return;
        INLINE_REF_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        var m;
        while ((m = INLINE_REF_RE.exec(text)) !== null) {
          if (m.index > lastIdx) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
          }
          var span = document.createElement('span');
          span.className = 'scripture-ref scripture-ref--inline';
          span.setAttribute('data-refs', m[1] || m[0]);
          span.textContent = m[0];
          frag.appendChild(span);
          lastIdx = INLINE_REF_RE.lastIndex;
        }
        if (lastIdx < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        tn.parentNode.replaceChild(frag, tn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', annotateInlineRefs);
  } else {
    annotateInlineRefs();
  }

  /* ═══════════════════════════ 自动渲染 scripture-block ═══════════════════════════ */
  /* .scripture-block[data-refs] 行内经文块（晨兴喂养等），带注脚和串珠上标 */
  function renderScriptureBlocks() {
    var blocks = document.querySelectorAll('.scripture-block[data-refs]');
    if (!blocks.length) return;
    ensureBibleText(function () {
      blocks.forEach(function (block) {
        if (block.hasAttribute('data-rendered')) return;
        block.setAttribute('data-rendered', '1');
        var refs = (block.dataset.refs || '').trim();
        if (!refs) return;
        block.innerHTML = renderVerseList(refs);
      });
      // 经文块渲染完成后，通知 highlight.js 重新计算字符偏移并恢复划线
      if (window.BKHighlight && window.BKHighlight.redoHighlights) {
        window.BKHighlight.redoHighlights();
      }
      // 经文块撑开内容后，通知翻页布局重新计算容器高度（避免 overflow:hidden 截断最后段落）
      document.dispatchEvent(new CustomEvent('cx:scriptureBlocksRendered'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderScriptureBlocks);
  } else {
    renderScriptureBlocks();
  }

  /* ═══════════════════════════ 静态经文块（锚文本对齐注入注解/串珠）═══════════════ */
  /* .scripture-block-static[data-refs]：保留文档原文，从 bible-text.json 找到
   * {N}/[a] 在 JSON 经文中的位置：
   *   - 标记前有文字 → 取末尾 8 字作 lookback，在文档原文中搜索，插在其后
   *   - 标记前无文字 → 取标记后 8 字作 lookahead，在文档原文中搜索，插在其前
   * 找不到对应文字 → 跳过（文档经文不全）。 */
  function renderScriptureStaticBlocks() {
    var blocks = document.querySelectorAll('.scripture-block-static[data-refs]');
    if (!blocks.length) return;
    ensureBibleText(function () {
      blocks.forEach(function (block) {
        if (block.hasAttribute('data-rendered')) return;
        block.setAttribute('data-rendered', '1');
        var refs = (block.dataset.refs || '').trim();
        if (!refs) return;
        var dict = window.BK_SCRIPTURES_DATA || {};
        var docText = block.textContent;
        var ctxBook = getBookFromRef((refs.split(',')[0] || '').trim());
        var refArr = parseAndExpandRefs(refs, dict, ctxBook);

        /* 从所有 ref 的 JSON 文本里，按出现顺序收集注入点 */
        var injections = [];
        refArr.forEach(function (ref) {
          var nr = normalizeRef(ref) || ref;
          var bk = baseKey(nr);
          var raw = dict[nr] || (bk !== nr ? dict[bk] : '');
          if (!raw) return;
          var MRE = /\{(\d+)\}|\[([a-z]+)\]/g, lastEnd = 0, mm;
          while ((mm = MRE.exec(raw)) !== null) {
          /* 剥除 {N}/[a] 标记后再提取锚定文字，避免相邻标记干扰 */
          var STRIP_MARKS = /\{\d+\}|\[[a-z]+\]/g;
          var prefix = raw.slice(lastEnd, mm.index).replace(STRIP_MARKS, '');
          var lookback  = prefix.replace(/[\s\u3000\u00a0]/g, '').slice(-8);
          var suffix    = raw.slice(mm.index + mm[0].length).replace(STRIP_MARKS, '');
            var lookahead = suffix.replace(/[\s\u3000\u00a0]/g, '').slice(0, 8);
            var mhtml = mm[1]
              ? '<sup class="fn-ref" data-vkey="' + esc(nr) + '" data-fn="' + mm[1] + '">' + mm[1] + '</sup>'
              : '<sup class="xref-ref" data-vkey="' + esc(nr) + '" data-xr="' + mm[2] + '">' + mm[2] + '</sup>';
            injections.push({ lookback: lookback, lookahead: lookahead, html: mhtml });
            lastEnd = mm.index + mm[0].length;
          }
        });

        if (!injections.length) { block.innerHTML = esc(docText); return; }

        /* 依次在 docText 中定位每个注入点 */
        var parts = [];
        var searchFrom = 0;

        injections.forEach(function (inj) {
          var insertPos = -1;

          if (inj.lookback) {
            /* 优先用 lookback：在 lookback 文字之后插入 */
            var idx = docText.indexOf(inj.lookback, searchFrom);
            if (idx !== -1) {
              insertPos = idx + inj.lookback.length;
            } else if (inj.lookback.length > 3) {
              idx = docText.indexOf(inj.lookback.slice(-4), searchFrom);
              if (idx !== -1) insertPos = idx + inj.lookback.slice(-4).length;
            }
          }

          if (insertPos === -1 && inj.lookahead) {
            /* lookback 找不到（或为空）→ 用 lookahead：在 lookahead 文字之前插入 */
            /* 依次尝试 8‑字符、4‑字符、2‑字符，处理文档省略号截断的情形 */
            var laFull = inj.lookahead;
            var laTrys = [laFull, laFull.slice(0, 4), laFull.slice(0, 2)];
            for (var _li = 0; _li < laTrys.length; _li++) {
              if (!laTrys[_li]) continue;
              var idx2 = docText.indexOf(laTrys[_li], searchFrom);
              if (idx2 !== -1) { insertPos = idx2; break; }
            }
          }

          if (insertPos !== -1) {
            parts.push({ pos: insertPos, html: inj.html });
            searchFrom = insertPos;
          }
          /* 两者都找不到 → 文档经文不全，跳过 */
        });

        /* 按位置升序排列，拼接最终 HTML */
        parts.sort(function (a, b) { return a.pos - b.pos; });
        var out = '', lastPos = 0;
        parts.forEach(function (part) {
          out += esc(docText.slice(lastPos, part.pos)) + part.html;
          lastPos = part.pos;
        });
        out += esc(docText.slice(lastPos));
        block.innerHTML = out;
      });
      if (window.BKHighlight && window.BKHighlight.redoHighlights) {
        window.BKHighlight.redoHighlights();
      }
      document.dispatchEvent(new CustomEvent('cx:scriptureBlocksRendered'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderScriptureStaticBlocks);
  } else {
    renderScriptureStaticBlocks();
  }

  /* ── 暴露给外部（可选）── */
  /* init()：由 renderer.js 的 setContent 在每次 SPA 切换后调用，
   * 重新对动态插入的经文块执行注解/串珠注入和行内引用标注。 */
  function init() {
    annotateInlineRefs();
    renderScriptureBlocks();
    renderScriptureStaticBlocks();
  }
  window.BKScripturePopup = { open: openModal, close: closeModal, init: init };

  /* ── 空闲预加载：页面加载后利用空闲时间提前解析三个大文件 ──
   * 文件已在 PWA/APK 缓存中，无网络开销；
   * 提前解析后用户首次点击经文时无需等待。
   * 按优先级依次加载：bible-text → bible-notes → bible-xrefs
   */
  function idleLoad(fn) {
    if (window.requestIdleCallback) {
      requestIdleCallback(fn, { timeout: 4000 });
    } else {
      setTimeout(fn, 3000);
    }
  }

  function schedulePreload() {
    idleLoad(function () {
      ensureBibleText(function () {
        idleLoad(function () {
          ensureBibleNotes(function () {
            idleLoad(function () {
              ensureBibleXrefs(function () {});
            });
          });
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedulePreload);
  } else {
    schedulePreload();
  }
})();
