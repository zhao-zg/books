---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd7f3abda-af8d-46c1-9f3f-e57e10161fa0'
  PropagateID: 'd7f3abda-af8d-46c1-9f3f-e57e10161fa0'
  ReservedCode1: '0b8017cc-dd46-4b3a-b3b6-3afe5e5419c4'
  ReservedCode2: '0b8017cc-dd46-4b3a-b3b6-3afe5e5419c4'
---

# 跨设备同步阅读进度与笔记 — 设计文档

> 日期：2026-08-31
> 状态：待评审
> 项目：书报（books）— Capacitor 移动阅读应用

## 1. 背景与目标

用户在多设备（手机、平板、PWA）间阅读同一本书时，阅读进度、书签、划线笔记、书架记录无法同步。

**根因**：现有 `export-batch.js` → `import-zip.js` 的 `userdata.json` 只覆盖了部分数据：

| 数据 | 存储位置 | 当前 ZIP 导出 |
|---|---|---|
| 阅读进度（章节/滚动/PDF页码） | localStorage | ✅ 已覆盖 |
| PDF 书签/高亮 | localStorage | ✅ 已覆盖 |
| EPUB 书签 | IndexedDB `bookmarks`（单键数组） | ❌ 缺失 |
| EPUB 划线/笔记 | IndexedDB `highlights`（每页一键） | ❌ 缺失 |
| 书架笔记/评分/读完标记 | localStorage `bk_shelf:` | ❌ 缺失 |

**目标**：通过 ZIP 手动导出/导入，实现跨设备同步「阅读进度 + 书签 + 划线笔记 + 书架信息」，支持两种模式（仅数据 / 数据+书），导入采用**合并策略**（不丢任何一端数据）。

**非目标**：
- 不做自动云同步（用户已确认选 ZIP 手动方案）
- 不做 WebDAV/GitHub 同步
- 不改动现有阅读器/笔记核心存储结构

## 2. 设计原则

1. **兼容旧版**：旧版 v1/v2 导出的 ZIP 仍可导入（无书签/高亮字段时跳过）
2. **合并优先**：导入是「合并」不是「覆盖」——书签/高亮按 id 去重，进度按时间戳取新
3. **复用现有管线**：不新造导入导出框架，扩展现有 `export-batch.js` / `import-zip.js`
4. **小改动面**：不动现有存储模块（bookmark.js / highlight-shared.js / shelf.js），只新增同步专用模块

## 3. 数据格式设计

### 3.1 userdata.json 升级（v2 → v3 schema）

在现有字段（`progress`/`lastReadTs`/`pdfPos`/`pdfBookmarks`/`pdfHighlights`/`chapterReads`）基础上新增：

```jsonc
{
  // ── 既有字段（保持不变） ──
  "progress": "3",
  "lastReadTs": "1725000000000",
  "pdfPos": "42",
  "pdfBookmarks": "[{\"page\":1,\"title\":\"x\",\"timestamp\":1725000000000}]",
  "pdfHighlights": "[{\"id\":\"abc\",\"page\":2,\"text\":\"...\"}]",
  "chapterReads": ["1", "2", "3"],

  // ── v3 新增字段 ──
  "schema": 3,                          // 标识新格式
  "bookmarks": [                         // EPUB 书签（IndexedDB bookmarks store 全量数组过滤该书）
    { "id": "bk1", "path": "books-1-1001/5", "scrollY": 1200, "title": "第5章", "bookId": "books-1-1001", "chapterNum": 5, "note": "重点", "timestamp": 1725000000000 }
  ],
  "highlights": {                        // EPUB 划线/笔记，按页 key 分组（key 与 BKStorage 一致，含前导 /）
    "/books-1-1001/1": [
      { "id": "hl1", "start": 10, "end": 20, "text": "...", "prefix": "", "suffix": "", "color": "yellow", "underline": false, "note": "", "timestamp": 1725000000000 }
    ]
  },
  "scroll": {                            // 章内滚动位置
    "books-1-1001/1": "800",
    "books-1-1001/2": "300"
  }
}
```

> 说明：`bookmarks` 数组导出**该本书**的书签（`bookId === bookId`），不含书级书架滚动键（`bk_scroll:<bookId>`，那是书架页位置，无同步价值）。

### 3.2 书级数据：shelf.json（新增，ZIP 根目录）

书架记录是**全局数据**（不属于单本书），放 ZIP 根目录独立文件：

```jsonc
// shelf.json — 全部书架记录（BKShelf.all() 原样序列化）
{
  "schema": 1,
  "exportedAt": "2026-08-31T10:00:00.000Z",
  "shelves": [
    { "bookId": "books-1-1001", "addedAt": "2026-08-01", "addedAtTs": 1722500000000, "note": "我的读后感", "rating": 5, "status": "collected", "finished": true, "completedAt": "2026-08-20", "pinned": true, "pinnedTs": 1723000000000, "favorite": true, "favoriteTs": 1723100000000 }
  ]
}
```

### 3.3 两种导出模式

| 模式 | ZIP 内容 | 典型大小 |
|---|---|---|
| **仅数据**（默认） | `manifest.json` + `shelf.json` + `books/<id>/userdata.json`（无 book.json / original.pdf） | 几 KB |
| **数据 + 书** | 现有完整结构（book.json + userdata.json + original.pdf）+ shelf.json | 视书大小 |

## 4. 模块设计

### 4.1 新增：`src/static/js/sync/sync-export.js`

挂载 `window.BK.Sync.exportData(bookIds, opts)`：

- `opts.mode`: `'data'`（默认）| `'full'`
- 复用 `export-batch.js` 的 `_collectUserData` 逻辑（抽公共函数或直接调用），扩展收集 `bookmarks`/`highlights`/`scroll`
- 调用 `BKStorage.getAllPages()` 按 `bookId` 过滤高亮
- 调用 `BKBookmark.getAll()` 按 `bookId` 过滤书签
- 生成 `shelf.json`（`BKShelf.all()`）
- `仅数据` 模式：跳过 `book.json`/`original.pdf` 写入
- 输出文件名：`bk-sync-export-<date>.zip`（区分现有 `bk-books-export`）

### 4.2 新增：`src/static/js/sync/sync-import.js`

挂载 `window.BK.Sync.importFromZip(buffer, opts)`：

1. 解析 ZIP，读取 `shelf.json`（如有）
2. 逐本书：读 `userdata.json`
3. 对每本书执行**合并**恢复：
   - **书签**：现有 `bookmarks` store 数组 + 导入数组按 `id` 去重合并（导入优先保留）→ `BKBookmark._save` 或直接 `setItem('bk_bookmarks', merged)`
   - **高亮**：逐 key 合并（同 key 高亮按 id 去重）→ `BKStorage.setPage(key, merged)`
   - **进度**：比较 `lastReadTs`，导入的更新才覆盖 `bk_progress`/`bk_scroll`/`bk_chapter_read`
   - **PDF 书签/高亮**：按 id 合并
   - **书架**：`BKShelf.add(id)`（幂等）→ 若本地无 note/rating/finished 则用导入的
4. 完成后广播 `bk:data-synced` 事件，书架 UI 刷新

### 4.3 书 ID 映射（导入书跨设备）

导入书在目标设备会重新生成 `imported-<ts>-<rand>` ID（`import-zip.js` 现有逻辑）。书签/高亮里记录的 `bookId` 必须跟随映射改写，否则挂到失效 ID。

**方案**：导入时维护 `idMap = { 旧ID → 新ID }`，在合并书签/高亮前对 `bookId` 字段执行映射；书城书（ID 不变）不做映射。

### 4.4 UI 入口：「我的」页「内容与数据」分组

入口位置：`renderer-api.js` 的 `renderMyPage()` 的「内容与数据」section（当前只有「清理数据」一行）。

在「内容与数据」section 内新增 4 行（或用一个「数据同步」二级分组）：

```
内容与数据
├── 清理数据          （现有）
├── 数据同步          （新分组标题）
│   ├── 导出阅读数据（仅进度/笔记/书签）   → BK.Sync.exportAll({mode:'data'})
│   ├── 导出数据+书籍（完整备份）          → BK.Sync.exportAll({mode:'full'})
│   └── 导入数据同步包                     → BK.Sync.importFromZip(file picker)
```

- `data-action="sync-export-data"` / `sync-export-full` / `sync-import`
- 绑定逻辑加到现有 `rows.forEach` 的 action 分发（renderer-api.js:225-272）
- 导入用 `<input type="file" accept=".zip">` 隐藏 input 触发（复用现有 `pickAndImport` 模式，见 renderer-api.js:824）
- 进度反馈用 `win.BK.openDialog` 或底部 toast（与现有导出进度框 `_doBatchExport` 一致）

> 说明：因「我的」页 HTML 由 renderer-api.js 动态生成，新增入口只需改 renderer-api.js 一处，无需动静态 HTML。

## 5. 实施计划（任务分解）

> 每任务 = 写测试 → 看失败 → 实现 → 看通过 → 提交

| # | 任务 | 内容 | 涉及文件 |
|---|---|---|---|
| 1 | 抽公共 userdata 收集函数 | 把 `_collectUserData` 从 export-batch.js 抽出供 sync 复用 | export-batch.js / sync-export.js |
| 2 | sync-export 仅数据模式 | 收集书签/高亮/滚动/书架 → 生成 ZIP（无书） | sync-export.js（新） |
| 3 | sync-export 含书模式 | 复用 exportBatch 打包书 + 数据 | sync-export.js |
| 4 | sync-import 合并导入 | 解析 ZIP → 按 id 去重合并书签/高亮 → 进度取新 | sync-import.js（新） |
| 5 | 书 ID 映射 | 导入书 ID 重映射 + 数据 bookId 改写 | sync-import.js |
| 6 | 「我的」页 UI | 「内容与数据」新增数据同步分组 + 3 个入口 + 进度反馈 | renderer-api.js |
| 7 | 测试与回归 | node --test tests/ui/ 全量 + 手动验证新旧 ZIP 兼容 | tests/ |

## 6. 风险与兼容

- **旧版 ZIP 兼容**：无 `shelf.json`/`bookmarks`/`highlights` 字段时静默跳过合并，不影响原有导入
- **书签上限**：`MAX_BOOKMARKS=100`，合并后截断时保留最新（timestamp 降序）
- **高亮 key 归一化**：`_normalizePath`（android_asset/public 前缀）已由存储层处理，导出用归一化后 key，导入直接写回
- **书城书 vs 导入书**：书城书保持原 ID（映射为恒等），导入书 ID 重映射
- **合并幂等**：同一 ZIP 重复导入不产生重复数据（按 id 去重）

## 7. 验收标准

1. A 设备导出「仅数据」ZIP → B 设备导入：B 设备该书（已存在）的进度/书签/划线/书架笔记与 A 一致
2. A 设备导出「含书」ZIP → 全新设备导入：书可读 + 进度/笔记完整
3. B 设备本地已有新笔记 → 导入 A 的包 → 两端笔记都在（无覆盖丢失）
4. 旧版（v1/v2）ZIP 仍可导入，行为不变
5. 重复导入同一 ZIP 无重复数据

> AI生成