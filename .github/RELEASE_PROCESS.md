# 🚀 发布流程说明

## 📋 完整的发布流程

### 1️⃣ 本地发布（推荐）

```bash
# 运行发布脚本
.\release.bat

# 按提示输入新版本号
# 确认后会自动：
# - 更新 app_config.json
# - 创建并推送 git tag
```

### 2️⃣ GitHub Actions 自动构建

Tag 推送后，GitHub Actions 会自动：

```
✅ 1. 安装依赖
✅ 2. 生成静态网站 (python main.py)
✅ 3. 🔐 加密 app-update.js (保护下载地址)
✅ 4. 生成版本信息
✅ 5. 同步到 Capacitor
✅ 6. 构建 Android APK
✅ 7. 签名 APK
✅ 8. 创建 GitHub Release
✅ 9. 上传加密后的 APK
```

### 3️⃣ 验证发布

访问 Release 页面查看：
```
https://github.com/zhao-zg/books/releases
```

---

## 🔐 安全特性

### app-update.js 自动加密

在 GitHub Actions 构建过程中，会自动加密 `app-update.js`：

**加密内容：**
- ✅ 下载地址
- ✅ 镜像链接
- ✅ 更新逻辑

**加密效果：**
```javascript
// 原始代码（明文）
mirrors: [
    'https://gh-proxy.com/',
    'https://ghproxy.net/',
    ...
]

// 加密后（完全不可读）
var _d='ΩΨΦΩΨΦΩΨΦ...';
function _dec(e,k){...}
```

---

## ⚠️ 注意事项

### ✅ 本地开发

**不要**在本地运行加密：
```bash
# ❌ 本地不要执行
npm run encrypt:app-update

# ✅ 只需正常开发
python main.py
npm run android:dev
```

### ✅ GitHub Actions

加密**只在 GitHub Actions 中自动进行**：
- 本地仓库保持原始文件
- 构建时自动加密
- 发布的 APK 包含加密版本

---

## 🔄 发布版本更新

### 快速发布

```bash
# 1. 运行发布脚本
.\release.bat

# 2. 输入版本号（如 1.2.3）

# 3. 确认

# 4. 等待 GitHub Actions 完成
```

### 查看进度

```
https://github.com/zhao-zg/books/actions
```

---

## 📊 版本号规范

使用语义化版本：`主版本.次版本.修订号`

**示例：**
- `1.0.0` - 首个正式版本
- `1.1.0` - 新增功能
- `1.1.1` - 修复 bug
- `2.0.0` - 重大更新

---

## 🆘 常见问题

### Q: 本地如何测试加密？

A: 不需要！只在 GitHub Actions 中加密，本地保持原始文件便于开发。

### Q: 如果需要手动加密怎么办？

A: 
```bash
npm run encrypt:app-update  # 加密
npm run restore:app-update  # 恢复
```

### Q: 如何验证 APK 是否已加密？

A: 解压 APK 查看 `assets/output/js/app-update.js`，应该看到加密后的代码。

---

## 📝 工作流文件

加密步骤位于：
```
.github/workflows/android-release-offline.yml
```

关键步骤：
```yaml
- name: 🔐 加密 app-update.js (保护下载地址)
  run: |
    python encrypt_app_update.py
```
