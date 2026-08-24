'use strict';

  // ════════════════════════════════════════════════════════════
  // 书城：多级下钻（系列 → 分类 → 书籍，模块级状态机）
  // 渲染进 #homeView（与书架页 #app 区分）；底栏常驻由 bottom-tab-bar 控制。
  // ════════════════════════════════════════════════════════════

  var CITY_BATCH_SIZE = 24; // 三级书籍列表每批加载数量（决策 OQ1）

  // 书城下钻状态（与旧 _zl* 区分，避免污染）
  var _cityCategory = null;       // 当前分类名
  var _cityCategoryPrefix = null; // 当前分类 prefix
  var _citySeries = '';           // 当前系列 id（'' 表示未进入三级）
  var _cityGroup = null;          // 当前分组名（仅含 groups 的系列使用）
  var _cityBookOffset = 0;        // 三级书籍列表已渲染偏移
  var _cityLoading = false;       // 加载中锁（防重复触发）
  var _cityAllBooks = [];         // 当前三级系列在分类下的全部书籍
  var _cityObserver = null;       // IntersectionObserver 实例（触底哨兵）
  var _cityEventsBound = false;   // 书城事件委托是否已绑定（homeView 持久，仅绑一次）
  var _cityIndexUpdateBound = false; // 后台索引更新监听是否已注册（仅一次）
  var _cityImplicit = false;       // 当前三级书籍列表是否隐式选定唯一分类（单分类系列跳过二级）

  /** 计算书城当前下钻层级：1=系列网格，2=分组/分类列表，3=分类/书籍列表，4=书籍列表
   *  有 groups 的系列：L2=分组，L3=分类，L4=书籍
   *  无 groups 的系列：L2=分类，L3=书籍 */
  function _cityLevel() {
    if (_citySeries && (_cityCategory || _cityImplicit)) return _cityGroup ? 4 : 3;
    if (_citySeries && _cityGroup) return 3;
    if (_citySeries) return 2;
    return 1;
  }

  /**
   * 书城一级：返回系列列表（模块级下钻主轴翻转后，L1 = 系列）。
   * 职事书报 books 系列强制置顶；其余按 count 降序。
   * @returns {Array<Object>} 系列对象数组
   */
  function _getSeriesList() {
    // 合并微型系列（count < MIN_SERIES_BOOKS）到拾遗系列，与下载面板行为一致
    var merged = _getMergedSeries();
    var list = merged.series.slice();
    // 更新拾遗系列的显示计数（含被合并掉的书籍）
    var pickupIdx = -1;
    for (var k = 0; k < list.length; k++) {
      if (list[k].id === _PICKUP_SERIES_ID) { pickupIdx = k; break; }
    }
    if (pickupIdx >= 0 && merged.mergedCount > 0) {
      var pickupOrig = (merged.bookCount[_PICKUP_SERIES_ID] || 0);
      list[pickupIdx] = {
        id: list[pickupIdx].id,
        title: list[pickupIdx].title,
        count: pickupOrig + merged.mergedCount
      };
    }
    list.sort(function (a, b) {
      var aTop = (a.id === 'books') ? 1 : 0;
      var bTop = (b.id === 'books') ? 1 : 0;
      if (aTop !== bTop) return bTop - aTop; // books 置顶
      var ac = (typeof a.count === 'number') ? a.count : 0;
      var bc = (typeof b.count === 'number') ? b.count : 0;
      return bc - ac; // 其余按 count 降序
    });
    return list;
  }

  /**
   * 取某系列下的分类集合（模块级下钻主轴翻转后，L2 = 系列内分类）。
   * 若系列对象自带 categories 字段（数组 of {prefix,name,count}，如职事书报 books）则直接用；
   * 否则从 _zlBooks 过滤 b.series===seriesId 聚合出 {prefix,name:category,count}，按 prefix 数值升序。
   * 单分类系列返回 1 项（触发 implicit 跳过二级）。
   * @param {string} seriesId
   * @returns {Array<{prefix:string,name:string,count:number}>}
   */
  /** 判断书籍是否属于某系列（含被合并到拾遗的系列） */
  var _mergedSeriesCache = null;
  function _bookMatchesSeries(b, seriesId) {
    if (b.series === seriesId) return true;
    // 拾遗系列：被合并的微型系列书籍也属于拾遗
    if (seriesId === _PICKUP_SERIES_ID) {
      if (!_mergedSeriesCache) _mergedSeriesCache = _getMergedSeries();
      return !!_mergedSeriesCache.mergedIds[b.series];
    }
    return false;
  }
  /** 清除合并系列缓存（数据变更时调用） */
  function _invalidateMergedSeriesCache() { _mergedSeriesCache = null; }

  /**
   * 取某系列下的分组集合（仅含 groups 字段的系列，如信息拾遗）。
   * @param {string} seriesId
   * @returns {Array<{name:string,count:number}>} 分组数组，空数组表示无分组
   */
  function _getSeriesGroups(seriesId) {
    var seriesObj = null;
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) { seriesObj = _zlSeries[i]; break; }
    }
    if (seriesObj && Array.isArray(seriesObj.groups) && seriesObj.groups.length) {
      // 后端有 groups 数组，但仍需检查是否有平铺书（无 group 字段）
      var namedCount = 0;
      for (var gi = 0; gi < _zlBooks.length; gi++) {
        var gb = _zlBooks[gi];
        if (!_bookMatchesSeries(gb, seriesId)) continue;
        if (gb.group) namedCount++;
      }
      var totalInSeries = _countSeriesBooks(seriesId);
      var otherCount = totalInSeries - namedCount;
      var groupsList = seriesObj.groups.slice();
      if (otherCount > 0) {
        groupsList.push({ name: '其他', count: otherCount });
      }
      return groupsList;
    }
    // 无后端 groups：从书籍聚合（仅统计有 group 字段的书，无 group 的不归入「其他」）
    // 对于 books 等系列（所有书都没有 group 字段），返回空数组 → 走原三级分类逻辑
    var map = {};
    for (var j = 0; j < _zlBooks.length; j++) {
      var b = _zlBooks[j];
      if (!_bookMatchesSeries(b, seriesId)) continue;
      var g = b.group;
      if (!g) continue; // 无 group 字段的书不归入任何分组
      if (!map[g]) map[g] = { name: g, count: 0 };
      map[g].count++;
    }
    var arr = [];
    for (var k in map) {
      if (map.hasOwnProperty(k)) arr.push(map[k]);
    }
    return arr;
  }

  /**
   * 取某系列下的分类集合，可选按 group 过滤。
   * 若系列对象自带 categories 字段（数组 of {prefix,name,count}，如职事书报 books）则直接用；
   * 否则从 _zlBooks 过滤 b.series===seriesId 聚合出 {prefix,name:category,count}，按 prefix 数值升序。
   * 单分类系列返回 1 项（触发 implicit 跳过二级）。
   * @param {string} seriesId
   * @param {string} [group] 可选分组名，仅统计属于该分组的书籍
   * @returns {Array<{prefix:string,name:string,count:number}>}
   */
  function _getSeriesCategories(seriesId, group) {
    var seriesObj = null;
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) { seriesObj = _zlSeries[i]; break; }
    }
    // 「其他」虚拟分组：统计无 group 无 category_prefix 的平铺书，作为单一隐式分类
    if (group === '其他') {
      var flatCount = 0;
      for (var f = 0; f < _zlBooks.length; f++) {
        var fb = _zlBooks[f];
        if (!_bookMatchesSeries(fb, seriesId)) continue;
        if (fb.group) continue; // 有 group 的不属于「其他」
        flatCount++;
      }
      if (flatCount > 0) {
        return [{ prefix: '', name: '其他', count: flatCount }];
      }
      return [];
    }
    // 从书籍聚合（按 group 过滤后重新聚合分类）
    var map = {};
    for (var j = 0; j < _zlBooks.length; j++) {
      var b = _zlBooks[j];
      if (!_bookMatchesSeries(b, seriesId)) continue;
      if (group && b.group !== group) continue;
      var p = b.category_prefix;
      if (p === undefined || p === null || p === '') continue; // 无 prefix 的书不纳入分类
      if (!map[p]) map[p] = { prefix: p, name: b.category, count: 0 };
      map[p].count++;
    }
    var cats = [];
    for (var k in map) {
      if (map.hasOwnProperty(k)) cats.push(map[k]);
    }
    cats.sort(function (a, b) { return parseInt(a.prefix || '0', 10) - parseInt(b.prefix || '0', 10); });
    // 未指定 group 时，检查是否有平铺书（无 category_prefix），追加「其他」分类
    if (!group) {
      var uncatCount = 0;
      for (var m = 0; m < _zlBooks.length; m++) {
        var bk = _zlBooks[m];
        if (!_bookMatchesSeries(bk, seriesId)) continue;
        var pp = bk.category_prefix;
        if (pp === undefined || pp === null || pp === '') uncatCount++;
      }
      if (cats.length > 0 && uncatCount > 0) {
        cats.push({ prefix: '', name: '其他', count: uncatCount });
      }
    }
    return cats;
  }

  /**
   * 取某系列在某分类下的书籍（主轴翻转后，books 跨分类特例自然消解，无需特判）。
   * @param {string} seriesId
   * @param {string} cat 分类名
   * @param {string} prefix 分类 prefix（空/未定义表示单分类系列隐式选定，返回该系列全部书）
   * @returns {Array<Object>} 书籍数组
   */
  /**
   * 取某系列在某分类下的书籍，可选按 group 过滤。
   * @param {string} seriesId
   * @param {string} cat 分类名
   * @param {string} prefix 分类 prefix（空/未定义表示平铺书）
   * @param {string} [group] 可选分组名
   * @returns {Array<Object>} 书籍数组
   */
  function _getBooksInSeriesCategory(seriesId, cat, prefix, group) {
    var result = [];
    var hasPrefix = (prefix !== undefined && prefix !== null && prefix !== '');
    var isOtherGroup = (group === '其他');
    for (var i = 0; i < _zlBooks.length; i++) {
      var b = _zlBooks[i];
      if (!_bookMatchesSeries(b, seriesId)) continue;
      // 「其他」虚拟分组：仅返回无 group 的平铺书
      if (isOtherGroup) {
        if (b.group) continue;
      } else if (group && b.group !== group) {
        continue;
      }
      if (!hasPrefix) {
        // 无 prefix：返回该系列下所有无 category_prefix 的平铺书
        var bp = b.category_prefix;
        if (bp === undefined || bp === null || bp === '') {
          result.push(b);
        }
      } else if (b.category_prefix === prefix) {
        result.push(b);
      }
    }
    return result;
  }

  /** 计算系列书籍数（无 series.count 时实时统计，含被合并系列） */
  function _countSeriesBooks(seriesId) {
    var n = 0;
    for (var i = 0; i < _zlBooks.length; i++) {
      if (_bookMatchesSeries(_zlBooks[i], seriesId)) n++;
    }
    return n;
  }

  /**
   * 渲染面包屑（供测试定位：.bk-city-crumb[data-level] / .bk-crumb-item[data-action] / .bk-crumb-sep）
   * 四级下钻：
   *   L2 分组列表：「书城 › 系列名」(to-city / to-series→回 L1)
   *   L3 分组内分类列表：「书城 › 系列名 › 分组名」(to-city / to-series→回 L2 分组列表 / to-group→回 L2)
   *   L3 无分组分类列表（原三级）：「书城 › 系列名」(to-series→回 L1)
   *   L4 书籍列表（有分组）：「书城 › 系列名 › 分组名 › 分类名」(to-series→回 L2 / to-group→回 L3 / to-category→回 L3)
   *   L3 书籍列表（无分组，原三级）：「书城 › 系列名 › 分类名」(to-series / to-category)
   * @param {number} level 2 | 3 | 4
   * @param {string} seriesTitle 系列名
   * @param {string} cat 分类名（L3/L4 使用）
   * @param {boolean} implicit 是否单分类隐式
   * @param {string} seriesId 系列ID
   * @param {string} [group] 分组名（仅含 groups 的系列使用）
   */
  function _renderCityCrumb(level, seriesTitle, cat, implicit, seriesId, group) {
    var cityRoot = '<span class="bk-crumb-item" data-action="to-city" role="button" tabindex="0">书城</span>';
    var sep = '<span class="bk-crumb-sep">›</span>';
    var seriesCrumb = '<span class="bk-crumb-item" data-action="to-series" data-series="' + escAttr(seriesId || '') + '" role="button" tabindex="0">' + escText(seriesTitle) + '</span>';
    var groupCrumb = group ? (sep + '<span class="bk-crumb-item" data-action="to-group" data-series="' + escAttr(seriesId || '') + '" role="button" tabindex="0">' + escText(group) + '</span>') : '';

    if (level === 2) {
      // 分组列表页 或 无分组分类列表页：仅显示系列名
      return '<nav class="bk-city-crumb" data-level="2">' +
        cityRoot + sep + seriesCrumb +
        '</nav>';
    }
    if (level === 3 && group) {
      // 分组内分类列表页：系列名 › 分组名
      return '<nav class="bk-city-crumb" data-level="3">' +
        cityRoot + sep + seriesCrumb + groupCrumb +
        '</nav>';
    }
    if (level === 3 && implicit) {
      // 单分类隐式：仅显示系列名
      return '<nav class="bk-city-crumb" data-level="3">' +
        cityRoot + sep + seriesCrumb +
        '</nav>';
    }
    if (level === 3) {
      // 无分组分类列表的书籍列表（原三级）：系列名 › 分类名
      return '<nav class="bk-city-crumb" data-level="3">' +
        cityRoot + sep + seriesCrumb + sep +
        '<span class="bk-crumb-item" data-action="to-category" role="button" tabindex="0">' + escText(cat) + '</span>' +
        '</nav>';
    }
    // L4 书籍列表（有分组）：系列名 › 分组名 › 分类名
    // implicit 时分类名与分组名重复，只显示到分组级
    if (implicit) {
      return '<nav class="bk-city-crumb" data-level="4">' +
        cityRoot + sep + seriesCrumb + groupCrumb +
        '</nav>';
    }
    return '<nav class="bk-city-crumb" data-level="4">' +
      cityRoot + sep + seriesCrumb + groupCrumb + sep +
      '<span class="bk-crumb-item" data-action="to-category" role="button" tabindex="0">' + escText(cat) + '</span>' +
      '</nav>';
  }

  /** 书城一级：系列网格（主轴翻转后，L1 = 系列） */
  function _renderCityHome(homeView) {
    _citySeries = '';
    _cityCategory = null;
    _cityCategoryPrefix = null;
    _cityGroup = null;
    _cityImplicit = false;
    _cityBookOffset = 0;
    if (_cityObserver) { _cityObserver.disconnect(); _cityObserver = null; }
    var seriesList = _getSeriesList();
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-header"><h1 class="bk-city-title">书城</h1><button type="button" id="cityDlMgrBtn" class="bk-city-dl-btn" aria-label="下载管理">📥</button></div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">系列</span></div>';
    html += '<div class="series-catalog-grid bk-poster-grid">';
    for (var i = 0; i < seriesList.length; i++) {
      var s = seriesList[i];
      var displayTitle = _displaySeriesTitle ? _displaySeriesTitle(s.title) : s.title;
      var bookCount = (typeof s.count === 'number') ? s.count : _countSeriesBooks(s.id);
      var sc1 = _getSeriesColor(s.id);
      html += '<div class="series-catalog-card bk-poster-card" data-series="' + escAttr(s.id) + '" role="button" tabindex="0" style="--series-color:' + sc1 + '">';
      // 海报封面（复用 .bk-cover，系列色 + 系列名作为封面标题），与 L3 书籍卡海报同构
      html += _coverHTML({ series: s.id, title: displayTitle }, { seriesTitle: '系列' });
      // 信息条（与 L3 .book-caption 同构）：名称 + 数量
      html += '<div class="collection-caption bk-poster-card__caption">';
      html += '<div class="series-catalog-card-title">' + escText(displayTitle) + '</div>';
      html += '<div class="series-catalog-card-count">' + bookCount + ' 本</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
    homeView.innerHTML = html;
    startScrollTracking('city');
    restoreScrollPosition('city');
    // 书城右上角下载管理按钮
    var cityDlBtn = document.getElementById('cityDlMgrBtn');
    if (cityDlBtn) cityDlBtn.addEventListener('click', function () {
      if (win.BKRenderer && win.BKRenderer.openDownloadManager) win.BKRenderer.openDownloadManager();
    });
  }

  /**
   * 进入某系列：判断是否有 groups。
   * 有 groups → 进 L2 分组列表。
   * 无 groups → 取分类集合，单分类隐式跳过二级，多分类进二级分类列表。
   */
  function _enterSeries(homeView, seriesId) {
    var groups = _getSeriesGroups(seriesId);
    if (groups.length > 0) {
      _renderCityGroupList(homeView, seriesId);
      return;
    }
    var cats = _getSeriesCategories(seriesId);
    if (cats.length === 1) {
      _renderCityBookList(homeView, seriesId, cats[0].name, cats[0].prefix, true);
    } else {
      _renderCityCategoryList(homeView, seriesId);
    }
  }

  /** 书城 L2：某系列下的分组网格 + 面包屑（仅有 groups 的系列） */
  function _renderCityGroupList(homeView, seriesId) {
    _citySeries = seriesId;
    _cityCategory = null;
    _cityCategoryPrefix = null;
    _cityGroup = null;
    _cityImplicit = false;
    _cityBookOffset = 0;
    if (_cityObserver) { _cityObserver.disconnect(); _cityObserver = null; }
    var groups = _getSeriesGroups(seriesId);
    var seriesTitle = _getSeriesTitle(seriesId);
    var seriesColor = _getSeriesColor(seriesId);
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-topbar">';
    html += _renderCityCrumb(2, seriesTitle, '', false, seriesId);
    html += '</div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">' + escText(seriesTitle) + '</span></div>';
    html += '<div class="category-grid bk-poster-grid">';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      html += '<div class="category-card group-card bk-poster-card" data-group="' + escAttr(g.name) + '" role="button" tabindex="0" style="--series-color:' + seriesColor + '">';
      html += _coverHTML({ series: seriesId, title: g.name }, { seriesTitle: seriesTitle });
      html += '<div class="collection-caption bk-poster-card__caption">';
      html += '<div class="category-card-title">' + escText(g.name) + '</div>';
      html += '<div class="category-card-count">' + g.count + ' 本</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
    homeView.innerHTML = html;
    startScrollTracking('city-group');
    restoreScrollPosition('city-group');
  }

  /**
   * 进入某分组：取该分组下的分类集合。
   * 单分类 → 隐式跳过三级，直接进 L4 书籍列表。
   * 多分类 → 进 L3 分类列表。
   */
  function _enterGroup(homeView, seriesId, group) {
    var cats = _getSeriesCategories(seriesId, group);
    if (cats.length === 1) {
      _renderCityBookList(homeView, seriesId, cats[0].name, cats[0].prefix, true, group);
    } else {
      _renderCityCategoryList(homeView, seriesId, group);
    }
  }

  /** 书城分类网格 + 面包屑
   *  无 groups 系列：L2 = 系列内分类列表（面包屑 level=2）
   *  有 groups 系列：L3 = 分组内分类列表（面包屑 level=3，含分组名）
   *  @param {string} seriesId
   *  @param {string} [group] 可选分组名（有 groups 系列使用）
   */
  function _renderCityCategoryList(homeView, seriesId, group) {
    _citySeries = seriesId;
    _cityCategory = null;
    _cityCategoryPrefix = null;
    _cityGroup = group || null;
    _cityImplicit = false;
    _cityBookOffset = 0;
    if (_cityObserver) { _cityObserver.disconnect(); _cityObserver = null; }
    var cats = _getSeriesCategories(seriesId, group);
    var seriesTitle = _getSeriesTitle(seriesId);
    var crumbLevel = group ? 3 : 2;
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-topbar">';
    html += _renderCityCrumb(crumbLevel, seriesTitle, '', false, seriesId, group);
    html += '</div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">' + escText(seriesTitle) + '</span></div>';
    html += '<div class="category-grid bk-poster-grid">';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      var sc2 = _getSeriesColor(seriesId);
      html += '<div class="category-card bk-poster-card" data-category="' + escAttr(c.name) + '" data-category-prefix="' + escAttr(c.prefix) + '" role="button" tabindex="0" style="--series-color:' + sc2 + '">';
      // 海报封面（复用 .bk-cover，系列色 + 分类名作为封面标题，顶部标签为所属系列名），与 L3 同构
      html += _coverHTML({ series: seriesId, title: c.name }, { seriesTitle: seriesTitle });
      // 信息条（与 L3 .book-caption 同构）：分类名 + 数量
      html += '<div class="collection-caption bk-poster-card__caption">';
      html += '<div class="category-card-title">' + escText(c.name) + '</div>';
      html += '<div class="category-card-count">' + c.count + ' 本</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
    homeView.innerHTML = html;
    startScrollTracking('city-category');
    restoreScrollPosition('city-category');
  }

  /** 书城书籍列表（无限滚动）+ 面包屑
   *  无 groups 系列：L3 书籍列表（面包屑 level=3）
   *  有 groups 系列：L4 书籍列表（面包屑 level=4，含分组名）
   *  @param {string} seriesId
   *  @param {string} cat 分类名
   *  @param {string} prefix 分类 prefix
   *  @param {boolean} implicit 是否单分类隐式（跳过二级/三级，面包屑仅显示系列名/系列名+分组名）
   *  @param {string} [group] 可选分组名（有 groups 系列使用）
   */
  function _renderCityBookList(homeView, seriesId, cat, prefix, implicit, group) {
    _citySeries = seriesId;
    _cityCategory = (cat === undefined || cat === null) ? null : cat;
    _cityCategoryPrefix = (prefix === undefined || prefix === null) ? null : prefix;
    _cityGroup = group || null;
    _cityImplicit = !!implicit;
    _cityBookOffset = 0;
    _cityLoading = false;
    _cityAllBooks = _getBooksInSeriesCategory(seriesId, cat, prefix, group);
    var seriesTitle = _getSeriesTitle(seriesId);
    var crumbLevel = group ? 4 : 3;
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-topbar">';
    html += _renderCityCrumb(crumbLevel, seriesTitle, cat, implicit, seriesId, group);
    html += '</div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">' + escText(seriesTitle) + '</span></div>';
    html += '<div class="book-grid bk-city-book-grid bk-poster-grid" data-series="' + escAttr(seriesId) + '"></div>';
    html += '<div class="bk-city-sentinel" id="bkCitySentinel"></div>';
    html += '<div class="bk-city-end" hidden>已经到底了</div>';
    html += '</div>';
    homeView.innerHTML = html;
    // 先填首批，再建立触底哨兵
    _appendCityBatch(homeView);
    _setupCitySentinel(homeView);
    startScrollTracking('city-book');
    restoreScrollPosition('city-book');
  }

  /** 向三级书籍网格追加下一批（更新 _cityBookOffset），返回是否还有更多 */
  function _appendCityBatch(homeView) {
    if (_cityLoading) return false;
    var remaining = _cityAllBooks.length - _cityBookOffset;
    if (remaining <= 0) {
      _showCityEnd(homeView, true);
      return false;
    }
    _cityLoading = true;
    var batch = _cityAllBooks.slice(_cityBookOffset, _cityBookOffset + CITY_BATCH_SIZE);
    var grid = homeView.querySelector('.bk-city-book-grid');
    if (grid) {
      var frag = '';
      for (var i = 0; i < batch.length; i++) {
        frag += _buildBookCard(batch[i], { showProgress: false, cityBook: true });
      }
      grid.insertAdjacentHTML('beforeend', frag);
    }
    _cityBookOffset += batch.length;
    _cityLoading = false;
    if (_cityBookOffset >= _cityAllBooks.length) _showCityEnd(homeView, true);
    return true;
  }

  /** 显示 / 隐藏「已经到底了」 */
  function _showCityEnd(homeView, show) {
    var endEl = homeView.querySelector('.bk-city-end');
    if (endEl) endEl.hidden = !show;
  }

  /** 建立触底哨兵（IntersectionObserver 守卫；jsdom 无 IO 时由测试直接调 _cityLoadMore） */
  function _setupCitySentinel(homeView) {
    if (typeof IntersectionObserver !== 'function') return;
    var sentinel = homeView.querySelector('#bkCitySentinel');
    if (!sentinel) return;
    if (_cityObserver) _cityObserver.disconnect();
    _cityObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) _cityLoadMore();
      }
    }, { rootMargin: '200px' });
    _cityObserver.observe(sentinel);
  }

  /** 无限滚动加载更多（供 IntersectionObserver 与测试 stub 调用） */
  function _cityLoadMore() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    var lvl = _cityLevel();
    if (lvl !== 3 && lvl !== 4) return;
    _appendCityBatch(homeView);
    _setupCitySentinel(homeView);
  }

  /** 逐级回退：任意级 → 一级（系列网格） */
  function _cityBackToSeries() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    _renderCityHome(homeView);
  }

  /** 逐级回退：书籍列表 → 分类列表（有 group 回分组内分类，无 group 回系列分类） */
  function _cityBackToCategories() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    _renderCityCategoryList(homeView, _citySeries, _cityGroup);
  }

  var _cityQuickLockCleanup = null;

  function _closeCityQuickMenu() {
    if (_cityQuickLockCleanup) { _cityQuickLockCleanup(); _cityQuickLockCleanup = null; }
    var m = document.querySelector('.bk-city-quick-mask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  /** 书城长按快捷菜单（底部 action sheet，复用书架快捷菜单样式） */
  function _openCityQuickMenu(bookId) {
    if (!bookId) return;
    _closeCityQuickMenu();
    var page = document.getElementById('homeView');
    if (!page) return;
    var book = _findBookById(bookId) || { id: bookId };
    var title = book.title || bookId;
    var author = book.author || '';
    var initial = title.replace(/^[\d]+\s*[-–—:：·.\s]+/, '').replace(/^[《「]/, '').charAt(0) || '?';
    var isRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
    var isOnShelf = !!(win.BKShelf && win.BKShelf.get && win.BKShelf.get(bookId));

    var mask = document.createElement('div');
    mask.className = 'bk-city-quick-mask';
    mask.setAttribute('role', 'presentation');
    var sheet = document.createElement('div');
    // 复用书架快捷菜单样式（bk-shelf-quick-*），确保视觉一致
    sheet.className = 'bk-shelf-quick-menu';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-label', '书籍操作');

    // 头部：迷你封面 + 书名 + 作者
    sheet.innerHTML =
      '<div class="bk-shelf-quick-head">' +
        '<div class="bk-shelf-quick-cover" style="background:' + _getSeriesColor(book.series) + '">' + escText(initial) + '</div>' +
        '<div class="bk-shelf-quick-headtext">' +
          '<div class="bk-shelf-quick-title">' + escText(title) + '</div>' +
          (author ? '<div class="bk-shelf-quick-author">' + escText(author) + '</div>' : '') +
        '</div>' +
      '</div>';

    var actions = [];
    actions.push({ icon: ICON_INFO, label: '书籍详情', act: 'detail' });
    if (isOnShelf) {
      if (!isRead) {
        actions.push({ icon: ICON_CHECK, label: '标记已读', act: 'mark-read' });
      } else {
        actions.push({ icon: ICON_UNDO, label: '移回在读', act: 'mark-unread' });
      }
    }


    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bk-shelf-quick-item';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-act', a.act || '');
      b.innerHTML =
        '<span class="qi-ico" aria-hidden="true">' + (a.icon || '') + '</span>' +
        '<span class="qi-label">' + escText(a.label) + '</span>';
      b.addEventListener('click', function () {
        if (a.act === 'detail') {
          _closeCityQuickMenu();
          _openBookDetail(book);
        } else if (a.act === 'mark-read') {
          _closeCityQuickMenu();
          if (win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(bookId);
        } else if (a.act === 'mark-unread') {
          _closeCityQuickMenu();
          if (win.BKShelf && win.BKShelf.unmarkRead) win.BKShelf.unmarkRead(bookId);
        }
      });
      sheet.appendChild(b);
    });

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bk-shelf-quick-item bk-shelf-quick-cancel';
    cancel.textContent = '取消';
    cancel.setAttribute('role', 'menuitem');
    cancel.addEventListener('click', function () { _closeCityQuickMenu(); });
    sheet.appendChild(cancel);

    mask.appendChild(sheet);
    mask.addEventListener('click', function (e) { if (e.target === mask) _closeCityQuickMenu(); });
    page.appendChild(mask);
    if (win.BK && win.BK.lockOverlayScroll) {
      _cityQuickLockCleanup = win.BK.lockOverlayScroll(mask, function() { _closeCityQuickMenu(); });
    }
    if (win.requestAnimationFrame) {
      win.requestAnimationFrame(function () { mask.classList.add('is-open'); });
    } else {
      mask.classList.add('is-open');
    }
  }

  /** 书城事件委托（绑定在 homeView 容器一次；重渲染 innerHTML 不丢失监听） */
  function _bindCityEvents(homeView) {
    if (_cityEventsBound) return;
    _cityEventsBound = true;

    function onClick(e) {
      if (!e.target || !e.target.closest) return;

      // 面包屑：回上一级
      var crumb = e.target.closest('.bk-crumb-item');
      if (crumb) {
        e.preventDefault();
        var action = crumb.getAttribute('data-action');
        if (action === 'to-city') {
          // 回书城根（一级系列网格）
          _renderCityHome(homeView);
        } else if (action === 'to-series') {
          // 有 group 时回分组列表（L2），无 group 回系列网格（L1）
          var sid = crumb.getAttribute('data-series');
          if (_cityGroup) {
            if (sid) _renderCityGroupList(homeView, sid);
          } else {
            _renderCityHome(homeView);
          }
        } else if (action === 'to-group') {
          // 回分组内分类列表（L3）
          var gid = crumb.getAttribute('data-series');
          var gname = crumb.textContent;
          if (gid) _renderCityCategoryList(homeView, gid, gname);
        } else if (action === 'to-category') {
          // 有 group 回分组内分类列表（L3），无 group 回系列分类列表（L2）
          _renderCityCategoryList(homeView, _citySeries, _cityGroup);
        }
        return;
      }

      // L1 系列卡 → 进入该系列
      var seriesCard = e.target.closest('.series-catalog-card');
      if (seriesCard) {
        e.preventDefault();
        var seriesId = seriesCard.getAttribute('data-series');
        _enterSeries(homeView, seriesId);
        return;
      }

      // L2 分组卡 → 进入分组内分类列表
      var groupCard = e.target.closest('.group-card');
      if (groupCard) {
        e.preventDefault();
        var gname = groupCard.getAttribute('data-group');
        _enterGroup(homeView, _citySeries, gname);
        return;
      }

      // L2/L3 分类卡 → 进入书籍列表
      var catCard = e.target.closest('.category-card');
      if (catCard) {
        e.preventDefault();
        var cat = catCard.getAttribute('data-category');
        var prefix = catCard.getAttribute('data-category-prefix');
        _renderCityBookList(homeView, _citySeries, cat, prefix, false, _cityGroup);
        return;
      }

      // 书籍卡 → 进入阅读
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (bookLink) {
        if (_cityLpFired) { _cityLpFired = false; return; }
        e.preventDefault();
        var bookId = bookLink.getAttribute('data-book-id');
        var series = bookLink.getAttribute('data-series');
        if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(bookId);
        _handleBookClick(bookId, series, bookLink);
        return;
      }
    }

    /**
     * 键盘事件委托（与 click 同容器 homeView，同一 _cityEventsBound 守卫仅绑一次）。
     * 书城 L1/L2/L3 卡及面包屑均为 role=button tabindex=0，聚焦后 Enter(13)/Space(32)
     * 触发与鼠标点击等效的下钻 / 打开逻辑；Space 必须 preventDefault 防页面滚动。
     * 注意：<div role=button> / <span role=button> 不会自动派发 click，故 keydown 与 click
     * 不会重复触发，此处不手动 dispatch click。
     */
    function onKeyDown(e) {
      if (!e.target || !e.target.closest) return;
      // 仅响应 Enter / Space 键
      var isEnter = e.key === 'Enter' || e.keyCode === 13;
      var isSpace = e.key === ' ' || e.keyCode === 32;
      if (!isEnter && !isSpace) return;

      // 面包屑：回上一级（键盘可达）
      var crumb = e.target.closest('.bk-crumb-item');
      if (crumb) {
        e.preventDefault();
        var action = crumb.getAttribute('data-action');
        if (action === 'to-city') {
          _renderCityHome(homeView);
        } else if (action === 'to-series') {
          var sid2 = crumb.getAttribute('data-series');
          if (_cityGroup) {
            if (sid2) _renderCityGroupList(homeView, sid2);
          } else {
            _renderCityHome(homeView);
          }
        } else if (action === 'to-group') {
          var gid2 = crumb.getAttribute('data-series');
          var gname2 = crumb.textContent;
          if (gid2) _renderCityCategoryList(homeView, gid2, gname2);
        } else if (action === 'to-category') {
          _renderCityCategoryList(homeView, _citySeries, _cityGroup);
        }
        return;
      }

      // L1 系列卡 → 进入该系列
      var seriesCard = e.target.closest('.series-catalog-card');
      if (seriesCard) {
        e.preventDefault();
        var seriesId = seriesCard.getAttribute('data-series');
        _enterSeries(homeView, seriesId);
        return;
      }

      // L2 分组卡 → 进入分组内分类列表
      var groupCard = e.target.closest('.group-card');
      if (groupCard) {
        e.preventDefault();
        var gname = groupCard.getAttribute('data-group');
        _enterGroup(homeView, _citySeries, gname);
        return;
      }

      // L2/L3 分类卡 → 进入书籍列表
      var catCard = e.target.closest('.category-card');
      if (catCard) {
        e.preventDefault();
        var cat = catCard.getAttribute('data-category');
        var prefix = catCard.getAttribute('data-category-prefix');
        _renderCityBookList(homeView, _citySeries, cat, prefix, false, _cityGroup);
        return;
      }

      // 书籍卡 → 进入阅读（与 click 同一逻辑）
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (bookLink) {
        e.preventDefault();
        var bookId = bookLink.getAttribute('data-book-id');
        var series = bookLink.getAttribute('data-series');
        // 键盘打开 = 打开阅读 + 自动加入书架（与 click 一致）
        if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(bookId);
        _handleBookClick(bookId, series, bookLink);
        return;
      }
    }

    homeView.addEventListener('click', onClick);
    homeView.addEventListener('keydown', onKeyDown);

    // 长按书籍卡（≥450ms）弹快捷菜单；移动超 12px 视为滚动取消
    var _cityLpTimer = null, _cityLpFired = false, _cityLpX = 0, _cityLpY = 0;
    function _cityClearLp() { if (_cityLpTimer) { clearTimeout(_cityLpTimer); _cityLpTimer = null; } /* 保留 _cityLpFired：长按触发后 pointerup 不应重置，留待 click 拦截消费 */ }
    homeView.addEventListener('pointerdown', function (e) {
      if (!e.target || !e.target.closest) return;
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (!bookLink) return;
      _cityLpFired = false; _cityLpX = e.clientX; _cityLpY = e.clientY;
      _cityLpTimer = setTimeout(function () {
        _cityLpFired = true;
        var bookId = bookLink.getAttribute('data-book-id');
        _openCityQuickMenu(bookId);
      }, 450);
    });
    homeView.addEventListener('pointermove', function (e) {
      if (!_cityLpTimer) return;
      if (Math.abs(e.clientX - _cityLpX) > 12 || Math.abs(e.clientY - _cityLpY) > 12) _cityClearLp();
    });
    homeView.addEventListener('pointerup', _cityClearLp);
    homeView.addEventListener('pointercancel', _cityClearLp);
    homeView.addEventListener('pointerleave', _cityClearLp);
    // 右键书籍卡弹快捷菜单（桌面端）
    homeView.addEventListener('contextmenu', function (e) {
      if (!e.target || !e.target.closest) return;
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (!bookLink) return;
      e.preventDefault();
      var bookId = bookLink.getAttribute('data-book-id');
      _openCityQuickMenu(bookId);
      _cityLpFired = true; // 吞掉后续 click
    });
  }

  /** 注册书城所需的全局监听（bk-shelf-changed 就地翻转 + 后台索引更新）仅一次 */
  function _registerCityGlobalHandlers() {
    if (!_bkShelfChangedBound) {
      _bkShelfChangedBound = true;
      if (win.BKShelf) win.addEventListener('bk-shelf-changed', _bkShelfChangedHandler);
    }
    if (!_cityIndexUpdateBound) {
      _cityIndexUpdateBound = true;
      document.addEventListener('zl:index-updated', _onIndexUpdated);
    }
  }

  /** 后台索引更新 → 重渲染当前可见浏览视图 */
  function _onIndexUpdated() {
    if (!win.DataManager) return;
    var idx = win.DataManager.getCachedIndex();
    if (!idx || !idx.books) return;
    _zlIndex = idx;
    _zlSeries = idx.series || [];
    _zlBooks = idx.books || [];
    _invalidateMergedSeriesCache();
    _rerenderCurrentView();
  }

  /** 重渲染当前可见浏览视图（书架 / 书城），供管理模式切换与索引更新复用 */
  function _rerenderCurrentView() {
    var homeView = document.getElementById('homeView');
    var appEl = document.getElementById('app');
    if (appEl && appEl.style.display !== 'none') {
      if (win.location.hash.indexOf('city') !== -1) {
        if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
      } else if (BKRenderer.renderShelfPage) {
        BKRenderer.renderShelfPage();
      }
    } else if (homeView && homeView.style.display !== 'none') {
      if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
    }
  }

