---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'f15d0a4d-d61b-4718-8ee0-007887a138e0'
  PropagateID: 'f15d0a4d-d61b-4718-8ee0-007887a138e0'
  ReservedCode1: '2d0dbe68-2a93-482c-ad70-3c8427833170'
  ReservedCode2: '2d0dbe68-2a93-482c-ad70-3c8427833170'
---

# 数据与同步中心整合 — 设计文档

> 日期：2026-09-01
> 状态：设计已确认（用户逐段确认）
> 项目：书报（books）— Capacitor 移动阅读应用

## 1. 背景与问题

当前「导入 / 导出 / 同步」功能入口分散在多处：

| 入口 | 位置 | 功能 |
|---|---|---|
| 导出同步数据 | 我的页 | 导出 zip（书架+进度+书签，不含书） |
| 导出含书完整包 | 我的页 | 导出 zip（数据 + 书的 PDF 原件） |
| 导入同步数据 | 我的页 | 选 zip 合并导入 |
| 局域网同步 | 我的页 | NSD/WebRTC 面板 |
| 📂 导入按钮 | 书架头部 | 对话框（本地文件 + WebDAV 两个 Tab） |
| 批量条「导出 / 上传 WebDAV」 | 书架编辑态 | 批量导出 zip / 单本传 WebDAV |
| 长按书籍「导出书籍」 | 书架 | 单本导出 TXT/MD/EPUB/PDF |
| 📥 下载管理 | 书城头部 | 弹窗含「导出 / 导入」两个 Tab |

底层重复与不一致：

1. **两套 ZIP 导出格式**：sync-export v3（含 shelf.json）vs export-batch v2（无 shelf.json），目录结构几乎一致。
2. **两套 ZIP 导入**：sync-import（合并式）vs import-zip（覆盖/分流式），sync-import 内部还按 v1/v2/v3 三层委托。
3. **重复代码**：`_isPdfBookData`×3、`_getBookData`×3、`_generateId`×3、`_isCityBookId`×2（两份实现行为不一致，import-zip 有防误判二次校验、sync-import 没有——存在误判风险）。
4. **文本转换重复**：export-book.js 与 webdav-upload.js 的 `_bookToText/_bookToMd/_bookToEpub` 完全重复。
5. **WebDAV 散落四处**：WebDavManager（下载）、WebDavUpload（上传）、SyncWebDAV（增量同步）、rp-import 对话框 Tab——配置/连接 UI 各自独立。
6. **SyncWebDAV 无 UI**：双向增量同步只在退书时自动触发，用户无感知、无法手动配置或触发。
7. **遗留死代码**：renderer-api.js 的 `download-mgr` action（无对应按钮）。

## 2. 目标

- 「我的」页 4 个零散入口收敛为 1 个「数据与同步」全屏页（唯一完整入口）。
- 底层 zip 导出/导入收敛为一套 v4 格式、一个核心模块。
- 书架保留快捷导入，书城只保留导出（只出不进）。
- WebDAV 配置全局唯一，增量同步在中心页可见可控（状态 + 手动触发）。

### 非目标（YAGNI）

- 不做云端备份扩展、自动定时备份。
- 不做同步冲突 UI 化解（沿用「进度取新」静默合并策略）。
- 不做迁移向导。
- 不兼容旧版导出包（v1/v2/v3 导入委托链全部移除）。

## 3. 用户已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 大方向 | 建统一「数据与同步」中心，从「我的」进入；书架/书城保留快捷方式 |
| zip 格式 | v2/v3 合并为一个新格式 v4 |
| 书架/书城 | 书架留导入，书城只留导出 |
| WebDAV | 加状态 + 手动触发；配置全部收进中心 |
| 旧包兼容 | **不兼容**（旧包导入直接报错并指引） |
| UI 形态 | 全屏页（仿 lan-sync-panel 风格） |

## 4. 新架构总览

```
我的页
  └─ 数据与同步（全屏页，唯一完整入口）
       ├─ ① 导出区
       │    ├ 导出同步数据（data：数据，不含书）
       │    └ 导出含书完整包（full：数据 + 书文件）
       ├─ ② 导入区
       │    └ 导入数据包（选 zip，合并模式，仅识别 v4）
       ├─ ③ WebDAV 区
       │    ├ 服务器配置（全局唯一一份）
       │    ├ 增量同步：状态 + 上次同步时间 + 立即同步
       │    ├ 从 WebDAV 导入书（原书架 WebDAV Tab 迁入）
       │    └ 上传书到 WebDAV
       └─ ④ 局域网同步（现面板整体迁入）

书架页（快捷口，只留高频操作）
  ├ 头部「+添加」→ 纯本地导入（删 WebDAV Tab）
  ├ 编辑态批量条「导出」→ 调新导出核心
  ├ 编辑态批量条「上传 WebDAV」→ 调统一模块（未配置则提示去中心）
  └ 长按单书「导出书籍」TXT/MD/EPUB/PDF 保留

书城页（快捷口，只出不进）
  └ 下载管理弹窗只留「导出」Tab（删导入 Tab）
```

入口数量：我的页 4 项 → 1 项；书城导入 Tab 删除；书架 WebDAV Tab 删除。

## 5. v4 包格式

一种格式，两种模式（mode 区分包含哪些文件，结构相同）：

```
bk-book-<date>.zip（v4）
├─ manifest.json            # { version: 4, mode: "data"|"full", exportedAt, deviceName }
├─ shelf.json               # 书架列表（v3 已有；v2 没有的本次补齐）
└─ books/
    └─ <bookId>/
        ├─ book.json        # 书元数据
        ├─ userdata.json    # 进度/书签/标注
        ├─ original.pdf     # 仅 full 模式
        └─ book.<ext>       # 仅 full 模式（txt/md/epub）
```

- **data 模式**（导出同步数据）：manifest + shelf.json + books/*/（book.json + userdata.json）——小包，跨设备恢复阅读状态。
- **full 模式**（含书完整包）：data 的一切 + original.pdf / book.<ext>——大包，完整备份/迁移。

### 导入规则（无委托链）

- 读 `manifest.version === 4` → 按 mode 导入：
  - data 包：合并数据（进度按 lastReadTs 取新、书签按 id 去重、章节已读并集、书架补缺）。
  - full 包：连书文件一起导入。
- `manifest.version < 4` → 直接报错："此包由旧版本导出，请在新旧设备间用局域网同步或重新导出"。不猜、不试、不部分导入。
- 无 manifest → 报错"不是有效的书籍数据包"（普通书文件导入走书架「+添加」，不混在数据包导入里）。

## 6. 模块拆分

### 新建（4 个文件）

| 文件 | 职责 |
|---|---|
| `sync/sync-shared.js` | 共享工具（收编 `_getBookData`×3、`_isCityBookId`×2、`_isPdfBookData`×3、`_generateId`×3；`_isCityBookId` 统一实现 + 沿用防误判二次校验） |
| `sync/book-convert.js` | 书籍文本转换共享实现（`_bookToText/_bookToMd/_bookToEpub`，供 export-book 与 webdav-upload 复用） |
| `sync/sync-core.js` | v4 包唯一导出/导入实现（收编 sync-export + export-batch；data/full 两模式） |
| `sync/data-sync-page.js` | 「数据与同步」全屏页 UI（仿 lan-sync-panel 风格，四区块：导出 / 导入 / WebDAV / 局域网） |

### 删除

| 删除项 | 原因 |
|---|---|
| `export/export-batch.js` | 并入 sync-core |
| `sync/sync-export.js`、`sync/sync-import.js` | 重写为 sync-core，v1/v2/v3 委托链消失 |
| `renderer-api.js` 中 `download-mgr` 死代码 | 无对应按钮 |

### 改造

- `lan-sync.js` / `lan-sync-webrtc.js`：改调 sync-core（原复用旧 sync-export/import）。
- `webdav-upload.js` / `webdav-manager.js` / `sync-webdav.js`：统一读中心管理的唯一 WebDAV 配置；文本转换改用 book-convert.js。
- `rp-import.js`：删 WebDAV Tab，只留本地文件。
- `renderer-city-helpers.js`：下载管理删导入 Tab。
- `sync-webdav-trigger.js`：保留退书自动触发，新增同步状态事件供中心页显示。
- `index.html`：新模块注册 script 标签（按 defer 依赖顺序插入）+ 预缓存清单（防生产静默失效）。

## 7. 测试（TDD，只测纯逻辑）

- `sync-core`：
  - v4 导出结构：data / full 两种模式的文件清单断言。
  - v4 导入合并：进度取新、书签去重、章节并集、书架补缺。
  - 报错路径：旧版本包（version < 4）明确报错；无 manifest 报错。
- `sync-shared`：`_isCityBookId` 统一实现 + 防误判二次校验（覆盖"索引未就绪"场景）。
- 范式：node --test 显式列文件；被测模块直接 import src 的 .ts/.js 源；UI 层不测。
- 改动后全量回归：现有测试套件全部通过。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 旧包不兼容属破坏性变更 | 导入报错文案明确指引（局域网同步 / 重新导出）；局域网同步两端版本不一致时面板显示提示 |
| 书城书误判（原两处实现不一致） | 统一实现 + 二次校验，测试覆盖索引未就绪场景 |
| 全屏页与阅读页浮动控制栏冲突 | 沿用既有约定：弹框/抽屉内点击不得触发阅读页浮动控制栏 |
| 脚本加载顺序敏感 | 新文件按 defer 依赖顺序插入 index.html，并同步 src/output/android 三副本 |

## 9. 实施顺序（每步独立验证、可回退）

1. **底座**：建 `sync-shared.js` → `book-convert.js` → 全量测试过。
2. **v4 核心**：TDD 实现 `sync-core.js` → 测试过。
3. **底层切换**：lan-sync / webrtc / webdav 改调 sync-core → 测试过。
4. **中心页 UI**：`data-sync-page.js` 四区块 + WebDAV 配置归拢 → 手动验证。
5. **入口收敛**：我的页 4 项→1 项；书架删 WebDAV Tab；书城删导入 Tab；删 download-mgr 死代码。
6. **收尾**：三副本同步（git 只跟踪 src）、预缓存清单核对、全量回归。

## 10. 明确不做

- 云端备份扩展、自动定时备份。
- 同步冲突 UI 化解。
- 迁移向导。
- javamapper 等无关功能（属 cfggen 项目范畴，本项目无涉）。

> AI生成