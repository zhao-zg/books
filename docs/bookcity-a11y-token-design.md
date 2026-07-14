# 书城方案 5 / 6 增量设计文档（a11y 键盘可达 + 漏色令牌化）

> 本文件为方案 1–4 之上的**增量设计**，真理源为 `src/static/`。
> **请勿覆盖** `docs/system_design.md` / `docs/class-diagram.mermaid` / `docs/sequence-diagram.mermaid`（方案 1–4 文档）。
> 时序图 / 类图内嵌于本文件，未另写独立 `.mermaid` 文件，以防覆盖方案 1–4 资源。

---

## 0. 代码现状确认（Grep / Read 实证）

| 关注点 | 真实位置 | 现状 |
|---|---|---|
| L1 分类卡 | `renderer.js:2458` | `<div class="category-card" data-category data-category-prefix>` —— **无 role / tabindex** |
| L2 系列卡 | `renderer.js:2487` | `<div class="series-catalog-card" data-series>` —— **无 role / tabindex** |
| L3 书卡链接 | `_buildBookCard` `renderer.js:1223` | `.book-link` **已有 `role="button" tabindex="0"`**（焦点可达），但**无 keydown 绑定** |
| `_buildBookCard` 漏色 | `renderer.js:1231` | `cache-status` 内联 `color: (downloaded ? '#4caf50' : '#999')` —— **硬编码漏色** |
| 下载态漏色 | `_handleBookClick` `renderer.js:1303` / `1312` | `#4caf50` / `#999` 运行时写 `style.color`（同族漏色，建议顺带令牌化） |
| 书城事件绑定 | `_bindCityEvents` `renderer.js:2594-2655` | **仅 `click` 委托**（`homeView.addEventListener('click', onClick)`），**无 keydown**；守卫 `_cityEventsBound`（2341 / 2595）保证仅绑一次 |
| L3 keydown 现状 | 全局 grep `keydown` | 仅 710/715（阅读快捷键）、1970/1980（TOC Esc）；**书城卡（L1/L2/L3）均无 keydown** |
| 令牌定义 | `style.css:6-7`、`:56-57` | `--brand:#3D8A5A`、`--text-muted:#9A958C` 已在 `:root` 定义 |
| cache-status 类 | `style.css:1561-1562` | `.cache-status{color:var(--text-muted)}`、`.cache-status.success{color:var(--success-text,#3D8A5A)}` 已存在 |

**结论（回应审查结论）**：
- 方案 5 的 L3 书卡「仅加属性不自动键盘可达」**确证**：`.book-link` 有 role/tabindex 但**缺 keydown**；L1/L2 连 role/tabindex 都没有。三者在 `_bindCityEvents` 均无 keydown。
- 方案 6 的漏色**确证**：`_buildBookCard:1231` 内联 `#4caf50` / `#999`，是本次 scope 内**唯一**位于 `_buildBookCard` 中的漏色（行 1228 的 `var(--series-color)` 彩虹注入不在 scope 内）。

---

## 1. 实现方案 + 框架选型

- **技术栈**：原生 JS + CSS（与现状一致），最小变更原则，**不引入任何新框架 / 依赖**。
- **方案 6（漏色令牌化）—— 选「内联 `var()` 替换」，不重写结构**：
  - `renderer.js:1231` 的 `style="color:...;font-size:0.75em"` 仅把 `#4caf50` → `var(--brand)`、`#999` → `var(--text-muted)`，**保留 `font-size:0.75em`**（避免触发 `.zl-book-card .cache-status{font-size:var(--text-lg)}` 把图标放大，零视觉回归）。
  - 令牌取 `:root` 既有 `--brand` / `--text-muted`，与 Soft Nordic 完全一致。
  - 同族漏色（`_handleBookClick` 1303 / 1312 下载态）建议**同一任务顺带**令牌化：运行时 `iconEl.style.color` 由 `#4caf50` / `#999` 改为 `var(--brand)` / `var(--text-muted)`（或切 `.cache-status.success` 类），保证下载成功 / 失败回退也走令牌。
- **方案 5（a11y 键盘可达）**：
  - T02 给 L1/L2 卡补 `role="button" tabindex="0"`（L3 `.book-link` 已有，无需改）；并在 `style.css` 补 `:focus-visible` 描边，让键盘焦点可见（a11y 必需）。
  - T03 在 `_bindCityEvents` **新增 `keydown` 委托**（与 `click` 同处、同 `_cityEventsBound` 守卫）：L1/L2/L3 各自 `closest()` 命中后，Enter(13) / Space(32) → `e.preventDefault()`（Space 防页面滚动）→ 调用与 `click` **完全相同**的下钻 / 打开闭包。因 `<div role=button>` **不会自动 fire click**，keydown 与 click 不会重复触发。

---

## 2. 文件列表（相对路径）

- `src/static/js/renderer.js`（改：T01 行 1231 / 1303 / 1312 令牌化；T02 行 2458 / 2487 加 role/tabindex；T03 `_bindCityEvents` 加 keydown）
- `src/static/css/style.css`（改：T02 新增 `.category-card:focus-visible` / `.series-catalog-card:focus-visible` / `.book-link:focus-visible` 描边）
- `tests/ui/test-bookcity.js`（改：T04 新增 BC-15 / BC-16，由 QA 自写）
- `docs/bookcity-a11y-token-design.md`（**新增**：本增量设计文档，勿覆盖方案 1–4 文档）

---

## 3. 数据结构与接口（类图）

**无新增数据结构 / 类**。复用既有 `BKRenderer` 模块与 `BKRouter` / `BKShelf` 实例。下图以类图形式标注本次改动点（★ = 方案 6 改，▲ = 方案 5 改）。

```mermaid
classDiagram
    class BKRenderer {
        +renderCityPage()
        +renderSeriesPage(seriesId)
        -_renderCityHome(homeView)  ▲加 role/tabindex
        -_renderCitySeriesList(homeView,cat,prefix)  ▲加 role/tabindex
        -_renderCityBookList(homeView,seriesId,cat,prefix)
        -_buildBookCard(book,opts)  ★令牌化漏色(1231)
        -_bindCityEvents(homeView)  ▲新增 keydown 委托
        -_handleBookClick(bookId,series,cardEl)  ★令牌化下载态(1303/1312)
    }
    class BKRouter {
        +navigate(path)
    }
    class BKShelf {
        +add(bookId)
        +isRead(bookId)
    }
    BKRenderer ..> BKRouter : navigate('book/&lt;id&gt;')
    BKRenderer ..> BKShelf : add(bookId)
    note for BKRenderer "L1/L2/L3 卡事件（click + keydown）\n统一在 _bindCityEvents 委托于 homeView\n由 _cityEventsBound 守卫仅绑一次"
```

---

## 4. 程序调用流程（时序图）

键盘聚焦 L1/L2 卡 → Enter / Space → 触发与点击等效的下钻闭包；L3 书卡 Enter / Space → 打开阅读。

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant KB as 键盘
    participant HV as homeView
    participant BE as _bindCityEvents(keydown)
    participant R as _renderCity*(下钻 / 打开)

    Note over HV: L1 分类卡 role=button tabindex=0
    User->>KB: Tab 聚焦 .category-card
    User->>KB: Enter / Space
    KB->>HV: keydown(key=13/32)
    HV->>BE: 委托 keydown
    BE->>BE: e.target.closest('.category-card')
    BE->>BE: e.preventDefault()  %% Space 防页面滚动
    BE->>R: _renderCitySeriesList(homeView,cat,prefix)
    R-->>HV: 渲染 L2 列表

    Note over HV: L2 系列卡 role=button tabindex=0
    User->>KB: Enter / Space
    KB->>HV: keydown
    HV->>BE: 委托
    BE->>BE: closest('.series-catalog-card'); preventDefault()
    BE->>R: _renderCityBookList(homeView,seriesId,cat,prefix)
    R-->>HV: 渲染 L3 书列表

    Note over HV: L3 .book-link role=button tabindex=0
    User->>KB: Enter / Space
    KB->>HV: keydown
    HV->>BE: 委托
    BE->>BE: closest('.book-link[data-book-id]'); preventDefault()
    BE->>BE: BKShelf.add(bookId)
    BE->>R: _handleBookClick(bookId,series,bookLink)
    R->>R: 已下载 → BKRouter.navigate(bookId[/progress])
    R->>R: 未下载 → downloadBook → navigate
```

> 说明：click 流程与 keydown 完全对称（同一 `closest()` 命中 + 同一渲染闭包）；因 `<div role=button>` 不会自动派发 click，keydown 与 click 不会重复触发。

---

## 5. 任务列表（有序，含依赖、按实现顺序）

### T01（P0）方案 6 · 漏色令牌化
- **源文件**：`src/static/js/renderer.js`
- **改动**：`_buildBookCard` 行 1231 内联 `color:' + (downloaded ? '#4caf50' : '#999')` → `' + (downloaded ? 'var(--brand)' : 'var(--text-muted)')`（保留 `font-size:0.75em`）。
- **同任务顺带（一致性，建议）**：`_handleBookClick` 行 1303 / 1312 `iconEl.style.color = '#4caf50'` / `'#999'` → `'var(--brand)'` / `'var(--text-muted)'`。
- **依赖**：无。
- **验收**：grep `renderer.js` 在方案 6 scope 内无 `#4caf50` / `#999`（1303 / 1312 改后亦无）；视觉表现不变。

### T02（P0）方案 5 · L1/L2 卡 role/tabindex + 焦点可见
- **源文件**：`src/static/js/renderer.js`、`src/static/css/style.css`
- **改动（JS）**：`_renderCityHome` 行 2458 `<div class="category-card" ...>` 加 `role="button" tabindex="0"`；`_renderCitySeriesList` 行 2487 `<div class="series-catalog-card" ...>` 加 `role="button" tabindex="0"`。
- **改动（CSS）**：新增 `.category-card:focus-visible`、`.series-catalog-card:focus-visible`、`.book-link:focus-visible` `{ outline: 2px solid var(--brand); outline-offset: 2px; }`（L3 `.book-link` 也补，因原无焦点描边）。
- **依赖**：无。
- **验收**：L1/L2 卡 DOM 中含 `role="button"` 与 `tabindex="0"`；Tab 聚焦可见 sage 描边。

### T03（P0）方案 5 · 键盘事件委托
- **源文件**：`src/static/js/renderer.js`
- **改动**：在 `_bindCityEvents`（行 2594 函数体内、`homeView.addEventListener('click', onClick)` 附近）**新增** `homeView.addEventListener('keydown', onKeyDown)`，受同一 `_cityEventsBound` 守卫（仅绑一次）。`onKeyDown` 复用 `onClick` 的 `closest()` 命中逻辑：
  - `.category-card` → `e.preventDefault(); _renderCitySeriesList(...)`
  - `.series-catalog-card` → `e.preventDefault(); _renderCityBookList(...)`
  - `.book-link[data-book-id]` → `e.preventDefault(); BKShelf.add(bookId); _handleBookClick(bookId,series,bookLink)`
  - 触发键：`e.key === 'Enter' || e.key === ' '` 或 `e.keyCode === 13 || e.keyCode === 32`；命中后 `e.preventDefault()`（**Space 必须防页面滚动**）；未命中则不拦截。
- **依赖**：T02（role/tabindex 是键盘可达语义前提；`.book-link` 已具备）。
- **验收**：L1/L2/L3 卡键盘聚焦后 Enter 或 Space 触发与鼠标点击等效行为；Space 不滚动页面。

### T04（P1）测试对齐
- **源文件**：`tests/ui/test-bookcity.js`
- **改动（由 QA 自写，仅交付测试点）**：
  - **BC-15（a11y）**：断言 L1 `.category-card` 与 L2 `.series-catalog-card` 含 `role="button"` 且 `tabindex="0"`；模拟 `keydown`（Enter 13 与 Space 32）于聚焦卡，断言触发下钻（L1→L2 渲染、L2→L3 渲染）；断言 Space 不触发页面滚动（preventDefault 生效）。
  - **BC-16（令牌化）**：断言 `_buildBookCard` 输出的书卡 `cache-status` 不含 `#4caf50` / `#999`，改用 `var(--brand)` / `var(--text-muted)`（或 `.cache-status.success` 类）；可选断言下载成功 / 失败回退色也走令牌。
- **依赖**：T01、T02、T03（测已实现行为）。
- **验收**：BC-15 / BC-16 在 jsdom（加载 `index.html` + 顺序 eval 7 模块）下通过。

---

## 6. 依赖包列表

- **无新增依赖**。纯原生 JS / CSS 改动。

---

## 7. 共享知识（跨文件约定）

- **键盘事件统一位置**：书城所有卡（L1/L2/L3）的 `click` 与 `keydown` 事件**统一在 `_bindCityEvents` 委托于 `homeView`**，事件委托（非逐卡绑定），随 `_cityEventsBound` 守卫仅绑一次。
- **颜色一律走 Soft Nordic 令牌**：漏色统一用 `:root` 既有 `--brand`(#3D8A5A) / `--text-muted`(#9A958C) / `--brand-rgb`；**禁止**硬编码 `#4caf50` / `#999` / `#3c8a5a` 等。单强调色纪律（禁彩虹、禁纯黑、禁紫）。
- **keydown 处理 Enter / Space 必须 `preventDefault`**：Space(32) 防页面滚动；Enter(13) 同理防默认；因 `<div role=button tabindex=0>` 不自动 fire click，**不要**在 keydown 中再手动 dispatch click，避免重复触发。
- **L3 `.book-link` 既有 `role` / `tabindex` 不变**，本次仅补 keydown 与焦点描边。

---

## 8. 待明确事项

1. **L3 书卡 keydown 当前是否已绑定？** —— 已确认**未绑定**。全局 grep `keydown` 仅在阅读快捷键(710/715)、TOC Esc(1970/1980) 出现；`_bindCityEvents` 与 `_buildBookCard` 均无 keydown。故 T03 在 `_bindCityEvents` 统一补齐 L1/L2/L3 三者 keydown（L3 为「补绑定」，非「验证已存在」）。
2. **绑定位置**：L1/L2/L3 keydown 统一放 `_bindCityEvents`（与 click 同一委托体），不在 `_buildBookCard` 内联、也不新增 `_bindBookCardEvents`（grep 确认该函数不存在）。不引用 `_bindBookCardEvents`。
3. **方案 6 是内联 style 还是 CSS 类？** —— 选定**内联 `var(--brand)` / `var(--text-muted)` 替换**（保留 `font-size:0.75em`），零视觉回归、最稳。`.cache-status.success` 类已存在可作为等价备选，但内联-var 更可控（避免 `.zl-book-card .cache-status{font-size:var(--text-lg)}` 放大）。工程师若改类方案需自行验证无字号回归。
4. **scope 边界**：`_buildBookCard` 行 1228 的 `.bk-series-dot` 背景 `var(--series-color)` 彩虹注入**不改**（收敛风 follow-up，本次 scope 外）；仅令牌化 `#4caf50` / `#999` 漏色。其余漏色点（如 `_buildShelfBadge` 1443、1594 等）若属同族可视情况顺带，但非方案 6 强制 scope；本设计仅把 `_handleBookClick`(1303/1312) 列为「建议顺带」。
5. **文档隔离**：本增量设计写入 `docs/bookcity-a11y-token-design.md`；**未**覆盖 `docs/system_design.md` / `docs/class-diagram.mermaid` / `docs/sequence-diagram.mermaid`（方案 1–4）。时序图 / 类图内嵌本文，未另写独立 `.mermaid` 文件以防覆盖方案 1–4 资源。
