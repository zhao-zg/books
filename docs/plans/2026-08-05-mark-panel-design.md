---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '782f6097-a41b-4186-a120-885aa1b33764'
  PropagateID: '782f6097-a41b-4186-a120-885aa1b33764'
  ReservedCode1: '484e48cd-7951-4ebf-b8d1-89df4b6fce15'
  ReservedCode2: '484e48cd-7951-4ebf-b8d1-89df4b6fce15'
---

# 统一标记面板（MarkPanel）重构设计

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 将分散的目录/书签/高亮标记功能合并为一个统一的左侧抽屉面板，3 Tab 切换（目录|书签|标记），EPUB 和 PDF 共享同一套 UI 组件。

**Architecture:** 采用适配器模式，MarkPanel 统一 UI 组件通过适配器抽象各端数据差异。EPUB 和 PDF 各实现一套适配器，MarkPanel 只调用适配器接口，不直接操作底层数据。条目采用紧凑列表 + 左侧颜色条，按页码排序。

**Tech Stack:** 纯前端 HTML/CSS/JS，无框架依赖，复用现有 BKStorage/BKBookmark/pdf-state 等数据层。

---

## 一、设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 重构范围 | 只重构统一面板，数据层保留 | 改动适中，风险可控 |
| 面板形式 | 左侧抽屉 | 与现有 TOC 抽屉位置一致，用户习惯不变 |
| Tab 结构 | 3 Tab: 目录 \| 书签 \| 标记 | 微信读书风格，用户最熟悉 |
| 条目样式 | 紧凑列表 + 左侧颜色条 | 主流做法，信息密度高 |
| 排序方式 | 按页码顺序 | 符合阅读顺序 |
| 实现架构 | 统一组件 + 适配器 | EPUB/PDF 共享 UI，体验完全一致 |

---

## 二、架构概览

### 2.1 组件关系图

```
┌─────────────────────────────────────────────────────┐
│              MarkPanel（统一左侧抽屉）                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Header: 书名 + 关闭按钮                       │  │
│  ├───────────────────────────────────────────────┤  │
│  │  Tab Bar: [目录] [书签] [标记]                  │  │
│  ├───────────────────────────────────────────────┤  │
│  │  Content Area（按 Tab 切换内容）                │  │
│  │                                               │  │
│  │  Tab=目录 → TocAdapter.getItems()             │  │
│  │            → 统一渲染 TocList                  │  │
│  │                                               │  │
│  │  Tab=书签 → BookmarkAdapter.getItems()        │  │
│  │            → 统一渲染 MarkList                 │  │
│  │                                               │  │
│  │  Tab=标记 → MarkAdapter.getItems()            │  │
│  │            → 统一渲染 MarkList                 │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Footer: [添加当前页书签] / 统计信息             │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐         ┌────▼────┐
    │EPUB适配器│         │PDF 适配器│
    ├─────────┤         ├─────────┤
    │Toc:     │         │Toc:     │
    │ renderer│         │ pdf-    │
    │ -toc-   │         │ outline │
    │ drawer  │         │         │
    │         │         │         │
    │Bookmark:│         │Bookmark:│
    │ BKBook- │         │ pdf-    │
    │ mark    │         │ state   │
    │         │         │         │
    │Mark:    │         │Mark:    │
    │ BKStor- │         │ pdf-    │
    │ age     │         │ state   │
    └─────────┘         └─────────┘
```

### 2.2 适配器接口定义

```javascript
// 目录适配器接口
const TocAdapter = {
  getItems() {},        // → [{id, title, depth, page/position, isActive}]
  navigate(item) {},    // 跳转到指定位置
  hasSearch() {},       // → Boolean，是否支持搜索
  search(keyword) {},   // → 过滤后的 items
};

// 书签适配器接口
const BookmarkAdapter = {
  getItems() {},           // → [{id, title, subtitle, position, timestamp, note}]
  add(position) {},        // 添加当前页书签
  remove(id) {},           // 删除书签
  updateTitle(id, title) {},// 修改标题
  updateNote(id, note) {}, // 修改笔记
  navigate(item) {},       // 跳转
  hasCurrentPage() {},     // → Boolean，当前页是否已有书签
  toggleCurrentPage() {},  // 切换当前页书签
};

// 标记适配器接口
const MarkAdapter = {
  getItems() {},           // → [{id, text, color, type, note, position, timestamp}]
  remove(id) {},           // 删除标记
  navigate(item) {},       // 跳转
  getColors() {},          // → ['yellow','green','blue','pink','orange']
  filterByType(type) {},   // 按类型筛选
  filterByColor(color) {}, // 按颜色筛选
};
```

---

## 三、各 Tab 详细设计

### 3.1 目录 Tab

**EPUB 端**：复用现有 `renderer-toc-drawer.js` 的数据获取逻辑，抽屉内平铺章节列表，保留搜索功能。

**PDF 端**：复用 `pdf-outline.js` 的递归树形渲染，支持展开/折叠。

**统一渲染**：由于 EPUB 是平铺列表、PDF 是树形结构，目录 Tab 采用**双模式渲染**：
- 平铺模式（EPUB）：每行 = 序号 + 章节标题 + 「在读」徽章
- 树形模式（PDF）：每行 = 缩进 + ▸/▾ 切换 + 标题 + 页码

### 3.2 书签 Tab

**条目结构**：
```
┌─ 颜色条 ─┬─────────────────────────────────────┐
│ 🟠(4px)  │ 书签标题（粗体）                      │
│          │ 章节名 · 页码 · 3分钟前               │
│          │ 笔记摘要预览（灰色缩进，如有）           │
└──────────┴─────────────────────────────────────┘
```

- 颜色条：固定橙色（书签专属颜色），4px 宽，圆角
- 标题行：书签名，可编辑
- 元信息行：章节/页码 + 相对时间
- 笔记行：如有笔记则缩进折叠显示（最多2行，溢出省略）
- 操作：左滑显示删除按钮，点击跳转，长按编辑

**Footer**：添加当前页书签按钮（outline 样式），当前页已有书签时变为「移除当前页书签」

### 3.3 标记 Tab

**条目结构**：
```
┌─ 颜色条 ─┬─────────────────────────────────────┐
│ 🟡(4px)  │ 选中原文摘要（粗体）                   │
│          │ 章节名 · 页码 · 高亮/下划线/删除线      │
│          │ 笔记摘要预览（灰色缩进，如有）           │
└──────────┴─────────────────────────────────────┘
```

- 颜色条：与高亮颜色一致（yellow/green/blue/pink/orange），4px 宽
- 原文行：选中文字摘要，最多3行
- 元信息行：章节/页码 + 类型标签 + 相对时间
- 笔记行：如有笔记则缩进折叠显示
- 操作：左滑删除，点击跳转并高亮选中

**筛选栏**（标记 Tab 专属）：
```
[全部] [🖍高亮] [U̲下划线] [S̶删除线] [📝批注]
```
pill 样式标签，点击筛选，选中的标签高亮。

---

## 四、交互设计

### 4.1 抽屉行为

| 行为 | 说明 |
|------|------|
| 打开 | 底栏「目录/书签」按钮 → 打开抽屉，默认显示目录 Tab |
| 关闭 | 点击遮罩 / ESC / 返回键 / 关闭按钮 |
| Tab 切换 | 点击 Tab 栏切换内容，不关闭抽屉 |
| 记忆上次 Tab | 下次打开恢复上次选择的 Tab |
| 跳转后行为 | 点击条目跳转后**不关闭抽屉**（方便连续浏览），5秒无操作后自动关闭 |

### 4.2 条目交互

| 操作 | 行为 |
|------|------|
| 单击 | 跳转到对应位置 |
| 长按 | 弹出编辑菜单（编辑标题/笔记/删除） |
| 左滑 | 显示删除按钮（红色） |
| 右滑恢复 | 隐藏删除按钮 |

### 4.3 与阅读页面的联动

- 打开 MarkPanel 时不暂停阅读
- 在 MarkPanel 中跳转，阅读页面平滑滚动/翻页到目标位置
- EPUB 端：跳转后高亮闪烁目标段落 1 秒
- PDF 端：跳转后高亮闪烁目标标注 1 秒

---

## 五、数据流

### 5.1 读取流程

```
MarkPanel.open()
  → 检测当前阅读类型（EPUB/PDF）
  → 实例化对应适配器（EpubAdapter / PdfAdapter）
  → activeTab.getItems()
  → 渲染列表
```

### 5.2 写入流程

```
用户操作（删除/编辑）
  → MarkPanel 调用适配器方法
  → 适配器调用底层 BKBookmark / BKStorage / pdf-state
  → 底层完成 CRUD
  → 适配器返回最新数据
  → MarkPanel 重新渲染受影响的条目（局部更新，非全量）
```

### 5.3 外部变更同步

当用户在阅读页通过选区菜单添加/删除高亮时：
- MarkPanel 如果处于打开状态，监听自定义事件 `marks-changed`
- 收到事件后刷新当前 Tab 数据

---

## 六、组件文件规划

| 文件 | 职责 |
|------|------|
| `src/static/js/mark-panel/mark-panel.js` | 主控：抽屉创建/显示/隐藏、Tab切换、事件分发 |
| `src/static/js/mark-panel/mark-list.js` | 通用列表渲染：紧凑列表+颜色条+左滑删除 |
| `src/static/js/mark-panel/adapters/epub-adapter.js` | EPUB 适配器（目录/书签/标记三合一） |
| `src/static/js/mark-panel/adapters/pdf-adapter.js` | PDF 适配器（目录/书签/标记三合一） |
| `src/static/js/mark-panel/mark-utils.js` | 工具函数：时间格式化、文本截断、颜色映射 |
| `src/static/css/style/css-mark-panel.css` | 全部样式 |

---

## 七、兼容性策略

### 7.1 旧入口迁移

| 旧入口 | 迁移方式 |
|--------|---------|
| 底栏「目录」按钮 | → 打开 MarkPanel，Tab=目录 |
| 底栏「书签」按钮（EPUB） | → 打开 MarkPanel，Tab=书签 |
| 底栏「书签」按钮（PDF） | 短按仍 toggle 当前页书签，长按打开 MarkPanel，Tab=书签 |
| 底栏🖍高亮按钮（PDF） | → 打开 MarkPanel，Tab=标记 |
| BKNoteSummary.show() | → 打开 MarkPanel，Tab 对应 |
| BKBookmark.showList() | → 打开 MarkPanel，Tab=书签 |

### 7.2 旧代码保留

- `bookmark.js`、`highlight-*.js`、`pdf-bookmark.js`、`pdf-highlight.js` **保留不删**，MarkPanel 通过适配器调用它们
- `renderer-toc-drawer.js` 的 DOM 渲染逻辑迁移到适配器，原文件标记为 deprecated
- `BKNoteSummary` 标记为 deprecated，所有调用方改为打开 MarkPanel

---

## 八、错误处理

- 适配器 `getItems()` 失败 → 显示空状态 + 重试按钮
- 删除操作失败 → Toast 提示「删除失败」
- 跳转失败 → Toast 提示「无法跳转到该位置」
- IndexedDB/localStorage 不可用 → 降级显示空列表 + 提示

---

## 九、不做的事（YAGNI）

- 不统一 PDF 和 EPUB 的数据存储后端（保持各自 IndexedDB/localStorage）
- 不修改高亮/书签的数据模型字段
- 不添加撤销栈到通用高亮（后续可独立做）
- 不做跨书籍的标记汇总（只在单本书内）
- 不做标记导出功能（已有独立导出模块）
- 不做 AI 摘要/智能标注功能