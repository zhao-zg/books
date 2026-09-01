---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'ee988c7a-562b-45bf-a475-9168b6b69afc'
  PropagateID: 'ee988c7a-562b-45bf-a475-9168b6b69afc'
  ReservedCode1: '322102ae-5e48-4c7b-8fef-5b622a0508d2'
  ReservedCode2: '322102ae-5e48-4c7b-8fef-5b622a0508d2'
---

# 数据与同步中心整合 — 实施计划

> 日期：2026-09-01
> 设计文档：[2026-09-01-data-sync-center-design.md](./2026-09-01-data-sync-center-design.md)
> 范式：TDD（先测试后实现），每个任务绿后提交。测试用 node --test 显式列文件，只测纯逻辑。

## 前置说明

- 项目：books（G:\project\github\books），src 为源，git 只跟踪 src；改完同步 src/output/android 三副本（任务 9 收尾统一做）。
- 现有测试文件在 tests/（按现有惯例显式列文件跑 node --test）。
- 每个任务格式：写测试（红）→ 实现（绿）→ 全量测试 → 提交。

---

## 任务 1：sync-shared.js 共享工具底座

**文件**：
- 新建 `src/static/js/sync/sync-shared.js`
- 新建 `tests/sync-shared.test.js`

**步骤**：

1. 写测试 `tests/sync-shared.test.js`：
   - `isCityBookId(id)`：以约定前缀（书城书 ID 格式）返回 true；非书城 ID 返回 false。
   - `resolveCityBook(page, id)`（防误判二次校验）：索引未就绪（null/undefined）时不误判为书城书；索引存在且命中时 true；索引存在但未命中时 false。
   - `isPdfBookData(data)`：pdf 相关字段判定。
   - `generateBookId()`：生成格式符合 `imported-<ts><rand>`。
   - `getBookData(bookId)`：从 imported-data / imported-pdf-data / zl-data 三 store 读取（用注入的 fake forage 实例测路由逻辑）。
2. 运行测试确认失败（模块不存在）。
3. 实现 `sync-shared.js`：
   - 从 `import-zip.js` 提取 `_isCityBookId` + `_doubleCheckCityBook` 合并为 `resolveCityBook`（保留二次校验行为）。
   - 三份重复 `_getBookData`（sync-import / import-zip / webdav-manager）合并为 `getBookData`，依赖注入 forage 实例避免单测碰真 IndexedDB。
   - `_generateId`、`_isPdfBookData` 同理收编。
4. 测试通过；提交 `feat(sync): 新增 sync-shared 共享工具（收编重复实现）`。

## 任务 2：book-convert.js 文本转换共享

**文件**：
- 新建 `src/static/js/sync/book-convert.js`
- 新建 `tests/book-convert.test.js`

**步骤**：

1. 写测试：
   - `bookToText(book, data)`：纯文本拼接、章节分隔符。
   - `bookToMd(book, data)`：标题层级、章节标题格式。
   - `bookToEpub(book, data)`：返回结构（mimetype 首条、章节文件列表）——只断言结构不解析 zip。
   - 对照 `webdav-upload.js` 内联版与 `export-book.js` 版行为一致。
2. 红后实现：从 `export-book.js` 抽取三个函数，导出纯函数。
3. `export-book.js` 与 `webdav-upload.js` 改为调用 book-convert（此任务先改 export-book；webdav-upload 在任务 5 一起切，避免语义混淆——不，改为同任务一起切，保持 DRY 无中间态）。
4. 测试通过；提交 `refactor(export): 抽取 book-convert 共享文本转换`。

## 任务 3：sync-core.js — v4 导出

**文件**：
- 新建 `src/static/js/sync/sync-core.js`
- 新建 `tests/sync-core-export.test.js`

**步骤**：

1. 写测试（全部用注入的 fake forage / fake localStorage 快照）：
   - `exportData('data')` → zip 内容清单 = manifest.json + shelf.json + books/<id>/{book.json,userdata.json}，**不含** original.pdf。
   - `exportData('full')` → 含 original.pdf（或 book.<ext> 按 book 类型）。
   - manifest 断言：version===4、mode 正确、exportedAt 为 ISO 字符串、deviceName 取 bk_device_name。
   - 书城书（zl-data 来源）在 full 模式下也导出原件；data 模式只导 userdata。
2. 红后实现 `sync-core.js` 的 `exportData(mode)` 与 `generateZipBytes(mode)`（参考现有 sync-export.js 结构，合并 export-batch.js 逻辑；底层复用 export-core 的写出出口）。
3. 测试通过；提交 `feat(sync): sync-core v4 导出（data/full 两模式）`。

## 任务 4：sync-core.js — v4 导入（无委托链）

**文件**：`sync-core.js` 追加；`tests/sync-core-import.test.js`

**步骤**：

1. 写测试：
   - v4 data 包导入：进度按 lastReadTs 取新（旧>新不动、新>旧覆盖）、书签按 id 去重截断 100、chapterReads 并集、shelf 补缺不覆盖已有。
   - v4 full 包导入：书文件写入 imported-data / imported-pdf-data，生成新 `imported-` ID，shelf 引用新 ID。
   - `manifest.version === 3 / 2 / 1` → 抛错文案含"旧版本"；无 manifest → 抛错"不是有效的书籍数据包"。
   - zip 内 books 目录与 shelf.json 不一致（孤儿条目）时忽略孤儿并继续。
2. 红后实现 `importFromZip(file)`：只认 v4；合并逻辑参考现 sync-import 但去掉 v1/v2/v3 委托分支。
3. 测试通过；提交 `feat(sync): sync-core v4 导入（合并策略+旧包明确报错）`。

## 任务 5：底层调用方切换

**文件**：
- 改 `sync/lan-sync.js`、`sync/lan-sync-webrtc.js`（原调 BK.Sync.exportData/importFromZip → 改调 BK.SyncCore）
- 改 `webdav-upload.js`（文本转换改用 book-convert；WebDAV 配置改读统一配置读取器）
- 改 `webdav-manager.js`、`sync/sync-webdav.js`（配置统一）
- 改 `sync/sync-webdav-trigger.js`（新增 `onSyncStateChange` 事件回调注册，供中心页订阅；退书自动触发保留）

**步骤**：

1. 为 WebDAV 配置统一读取器写测试：三处旧配置键（bk_webdav_configs/bk_webdav_active）读取优先级、缺失回退。
2. 切换调用方；删除各文件内残留的重复工具函数，改用 sync-shared。
3. 全量测试通过；提交 `refactor(sync): 底层调用统一到 sync-core 与统一 WebDAV 配置`。

## 任务 6：data-sync-page.js 中心页 UI

**文件**：
- 新建 `src/static/js/sync/data-sync-page.js`
- 改 `src/static/index.html`（script 注册 + 预缓存清单）

**步骤**（UI 不做单测，人工验证清单如下）：

1. 全屏页骨架：顶栏返回 + 四区块（导出 / 导入 / WebDAV / 局域网），风格对齐 lan-sync-panel（暖调低饱和、正文 18px/UI 14px/辅助 12px）。
2. 导出区两按钮：调 SyncCore.exportData('data'|'full')，导出中 loading，完成后 toast 显示文件名。
3. 导入区：文件选择 → SyncCore.importFromZip，旧包报错文案原样展示。
4. WebDAV 区：配置表单（从现有 WebDavManager 配置迁移读取）、增量同步状态行（订阅 onSyncStateChange）、立即同步按钮、从 WebDAV 导入书列表、上传书入口。
5. 局域网区：嵌入现有 LanSyncPanel 或按钮跳转其面板。
6. 点击不得触发阅读页浮动控制栏（沿用既有弹层约定）。
7. index.html：新 script 按依赖顺序插入 defer 列表；SW 预缓存清单补 4 个新文件；三副本同步此文件改动（src 优先）。
8. 提交 `feat(sync): 数据与同步中心全屏页`。

## 任务 7：入口收敛

**文件**：
- `renderer/renderer-api.js`：我的页 4 项改 1 项「数据与同步」；删 `download-mgr` 死代码分支。
- `resource-pack/rp-import.js`：删 WebDAV Tab，只留本地文件。
- `renderer/renderer-city-helpers.js`：下载管理删导入 Tab（`_doCityImport` 及对应 UI）。
- 书架批量条、长按导出保留（底层已在任务 5 切换）。

**步骤**：

1. 逐项修改；每处修改后跑全量测试（renderer 层如无测试则靠语法检查 node --check）。
2. 人工验证清单：
   - 我的页只剩一个入口且能进中心页。
   - 书城下载管理无导入 Tab。
   - 书架导入对话框无 WebDAV Tab。
   - 书架批量导出/上传 WebDAV 仍工作（未配置 WebDAV 时提示去中心配置）。
3. 提交 `refactor(ui): 收敛导入导出入口到数据与同步中心`。

## 任务 8：删除旧模块

**步骤**：

1. 删 `sync/sync-export.js`、`sync/sync-import.js`、`export/export-batch.js`。
2. 全局 grep `BK.Sync.exportData|BK.Sync.importFromZip|BK.Export.exportBatch|sync-export|sync-import|export-batch` 确认零引用。
3. index.html 清对应 script 标签与预缓存清单。
4. 全量测试 + node --check；提交 `refactor(sync): 移除旧版导出导入模块（v1-v3 委托链）`。

## 任务 9：收尾

**步骤**：

1. 三副本同步：src → output、android（按项目惯例脚本/复制），git 只跟踪 src。
2. 全量回归：node --test 全部测试文件 + node --check 全部改动 js。
3. 手动冒烟（PWA）：导出 data/full → 删数据 → 导入恢复；书城导出；局域网面板进出。
4. 提交 + 更新 MEMORY/日志。

## 验证命令备忘

```powershell
node --test tests/sync-shared.test.js tests/book-convert.test.js tests/sync-core-export.test.js tests/sync-core-import.test.js
node --check src/static/js/sync/sync-core.js
rg "sync-export|sync-import|export-batch|BK\.Sync\." src/static/js --glob "!sync/sync-core.js"
```

> AI生成