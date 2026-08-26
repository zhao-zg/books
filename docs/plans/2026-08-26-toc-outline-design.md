---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '165f9c85-9758-48e4-8d8d-52390b9cd9c8'
  PropagateID: '165f9c85-9758-48e4-8d8d-52390b9cd9c8'
  ReservedCode1: 'a5ea0cd9-34e9-4c4f-9782-c42c75ed7828'
  ReservedCode2: 'a5ea0cd9-34e9-4c4f-9782-c42c75ed7828'
---

# 目录面板纲目展开 + 全文搜索功能设计

> 日期: 2026-08-26
> 状态: 设计待确认

## 一、需求背景

当前书籍目录面板存在两个不足：

1. **纲目不可见**：目录仅展示章节级扁平列表，用户无法从目录直接定位到章节内的纲目（heading）。书籍章节的 `content` 中已包含 heading 元素（level 1-6），但目录面板没有利用这些信息。
2. **搜索仅匹配标题**：目录搜索只做章节标题模糊匹配，无法搜索正文内容。用户想找包含某个关键词的章节时，无法通过目录快速定位。

**目标**：
- 在目录面板中，每个章节可展开显示其内部纲目层级，点击纲目项可跳转到对应章节并滚动到纲目位置。
- 目录搜索升级为全文搜索：输入关键词后，遍历当前书籍所有章节的正文内容，返回包含关键词的章节，并显示匹配文本的上下文片段。

### 已有基础设施（重大发现）

项目**已有一套完整的全文搜索基础设施**，可直接复用：
- `DataManager.buildContentIndex(book)`：在下载/导入书籍时自动构建纯文本索引 `{n, t, c}`，存入 IndexedDB
- `DataManager.getContentIndexMap()`：内存中返回所有书的内容索引
- `search.js _searchContent()`：已实现全文 indexOf 匹配、上下文片段提取（前后 30 字符 + …）、关键词高亮
- `loadBook(bookId)` 一次返回完整书籍对象（含所有章节 content），已在内存缓存
- 单书最大约 240 万字，indexOf 全量扫描约 10-50ms，无需引入第三方搜索库

## 二、适用范围

- **书城书**（ysz 系列，content 为纯字符串）：从渲染后的 DOM 提取 heading
- **导入书**（EPUB/TXT/MD，content 为 Content[] 数组）：直接遍历数组提取 heading

## 三、UI 交互设计

### 3.1 默认状态

目录面板展示扁平的章节列表（与现状一致），每个章节项右侧添加展开箭头图标（▸）。

### 3.2 展开纲目

点击章节项右侧的展开箭头 → 异步加载该章节的纲目列表 → 在章节项下方展开子列表（缩进显示），箭头变为 ▾。

### 3.3 折叠纲目

再次点击箭头 → 隐藏子列表，箭头恢复 ▸。

### 3.4 点击纲目项

点击纲目项（非箭头）→ 跳转到对应章节 → 关闭目录面板 → 章节渲染完成后自动滚动到纲目 heading 所在位置。

### 3.5 点击章节项（非箭头区域）

与现状一致：跳转到对应章节开头，关闭面板。

### 3.6 全文搜索

搜索框输入关键词后（防抖 200ms），搜索逻辑升级为**全文搜索**：

1. **搜索范围**：当前书籍的所有章节正文内容 + 章节标题
2. **匹配方式**：`indexOf` 子串匹配（复用现有 `_searchContent` 算法逻辑），支持多关键词空格分隔（AND 逻辑）
3. **结果展示**：每条结果显示章节号 + 章节标题 + 匹配上下文片段（前后 30 字符，关键词高亮）
4. **点击跳转**：点击搜索结果跳转到对应章节
5. **展开状态**：搜索模式下纲目子列表自动收起，退出搜索后恢复
6. **加载状态**：若内容索引尚未加载（冷启动），先显示标题匹配结果 + "正在加载内容索引..." 提示，索引加载后自动补充全文结果

## 四、技术方案

### 4.1 数据流

```
用户点击展开箭头
  → epub-adapter.toc.getOutlines(bookId, chapterNum)
    → 判断 content 类型：
      A) Content[] 数组（导入书）→ 遍历数组提取 type==='heading' 元素
      B) 纯字符串（书城书）→ loadBook → renderChapterContent 到隐藏 DOM → querySelectorAll('h1,h2,h3,h4,h5,h6') → 提取文本+level
    → 返回 [{ text, level, index }]
  → mark-panel._renderOutlineItems() 渲染子列表
  → 缓存结果到内存（同一章节不重复提取）
```

### 4.2 epub-adapter 新增方法

在 `EpubAdapter.toc` 中新增：

```javascript
/**
 * 获取章节纲目列表
 * @param {string} bookId
 * @param {number} chapterNum
 * @returns {Promise<Array<{text, level, index}>>}
 */
getOutlines: function (bookId, chapterNum) {
    // 1. 检查缓存
    // 2. loadBook(bookId) → 找到对应 chapter
    // 3. 判断 content 类型：
    //    - Content[] 数组：遍历提取 heading
    //    - 纯字符串：渲染到隐藏 DOM 提取 heading
    // 4. 缓存并返回
}
```

### 4.3 纲目提取策略

**Content[] 数组（导入书）**：

```javascript
function _extractOutlinesFromArray(contentArr) {
    var outlines = [];
    for (var i = 0; i < contentArr.length; i++) {
        var item = contentArr[i];
        if (item.type === 'heading') {
            outlines.push({
                text: item.text || '',
                level: item.level || 2,
                index: i  // 在 content 数组中的位置
            });
        }
    }
    return outlines;
}
```

**纯字符串（书城书）**：

```javascript
function _extractOutlinesFromString(contentStr, chapter) {
    // 复用 renderChapterContent 渲染到隐藏 DOM
    var hidden = document.createElement('div');
    hidden.style.display = 'none';
    hidden.innerHTML = renderChapterContent(chapter, false);
    document.body.appendChild(hidden);
    var headings = hidden.querySelectorAll('.bk-heading');
    var outlines = [];
    for (var i = 0; i < headings.length; i++) {
        var h = headings[i];
        // 从 className 提取 level: bk-h2 → level 2
        var levelMatch = /bk-h(\d)/.exec(h.className);
        outlines.push({
            text: h.textContent.trim(),
            level: levelMatch ? parseInt(levelMatch[1], 10) : 2,
            index: i
        });
    }
    document.body.removeChild(hidden);
    return outlines;
}
```

**已在 carousel 中渲染的章节**（优化）：

```javascript
// 如果该章节已在 carousel 的 prev/curr/next 页中渲染，
// 直接从可见 DOM 提取 heading，无需重新渲染
function _extractOutlinesFromCarousel(chapterNum) {
    var pages = win.BKRenderer && win.BKRenderer._carouselPages;
    if (!pages) return null;
    // 检查 curr/prev/next 三页
    var candidates = [pages.curr, pages.prev, pages.next];
    for (var i = 0; i < candidates.length; i++) {
        var page = candidates[i];
        if (!page) continue;
        // 检查页内 chapter number 是否匹配
        // 从 DOM 提取 heading
        var headings = page.querySelectorAll('.bk-heading');
        if (headings.length > 0) return _headingsToOutlines(headings);
    }
    return null;
}
```

### 4.4 DOM 锚点与滚动定位

**渲染时添加锚点**：`renderContentItem` 中 heading 渲染已有 `bk-h{level}` 类名。需要新增 `data-outline-index` 属性：

```javascript
// renderer-content.js renderContentItem heading case
case 'heading':
    var level = item.level || 2;
    // ...
    html = '<h' + level + ' class="' + hCls + '" data-outline-idx="' + i + '"' + ...>
```

但由于 `renderContentItem` 不接收 index 参数，改用 CSS 类 `bk-heading` 已存在，滚动定位时直接用 `querySelectorAll('.bk-heading')[index]` 获取目标元素。

**滚动定位逻辑**：

```javascript
// 点击纲目项后的跳转+滚动
function navigateToOutline(bookId, chapterNum, outlineIndex) {
    // 1. 路由跳转到章节
    BKRouter.navigate(bookId + '/' + chapterNum);
    // 2. 章节渲染完成后滚动到 heading
    //    监听 reader-page-change 事件或 setTimeout
    setTimeout(function () {
        var pageEl = document.querySelector('.bk-carousel-page.active .content')
                   || document.getElementById('carouselContent1');
        if (!pageEl) return;
        var headings = pageEl.querySelectorAll('.bk-heading');
        var target = headings[outlineIndex];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
}
```

### 4.5 mark-panel.js 修改

**_renderEpubToc 改造**：

当前 `_renderEpubToc` 渲染扁平列表。改造为：

```javascript
_renderEpubToc: function (pane, items) {
    var ul = document.createElement('ul');
    ul.className = 'bk-mp-toc-list';

    items.forEach(function (item, idx) {
        var li = document.createElement('li');
        li.className = 'bk-mp-toc-item-wrapper';

        // 章节行（含展开箭头）
        var row = document.createElement('div');
        row.className = 'bk-mp-toc-item';
        if (item.isActive) row.classList.add('bk-mp-toc-current');

        var num = document.createElement('span');
        num.className = 'bk-mp-toc-num';
        num.textContent = item.num || (idx + 1);

        var title = document.createElement('span');
        title.className = 'bk-mp-toc-title';
        title.textContent = item.title;

        var toggle = document.createElement('button');
        toggle.className = 'bk-mp-toc-toggle';
        toggle.textContent = '▸';

        row.appendChild(toggle);
        row.appendChild(num);
        row.appendChild(title);

        // 点击章节标题区域 → 跳转
        row.addEventListener('click', function (e) {
            if (e.target === toggle || e.target.closest('.bk-mp-toc-toggle')) return;
            MarkPanel._adapter.toc.navigate(item);
            MarkPanel.close();
        });

        // 点击展开箭头 → 加载/切换纲目子列表
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            MarkPanel._toggleOutline(li, item);
        });

        li.appendChild(row);
        ul.appendChild(li);
    });

    pane.appendChild(ul);
}
```

**新增 _toggleOutline 方法**：

```javascript
_toggleOutline: function (li, chapterItem) {
    var existing = li.querySelector('.bk-mp-toc-outline');
    if (existing) {
        // 已有子列表：切换显示
        var isExpanded = existing.style.display !== 'none';
        existing.style.display = isExpanded ? 'none' : 'block';
        li.classList.toggle('bk-mp-toc-expanded', !isExpanded);
        var toggle = li.querySelector('.bk-mp-toc-toggle');
        if (toggle) toggle.textContent = isExpanded ? '▸' : '▾';
        return;
    }

    // 无子列表：异步加载
    var toggle = li.querySelector('.bk-mp-toc-toggle');
    if (toggle) { toggle.textContent = '…'; toggle.disabled = true; }

    var bookId = chapterItem.bookId || _getCurrentBookId();
    var chapterNum = chapterItem.chapterNum || chapterItem.num;

    MarkPanel._adapter.toc.getOutlines(bookId, chapterNum).then(function (outlines) {
        if (!outlines || outlines.length === 0) {
            // 无纲目：隐藏箭头
            if (toggle) { toggle.textContent = ''; toggle.style.visibility = 'hidden'; }
            return;
        }

        var sub = document.createElement('ul');
        sub.className = 'bk-mp-toc-outline';

        outlines.forEach(function (outline) {
            var subLi = document.createElement('li');
            subLi.className = 'bk-mp-toc-outline-item';
            subLi.style.paddingLeft = (16 + (outline.level - 1) * 12) + 'px';

            var dot = document.createElement('span');
            dot.className = 'bk-mp-toc-outline-dot';
            dot.textContent = '·';

            var text = document.createElement('span');
            text.className = 'bk-mp-toc-outline-text';
            text.textContent = outline.text;

            subLi.appendChild(dot);
            subLi.appendChild(text);

            subLi.addEventListener('click', function () {
                MarkPanel._adapter.toc.navigateOutline(bookId, chapterNum, outline.index);
                MarkPanel.close();
            });

            sub.appendChild(subLi);
        });

        li.appendChild(sub);
        li.classList.add('bk-mp-toc-expanded');
        if (toggle) { toggle.textContent = '▾'; toggle.disabled = false; }
    });
}
```

### 4.6 epub-adapter 新增 navigateOutline 方法

```javascript
navigateOutline: function (bookId, chapterNum, outlineIndex) {
    // 1. 路由跳转到章节
    if (win.BKRouter && win.BKRouter.navigate) {
        win.BKRouter.navigate(bookId + '/' + chapterNum);
    }
    // 2. 延迟后滚动到 heading
    setTimeout(function () {
        var contentEl = document.querySelector('.bk-carousel-page.active .content')
                      || document.getElementById('carouselContent1');
        if (!contentEl) return;
        var headings = contentEl.querySelectorAll('.bk-heading');
        if (outlineIndex < headings.length) {
            headings[outlineIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 350);  // 等待章节渲染完成
}
```

### 4.7 缓存策略

纲目提取结果缓存在内存中（非持久化），以 `bookId + '_' + chapterNum` 为 key：

```javascript
var _outlineCache = {};

function _cacheKey(bookId, chapterNum) {
    return bookId + '_' + chapterNum;
}
```

- 首次展开：提取 + 缓存
- 再次展开：直接读缓存
- 切换书籍（`_syncBookContext` 检测到 bookId 变化）：清空缓存

### 4.8 全文搜索实现

**数据流**：

```
用户输入关键词（防抖 200ms）
  → epub-adapter.toc.search(keyword)
    → 1. 标题匹配：遍历章节标题 indexOf
    → 2. 全文匹配：DataManager.getContentIndexMap()[bookId].chapters
         → 每个 chapter 的 c 字段（纯文本）做 indexOf
         → 命中则提取上下文片段（前后 30 字符 + …）
    → 返回 [{ id, title, num, chapterNum, bookId, context, isActive }]
  → mark-panel._renderEpubToc() 渲染（扩展支持 context 片段展示）
```

**epub-adapter.js `toc.search` 改造**：

```javascript
search: function (keyword) {
    var q = (keyword || '').trim().toLowerCase();
    if (!q) return [];
    var bookId = _getCurrentBookId();
    if (!bookId) return [];

    var terms = q.split(/\s+/).filter(Boolean);
    var results = [];

    // --- 阶段1：标题匹配（即时，无需索引）---
    var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
    if (chapterItems.length > 0) {
        for (var i = 0; i < chapterItems.length; i++) {
            var el = chapterItems[i];
            var numEl = el.querySelector('.bk-toc-chapter-num');
            var titleEl = el.querySelector('.bk-toc-chapter-title');
            var num = numEl ? parseInt(numEl.textContent.trim(), 10) : (i + 1);
            var title = titleEl ? titleEl.textContent.trim() : '';
            var hayTitle = title.toLowerCase();
            var titleMatch = true;
            for (var j = 0; j < terms.length; j++) {
                if (hayTitle.indexOf(terms[j]) === -1) { titleMatch = false; break; }
            }
            if (titleMatch) {
                results.push({
                    id: 'toc-' + num, title: title, num: num,
                    depth: 0, position: i,
                    isActive: el.classList.contains('bk-toc-current'),
                    element: el, context: '', score: 2
                });
            }
        }
    }

    // --- 阶段2：全文匹配（复用内容索引）---
    var DM = win.DataManager;
    if (DM && DM.getContentIndexMap) {
        var indexMap = DM.getContentIndexMap();
        if (!indexMap) {
            // 索引未加载：异步加载后重新搜索
            if (DM.loadContentIndexes) {
                DM.loadContentIndexes().then(function () {
                    // 重新触发搜索
                    var pane = document.getElementById('bk-mp-pane-toc');
                    if (pane) MarkPanel._onTocSearch(keyword);
                });
            }
            // 先返回标题匹配结果
            return results;
        }
        var bookIdx = indexMap[bookId];
        if (bookIdx && bookIdx.chapters) {
            var chapters = bookIdx.chapters;
            for (var c = 0; c < chapters.length; c++) {
                var ch = chapters[c];
                var hayTitle = (ch.t || '').toLowerCase();
                var hayContent = (ch.c || '').toLowerCase();
                var hayCombined = hayTitle + ' ' + hayContent;
                var allMatch = true;
                for (var j = 0; j < terms.length; j++) {
                    if (hayCombined.indexOf(terms[j]) === -1) { allMatch = false; break; }
                }
                if (!allMatch) continue;

                // 跳过已通过标题匹配添加的结果
                var chNum = ch.n;
                var dup = false;
                for (var r = 0; r < results.length; r++) {
                    if (results[r].num === chNum) { dup = true; break; }
                }
                if (dup) continue;

                // 提取上下文片段
                var context = '';
                if (hayContent) {
                    var firstPos = -1;
                    for (var t = 0; t < terms.length; t++) {
                        var p = hayContent.indexOf(terms[t]);
                        if (p !== -1 && (firstPos === -1 || p < firstPos)) firstPos = p;
                    }
                    if (firstPos !== -1) {
                        var ctxFrom = Math.max(0, firstPos - 30);
                        var ctxTo = Math.min(hayContent.length, firstPos + 30);
                        context = (ctxFrom > 0 ? '…' : '') +
                            ch.c.substring(ctxFrom, ctxTo) +
                            (ctxTo < hayContent.length ? '…' : '');
                    }
                }

                results.push({
                    id: 'toc-' + chNum,
                    title: ch.t || ('第' + chNum + '章'),
                    num: chNum, depth: 0,
                    position: results.length,
                    isActive: false,
                    context: context, score: 1,
                    chapterNum: chNum, bookId: bookId
                });
            }
        }
    }

    // 按评分排序：标题匹配(score 2)优先
    results.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return results;
}
```

**mark-panel.js `_renderEpubToc` 扩展**：

渲染时检查 item.context，若有则显示上下文片段：

```javascript
// 在 _renderEpubToc 中，title 之后追加 context
if (item.context) {
    var ctx = document.createElement('div');
    ctx.className = 'bk-mp-toc-context';
    // 高亮关键词
    ctx.innerHTML = MarkPanel._highlightContext(item.context, MarkPanel._searchQuery);
    li.appendChild(ctx);
}
```

**mark-panel.js 新增高亮方法**（复用 search.js 的 `_highlightText` 逻辑）：

```javascript
_highlightContext: function (text, query) {
    if (!query || !query.trim()) return esc(text);
    var terms = query.trim().split(/\s+/).filter(Boolean);
    var html = esc(text);
    for (var i = 0; i < terms.length; i++) {
        var re = new RegExp('(' + escRe(terms[i]) + ')', 'gi');
        html = html.replace(re, '<span class="bk-mp-toc-hl">$1</span>');
    }
    return html;
}
```

**搜索查询缓存**：在 `_onTocSearch` 中保存当前查询词：

```javascript
_onTocSearch: function (keyword) {
    MarkPanel._searchQuery = keyword;
    // ... 其余不变
}
```

旧 TOC Drawer（`renderer-toc-drawer.js` 的 `_fillTocDrawer`）保持不变，不添加纲目展开功能。原因：
- 旧 Drawer 已退化为双栏模式常驻左栏，不是主入口
- MarkPanel 是当前主入口，手机端和大部分场景都走 MarkPanel
- 避免两套代码都改，降低维护成本

## 五、CSS 样式

新增样式（`css-mark-panel.css`）：

```css
/* ── TOC 纲目展开（EPUB）────────────────────── */
.bk-mp-toc-item-wrapper {
    border-bottom: 1px solid var(--border, #E5E2DD);
}

.bk-mp-toc-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    /* ... 继承现有样式 ... */
}

.bk-mp-toc-toggle {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    color: var(--text-muted, #888);
    cursor: pointer;
    font-size: 0.7em;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.2s;
}
.bk-mp-toc-toggle:empty {
    visibility: hidden;
}

.bk-mp-toc-outline {
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--surface-alt, #F7F5F2);
}
.bk-mp-toc-outline-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px 7px 0;
    font-size: 0.9em;
    color: var(--text-muted, #9A958C);
    border-bottom: 1px solid var(--border, rgba(0,0,0,0.04));
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.15s, color 0.15s;
}
.bk-mp-toc-outline-item:active {
    background: var(--nav-hover, #ECEAE5);
    color: var(--text, #1A1918);
}
.bk-mp-toc-outline-dot {
    color: var(--text-muted, #ccc);
    flex-shrink: 0;
    margin-left: 4px;
}
.bk-mp-toc-outline-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.4;
}

/* ── 全文搜索上下文片段 ────────────────────── */
.bk-mp-toc-context {
    font-size: 0.82em;
    color: var(--text-muted, #9A958C);
    line-height: 1.5;
    padding: 2px 0 4px 38px;  /* 与 title 左对齐，num+toggle 宽度 */
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-all;
}
.bk-mp-toc-hl {
    color: var(--brand, #3D8A5A);
    font-weight: 600;
    background: rgba(61, 138, 90, 0.12);
    border-radius: 2px;
    padding: 0 1px;
}
.bk-mp-toc-loading-hint {
    padding: 8px 16px;
    font-size: var(--text-xs);
    color: var(--text-muted, #9A958C);
    text-align: center;
}
```

## 六、影响范围

### 需修改的文件（src 副本）

| 文件 | 修改内容 |
|------|---------|
| `src/static/js/mark-panel/adapters/epub-adapter.js` | 新增 `toc.getOutlines()`、`toc.navigateOutline()`；改造 `toc.search()` 为全文搜索 |
| `src/static/js/mark-panel/mark-panel.js` | 改造 `_renderEpubToc()`（支持展开+context），新增 `_toggleOutline()`、`_highlightContext()` |
| `src/static/css/style/css-mark-panel.css` | 新增纲目展开样式 + 全文搜索上下文片段样式 |

### 不需修改的文件

| 文件 | 原因 |
|------|------|
| `renderer-content.js` | heading 渲染已有 `.bk-heading` 类名，无需修改 |
| `renderer-toc-drawer.js` | 旧 Drawer 保持不变 |
| `renderer-carousel.js` | carousel DOM 结构不变 |
| `dm-api.js` / `search.js` | 内容索引和搜索算法已有，直接复用，不需修改 |
| 解析器（import-*.js） | 数据结构不变 |
| `pdf-adapter.js` | PDF 已有树形目录，不影响 |

### 三副本同步

按项目约定，修改的 3 个文件需同步到：
- `src/static/js/mark-panel/adapters/epub-adapter.js`
- `src/static/js/mark-panel/mark-panel.js`
- `src/static/css/style/css-mark-panel.css`
- `output/static/js/mark-panel/adapters/epub-adapter.js`
- `output/static/js/mark-panel/mark-panel.js`
- `output/static/css/style/css-mark-panel.css`
- `android/app/src/main/assets/public/js/mark-panel/adapters/epub-adapter.js`
- `android/app/src/main/assets/public/js/mark-panel/mark-panel.js`
- `android/app/src/main/assets/public/css/style/css-mark-panel.css`

共 3 文件 × 3 副本 = 9 处同步。

## 七、边界情况

### 纲目展开
1. **章节无 heading**：纲目列表为空，展开箭头隐藏（`visibility: hidden`），不影响章节点击
2. **大章节（heading 很多）**：纲目子列表天然受目录面板滚动支持，无需特殊处理
3. **章节尚未加载**（loadBook 失败）：展开箭头显示错误状态，点击章节仍可正常跳转
4. **carousel 中已渲染的章节**：优先从可见 DOM 提取 heading，避免重复渲染
5. **滚动定位时 heading 不在视口**：`scrollIntoView({ block: 'start' })` 确保滚动到顶部
6. **暗色主题**：纲目子列表使用 CSS 变量（`--surface-alt`、`--text-muted` 等），自动适配

### 全文搜索
7. **内容索引未加载**（冷启动）：先返回标题匹配结果，异步加载索引后自动补充全文结果
8. **无内容索引**（未下载未导入的书）：仅做标题匹配，不报错
9. **搜索时纲目展开状态**：搜索模式下纲目子列表自动收起，退出搜索后恢复
10. **搜索结果为空**：显示"无匹配章节"提示
11. **大书全文搜索性能**：240 万字 indexOf 扫描约 10-50ms，加 200ms 防抖完全无感
12. **多关键词搜索**：空格分隔的多个关键词为 AND 逻辑（复用现有 `_searchContent` 算法）

## 八、YAGNI 排除

以下功能**不实现**：
- 纲目搜索（搜索只搜索正文+标题，不搜索纲目标题文本——纲目通过展开浏览）
- 纲目多级嵌套树形展开（纲目为扁平列表 + 缩进，不做递归树）
- 纲目展开状态持久化（仅内存缓存，关闭面板后重置）
- 旧 TOC Drawer 的纲目展开（仅 MarkPanel 支持）
- 纲目数量徽章（不显示 heading 数量）
- 全文搜索高亮滚动定位（点击搜索结果只跳转到章节，不自动滚动到正文匹配位置——过于复杂且 DOM 重建后位置不稳定）
- 引入第三方搜索库（lunr.js 等，违背原生架构）

> AI生成