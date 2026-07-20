---
name: 书报
description: 安静的移动阅读应用，Sage绿品牌色，Soft Nordic设计语言
colors:
  sage-moss: "#3D8A5A"
  sage-moss-light: "#5EAE7E"
  surface-cool: "#F5F4F1"
  surface-warm: "#FAF8F4"
  surface-dark: "#1A1917"
  card-cool: "#ffffff"
  card-dark: "#201F1D"
  text-primary: "#1A1918"
  text-primary-dark: "#E8E6E2"
  text-muted: "#9A958C"
  border-cool: "#E5E2DD"
  border-dark: "#34322E"
  danger: "#C8553D"
  danger-dark: "#D8856E"
  warning: "#B5793A"
typography:
  heading:
    fontFamily: "'Songti SC', 'STSong', SimSun, Georgia, 'Times New Roman', serif"
    fontSize: "22px"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.01em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  float: "31px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
components:
  button-primary:
    backgroundColor: "{colors.sage-moss}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  button-primary-dark:
    backgroundColor: "{colors.sage-moss-light}"
    textColor: "{colors.surface-dark}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.card-cool}"
    rounded: "{rounded.lg}"
    padding: "{spacing.4}"
  card-dark:
    backgroundColor: "{colors.card-dark}"
    rounded: "{rounded.lg}"
  chip:
    backgroundColor: "rgba(61,138,90,0.10)"
    textColor: "{colors.sage-moss}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
  drawer:
    backgroundColor: "{colors.card-cool}"
    rounded: "{rounded.lg}"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '64d4d8a0-ed58-42d2-983a-9b867062b3e0'
  PropagateID: '64d4d8a0-ed58-42d2-983a-9b867062b3e0'
  ReservedCode1: '19f0b5c9-04e8-4d05-aafe-02b95090eb06'
  ReservedCode2: '19f0b5c9-04e8-4d05-aafe-02b95090eb06'
---

# Design System: 书报

## 1. Overview

**Creative North Star: "The Paper Sanctuary"**

书报的设计语言是 Soft Nordic, 一种以纸张安静感为基底、以 Sage 绿为唯一强调色的克制系统。灵感来自 Apple Books 的留白哲学和 Kindle 的工具隐退原则: 用户打开应用后, 界面应该在 5 秒内消失, 让内容成为唯一可见物。

这个系统明确拒绝两种倾向: 一是微信读书式的社交侵入(红点/气泡/弹窗密集劫持注意力), 二是 WPS/PDF工具式功能堆砌(工具栏按钮过密、面板风格与内容区割裂)。面板不是另一个世界, 它和书架使用同一套令牌和组件模式。

**Key Characteristics:**

- 白底纸张感为主, Sage 绿唯一强调, 出现面积不超过 10%
- 1px 细描边替代阴影作为容器边界(默认状态), 阴影仅响应用于 hover/float
- 大圆角浮岛导航(border-radius: 31px)与方正卡片(16px)形成节奏对比
- 三档主题(cool/warm/dark)覆盖全局, 无视图独立配色
- 系统字体栈, 不下载 webfont, UI 用无衬线、阅读/标题用衬线

## 2. Colors

### Primary

- **Sage Moss** (#3D8A5A / dark主题 #5EAE7E): 唯一的品牌强调色。用于主按钮、激活态标签、进度条、选中图标。出现在任何单屏的面积不超过 10%。暗色主题提亮至 #5EAE7E 以保持对比度。

**The One Accent Rule.** Sage Moss 是唯一的饱和色。禁止引入第二个品牌色或渐变。任何需要强调的地方用 Sage Moss 的透明度变体(10%背景 / 20%边框 / 14%进度条), 不是用新色相。

### Neutral

- **Warm Paper** (#F5F4F1 / warm #FAF8F4 / dark #1A1917): 应用底色。偏暖的白, 不是纯白, 带极微的褐色调。
- **Card White** (#ffffff / dark #201F1D): 卡片和弹框的底色。比底色略亮一级, 形成纸张层叠感。
- **Ink** (#1A1918 / dark #E8E6E2): 正文文字色。近乎纯黑但不是 #000, 带暖色调。
- **Faded Ink** (#9A958C): 辅助文字色。同一色相但低饱和, 用于页码、时间戳、辅助标签。
- **Warm Border** (#E5E2DD / dark #34322E): 1px 描边色。足够可见但不抢视线, 用于卡片边框、分割线。

### Semantic

- **Terracotta** (#C8553D / dark #D8856E): 危险/删除操作。低饱和度红, 与 Sage Moss 同级别克制。
- **Amber** (#B5793A): 警告/书签标记色。

### Glass

- **Glass BG** (rgba(245,244,241,0.78)): 毛玻璃面板底色, 仅用于浮动元素(底部 Tab 栏)。禁止作为抽屉或弹框的默认背景。

**The No Dark Glass Rule.** 禁止在阅读器面板中使用 `rgba(30,30,30,0.95)` 深黑毛玻璃。这种风格与 Paper Sanctuary 的纸质感根本冲突。面板应当使用 Card White 或主题对应底色, 与书架对话框保持一致。

## 3. Typography

**Display/Heading Font:** Songti SC, STSong, SimSun, Georgia, Times New Roman, serif
**Body/Label Font:** -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif
**Mono Font:** SF Mono, Menlo, Consolas, Courier New, monospace

**Character:** 衬线体承载中文阅读的文人气质, 无衬线体确保小字号下的清晰度。两者共享同一暖色调色轴, 不产生冷暖冲突。

### Hierarchy

- **3xl** (26px, weight 600, serif): 应用标题, 仅书架顶栏
- **2xl** (22px, weight 600, serif): 页面标题, 书城分类名
- **xl** (18px, weight 600): 小节标题, 对话框标题
- **lg** (16px, weight 500): 副标题, 抽屉标题
- **base** (14px, weight 400): 正文, 列表文字
- **sm** (13px, weight 400): 辅助说明
- **xs** (12px, weight 400): 页码, 标签, 统计

**The 1.25 Rule.** 相邻层级字号比不小于 1.25。避免平级缩放(14/15/16)导致的视觉扁平。

## 4. Elevation

默认无阴影。阴影是交互事件, 不是容器属性。

卡片默认只有 1px 描边(`var(--border)`)。阴影仅在以下状态出现:

- **Card Hover** (0 6px 20px rgba(60,40,10,.10)): 鼠标悬停或长按时, 卡片上浮 2px + 展开阴影
- **Float** (0 8px 24px rgba(60,40,10,.10)): 浮动元素(底部 Tab 栏、浮动导航)
- **Menu** (0 6px 20px rgba(90,65,30,.14)): 下拉菜单
- **Dialog** (0 10px 32px rgba(90,65,30,.12)): 居中弹框
- **Glass** (0 4px 16px rgba(60,40,10,.06)): 毛玻璃浮动条

**The Responsive Shadow Rule.** 阴影是对用户动作的回应, 不是元素的固有属性。静态元素禁止有阴影。如果某处看起来像 2014 年的 Material Design 卡片(深阴影+小模糊), 阴影太重且模糊太小, 减半修复。

## 5. Components

所有组件遵循"克制的存在"原则: 存在感刚好够用, 不多不少。

### Buttons

- **Shape:** 8px 圆角
- **Primary:** Sage Moss 填充(#3D8A5A) + 白色文字, 暗色主题反转。10px 20px 内距
- **Hover:** 无变色, translateY(-1px) 微上浮
- **Active:** scale(0.98) 点击反馈
- **Ghost/Secondary:** 透明底 + 1px border(rgba(61,138,90,.20)) + Sage Moss 文字

### Cards / Containers

- **Corner Style:** 16px 大圆角(书城卡片、设置项), 12px 中圆角(弹框内分区)
- **Background:** Card White(#ffffff), 暗色 #201F1D
- **Shadow Strategy:** 默认无阴影, 1px Warm Border 描边。Hover 时展开 Card Hover 阴影 + translateY(-2px)
- **Border:** 1px solid var(--border)
- **Internal Padding:** 16px (--space-4)

### Chips / Tags

- **Style:** Sage Moss 10%透明度底 + Sage Moss 文字, pill 形状(9999px 圆角)
- **State:** 选中态加深底色至 20%, 未选中态透明底 + muted 文字色
- **用法:** 筛选标签、分类标签、状态标记

### Navigation

- **Bottom Tab Bar:** 白色胶囊浮岛, border-radius: 31px, 4-Tab 内联 SVG 图标。Sage Moss 填充激活态图标
- **Float Bar:** 顶部/底部浮动胶囊, 1px 描边 + Glass 阴影
- **Active state:** Sage Moss 图标填充 + 文字标签

### Drawers / Panels

- **Style:** Card White 底, 12px 顶部圆角(底部抽屉) 或 16px 圆角(侧面板), 与 `BK.openDialog` 保持一致
- **Header:** 14px 16px 内距, xl 字号标题 + 右侧关闭按钮(x)
- **Close button:** 无背景, muted 色文字, hover 变 ink 色
- **Overlay:** rgba(44,24,16,.38) 暖色遮罩
- **Transition:** ease-out (--ease-out: cubic-bezier(0.16, 1, 0.3, 1)), 300ms

### Inputs / Sliders

- **Style:** 透明底 + muted 色轨道
- **Active/Fill:** Sage Moss 14%透明度轨道 + Sage Moss 填充
- **Thumb:** 20px 圆形, 白色底 + 2px Sage Moss 描边
- **Focus:** 2px Sage Moss 描边

### Action Panels (PDF 标注操作面板)

- **Style:** Card White 底, 12px 圆角, Glass 阴影
- **Buttons:** 36x32px, Sage Moss 图标(高亮/下划线/删除线), muted 色图标(复制/批注), hover 时加深
- **Position:** 选区上方居中, 超出视口时翻转至下方

## 6. Do's and Don'ts

### Do:

- **Do** 让 Sage Moss 作为唯一强调色, 任何屏幕占比不超过 10%
- **Do** 使用 1px Warm Border 作为默认容器边界, 不用阴影
- **Do** 让阴影只响应用于交互状态(hover/float/focus)
- **Do** 保持 PDF 面板与书架对话框使用相同的 Card White 底色和圆角
- **Do** 使用 `var(--radius-md)` (12px) 和 `var(--radius-lg)` (16px) 保持圆角一致性
- **Do** 使用 `var(--text-muted)` (#9A958C) 作为辅助色, 而不是 #888 或 #999
- **Do** 使用 `var(--ease-out)` 作为过渡曲线, 保持动效的一致性

### Don't:

- **Don't** 在阅读器面板中使用 `rgba(30,30,30,0.95)` 深黑毛玻璃底色(这是当前 PDF 抽屉和操作面板的样式, 必须统一回 Card White)
- **Don't** 使用 `#000` 或 `#fff` 作为任何颜色(用 #1A1918 替代纯黑, 用 #ffffff 替代纯白但注意后者已是 card-bg 令牌)
- **Don't** 在 PDF 视图中搞独立的四档护眼模式切换, 不与主应用三档主题联动
- **Don't** 引入第二个饱和色作为"辅助强调"
- **Don't** 使用 border-left 或 border-right 大于 1px 作为彩色条纹标记
- **Don't** 在面板标题和正文之间重复同样的信息
- **Don't** 让面板看起来像开发者工具的暗色抽屉, 这会打断阅读心流(来自 PRODUCT.md: "任何使用深黑毛玻璃面板作为默认的阅读App")