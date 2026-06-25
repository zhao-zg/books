# Nav Stack Template

核心目标：在不同运行环境统一返回行为。

- 内容页回退 -> 目录页
- 目录页回退 -> 主页
- 主页回退 -> 退出（Capacitor `exitApp`）

接口：

```javascript
window.CXNavStack.initContentPage();
window.CXNavStack.initDirectoryPage();
window.CXNavStack.initHomePage();
```

若是 Web + PWA，可监听 `popstate`；若是 Capacitor，监听 `App.backButton`。
