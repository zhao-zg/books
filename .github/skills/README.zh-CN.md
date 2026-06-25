# Skills 中文使用手册

本目录下的 skills 都支持在 Copilot Chat 中用 `/` 调用。

## 如何调用

1. 在项目中确保存在 `.github/skills/`。
2. 打开 Copilot Chat，输入 `/`。
3. 选择对应 skill，或直接输入命令。

## 推荐总流程（新项目）

1. `/static-to-pwa ...`
2. `/web-reading-tts ...`
3. `/page-navigation-stack ...`
4. `/reading-experience-suite ...`
5. `/capacitor-apk-build ...`
6. `/apk-self-update ...`
7. `/cloudflare-pages-deploy ...`

---

## 1. static-to-pwa

用途：把静态 HTML 站点变成 PWA（manifest、sw、离线缓存、缓存清理、环境按钮）。

示例命令：

```text
/static-to-pwa 把 output 目录改造成 PWA，包含缓存数据/清理缓存，并按环境显示下载APK和安装PWA按钮
```

---

## 2. web-reading-tts

用途：给页面加朗读（TTS），含播放暂停、语速、进度条。

示例命令：

```text
/web-reading-tts 给内容页加朗读功能，使用 .content-text 作为朗读文本来源
```

---

## 3. page-navigation-stack

用途：统一翻页和返回栈（内容页->目录页->主页->退出），兼容 Web/PWA/Capacitor。

示例命令：

```text
/page-navigation-stack 给主页、目录页、内容页接入统一返回逻辑，并支持安卓返回键
```

---

## 4. reading-experience-suite

用途：一条命令整合阅读体验（字体、主题、朗读、翻页、环境按钮、缓存管理）。

示例命令：

```text
/reading-experience-suite 把完整阅读体验接入我的项目，页面分为 home/directory/content 三类
```

配套模板：

- `reading-experience-suite/assets/starter/README.md`

---

## 5. capacitor-apk-build

用途：使用 GitHub Actions + Capacitor 6 自动打包 Android APK（可发布 Release）。

示例命令：

```text
/capacitor-apk-build 用 appId=com.example.app appName=MyApp webDir=output 生成可发布的 APK 构建流程
```

配套模板包：

- `capacitor-apk-build/assets/starter/`

---

## 6. apk-self-update

用途：给 APK 加应用内更新（版本检测、下载 APK、触发安装）。

示例命令：

```text
/apk-self-update 使用 version.json 检查更新，下载 GitHub Release 的 APK 并触发安装
```

---

## 7. cloudflare-pages-deploy

用途：自动部署到 Cloudflare Pages（可带 GitHub Pages 兜底）。

示例命令：

```text
/cloudflare-pages-deploy 项目名 my-app，部署 output 目录，并保留 github pages fallback
```

配套模板包：

- `cloudflare-pages-deploy/assets/starter/.github/workflows/deploy.yml`

---

## 常见问题

1. 为什么 `/` 里看不到 skill？
- 检查 `SKILL.md` 是否存在。
- 检查 `name` 是否与文件夹名一致。
- 重新打开工作区或重开 Chat 面板。

2. 能不能只用一个总 skill？
- 可以，优先用 `/reading-experience-suite`，它会串联阅读相关能力。

3. 新项目最快怎么落地？
- 先复制 starter 模板包，再按“推荐总流程”执行。
