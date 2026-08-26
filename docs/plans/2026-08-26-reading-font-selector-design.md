---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '101e6652-af72-42e3-b20c-edb98bcb2a46'
  PropagateID: '101e6652-af72-42e3-b20c-edb98bcb2a46'
  ReservedCode1: 'de3bd150-f9dc-4531-8a0a-90dd5e77462d'
  ReservedCode2: 'de3bd150-f9dc-4531-8a0a-90dd5e77462d'
---

# 阅读字体风格选择 设计文档

> 日期: 2026-08-26
> 状态: 已批准

## 目标

在阅读设置面板中新增「阅读字体」选择区块，让用户可以在 4 种系统字体预设间切换阅读正文字体风格，无需下载任何 webfont。

## 背景

当前阅读正文固定使用 `--reading-font-family`（衬线栈），用户无法切换。字号和主题已有完整的切换+持久化基础设施，字体切换可复用同一模式。

## 字体预设

| 预设名 | key | 字体栈 |
|--------|-----|--------|
| 宋体（默认） | `serif` | `Songti SC, STSong, SimSun, Noto Serif CJK SC, Source Han Serif SC, Georgia, Times New Roman, serif` |
| 黑体 | `sans` | `PingFang SC, Noto Sans CJK SC, Source Han Sans SC, Microsoft YaHei, sans-serif` |
| 楷体 | `kai` | `STKaiti, KaiTi, 楷体, KaiTi_GB2312, Noto Serif CJK SC, Source Han Serif SC, serif` |
| 系统默认 | `system` | `-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif` |

## 架构方案

引入新的 CSS 变量 `--user-reading-font`，阅读区通过兜底链引用它：

```css
:root { --user-reading-font: ; }  /* 空变量，由 JS 运行时设置 */

#chapterContent, .bk-carousel-page .content {
  font-family: var(--user-reading-font, var(--reading-font-family, 'Songti SC', Georgia, serif));
}
```

- JS 切换时：`document.documentElement.style.setProperty('--user-reading-font', fontStack)`
- 封面 `.bk-cover-title` 仍用 `--reading-font-family`，不受影响

## 数据流

```
用户点击字体卡片
  → setReadingFont(presetKey)
  → localStorage.setItem('readingFontFamily', presetKey)
  → document.documentElement.style.setProperty('--user-reading-font', fontStack)
  → updateReadingFontUI(presetKey)   // 高亮当前选中卡片
  → 阅读区即时切换字体
```

初始化（页面加载时）：
```
initThemeToggle()
  → 读取 localStorage.readingFontFamily
  → applyReadingFont(savedKey || 'serif')
  → 设置面板打开时 updateReadingFontUI 同步选中态
```

## UI 设计

在现有设置面板的「阅读模式」区块和「字体大小」区块之间，插入新的「阅读字体」区块：

```
设置面板
├── 阅读模式（暖色 / 默认 / 夜间）  ← 已有
├── 阅读字体（宋体 / 黑体 / 楷体 / 系统）  ← 新增
└── 字体大小（A — 滑块 — A  18px）  ← 已有
```

- 复用 `.theme-options` / `.theme-option` 卡片布局
- 每个卡片显示字体名称文字，文字本身用对应字体栈渲染（所见即所得预览）
- 选中态复用 `.theme-option.active` + `.theme-radio` 圆点

## 影响文件（3 副本同步）

| 文件 | 改动 |
|------|------|
| `css-variables.css` | 新增 `--user-reading-font` 空变量 |
| `css-reader.css` | 阅读容器 font-family 改为兜底链 |
| `css-settings.css` | 新增字体卡片预览样式 |
| `theme-toggle.js` | 字体预设定义、切换/持久化/初始化/UI 逻辑 |

## 不做的事

- 不下载任何 webfont
- 不改封面标题字体
- 不改 UI 控件字体
- 不加工具栏快捷按钮
- 夜间模式不需额外适配（CSS 变量体系已兼容）

> AI生成