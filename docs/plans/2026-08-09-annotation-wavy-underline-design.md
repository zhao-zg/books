---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6af82fd0-87e0-4c2d-8f6c-e8d70d1e37b2'
  PropagateID: '6af82fd0-87e0-4c2d-8f6c-e8d70d1e37b2'
  ReservedCode1: '5cd8afcd-4aee-4c49-8877-d2d2bb5b2477'
  ReservedCode2: '5cd8afcd-4aee-4c49-8877-d2d2bb5b2477'
---

# 批注波浪下划线视觉区分

> 日期: 2026-08-09
> 状态: approved

## 问题

已保存的批注（note 类型）在页面上没有足够的视觉区分度：

1. **EPUB**: `var(--gold)` CSS 变量未定义，波浪线不可见
2. **PDF 普通模式**: 无波浪线区分
3. **PDF Reflow 模式**: 无波浪线区分

## 方案

为所有带 `note` 的批注标记统一添加波浪下划线，使用 `var(--brand)` 主题色。

## 任务

### Task 1: EPUB — 修复波浪线颜色 + 改用 CSS 类

- `highlight-apply.js`: note 时设置 `data-note="true"` 属性，移除内联 textDecoration/textUnderlineOffset
- `css-highlight.css`: 新增 `.bk-highlight[data-note="true"]` 用 `text-decoration: underline wavy var(--brand, #3D8A5A)` + `text-decoration-thickness: 2px` + `text-underline-offset: 3px`
- 兼容 underline+note 组合: `.bk-highlight[data-underline="true"][data-note="true"]` 时用 `text-decoration: underline wavy var(--danger-text)`

### Task 2: PDF 普通模式 — 覆盖层增加波浪线标记

- `pdf-highlight.js:594-607`: 当 `hl.note` 存在时，cls 追加 `bk-pdf-hl-note`
- `css-pdf.css`: `.bk-pdf-hl-note` 用 SVG 内联背景 + `::after` 伪元素在底部画波浪线
- 波浪线用 SVG 波形 path 内联 data URI 实现

### Task 3: PDF Reflow 模式 — 批注增加波浪线

- `pdf-reflow.js:574-576`: 当 `seg.note` 存在时，cls 追加 `bk-pdf-reflow-note`
- `css-pdf.css`: `.bk-pdf-reflow-note` 用 `text-decoration: underline wavy var(--brand, #3D8A5A)` + `text-decoration-thickness: 2px` + `text-underline-offset: 3px`

### Task 4: 构建验证

- 运行构建，确认编译成功