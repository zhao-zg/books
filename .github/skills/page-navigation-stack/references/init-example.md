# Init Example

```html
<script src="js/nav-stack.js"></script>
<script>
if (window.CXNavStack) {
  // 内容页
  window.CXNavStack.initContentPage();

  // 目录页时改成:
  // window.CXNavStack.initDirectoryPage();

  // 主页时改成:
  // window.CXNavStack.initHomePage();
}
</script>
```

目录页可结合 sessionStorage / URL 参数处理“从哪里返回”的细节。
