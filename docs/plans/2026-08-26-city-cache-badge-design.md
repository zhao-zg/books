---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'da1216ab-bc8a-4acc-a604-20056a1e2a85'
  PropagateID: 'da1216ab-bc8a-4acc-a604-20056a1e2a85'
  ReservedCode1: '688cb68f-2cca-4c7e-8e43-c6a75aa4d700'
  ReservedCode2: '688cb68f-2cca-4c7e-8e43-c6a75aa4d700'
---

# 书城缓存标识 + ZIP 导入分流设计

## 背景

当前书城书籍卡片没有常态缓存标识（`.cache-status` 默认空，下载完成后也被 `_refreshAfterDownload` 清空）。
ZIP 导入书城导出的 ZIP 包时，书城书会被加 `imported-` 前缀存入 `imported-data` store 并自动入架，
用户希望书城书导入时只缓存到 `zl-data`（书城缓存），不入架，不覆盖已有缓存。

## 需求

1. **书城卡片缓存标识**：书城 L3 书籍卡片上，已缓存到 IndexedDB 的书显示"已缓存"角标
2. **ZIP 导入分流**：书城书（非 `imported-` 前缀）保持原 ID → `DataManager.cacheBook()` 存入 zl-data，不入架
3. **已有缓存不覆盖**：ZIP 导入时检查 `DataManager.isBookDownloaded()`，已缓存则跳过
4. **导入后自动刷新**：ZIP 导入完成后刷新书城网格，显示新的缓存角标
5. **保留**：点击书城书籍仍自动入架；非书城书 ZIP 导入逻辑不变

## 任务拆分

### T1: `_buildBookCard()` 渲染缓存角标

**文件**: `src/static/js/renderer/renderer-city-helpers.js` (~L82-116)

当前 `_buildBookCard()` 在 L111 渲染 `<div class="cache-status" aria-hidden="true"></div>`，始终空。

修改：当 `cityBook === true` 且 `_isBookDownloaded(book.id)` 为 true 时，写入 `✓ 已缓存` 并设置 `aria-hidden="false"`，添加 class `is-cached`。

**测试**: 构造 `_zlDownloadedIds` 包含某 bookId 的场景，调用 `_buildBookCard()`，验证输出 HTML 含"已缓存"文字和 `is-cached` class。

### T2: `_refreshAfterDownload()` 保留缓存角标

**文件**: `src/static/js/renderer/renderer-city-helpers.js` (~L1322-1345)

当前 `_refreshAfterDownload()` 清空所有非下载中/非失败的 `.cache-status`。

修改：不再清空，改为检查 `_isBookDownloaded(bookId)` → 已缓存写入"✓ 已缓存"，未缓存清空。

**测试**: 模拟 `_zlDownloadedIds` 包含某 ID，调用 `_refreshAfterDownload()`，验证 `.cache-status` 文字为"已缓存"。

### T3: ZIP 导入分流 — 书城书走 zl-data 缓存

**文件**: `src/static/js/import-manager/import-zip.js` (~L150-238, `_importOneBook()`)

当前 `_importOneBook()` 对所有非 `imported-` 前缀的书加新 `imported-` ID → `_saveBook()` → 入架。

修改 `_importOneBook()`：在解析 `bookData.id` 后，判断 `originalId` 是否以 `imported-` 开头：

- **不以 `imported-` 开头（书城书）**：
  1. 不修改 `bookData.id`（保持原 ID）
  2. 检查 `DataManager.isBookDownloaded(originalId)` → 已缓存则跳过，返回 `{success: true, skipped: true}`
  3. 未缓存则 `DataManager.cacheBook(originalId, bookData)` 存入 zl-data
  4. 不调用 `BKShelf.add()`
  5. PDF 书的 `pdfBookId` 重映射不再需要（ID 不变）

- **以 `imported-` 开头（导入书）**：走现有 `_saveBook()` 逻辑不变

**测试**: 
- 书城书（id 不以 imported- 开头）→ 验证调用 `DataManager.cacheBook` 且不调用 `BKShelf.add`
- 已缓存的书城书 → 验证跳过不覆盖
- 导入书（id 以 imported- 开头）→ 验证走 `_saveBook` 原逻辑

### T4: CSS — 缓存角标常态样式

**文件**: `src/static/css/style/css-toc-drawer.css` (~L166-235)

当前 `.cache-status` 常态 `:empty` 时不显示。

修改：新增 `.zl-book-card.is-city-book .cache-status.is-cached` 样式，低调绿色角标，不影响下载中/失败的动画。

**测试**: CSS 无单元测试，手动验证。

### T5: 导入后自动刷新书城网格

**文件**: `src/static/js/renderer/renderer-city-helpers.js` (~L760-781, `_doCityImport()` 的 then 回调)

当前 ZIP 导入完成后调用 `_mergeImportedBooks()` + `renderHome()` + `_refreshAfterDownload()`。

修改：确认 `_refreshAfterDownload()` 在 T2 修改后会正确显示缓存角标。
如果书城书走 zl-data 缓存后不经过 `_mergeImportedBooks()`（因为不是导入书），需要额外刷新 `_zlDownloadedIds`。

在 `_doCityImport()` 的 then 回调中，增加 `DataManager.getDownloadedBookIds()` 刷新 `_zlDownloadedIds` 后再调 `_refreshAfterDownload()`。

**测试**: 验证导入完成后 `_zlDownloadedIds` 被更新。

### T6: 三副本同步

`src/` → `output/` → `android/app/src/main/assets/`，MD5 校验一致。

> AI生成