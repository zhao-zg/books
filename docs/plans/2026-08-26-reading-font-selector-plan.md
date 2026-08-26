---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6cdb9bf6-af2c-4193-81e4-737d6d724359'
  PropagateID: '6cdb9bf6-af2c-4193-81e4-737d6d724359'
  ReservedCode1: '5ac25556-757b-4ed6-8910-ee6505f2bed8'
  ReservedCode2: '5ac25556-757b-4ed6-8910-ee6505f2bed8'
---

# 阅读字体风格选择 实现计划

> **For implementer:** 本项目为纯前端 HTML+CSS+JS（无构建工具、无测试框架），
> TDD 以「浏览器手动验证」作为测试环节：每步先写代码，然后用 Chrome DevTools 验证预期效果，
> 确认失败（功能缺失/未生效）后再补实现，最后确认通过。

**Goal:** 在阅读设置面板中新增「阅读字体」区块，支持 宋体/黑体/楷体/系统 4 档字体预设切换，持久化到 localStorage。

**Architecture:** 新增 CSS 变量 `--user-reading-font`，阅读容器通过兜底链 `var(--user-reading-font, var(--reading-font-family, ...))` 引用；JS 切换时 setProperty 覆盖该变量，封面标题不受影响。三副本同步：`src/`（git 跟踪）、`output/`、`android/app/src/main/assets/public/`。

**Tech Stack:** 原生 HTML + CSS + JS（无构建工具），CSS 变量 + localStorage。

---

## 三副本路径约定

以下所有文件均需同步 3 份：

| 副本 | 前缀 |
|------|------|
| 主副本（git 跟踪） | `G:\project\github\books\src\` |
| 输出副本 | `G:\project\github\books\output\` |
| Android 副本 | `G:\project\github\books\android\app\src\main\assets\public\` |

设计副本路径为 `src\static\...`，另两副本对应路径结构一致（`output\...`、`android\app\src\main\assets\public\...`）。

---

### Task 1: css-variables.css 新增 `--user-reading-font` 变量

**Files:**
- Modify: `src/static/css/style/css-variables.css`（+ output/ + android/ 副本）

**Step 1: 修改**

在 `--mono-font-family` 行（第 52 行）之后新增一行：

```css
  /* 用户阅读字体（运行时由设置面板切换，空=用默认衬线栈） */
  --user-reading-font: ;
```

**Step 2: 验证**

`Get-Content` 三副本确认该行存在且一致。

**Step 3: Commit**

`git add src/static/css/style/css-variables.css && git commit -m "feat: 新增 --user-reading-font 阅读字体变量"`

---

### Task 2: css-reader.css 阅读容器字体改为兜底链

**Files:**
- Modify: `src/static/css/style/css-reader.css`（+ 副本）

**Step 1: 修改第 11 行**

```css
#chapterContent, .bk-carousel-page .content { padding: calc(env(safe-area-inset-top, 0px) + 16px) 16px 28px; line-height: 1.85; font-family: var(--user-reading-font, var(--reading-font-family, 'Songti SC', Georgia, serif)); font-size: var(--reading-font-size, 16px); }
```

**Step 2: 验证**

三副本 MD5 一致，且行内包含 `--user-reading-font`。

**Step 3: Commit**

`git add src/static/css/style/css-reader.css && git commit -m "feat: 阅读容器字体走 --user-reading-font 兜底链"`

---

### Task 3: css-settings.css 新增字体卡片样式

**Files:**
- Modify: `src/static/css/style/css-settings.css`（+ 副本）

**Step 1: 在 `.font-size-slider-container` 之前新增样式**

```css
/* 阅读字体选择卡片 */
.font-options { display: flex; gap: 8px; }
.font-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 8px;
  cursor: pointer;
  border-radius: 12px;
  border: 1.5px solid var(--border, #E5E2DD);
  color: var(--text);
  background: var(--page-bg, var(--surface, #F5F4F1));
  transition: all .2s cubic-bezier(.4,0,.2,1);
}
.font-option:hover { border-color: var(--brand, #3D8A5A); }
.font-option.active { border-color: var(--brand, #3D8A5A); background: var(--interactive-soft-bg, rgba(var(--brand-rgb, 61,138,90),.08)); }
.font-option-preview {
  font-size: 1.5em;
  line-height: 1.2;
  color: var(--text);
  font-weight: 500;
}
.font-option-content {
  display: flex;
  align-items: center;
  gap: 6px;
}
.font-option .theme-radio { width: 12px; height: 12px; }
.font-option.active .theme-radio {
  border-color: var(--brand, #3D8A5A);
  background: var(--brand, #3D8A5A);
}
.font-option.active .theme-radio::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 1px;
  width: 6px;
  height: 6px;
  background: #fff;
  border-radius: 50%;
}
.font-option-label { font-size: var(--text-sm); color: var(--text); font-weight: 500; }
```

**Step 2: 验证** 三副本一致。

**Step 3: Commit**

`git add src/static/css/style/css-settings.css && git commit -m "feat: 阅读字体选择卡片样式"`

---

### Task 4: theme-toggle.js 字体切换核心逻辑

**Files:**
- Modify: `src/static/js/theme-toggle.js`（+ 副本）

**Step 1: 在文件头部 fontSizes 定义后新增字体预设**

```javascript
    // 阅读字体预设：key → { label, stack }
    const fontPresets = {
        serif:  { label: '宋体', stack: "'Songti SC', 'STSong', SimSun, 'Noto Serif CJK SC', 'Source Han Serif SC', Georgia, 'Times New Roman', serif" },
        sans:   { label: '黑体', stack: "'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif" },
        kai:    { label: '楷体', stack: "'STKaiti', 'KaiTi', '楷体', 'KaiTi_GB2312', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
        system: { label: '系统', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif" }
    };
    const defaultFontKey = 'serif';
    let currentFontKey = defaultFontKey;
```

**Step 2: 新增 setReadingFont / applyReadingFont / updateReadingFontUI**

在 `window.resetFontSize` 定义之后（L866 附近）新增：

```js
    function applyReadingFont(key) {
        var preset = fontPresets[key] || fontPresets[defaultFontKey];
        document.documentElement.style.setProperty('--user-reading-font', preset.stack);
        try { localStorage.setItem('readingFontFamily', key); } catch (e) {}
        currentFontKey = preset === fontPresets[key] ? key : defaultFontKey;
    }

    function updateReadingFontUI() {
        var options = document.querySelectorAll('#bk-theme-dialog .font-option');
        for (var i = 0; i < options.length; i++) {
            var el = options[i];
            var isActive = el.getAttribute('data-font') === currentFontKey;
            el.classList.toggle('active', isActive);
        }
    }

    window.setReadingFont = function(key) {
        applyReadingFont(key);
        updateReadingFontUI();
    };
```

**Step 3: 初始化时读取持久化值**

在 `initThemeToggle()` 内、`applyFontSize(fontSizes[currentSizeIndex])`（L100）之后新增：

```js
        // 恢复阅读字体选择
        var savedFont = null;
        try { savedFont = localStorage.getItem('readingFontFamily'); } catch (e) {}
        if (savedFont && fontPresets[savedFont]) currentFontKey = savedFont;
        applyReadingFont(currentFontKey);
```

**Step 4: 设置面板 HTML 增加「阅读字体」区块**

在「阅读模式」theme-section 结束之后、「字体大小」section 之前（L750 与 L751 之间）插入：

```js
                '<div class="theme-section">' +
                    '<div class="theme-section-title">阅读字体</div>' +
                    '<div class="font-options">' +
                        '<div class="font-option" data-font="serif" onclick="setReadingFont(\'serif\')">' +
                            '<div class="font-option-preview" style="font-family: \'Songti SC\', SimSun, serif;">宋</div>' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label">宋体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="sans" onclick="setReadingFont(\'sans\')">' +
                            '<div class="font-option-preview" style="font-family: \'PingFang SC\', \'Microsoft YaHei\', sans-serif;">黑</div>' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label">黑体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="kai" onclick="setReadingFont(\'kai\')">' +
                            '<div class="font-option-preview" style="font-family: \'STKaiti\', KaiTi, serif;">楷</div>' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label">楷体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="system" onclick="setReadingFont(\'system\')">' +
                            '<div class="font-option-preview" style="font-family: -apple-system, \'Microsoft YaHei\', sans-serif;">系</div>' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label">系统</div></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
```

**Step 5: toggleThemePanel 打开时同步选中态**

在 L775 `updateFontSizeUI();` 之后新增 `updateReadingFontUI();`

**Step 6: 验证**

- 浏览器打开 index.html → 打开设置面板 → 出现「阅读字体」区块 4 卡片
- 点击「黑体」→ 阅读区正文变为无衬线
- 点击「楷体」→ 变为楷体
- 刷新页面 → 保持上次选择
- localStorage 出现 `readingFontFamily`

**Step 7: Commit**

`git add src/static/js/theme-toggle.js && git commit -m "feat: 阅读字体风格切换与持久化"`

---

### Task 5: 三副本同步 + 全面验证

**Files:**
- Sync: `output/` 与 `android/app/src/main/assets/public/` 下对应文件

**Step 1: 同步三副本**

将 `src/` 修改的 4 个文件复制到 output/ 和 android/ 对应路径，用 `Copy-Item`。

**Step 2: MD5 校验**

所有 12 个文件（4 文件 × 3 副本）MD5 一致。

**Step 3: 浏览器全面回归**

- 默认字体 = 宋体（衬线）
- 4 卡片切换即时生效
- 刷新持久化
- 夜间模式切换字体正常
- 封面书名不变（仍是衬线）
- 无 console 报错

**Step 4: Commit**

`git add src && git commit -m "feat: 阅读字体风格选择功能"`（三副本中仅 src 被 git 跟踪）

---

## 完成定义

- 设置面板出现「阅读字体」4 卡片（宋体/黑体/楷体/系统）
- 点击即切换阅读区字体，刷新后保持
- 封面标题不受影响
- 三副本 MD5 一致
- 浏览器无 console 报错

> AI生成