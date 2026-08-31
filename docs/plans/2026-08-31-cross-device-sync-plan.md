---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4d910bf9-c0b1-41b8-9349-8b0f0db6390c'
  PropagateID: '4d910bf9-c0b1-41b8-9349-8b0f0db6390c'
  ReservedCode1: '66e65820-20b0-4bb2-b741-7c3ef4d62ea5'
  ReservedCode2: '66e65820-20b0-4bb2-b741-7c3ef4d62ea5'
---

# 跨设备同步阅读进度与笔记 — 实施计划

> 日期：2026-08-31
> 前置：设计文档 `docs/plans/2026-08-31-cross-device-sync-design.md`
> 执行模式：Subagent-driven（每任务 TDD：先写测试→看失败→实现→看通过→提交）

## 技术背景速览

- **脚本加载**：`index.html` 中 `export-batch.js` 等 export 模块均为 `defer`，同步模块需放在 `import-zip.js`（line 338）之后加载，保证 JSZip/localforage/BK.Export 就绪
- **测试方式**：`node --test tests/ui/test-*.js`，JSDOM + `vm.runInThisContext`（参考 `tests/lazy-renderer.test.js`）
- **关键 API**：
  - 导出落地：`win.BK.Export.exportBinary(bytes, filename, 'application/zip', {chooseDestination:true})`
  - 高亮读取：`BKStorage.getAllPages()` → `[{key, highlights[]}]`
  - 书签读取：`BKBookmark.getAll()` → 数组（≤100 条）
  - 书架读取：`BKShelf.all()`（同步）
  - 导入 ZIP：`win.BK.ImportZip.importFromZip(buffer, fileName, {onProgress})`
- **存储约定**：所有 IndexedDB 实例 `name:'books'`；书签 store `bookmarks`（单键 `bk_bookmarks`）；高亮 store `highlights`（每页键 `/<bookId>/<chNum>`）

## 任务清单

### 任务 1：抽公共 userdata 收集函数

- **目标**：`export-batch.js` 的 `_collectUserData` 抽为可复用模块 `sync-data-collect.js`，挂 `window.BK.SyncData.collectUserData(bookId)`，行为与现在完全一致（回归零风险）
- **步骤**：
  1. 写测试 `tests/ui/test-sync-data-collect.js`：JSDOM 中注入 fake localStorage，构造 `bk_progress:<id>`/`bk_pdf_hl:<id>`/`bk_chapter_read:<id>/<n>` 等 key，断言收集结果字段齐全
  2. 新建 `src/static/js/sync/sync-data-collect.js`（复制 `_collectUserData` 逻辑）
  3. 改 `export-batch.js` 引用 `BK.SyncData.collectUserData`（删除本地重复实现）
  4. 运行 `node --test tests/ui/test-sync-data-collect.js` 通过
- **验证**：`npm run test:ui` 全绿；`git commit`
- **注意**：改动 export-batch.js 时保持导出行为不变（回归 `_doBatchExport` 手动验证）

### 任务 2：sync-export 仅数据模式

- **目标**：`window.BK.Sync.exportData(bookIds, {mode:'data'})` 生成 ZIP：
  ```
  bk-sync-export-<date>.zip
  ├── manifest.json       # {version:3, type:'sync-data', exportDate, bookCount}
  ├── shelf.json          # BKShelf.all() 原样
  └── books/<bookId>/userdata.json   # 进度 + 书签 + 高亮 + 滚动 + PDF 数据
  ```
- **步骤**：
  1. 写测试 `tests/ui/test-sync-export.js`：
     - mock `BKStorage.getAllPages()`（返回高亮）/ `BKBookmark.getAll()`（返回书签）/ `BKShelf.all()`（返回书架）/ localStorage
     - 断言 ZIP 内 userdata.json 含 `bookmarks`/`highlights`/`scroll`/`schema:3` 字段
     - 断言 `mode:'data'` 时 ZIP 不含 `book.json`/`original.pdf`
     - 断言 `shelf.json` 存在且含书架数组
  2. 新建 `src/static/js/sync/sync-export.js`：用 JSZip 打包，高亮按 bookId 过滤（`getAllPages().filter(p => p.key.startsWith('/'+bookId+'/'))`），书签 `getAll().filter(bm => bm.bookId===bookId)`
  3. 生成后调 `BK.Export.exportBinary` 落地
- **验证**：`node --test tests/ui/test-sync-export.js` 通过；手动在 DevTools 验证

### 任务 3：sync-export 含书模式

- **目标**：`exportData(bookIds, {mode:'full'})` 时打包书本体（复用 `exportBatch` 逻辑：`book.json` + PDF 书 `original.pdf`）+ userdata + shelf.json
- **步骤**：
  1. 测试扩展：`mode:'full'` 时断言存在 `books/<id>/book.json`，PDF 书存在 `original.pdf`
  2. sync-export.js 中 mode='full' 走 `ImportManager.getImportedBook(id)` / `DataManager.getBook(id)` 取书数据（复用 export-batch 现有 `_getBookData` 逻辑，抽到共享模块）
  3. PDF 书还需 `_getPdfData`（`imported-pdf-data` store）
- **验证**：测试通过；与现有 `exportBatch` 行为一致

### 任务 4：sync-import 合并导入

- **目标**：`window.BK.Sync.importFromZip(buffer, {merge:true})` 解析同步包，按 id 去重合并书签/高亮，进度按 lastReadTs 取新
- **合并规则**：
  - **书签**：读现有 `bookmarks` store 数组（`BKBookmark.getAll()`）→ 与导入数组按 `id` 去重合并（导入优先保留）→ 写回 `BKBookmark._save` 或直接 `localforage.setItem('bk_bookmarks', merged)`，超 100 条截断（timestamp 降序保留最新）
  - **高亮**：逐 key（`highlights` store 的 `/<bookId>/<chNum>`）合并，同 key 内按 id 去重 → `BKStorage.setPage(key, merged)`
  - **进度**：`bk_progress` 仅在导入的 `lastReadTs` 比本地新时覆盖；`bk_chapter_read` 并集；`bk_scroll` 同书键取新
  - **PDF 书签/高亮**：`bk_pdf_bm`/`bk_pdf_hl` 数组按 id 合并
  - **书架**：`BKShelf.add(bookId)`（幂等）→ 本地无 note/rating/finished 时用导入值（通过 BKShelf.updateNote/updateRating/markRead）
- **步骤**：
  1. 写测试：JSDOM + mock 存储，构造 `userdata.json` 含新书签 + 本地已有书签，断言合并结果无重复、双端保留；进度较旧不覆盖、较新覆盖
  2. 新建 `src/static/js/sync/sync-import.js`：`window.BK.Sync.importFromZip`
- **验证**：测试通过；重复导入同一 ZIP 无重复数据（幂等）

### 任务 5：书 ID 映射

- **目标**：导入书（非书城书）ID 重映射后，书签/高亮中的 bookId 跟随改写
- **步骤**：
  1. 测试：构造 ZIP，导入书 `imported-xxx` → 断言合并后书签/高亮 bookId 为新 ID
  2. 实现：`idMap`（旧→新），在合并前对导入数组 `bookId` 字段改写（书城书恒等映射）
- **验证**：测试通过

### 任务 6：「我的」页 UI

- **目标**：`renderer-api.js` 的 `renderMyPage()`「内容与数据」section 新增「数据同步」3 个入口
- **步骤**：
  1. HTML：新增 3 个 `bk-settings-row`（`data-action="sync-export-data"` / `sync-export-full` / `sync-import`）
  2. action 分发（renderer-api.js rows.forEach）：
     - 导出：调 `BK.Sync.exportAll({mode})` → `exportAll` 内部取 `BKShelf.all()` 的 bookIds 后调 exportData
     - 导入：隐藏 `<input type="file" accept=".zip">` → `BK.Sync.importFromZip(buffer)`
  3. 完成后 toast + 书架刷新（`BK.emitChanged` 或 `bk:data-synced` 事件）
- **验证**：手动 DevTools 走通导出→导入闭环

### 任务 7：回归 + 全量测试

- `node --test tests/ui/` 全绿
- 手动验证：旧版 v1/v2 ZIP 导入不回归；书城书/导入书分流不回归（`_isCityBookId` 逻辑未动）
- 更新 changelog（如项目有此惯例）

## 验收标准（来自设计文档 §7）

1. A 设备导出「仅数据」→ B 导入：进度/书签/划线/书架笔记一致
2. 含书模式 → 全新设备：书可读 + 数据完整
3. B 本地已有新笔记 → 导入 A 包 → 两端笔记都在（无丢失）
4. 旧版 ZIP 可导入不回归
5. 重复导入无重复数据

## 提交策略

- 每个任务完成（测试绿）即 commit，message 前缀 `sync(books):`
- 分支：当前工作分支，不新建分支（按项目惯例，git 只跟踪 src）
- 三副本同步：`src/static` 修改后需同步 `output` 与 `android/app/src/main/assets/public`（`npm run build` 或手动复制）——确认项目惯例后执行

> AI生成