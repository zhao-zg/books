---
name: page-navigation-stack
description: 'Add page navigation and back-stack behavior for web, PWA, and Capacitor apps. Use when: 翻页, 页面导航, 返回栈, backButton, popstate, 上一页, 下一页, 目录返回.'
argument-hint: 'Describe your page types (home/directory/content) and desired back behavior'
---

# Page Navigation Stack

## When to Use
- 多页面静态站需要稳定的返回逻辑
- 要兼容浏览器、PWA、Capacitor 的返回键行为
- 需要统一“内容页 -> 目录页 -> 主页 -> 退出”路径

## Procedure

### Step 1: Add navigation bar

使用模板 [Page Navigation Template](./references/page-navigation-template.md)。

### Step 2: Add shared `nav-stack.js`

复制共享脚本（见 [Nav Stack Template](./references/nav-stack-template.md) 或 [assets/nav-stack.js](./assets/nav-stack.js)）。

### Step 3: Initialize by page type

在页面中调用：
- `window.CXNavStack.initContentPage()`
- `window.CXNavStack.initDirectoryPage()`
- `window.CXNavStack.initHomePage()`

示例见 [Init Example](./references/init-example.md)。

### Step 4: Optional previous/next page links

若要章节内翻页（上一页/下一页），可在模板中按文件命名规则拼接链接。

## Assets

- [Nav Stack Starter](./assets/nav-stack.js)

## References

- [Page Navigation Template](./references/page-navigation-template.md)
- [Nav Stack Template](./references/nav-stack-template.md)
- [Init Example](./references/init-example.md)
