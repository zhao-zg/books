# Copilot Instructions

## 项目概述

**书报**：电子书阅读应用，从源文件生成静态 HTML 网站，并打包为 Android PWA/APK。

- **技术栈**：Python 3 生成器 + Jinja2 模板 + Capacitor 6（Android 壳）
- **构建命令**：`python main.py`（重新生成 `output/` 全部静态文件）
- **发布**：运行 `.\release.bat` → 推送 git tag → GitHub Actions 自动构建签名 APK
  见 [.github/RELEASE_PROCESS.md](.github/RELEASE_PROCESS.md)

## 项目架构

```
resource/             # 电子书源文件
src/
  parser_improved.py  # 文档解析器（双格式自动检测）
  generator.py        # HTML 生成器（调用 Jinja2 模板）
  models.py           # 数据模型
  templates/          # Jinja2 模板
  static/
    css/style.css     # 全局样式（source，main.py 复制到 output/）
    js/               # 前端运行时（source，main.py 复制到 output/）
    index.html        # PWA 首页 source
output/               # 生成产物（勿手动编辑），deploy 到 Cloudflare Pages
android/              # Capacitor Android 项目
config.yaml           # 配置
```

## 关键前端文件（src/static/js/）

| 文件 | 职责 |
|---|---|
| `theme-toggle.js` | 主题切换、设置面板、`CX.openDialog` 工厂、`CX.backStack` |
| `speech.js` | TTS 朗读（Web Speech API + Capacitor NativeTTS），状态机 `idle/playing/paused` |
| `router.js` | SPA 路由 |
| `nav-stack.js` | 页面翻页 & 返回栈（PWA/Capacitor） |
| `app-update.js` | APK 自动更新（GitHub Releases + 镜像回退） |
| `resource-pack.js` | 资源包管理对话框 |
| `renderer.js` | 各页面类型渲染逻辑 |

## 代码修改规范

- **禁止使用 PowerShell 命令修改代码文件**（包括 `Set-Content`、`Out-File`、`Add-Content`、重定向 `>`、`>>`、`$lines[...] | Set-Content` 等方式）。
  PowerShell 的文本 cmdlet 默认使用系统代码页（如 GBK）读取文件，再以 UTF-8 BOM 写回，会导致中文字符乱码，且可能破坏字符串字面量（如丢失引号）。
- 需要生成或覆写文件内容时，一律使用：
  1. `create_file` / `replace_string_in_file` 工具直接操作，或
  2. Node.js 脚本，以 `fs.writeFileSync(path, content, 'utf8')` 写入（无 BOM）。

## 弹框开发规范（优先使用 CX.openDialog）

### CX.openDialog — 通用弹框工厂（推荐）

`theme-toggle.js` 中的 `window.CX.openDialog(opts)` 统一封装了所有弹框样板代码（遮罩创建、lockOverlayScroll、backStack 注册、遮罩点击关闭、冒泡阻止），**新增弹框应优先使用它**：

```js
var dlg = window.CX.openDialog({
    id: 'myDialogMask',          // 可选，用于防止重复打开；重复时返回 null
    html: '<div class="cx-dialog">...</div>',  // 遮罩内的 innerHTML
    // className: 'cx-dialog-mask',  // 默认值，一般不需要改
    // onClose: function() {},       // 关闭后回调（可选）
});
if (!dlg) return;  // id 重复守卫

// dlg.mask  — 遮罩 DOM 元素，用于继续绑定内部事件
// dlg.close — 主动关闭函数（消耗 history 记录）
dlg.mask.addEventListener('click', function(e) {
    var t = e.target;
    if (t.getAttribute('data-action') === 'cancel') { dlg.close(); return; }
    // ... 其他内部事件委托
});
var closeBtn = document.getElementById('myDialogClose');
if (closeBtn) closeBtn.addEventListener('click', dlg.close);
```

**openDialog 已自动处理**：遮罩 `appendChild`、`lockOverlayScroll`、`backStack.push`、`e.target === mask` 时 `stopPropagation + close()`。
**无需手动做**：mask.id 赋值、class 赋值、append、lockOverlay、backStack push/pop、mask 点击关闭逻辑。

---

### 低层 API（仅当 openDialog 不适用时使用）

进度类弹框（不可中途关闭）或有特殊结构时，手动处理：

```js
// 挂载后注册到 backStack（系统返回键直接调用此 fn 关闭）
document.body.appendChild(mask);
if (win.CX && win.CX.lockOverlayScroll) win.CX.lockOverlayScroll(mask);
if (win.CX && win.CX.backStack) win.CX.backStack.push(function() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
});

// 手动关闭（按钮/遮罩点击）：先移除 DOM，再 pop（内部调 history.back()）
function closeDialog() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    if (win.CX && win.CX.backStack) win.CX.backStack.pop();
}
// 遮罩点击关闭时必须 stopPropagation，避免冒泡误触主题面板关闭
mask.addEventListener('click', function(e) {
    if (e.target === mask) { e.stopPropagation(); closeDialog(); }
});
```

**背景**：`window.CX.lockOverlayScroll` 通过绑定 `touchstart` / `touchmove` 防滚动穿透；`backStack` 统一管理系统返回键。

---

**新增弹框时的检查清单**：
1. 优先用 `CX.openDialog`，填 `id`、`html` 两个字段即可
2. 若手动创建：class `cx-dialog-mask`，`touch-action:none;overscroll-behavior:none`
3. 遮罩点击必须 `e.stopPropagation()`，防止冒泡误触设置面板
