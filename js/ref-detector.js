/*!
 * ref-detector.js — 中文经文引用检测与包裹
 * 将 section.title / paragraph 中的经文引用括号、破折号引用
 * 包裹为 <span class="scripture-ref" data-refs="...">
 *
 * 对应 Python: HTMLGenerator._wrap_scripture_ref + ImprovedParser._expand_cn_scripture_refs
 *
 * 注意：JSON 中已由 Python 预计算 ctx_scripture（每节初始上下文）、
 * feeding_refs（喂养经文 data-refs）、morning_feeding_contexts 等，
 * 本模块只需做文字渲染层的包裹。
 *
 * 暴露: window.BKRef
 *   .wrapRefs(text, ctxStr)  → HTML string
 *   .escHtml(text)           → escaped string
 */
(function (win) {
  'use strict';

  // ── 书卷名映射（完整名 / 别名 → 缩写） ────────────────────────────────
  var FULL_BOOK_MAP = {
    '创世记':'创','出埃及记':'出','利未记':'利','民数记':'民','申命记':'申',
    '约书亚记':'书','士师记':'士','路得记':'得',
    '撒母耳记上':'撒上','撒母耳记下':'撒下',
    '列王纪上':'王上','列王纪下':'王下',
    '历代志上':'代上','历代志下':'代下',
    '以斯拉记':'拉','尼希米记':'尼','以斯帖记':'斯',
    '约伯记':'伯','诗篇':'诗','箴言':'箴','传道书':'传','雅歌':'歌',
    '以赛亚书':'赛','耶利米书':'耶','耶利米哀歌':'哀',
    '以西结书':'结','但以理书':'但',
    '何西阿书':'何','约珥书':'珥','阿摩司书':'摩','俄巴底亚书':'俄',
    '约拿书':'拿','弥迦书':'弥','那鸿书':'鸿','哈巴谷书':'哈',
    '西番雅书':'番','哈该书':'该','撒迦利亚书':'亚','玛拉基书':'玛',
    '马太福音':'太','马可福音':'可','路加福音':'路','约翰福音':'约',
    '马太':'太','马可':'可','路加':'路','约翰':'约',
    '行传':'徒','哀歌':'哀','雅各':'雅',
    '使徒行传':'徒','罗马书':'罗','罗马':'罗',
    '哥林多前书':'林前','哥林多后书':'林后',
    '加拉太书':'加','以弗所书':'弗','腓立比书':'腓','歌罗西书':'西',
    '帖撒罗尼迦前书':'帖前','帖撒罗尼迦后书':'帖后',
    '提摩太前书':'提前','提摩太后书':'提后',
    '腓利门书':'门','希伯来书':'来','雅各书':'雅',
    '彼得前书':'彼前','彼得后书':'彼后',
    '约翰壹书':'约壹','约翰贰书':'约贰','约翰叁书':'约叁',
    '约翰一书':'约壹','约翰二书':'约贰','约翰三书':'约叁',
    '犹大书':'犹','启示录':'启','提多书':'多',
    // 省略「书/记/传」字的3字简称
    '但以理':'但','以西结':'结','以赛亚':'赛','耶利米':'耶','出埃及':'出',
    '何西阿':'何','阿摩司':'摩','俄巴底亚':'俄',
    '约拿':'拿','弥迦':'弥','那鸿':'鸿','哈巴谷':'哈',
    '西番雅':'番','哈该':'该','撒迦利亚':'亚','玛拉基':'玛',
    '腓立比':'腓','以弗所':'弗','歌罗西':'西','加拉太':'加'
  };

  // 中文数字 → 整数
  function cnToInt(s) {
    if (!s) return 0;
    var UNITS = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    if (s === '十') return 10;
    if (s.indexOf('百') !== -1) {
      var bi = s.indexOf('百');
      var h = (UNITS[s[bi-1]] || 1) * 100;
      return h + (bi+1 < s.length ? cnToInt(s.slice(bi+1)) : 0);
    }
    if (s.indexOf('十') !== -1) {
      var ti = s.indexOf('十');
      var tens = (ti > 0 ? (UNITS[s[ti-1]] || 1) : 1) * 10;
      return tens + (ti+1 < s.length ? (UNITS[s[ti+1]] || 0) : 0);
    }
    // 缩写两字：三八=38
    if (s.length === 2 && UNITS[s[0]] && UNITS[s[1]]) {
      return UNITS[s[0]] * 10 + UNITS[s[1]];
    }
    // 缩写三字：一一九=119
    if (s.length === 3) {
      var ZERO = {'○':0, '零':0, '〇':0};
      var h3 = UNITS[s[0]], t3 = ZERO.hasOwnProperty(s[1])?0:UNITS[s[1]],
          u3 = ZERO.hasOwnProperty(s[2])?0:UNITS[s[2]];
      if (h3 !== undefined && t3 !== undefined && u3 !== undefined) {
        return h3*100 + t3*10 + u3;
      }
    }
    return UNITS[s] || 0;
  }

  // 整数 → 中文数字（1-150）
  function intToCn(n) {
    if (n <= 0 || n > 150) return String(n);
    var UNITS = ['','一','二','三','四','五','六','七','八','九'];
    if (n <= 10) return UNITS[n];
    if (n < 20) return '十' + (n > 10 ? UNITS[n - 10] : '');
    if (n < 100) {
      var tens = Math.floor(n / 10);
      var ones = n % 10;
      return UNITS[tens] + '十' + (ones ? UNITS[ones] : '');
    }
    if (n === 100) return '一百';
    var h = Math.floor(n / 100);
    var rest = n % 100;
    var result = UNITS[h] + '百';
    if (rest === 0) return result;
    if (rest < 10) return result + '零' + UNITS[rest];
    var t = Math.floor(rest / 10);
    var o = rest % 10;
    if (t === 0) return result + '零' + UNITS[o];
    return result + (t === 1 ? '一' : UNITS[t]) + '十' + (o ? UNITS[o] : '');
  }

  // 将文本中完整书名替换为缩写（从长到短）
  var _sortedFullNames = Object.keys(FULL_BOOK_MAP).sort(function(a,b){return b.length-a.length;});

  // 行内章节式引用匹配（嵌在句子中、不在括号/破折号内）
  // 例：马可十一章二十三至二十四节、诗篇一百一十九篇、二十五章十四至三十节、三十七节
  var _INLINE_F5_RE = (function () {
    var CN = '[一二三四五六七八九十百〇○]+';
    var abbr = '[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启](?:前|后|上|下|壹|贰|叁)?';
    var bookPat = '(?:(?:' + _sortedFullNames.join('|') + '|' + abbr + '))?';
    var bookReq = '(?:' + _sortedFullNames.join('|') + '|' + abbr + ')';
    // versePart: 支持「的第?」连接词前缀、v1节([至到]v2节)? 及 v1([至到]v2)?节 两种格式
    var versePart = '(?:(?:的第?)?' + CN + '节(?:[至到]' + CN + '节)?(?:[上下]半?)?|(?:的第?)?' + CN + '(?:[至到]' + CN + ')?节(?:[上下]半?)?)?';
    // 「篇」是诗篇专属，须有显式「诗」/「诗篇」前缀；其他书卷用「章」
    // 快捷章节格式（bookReq+CN，无「章」字，如「弗四」「启二一」）：
    // 限制为不含「百」，因除诗篇外无书卷超过 66 章；诗篇已由「篇」分支覆盖
    var CN_NO_BAI = '[一二三四五六七八九十〇○]+';
    return new RegExp(
      '(?:(?:诗篇|诗)' + CN + '篇' + versePart
      + '|' + bookPat + '的?第?' + CN + '(?:(?:[至到]|、)' + CN + ')*章' + versePart
      + '|第?' + CN + '(?:节(?:[至到]' + CN + '节)?|(?:[至到]' + CN + ')?节)(?:[上下]半?)?'
      + '|(?:犹|门|俄|约贰|约叁)' + CN + '(?:节(?:[至到]' + CN + '节)?|(?:[至到]' + CN + ')?节)(?:[上下]半?)?'
      + '|' + bookReq + CN_NO_BAI + '\\d+[~～\\-]' + CN_NO_BAI + '\\d+'
      + '|' + bookReq + CN_NO_BAI + '(?!书)(?:[~～\\-]' + CN_NO_BAI + ')?(?:\\d+[上中下]?(?:[~～\\-]\\d+[上中下]?)?)?节?(?:[上下]半?)?'
      + '|' + bookReq + '(?:' + CN_NO_BAI + '|[1-9]\\d*)标题'      // 无书卷前缀的「中文章+阿拉伯节」相对引用（如「一4」「十四13」「二二17」）
      // 须放在所有 bookReq 分支之后，避免遮蔽带书卷的完整引用
      + '|' + CN_NO_BAI + '\\d+[上中下]?(?:[~～\\-]\\d+[上中下]?)?'      // 跨章混合格式：阿拉伯节1 + 范围符 + CN章2 + 阿拉伯节2（如「1～十一13」）
      + '|\\d+[上中下]?[~～\\-]' + CN_NO_BAI + '\\d+[上中下]?'      // 纯阿拉伯节号列表：「15、17节」「23、24节」等
        + '|\\d+[上中下]?[~～\\-]\\d+[上中下]?节'      // 纯阿拉伯节范围：「7~22节」「11下~13节」等
      + '|\\d+(?:[、，,]\\d+)*节'      + ')'
      , 'g');
  }());
  function normalizeBookNames(text) {
    for (var i = 0; i < _sortedFullNames.length; i++) {
      var full = _sortedFullNames[i];
      if (text.indexOf(full) !== -1) {
        text = text.split(full).join(FULL_BOOK_MAP[full]);
      }
    }
    return text;
  }

  // 从 ctx 字符串（如"弗4:17"或"腓四13"）提取 {book, chapter}
  function parseCtx(ctxStr) {
    if (!ctxStr) return {book:'', chapter:0};
    var s = normalizeBookNames(ctxStr);
    // 标准格式 book+chapter:verse
    var m = s.match(/^([^\d:]{1,3})(\d+):(\d+)/);
    if (m) return {book: m[1], chapter: parseInt(m[2], 10)};
    // 中文格式 book+中文章
    var CN_CH = '[一二三四五六七八九十百]+';
    var m2 = s.match(/^([^\d:一二三四五六七八九十百]{1,3})([\u4e00-\u9fff]+)/);
    if (m2) {
      var ch = cnToInt(m2[2]);
      if (ch) return {book: m2[1], chapter: ch};
    }
    return {book: s, chapter: 0};
  }

  // HTML 转义
  function escHtml(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── 核心：展开单个中文经文引用字符串 → ref 数组 ────────────────────
  // ref_text 例：「腓四5~9,11下~13」「一19~21上」「13」「三章十九节」
  function expandCnRefs(refText, defBook, defCh) {
    refText = normalizeBookNames((refText||'').trim());
    // 全角冒号→半角；去掉尾部标点（：。，；、)）等）
    refText = refText.replace(/：/g, ':').replace(/[\s。，；：:,;)）」』】〗\]]+$/g, '').trim();
    var book = defBook || '', ch = defCh || 0;
    var refs = [];

    // 两字后缀书卷（林前/林后/撒上/撒下 等）
    var TWO_SUFFIX = '(?:前|后|上|下|壹|贰|叁)';
    var BOOK_PAT = '(?:[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启]' + TWO_SUFFIX + '?|[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启])';
    var CN_N = '[一二三四五六七八九十百〇○]+';
    // Format1: book + 中文章 + 阿拉伯节  e.g. 腓四5 / 腓四5~9 / 腓四5上~9
    var F1 = new RegExp('^(' + BOOK_PAT + ')(' + CN_N + ')(\\d+)([上中下]?)(?:[~～\\-](\\d+)([上中下]?))?$');
    // Format2: 中文章 + 阿拉伯节 (relative)  e.g. 四5 / 四5~9上
    var F2 = new RegExp('^(' + CN_N + ')(\\d+)([上中下]?)(?:[~～\\-](\\d+)([上中下]?))?$');
    // Format3: 纯阿拉伯节（续） e.g. 13 / 13上 / 11下~13 / 24节 / 23~24节 / 17节上 / 17节上半
    var F3 = /^(\d+)([上中下]?)节?([上中下]半?)?(?:[~～\-](\d+)([上中下]?)节?([上中下]半?)?)?$/;
    // Format4: 阿拉伯章:节  e.g. 约壹1:1 / 腓4:13~15
    var F4 = new RegExp('^(' + BOOK_PAT + '?)(\\d+):(\\d+)([上中下]?)(?:[~～\\-](\\d+)([上中下]?))?$');
    // Format1x: book + CN章1 + 阿拉伯节1 + 范围符 + CN章2 + 阿拉伯节2 (跨章范围) e.g. 伯二11~三二1
    // 书卷可省略（?），省略时回退到上下文 book
    var F1x = new RegExp('^(' + BOOK_PAT + ')?(' + CN_N + ')(\\d+)[~～\\-](' + CN_N + ')(\\d+)$');
    // Format5: 中文「章节式」 e.g. 三章十九节 / 三章十九至二十一节 / 约伯记第一章 / 三章十七节上半
    // 「篇」仅匹配诗篇（书卷缩写 诗），其他书卷用「章」；支持「第」做章号前缀
    // 支持「章」与节号之间的「的」连接词，如「一章的一到四节」
    // 支持书卷与章号之间的「的」，如「启示录的二十二章」→「启的二十二章」（normalizeBookNames后）
    // 支持章范围，如「五到七章」→ 整章5-7
    var F5 = new RegExp('^(' + BOOK_PAT + ')?的?第?(' + CN_N + ')(?:[至到](' + CN_N + '))?([章篇])(?:(?:的第?)?(' + CN_N + ')(?:[至到](' + CN_N + '))?节([上下]半?)?)?');
    // Format6: 单章书卷 + 阿拉伯节  e.g. 犹20 / 门10~12 / 俄5
    var SINGLE_BOOK = '(?:犹|门|俄|约贰|约叁)';
    var F6 = new RegExp('^(' + SINGLE_BOOK + ')(\\d+)([上中下]?)(?:[~～\\-](\\d+)([上中下]?))?$');
    // Format10: 单章书卷 + 中文节号  e.g. 犹二十节 / 门十至十二节 / 俄五节
    var F10 = new RegExp('^(' + SINGLE_BOOK + ')(' + CN_N + ')节?([上下]半?)?(?:[至到](' + CN_N + ')节([上下]半?)?)?$');
    // Format7: 纯中文节号（续）e.g. 三十七节 / 三十六至三十七节 / 第三十七节
    var F7 = new RegExp('^第?(' + CN_N + ')节?([上中下]半?)?(?:[至到~～](' + CN_N + ')节([上中下]半?)?)?$');
    // Format9: book + CN章/阿拉伯章 + 「标题」  e.g. 诗二二标题 / 诗22标题
    var F9 = new RegExp('^(' + BOOK_PAT + ')(?:(' + CN_N + ')|([1-9]\\d*))标题$');
    // Format8: book + CN_chapter（整章速记，无节号、无"章"字）e.g. 但二 / 弗四 / 腓四～五
    // 书卷可省略（?），省略时回退到上下文 book（如「十二~十六」在罗马书上下文中）
    var F8 = new RegExp('^(' + BOOK_PAT + ')?(' + CN_N + ')(?:[~～\\-](' + CN_N + '))?$');
    // Format12: 阿拉伯节1 + 范围符 + CN章2 + 阿拉伯节2（跨章，依赖上下文 book+ch）
    // e.g. 「1～十一13」在启10:1上下文中 → 启10:1, 启11:13
    var F12 = new RegExp('^(\\d+)([上中下]?)[~～\\-](' + CN_N + ')(\\d+)([上中下]?)$');

    function emitRange(b, c, v1, m1, v2, m2) {
      v2 = v2 || v1; m2 = m2 || (v2===v1 ? m1 : '');
      for (var v = v1; v <= v2; v++) {
        var mod = v===v1 ? m1 : (v===v2 ? m2 : '');
        refs.push(b + c + ':' + v + (mod||''));
      }
    }

    // 顿号连接多章（「二、三章」「启二、三章」「一、二、三章」）→ 取首末构成范围（「二至三章」「启二至三章」「一至三章」）
    // 必须在 split 之前预处理，否则 split(/、/) 会把「二」和「三章」分开
    refText = refText.replace(
      /([一二三四五六七八九十百〇○]+)((?:、[一二三四五六七八九十百〇○]+)+)([章篇])/g,
      function(_, first, rest, zhang) {
        var last = rest.replace(/^.*[、]/, '');
        return first + '至' + last + zhang;
      }
    );
    // 顿号连接多节（「三十五、三十六节」）→ 每份都带「节」（「三十五节、三十六节」）
    // 必须在 split 之前预处理，否则 split(/、/) 会把「三十五」单独留下导致误识为整章
    refText = refText.replace(
      /([一二三四五六七八九十百〇○]+)((?:、[一二三四五六七八九十百〇○]+)+)(节)/g,
      function(_, first, rest, jie) {
        var rparts = rest.split('、').filter(Boolean);
        return first + jie + '、' + rparts.join(jie + '、') + jie;
      }
    );
    var parts = refText.split(/[,，、；。]+/);
    // 诗歌/赞美诗「N首」上下文：含「N首」的括号内容是诗歌引用，第N节指诗歌节次，不是经文节号
    var _hymnCtx = /[一二三四五六七八九十百\d]+首/.test(refText);
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi].trim().replace(/^[见参][看阅]?\s*/, '').replace(/^[—─]+\s*/, '').replace(/[：:。，；,;)）」』】〗\]]+$/g, '');
      // 预处理：若 part 不以合法经文引用字符开头，且含破折号，则取破折号后部分
      // 处理「表征神的荣耀—结一4」→「结一4」类型的括号内嵌入式引用
      if (p && !/^[一二三四五六七八九十百\d]/.test(p) &&
          !/^[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启]/.test(p)) {
        var _di = p.lastIndexOf('—');
        if (_di < 0) _di = p.lastIndexOf('\u2014');
        if (_di >= 0) p = p.slice(_di + 1).trim().replace(/[：:。，；,;)）」』】〗\]]+$/g, '');
      }
      if (!p) continue;
      // 含「注N」尾缀（如「但一8注1」「诗一一九15与注1」「来十19~20与20注2」）：剥离尾缀后继续展开经文
      // 注意：不再 return []，避免破折号/括号引用因含 注N 而整体失效
      if (/(?:与?注\d+|与\d+注\d+)$/.test(p)) {
        p = p.replace(/(?:与?注\d+|与\d+注\d+)$/, '').trim();
        if (!p) continue;
      }
      // 标准化「v1节至/到v2节」→「v1至v2节」，以便 F5/F7 等格式正确解析
      p = p.replace(/([一二三四五六七八九十百]+)节([至到])([一二三四五六七八九十百]+)节/g, '$1$2$3节');
      // 列表序号保护：单字中文数字（一～九）无「节」字无「第」前缀 → 通常是列表标记(一)(二)(三)，非节号
      if (/^[一二三四五六七八九]([上中下]半?)?$/.test(p)) continue;
      var m;
      // F4: arabic chapter:verse
      if ((m = F4.exec(p))) {
        var b4 = m[1] || book; if (!b4) continue;
        book = b4; ch = parseInt(m[2],10);
        emitRange(book, ch, parseInt(m[3],10), m[4]||'', m[5]?parseInt(m[5],10):0, m[6]||'');
        continue;
      }
      // F6: 单章书卷 + 阿拉伯节  (犹/门/俄/约贰/约叁)
      if ((m = F6.exec(p))) {
        book = m[1]; ch = 1;
        emitRange(book, ch, parseInt(m[2],10), m[3]||'', m[4]?parseInt(m[4],10):0, m[5]||'');
        continue;
      }
      // F10: 单章书卷 + 中文节号  e.g. 犹二十节 / 门十至十二节
      if ((m = F10.exec(p))) {
        book = m[1]; ch = 1;
        var v1_10 = cnToInt(m[2]), v2_10 = m[4] ? cnToInt(m[4]) : v1_10;
        var mod1_10 = m[3] ? m[3][0] : '', mod2_10 = m[5] ? m[5][0] : '';
        if (v1_10) emitRange(book, ch, v1_10, mod1_10, v2_10, mod2_10);
        continue;
      }
      // F5: 章节式（含章范围、书卷+的+章）
      if ((m = F5.exec(p))) {
        var b5 = m[1] ? normalizeBookNames(m[1]) : book; if (!b5) continue;
        // 「篇」仅适用于诗篇
        if (m[4] === '篇' && b5 !== '诗') continue;
        var c5 = cnToInt(m[2]); if (!c5 || c5 > 150) continue;
        var c5end = m[3] ? cnToInt(m[3]) : c5;
        if (!c5end || c5end < c5 || c5end > 150) c5end = c5;
        book = b5; ch = c5end;
        if (m[5]) {
          var v1_5 = cnToInt(m[5]), v2_5 = m[6] ? cnToInt(m[6]) : v1_5;
          var mod5 = m[7] ? m[7][0] : '';  // 取首字上/下
          if (v1_5) emitRange(book, c5, v1_5, mod5, v2_5, '');
        } else {
          for (var ci5 = c5; ci5 <= c5end; ci5++) refs.push(book + ci5 + ':0');
        }
        continue;
      }
      // F1x: book + cn_chapter1 + arabic_verse1 ~ cn_chapter2 + arabic_verse2 (跨章范围)
      // 书卷可省略，省略时回退到上下文 book
      if ((m = F1x.exec(p))) {
        var bx = m[1] || book; var c1x = cnToInt(m[2]); var v1x = parseInt(m[3], 10);
        var c2x = cnToInt(m[4]); var v2x = parseInt(m[5], 10);
        if (!bx || !c1x || !c2x || c1x > 150 || c2x > 150) continue;
        book = bx; ch = c2x;
        refs.push(book + c1x + ':' + v1x + '-' + c2x + ':' + v2x);
        continue;
      }
      // F1: book + cn_chapter + arabic_verse
      if ((m = F1.exec(p))) {
        book = m[1]; ch = cnToInt(m[2]); if (!ch || ch > 150) continue;
        emitRange(book, ch, parseInt(m[3],10), m[4]||'', m[5]?parseInt(m[5],10):0, m[6]||'');
        continue;
      }
      // F2: cn_chapter + arabic_verse (relative)
      if (book && (m = F2.exec(p))) {
        var c2 = cnToInt(m[1]); if (!c2 || c2 > 150) continue;
        ch = c2;
        emitRange(book, ch, parseInt(m[2],10), m[3]||'', m[4]?parseInt(m[4],10):0, m[5]||'');
        continue;
      }
      // F3: pure arabic verse (continuation)
      if (book && ch && (m = F3.exec(p))) {
        // m[2]: 上下在节前  m[3]: 上下/上半/下半在节后; 取首字统一为修饰副
        var mod1f = (m[2] || (m[3] ? m[3][0] : ''));
        var v1f = parseInt(m[1],10), v2f = m[4] ? parseInt(m[4],10) : v1f;
        var mod2f = (m[5] || (m[6] ? m[6][0] : ''));
        emitRange(book, ch, v1f, mod1f, v2f, mod2f);
        continue;
      }
      // Fvc: 纯阿拉伯节 ~ 中文章+阿拉伯节（跨章范围）e.g. 12~八13 / 1~四15
      // 表示：当前章第v1节 到 第c2章第v2节
      var F_vc = book && ch ? new RegExp('^(\\d+)[~～\\-](' + CN_N + ')(\\d+)$') : null;
      if (F_vc && (m = F_vc.exec(p))) {
        var v1vc = parseInt(m[1], 10); var c2vc = cnToInt(m[2]); var v2vc = parseInt(m[3], 10);
        if (v1vc && c2vc && c2vc <= 150) {
          refs.push(book + ch + ':' + v1vc + '-' + c2vc + ':' + v2vc);
          ch = c2vc;
          continue;
        }
      }
      // F7: 纯中文节号续（同书卷+同章）e.g. 三十七节 / 三十六至三十七节
      // 须有显式「节」字：裸中文数字（如「十六」）优先由 F8 解析为整章，而非误作节号
      if (!_hymnCtx && book && ch && /节/.test(p) && (m = F7.exec(p))) {
        var v1_7 = cnToInt(m[1]), v2_7 = m[3] ? cnToInt(m[3]) : v1_7;
        var mod1_7 = m[2] ? m[2][0] : '', mod2_7 = m[4] ? m[4][0] : '';
        // 节号>176（诗119:176 为圣经最大节数）→ 可能是页码等非经文编号，跳过
        if (v1_7 && v1_7 <= 176 && v2_7 <= 176) emitRange(book, ch, v1_7, mod1_7, v2_7, mod2_7);
        continue;
      }
      // F9: book + chapter + 「标题」 e.g. 诗二二标题 → 诗22:0T（T=title-only，区别于整章 :0）
      if ((m = F9.exec(p))) {
        var b9 = normalizeBookNames(m[1]);
        var c9 = m[2] ? cnToInt(m[2]) : parseInt(m[3], 10);
        if (!b9 || !c9 || c9 > 150) continue;
        book = b9; ch = c9;
        refs.push(book + ch + ':0T');
        continue;
      }
      // F8: book + CN_chapter（整章速记）e.g. 但二 → 但2:0 / 腓四～五 → 腓4:0,腓5:0
      // 书卷可省略，省略时回退到上下文 book（如「十二~十六」在罗马书上下文中）
      if ((m = F8.exec(p))) {
        var b8 = normalizeBookNames(m[1] || '') || book; var c8 = cnToInt(m[2]);
        if (!b8 || !c8 || c8 > 150) continue;
        book = b8; ch = c8;
        if (m[3]) {
          var c8end = cnToInt(m[3]);
          if (c8end && c8end >= c8 && c8end <= 150) {
            for (var ci8 = c8; ci8 <= c8end; ci8++) refs.push(book + ci8 + ':0');
            ch = c8end;
          } else { refs.push(book + ch + ':0'); }
        } else {
          refs.push(book + ch + ':0');
        }
        continue;
      }
      // F12: 阿拉伯节1 + 范围符 + CN章2 + 阿拉伯节2（跨章范围，依赖 book+ch 上下文）
      // e.g. 「1～十一13」在启10上下文 → [启10:1, 启11:13]
      if (book && ch && (m = F12.exec(p))) {
        var v1_12 = parseInt(m[1], 10), c2_12 = cnToInt(m[3]), v2_12 = parseInt(m[4], 10);
        if (v1_12 >= 1 && c2_12 >= 1 && c2_12 <= 150 && v2_12 >= 1 && v2_12 <= 176) {
          refs.push(book + ch + ':' + v1_12 + '-' + c2_12 + ':' + v2_12);
          ch = c2_12;
        }
        continue;
      }
      // F11: 纯阿拉伯节号（续接引用），仅在 book+ch 上下文已确立时生效
      // 例：「(约一1，4，十一25，十四6)」中 "4" = 约1:4（在 F1 处理「约一1」后 book=约 ch=1）
      // 适用于中文注解括号内「，N」形式的中间节号省略写法
      if (book && ch && (m = /^(\d{1,3})([上中下]半?)?$/.exec(p))) {
        var v11 = parseInt(m[1], 10);
        if (v11 >= 1 && v11 <= 176) emitRange(book, ch, v11, m[2]||'', 0, '');
        continue;
      }
    }
    return refs;
  }

  // ── 包裹单个括号/破折号引用为 <span> ───────────────────────────────────
  function makeSpan(rawText, refs) {
    var dataRefs = refs.join(',');
    return '<span class="scripture-ref" data-refs="' + escHtml(dataRefs) + '">' + escHtml(rawText) + '</span>';
  }

  // ── 主函数：将文本中的经文引用包裹为 <span> ────────────────────────────
  // ctxStr: 初始上下文字符串，如"弗4:17"（来自 section.ctx_scripture）
  // 处理：括号引用（弗四23）、破折号末尾引用 —腓四5
  function wrapRefs(text, ctxStr, opts) {
    if (!text) return '';
    var ctx = parseCtx(ctxStr);
    var book = ctx.book, ch = ctx.chapter;
    var _lockBook = !!(opts && opts.lockBook);
    var _origBook = book, _origCh = ch;

    // 找末尾破折号引用位置（括号外的最后一个 —）
    // 要求破折号后紧接合法经文引用格式，避免 "—耶稣基督…" 中"耶"（耶利米缩写）被误识别：
    //   ① 中文章号 + 数字/中文/章/篇  (一1 / 三章 / 一~二)
    //   ② 书卷缩写 + 数字/中文章号    (弗四5 / 腓4:13)
    //   ③ 阿拉伯章:节               (4:13)
    // 不合法：书卷缩写后接非数字汉字（如"耶稣"→耶+稣，稣不是章节号）
    var DASH_REF_START = /^(?:[一二三四五六七八九十百][\d一二三四五六七八九十百章篇~～\-]|[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启](?:前|后|上|下|壹|贰|叁)?[\d一二三四五六七八九十百]|\d+:\d|\d+(?:[~～\-]\d+)?(?:[、,，]\d+(?:[~～\-]\d+)?)*节)/;
    var splitPos = -1;
    var depth = 0;
    for (var i = text.length - 1; i >= 0; i--) {
      var c = text[i];
      if (c === ')' || c === '）' || c === '〕') depth++;
      else if (c === '(' || c === '（' || c === '〔') depth--;
      else if ((c === '—' || c === '─') && depth === 0) {
        var after = text.slice(i+1).trim();
        // 若破折号后方文本含换行，说明该破折号是句中注释而非末尾引用，跳过
        // 若句号/分号等后仍有正文（如「—18节。ˍ因此...」），也不是尾注引用，跳过
        if (after.indexOf('\n') < 0
            && !/[。；;!?！？]\s*\S/.test(after)
            && DASH_REF_START.test(after)) {
          splitPos = i;
          break;
        }
      }
    }

    var mainText = splitPos >= 0 ? text.slice(0, splitPos) : text;
    var dashText = splitPos >= 0 ? text.slice(splitPos) : '';

    // 扫描括号引用
    var PAREN_RE = /[（(〔]([^）)〕\n]{1,100})[）)〕]/g;
    var result = [], last = 0, m;

    // 对纯文本段扫描行内章节式引用，同时处理《书名》上下文更新
    function pushPlain(seg) {
      var isCJK = /[\u4e00-\u9fff]/;
      // 收集行内经文引用匹配
      var allMatches = [];
      _INLINE_F5_RE.lastIndex = 0;
      var m2;
      while ((m2 = _INLINE_F5_RE.exec(seg)) !== null) {
        allMatches.push({ index: m2.index, text: m2[0] });
      }
      // 收集正文/书名中裸露书卷全名上下文更新点（后不接章节号，用于括号相对引用的上下文推断）
      // 例：「以赛亚书（七14，八8）」→ book=赛；「《雅歌结晶读经》」→ 找到「雅歌」→ book=歌
      for (var ki2 = 0; ki2 < _sortedFullNames.length; ki2++) {
        var _fn = _sortedFullNames[ki2];
        var _fi = seg.indexOf(_fn);
        while (_fi >= 0) {
          var _fe = _fi + _fn.length;
          var _nc = _fe < seg.length ? seg[_fe] : '';
          // 后不接章节号相关字符（否则 _INLINE_F5_RE 已捕获或会捕获）
          if (!/[一二三四五六七八九十百\d章篇]/.test(_nc)) {
            allMatches.push({ index: _fi, text: _fn, ctxBook: FULL_BOOK_MAP[_fn] });
          }
          _fi = seg.indexOf(_fn, _fe);
        }
      }
      // 按位置排序，去除重叠（同位置时较长匹配优先，防止短书名覆盖长内联引用）
      allMatches.sort(function (a, b) {
        if (a.index !== b.index) return a.index - b.index;
        return b.text.length - a.text.length; // 同位置：长者优先
      });
      var filtered = [], prevEnd = 0;
      for (var mi = 0; mi < allMatches.length; mi++) {
        if (allMatches[mi].index >= prevEnd) {
          filtered.push(allMatches[mi]);
          prevEnd = allMatches[mi].index + allMatches[mi].text.length;
        }
      }
      // 延伸：吸收紧随其后的「、N」「、N~M」续接节号（同书同章接续引用）
      // 例："弗三2、8~9" 中 _INLINE_F5_RE 只匹配"弗三2"，「、8~9」通过此步并入同一 span
      // 两个子模式：① 有范围符（N~M）—— 无需后置汉字限制；② 纯数字N —— 后不跟量词/日期词（防误吸"19日""10月"等）
      // 注："的""章""节"等不在排除列表，如"八2、6、10的生命"中"10"后跟"的"仍应被吸收
      var CONT_VERSE_RE = /^[、，](?:\d+[~～\-]\d+[上中下]?|\d+[上中下]?(?![个种们位只件份次些条样封月日年]))/;
      for (var ei = 0; ei < filtered.length; ei++) {
        var fmEi = filtered[ei];
        if (fmEi.ctxBook !== undefined) continue;
        fmEi.origEnd = fmEi.index + fmEi.text.length; // 保存延伸前的原始末位（Rules 1-4 nextChar 用）
        var posEi = fmEi.origEnd;
        var nextFmEi = ei + 1 < filtered.length ? filtered[ei + 1] : null;
        for (;;) {
          var contM = CONT_VERSE_RE.exec(seg.slice(posEi));
          if (!contM) break;
          var consumed = posEi + contM[0].length;
          if (nextFmEi && consumed > nextFmEi.index) break;
          fmEi.text = fmEi.text + contM[0];
          posEi = consumed;
        }
        // 延伸：吸收紧随其后的「注N」或「与注N」→ 标记为注脚引用（fn-ref）
        var _fnMatch = /^与?注(\d+)/.exec(seg.slice(posEi));
        if (_fnMatch && !(nextFmEi && posEi + _fnMatch[0].length > nextFmEi.index)) {
          fmEi.text = fmEi.text + _fnMatch[0];
          fmEi.fnNum = _fnMatch[1];
        }
      }
      var last2 = 0;
      for (var fi = 0; fi < filtered.length; fi++) {
        var fm = filtered[fi];
        result.push(escHtml(seg.slice(last2, fm.index)));
        last2 = fm.index + fm.text.length;
        // 《书名》：更新上下文，原文直接输出
        // 书卷未变时保留章号（如注解正文含"但以理"，ch 仍应是当前章，而非重置为 0）
        if (fm.ctxBook !== undefined) {
          if (!_lockBook) {
            if (fm.ctxBook !== book) ch = 0;
            book = fm.ctxBook;
          }
          result.push(escHtml(fm.text));
          continue;
        }
        // 注脚引用（「经文引用注N」格式）：直接发射 fn-ref span，跳过规则过滤
        // 例：「但一8注1」→ <span class="scripture-ref fn-ref" data-vkey="但1:8" data-fn="1">
        if (fm.fnNum) {
          var _fnText = fm.text.replace(/与?注\d+$/, '');
          var _fnRefs = expandCnRefs(_fnText, book, ch);
          if (_fnRefs.length === 1) {
            var _fnLm = _fnRefs[0].match(/^([^\d:]+)(\d+):(\d+)/);
            if (_fnLm && !_lockBook) { book = _fnLm[1]; ch = parseInt(_fnLm[2], 10); }
            result.push('<span class="scripture-ref fn-ref" data-vkey="' + escHtml(_fnRefs[0]) + '" data-fn="' + escHtml(fm.fnNum) + '">' + escHtml(fm.text) + '</span>');
          } else {
            result.push(escHtml(fm.text));
          }
          continue;
        }
        // 行内经文引用：应用规则 1-4 过滤
        // 短格式（书卷+中文章数，无章/篇/节字）时检查上下文以排除误识别
        // 规则1：前后均为汉字 → 嵌在词语中（如"圣徒一同"中的"徒一"），跳过
        // 规则2：后接量词 → 同样跳过（如"徒一个"）
        var isShortForm = !/[章篇节]/.test(fm.text);
        var prevCharI = fm.index > 0 ? seg[fm.index - 1] : '';
        if (isShortForm) {
          // 用原始末位（延伸前）计算 nextChar，避免续接节号延伸后误触 Rule1/2
          var _origEnd = fm.origEnd !== undefined ? fm.origEnd : fm.index + fm.text.length;
          var nextChar = _origEnd < seg.length ? seg[_origEnd] : '';
          // 含阿拉伯数字的短格式（如「一4」「十四13」）：阿拉伯数字在普通汉字词语中不会出现，
          // 因而 Rule1（前后均汉字→跳过）不适用；仅保留 Rule2 并扩充量词表
          var _hasDigit = /\d/.test(fm.text);
          if (!_hasDigit && isCJK.test(prevCharI) && isCJK.test(nextChar)) {
            result.push(escHtml(fm.text)); continue;
          }
          // Rule2：后接量词/时间词 → 跳过（含「封」防止「但七封」误识别，含「月日年」防止日期误识别）
          if (/[个种们位只件份次些条样封月日年]/.test(nextChar)) {
            result.push(escHtml(fm.text)); continue;
          }
        }
        // 规则3：含章/篇的引用，首字为单字书卷缩写且紧接中文数字，前一字又是汉字
        // → 该缩写实为复合词的一部分，非书卷名（如"全书二十二章"中"书"前有"全"）
        // 注意：若首字为中文数字（如"十一节"中的"十"），不应触发此规则，那是合法的相对节引用
        var _isBookAbbr = /^[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启]/.test(fm.text);
        if (!isShortForm && isCJK.test(prevCharI) && _isBookAbbr
            && /[一二三四五六七八九十百]/.test(fm.text[1] || '')) {
          result.push(escHtml(fm.text)); continue;
        }
        // 规则4：纯中文节引用（无书卷、无章号），前驱为自然语言修饰字 → 跳过
        // 对应 Python _no_pre = '(?<![哪那这有前后没无每外的此同某上下])'
        // 例：「这一节」「在这一节」「在此一节」「下一节」→ 不识别
        var _isPureVerse = !/[章篇]/.test(fm.text) && !_isBookAbbr;
        // '首'：诗歌N首后紧接的「第N节」是诗歌节次而非经文节号
        if (_isPureVerse && prevCharI && '哪那这有前后没无每外的此同某上下首'.indexOf(prevCharI) >= 0) {
          result.push(escHtml(fm.text)); continue;
        }
        var irefs = expandCnRefs(fm.text, book, ch);  // 传入当前 book/ch，支持无书卷名的相对章引用
        if (irefs.length > 0) {
          var ilm = irefs[irefs.length - 1].match(/^([^\d:]+)(\d+):(\d+)/);
          // ★ 正文中过滤掉整章引用（节号全为 :0 的引用），不包裹 span
          var allVerseZero = irefs.every(function(r) {
            var vm = r.match(/:(\d+)/);
            return vm && parseInt(vm[1], 10) === 0;
          });
          if (allVerseZero) {
            // 仍然更新 book/ch 上下文
            if (ilm && !_lockBook) {
              book = ilm[1];
              ch = parseInt(ilm[2], 10);
            }
            if (irefs.length === 1) {
              // 单个整章引用：不包裹
              result.push(escHtml(fm.text));
            } else {
              // ★ 多章范围：拆分为独立 span（如“创世记一至三章”→ 3个独立span）
              var _splitOk = false;
              try {
                var _bookLen = 0;
                for (var _si = 0; _si < _sortedFullNames.length; _si++) {
                  if (fm.text.indexOf(_sortedFullNames[_si]) === 0) { _bookLen = _sortedFullNames[_si].length; break; }
                }
                if (!_bookLen && /^[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启]/.test(fm.text)) _bookLen = 1;
                var _bookPfx = fm.text.slice(0, _bookLen);
                var _chText = fm.text.slice(_bookLen);
                // 提取「章/篇」前的章范围文本
                var _zm = _chText.match(/^(.+)[章篇]/);
                var _rangeText = _zm ? _zm[1] : _chText;
                var _rm = _rangeText.match(/^([一二三四五六七八九十百〇○]+)[至到~～\-]([一二三四五六七八九十百〇○]+)$/);
                if (_rm) {
                  var _cStart = cnToInt(_rm[1]), _cEnd = cnToInt(_rm[2]);
                  if (_cStart && _cEnd && _cEnd >= _cStart && (_cEnd - _cStart + 1) === irefs.length) {
                    for (var _ci = _cStart; _ci <= _cEnd; _ci++) {
                      var _cn = intToCn(_ci);
                      var _txt = (_ci === _cStart ? _bookPfx : '') + _cn + (_zm ? _zm[0].slice(-1) : '');
                      var _ref = irefs[_ci - _cStart];
                      result.push('<span class="scripture-ref" data-refs="' + escHtml(_ref) + '">' + escHtml(_txt) + '</span>');
                    }
                    _splitOk = true;
                  }
                }
              } catch (_e) { _splitOk = false; }
              if (!_splitOk) result.push(escHtml(fm.text));
            }
            continue;
          }
          if (ilm && !_lockBook) {
            book = ilm[1];
            // 整章引用（节号为0）与具体节引用均更新章号，
            // 使行内明确提及的章（如「以西结一章说，」）能传递给后续括号引用
            ch = parseInt(ilm[2], 10);
          }
          result.push(makeSpan(fm.text, irefs));
        } else {
          result.push(escHtml(fm.text));
        }
      }
      result.push(escHtml(seg.slice(last2)));
    }

    PAREN_RE.lastIndex = 0;
    while ((m = PAREN_RE.exec(mainText)) !== null) {
      // 括号前的文字：先扫描行内引用再转义
      pushPlain(mainText.slice(last, m.index));
      // 括号内「见18注2 / 见十八注2」：识别为注解链接（fn-ref）
      // 语义是「当前上下文书卷+章」的第18节注2
      var _inner = (m[1] || '').trim();
      var _fnOnly = /^[见参]?\s*(?:第)?(\d{1,3}|[一二三四五六七八九十百〇○]+)(?:节)?\s*注(\d+)\s*$/.exec(_inner);
      if (_fnOnly && book && ch) {
        var _vRaw = _fnOnly[1];
        var _vNum = /^\d+$/.test(_vRaw) ? parseInt(_vRaw, 10) : cnToInt(_vRaw);
        if (_vNum && _vNum >= 1 && _vNum <= 176) {
          var _vKey = book + ch + ':' + _vNum;
          result.push('<span class="scripture-ref fn-ref" data-vkey="' + escHtml(_vKey) + '" data-fn="' + escHtml(_fnOnly[2]) + '">' + escHtml(m[0]) + '</span>');
          last = m.index + m[0].length;
          continue;
        }
      }
      // 含"页"字的括号是页码/书页引用，非经文，直接回退渲染（如"创世记L-S，四五五页"）
      if (m[1].indexOf('页') >= 0) {
        result.push(escHtml(m[0][0]));
        pushPlain(m[1]);
        result.push(escHtml(m[0][m[0].length - 1]));
        last = m.index + m[0].length;
        continue;
      }
      // 尝试展开括号内容
      var refs = expandCnRefs(m[1], book, ch);
      if (refs.length > 0) {
        // 括号处理后的上下文更新：
        // 1) 允许在外层 ch 缺失时从括号内补齐章号（如「…（一26）…（28）」中的 28）
        // 2) 避免无条件覆盖外层 ch，防止连续括号把纯节续接到错误章
        var lastRef = refs[refs.length - 1];
        var lm = lastRef.match(/^([^\d:]+)(\d+):(\d+)/);
        if (lm && !_lockBook) {
          var _newBook = lm[1];
          var _newCh = parseInt(lm[2], 10);
          // 书卷变化时同步章号；同书卷仅在外层无章号时补齐
          if (_newBook !== book) {
            book = _newBook;
            ch = _newCh;
          } else if (!ch) {
            ch = _newCh;
          }
        }
        // ★ 括号内也过滤掉整章引用（节号全为 :0），不包裹 span
        var allParenVerseZero = refs.every(function(r) {
          var vm = r.match(/:(\d+)/);
          return vm && parseInt(vm[1], 10) === 0;
        });
        if (allParenVerseZero) {
          if (refs.length === 1) {
            // 单个整章引用：不包裹
            result.push(escHtml(m[0]));
          } else {
            // ★ 多章范围：拆分为独立 span
            var _pSplitOk = false;
            try {
              var _pInt2c = {1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十'};
              var _pBookLen = 0;
              for (var _psi = 0; _psi < _sortedFullNames.length; _psi++) {
                if (_inner.indexOf(_sortedFullNames[_psi]) === 0) { _pBookLen = _sortedFullNames[_psi].length; break; }
              }
              if (!_pBookLen && /^[创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启]/.test(_inner)) _pBookLen = 1;
              var _pBookPfx = _inner.slice(0, _pBookLen);
              var _pChText = _inner.slice(_pBookLen);
              var _pZm = _pChText.match(/^(.+)[章篇]/);
              var _pRangeText = _pZm ? _pZm[1] : _pChText;
              var _pRm = _pRangeText.match(/^([一二三四五六七八九十百〇○]+)[至到~～\-]([一二三四五六七八九十百〇○]+)$/);
              if (_pRm) {
                var _pcStart = cnToInt(_pRm[1]), _pcEnd = cnToInt(_pRm[2]);
                if (_pcStart && _pcEnd && _pcEnd >= _pcStart && (_pcEnd - _pcStart + 1) === refs.length) {
                  var _openB = m[0][0], _closeB = m[0][m[0].length - 1];
                  result.push(escHtml(_openB));
                  for (var _pci = _pcStart; _pci <= _pcEnd; _pci++) {
                    var _pcn = _pInt2c[_pci] || String(_pci);
                    var _ptxt = (_pci === _pcStart ? _pBookPfx : '') + _pcn + (_pZm ? _pZm[0].slice(-1) : '');
                    var _pref = refs[_pci - _pcStart];
                    result.push('<span class="scripture-ref" data-refs="' + escHtml(_pref) + '">' + escHtml(_ptxt) + '</span>');
                  }
                  result.push(escHtml(_closeB));
                  _pSplitOk = true;
                }
              }
            } catch (_pe) { _pSplitOk = false; }
            if (!_pSplitOk) result.push(escHtml(m[0]));
          }
        } else {
          result.push(makeSpan(m[0], refs));
        }
      } else {
        // 括号整体解析失败（如「在以弗所三章十六节，」含前置词），
        // 回退：把括号开符、内容、闭符分别扫描行内引用
        var openCh = m[0][0], closeCh = m[0][m[0].length-1];
        result.push(escHtml(openCh));
        pushPlain(m[1]);
        result.push(escHtml(closeCh));
      }
      last = m.index + m[0].length;
    }
    pushPlain(mainText.slice(last));

    // 破折号引用
    if (dashText) {
      var refBody = dashText.replace(/^[—─]+/, '').trim();
      var drefs = expandCnRefs(refBody, book, ch);
      if (drefs.length > 0) {
        // ★ 破折号引用也过滤掉整章引用（节号全为 :0），不包裹 span
        var allDashVerseZero = drefs.every(function(r) {
          var vm = r.match(/:(\d+)/);
          return vm && parseInt(vm[1], 10) === 0;
        });
        if (allDashVerseZero) {
          result.push(escHtml(dashText));
        } else {
          result.push(makeSpan(dashText, drefs));
        }
      } else {
        result.push('<span class="scripture-ref">' + escHtml(dashText) + '</span>');
      }
    }

    return result.join('');
  }

  // ── scanCtx：扫描文本后返回更新的上下文字符串 ─────────────────────────
  // 用于 renderer 在处理完一个标题后，将新识别出的书卷+章传给后续兄弟/子节点
  function scanCtx(text, ctxStr) {
    if (!text) return ctxStr || '';
    var html = wrapRefs(text, ctxStr);
    var re = /data-refs="([^"]+)"/g, m, lastRefs = null;
    while ((m = re.exec(html)) !== null) lastRefs = m[1];
    if (!lastRefs) return ctxStr || '';
    var refs = lastRefs.split(',');
    var lr = refs[refs.length - 1].trim().replace(/[上中下]$/, '');
    var cm = lr.match(/^([^\d:]+)(\d+):(\d+)/);
    return cm ? (cm[1] + cm[2] + ':' + cm[3]) : (ctxStr || '');
  }

  win.BKRef = { wrapRefs: wrapRefs, escHtml: escHtml, expandCnRefs: expandCnRefs, cnToInt: cnToInt, scanCtx: scanCtx };

}(window));
