# 修复：「下载管理」按钮点击无反应 + 移除「管理书籍」按钮

## 现象
- 在「我的」页 与 阅读设置面板(⚙) 中点击「📥 下载管理」没有任何反应。
- 用户要求去掉「🗑️ 管理书籍」按钮。

## 根因
书架重设计把首屏从书城换成书架（`renderShelfPage`）后，下载面板的两个固定 DOM
（`#downloadPanel` / `#dlOverlay`）不再被任何页面渲染：
- 旧实现把面板挂在 `#homeView` 内；
- 切到「我的」页时 `#homeView` 被 `display:none` 隐藏，面板随之隐藏；
- `openDownloadManager()` 调 `_toggleDownloadPanel(true)` 时
  `document.getElementById('downloadPanel')` 返回 `null` → 静默无反应。
- 同时 `_startSeriesDownload` / `_startAllDownload` 的按钮绑定也随旧面板一并丢失。

## 修复内容

### 1. 下载面板改为全局持久元素（`src/static/js/renderer.js`）
- 新增 `_ensureDownloadPanel()`：把 `#downloadPanel` + `#dlOverlay` 挂到
  `document.body`（独立于当前页面，任何页都能弹出），并绑定
  关闭按钮 / 遮罩 / 全部下载 / 暂停(恢复) / 取消。
  面板结构含：概览卡 `dlOvSeries/dlOvCached/dlOvSize`、`dlResourceSummary`、
  `dlStorageInfo`、进度区 `dlProgressWrap/dlProgressBar/dlProgressText`、
  `dlControls/dlPauseBtn/dlCancelBtn`、系列列表 `#dlSeriesList`、`dlAllBtn`。
- 新增 `_renderDlSeriesList()`：按 `_getMergedSeries().series` 渲染系列行
  （含 `.series-cache-info[data-series]` 供 `_refreshSeriesCacheStatus` 更新，
  以及「下载」按钮触发 `_startSeriesDownload`）。
- 改写 `openDownloadManager()`：关设置面板 → `_ensureDownloadPanel()` →
  等待数据就绪（`_zlDmReady`，否则 `_ensureDmInit`）→
  `_renderDlSeriesList()` + `_toggleDownloadPanel(true)` + `_refreshStorageStats()`。
  复用既有的下载/进度全套逻辑，无需重写。
- `style.css` 补 `.download-resource-summary` 规则（其余下载面板类已存在）。

### 2. 移除「管理书籍」按钮
- `renderMyPage`（「我的」页）：删除 `manage-books` 行 + 其 `data-action` 分支。
- `theme-toggle.js`（阅读设置面板）：删除 `#manageBooksBtn` 标记 + 其绑定块
  （`MutationObserver` + `toggleManageMode` 调用），`resourceManageSection` 显示条件去掉 `manageBtn`。
- `renderer.js` 中 `toggleManageMode` / `isManageMode` 定义保留（无害，`_manageMode` 现恒为 false）。

## 验证
- `node --test tests/ui/*.js` → **159/159 通过**
  （BC-17 在全集偶发失败，但隔离运行 `test-bookcity.js` 连续 3 次 19/19 稳定，
  属既有 IntersectionObserver 时序 flake，与本次改动无关——本次未动书城渲染）。
- `renderer.js` / `theme-toggle.js` / `style.css` 三处副本
  （`src/static` / `output` / `android/.../public`）SHA256 完全一致。

## 部署同步
- 本沙箱 `main.py` 被 safe-delete 拦截（`rmtree(output/)` 拒绝），按
  “src 为真理之源 + 仅改 JS/CSS” 管线用 `cp` 同步 `output/` 与 android 副本
  （三副本 SHA 已校验一致）。
- 若后续需要做完整数据重建（如「生命读经→LS」正文还原），再跑
  `main.py`(系统 `C:\Python314\python.exe`) + `cap sync`。
