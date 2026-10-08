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
