---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '0cb57421-cbab-4deb-9291-e2d6bfe04b50'
  PropagateID: '0cb57421-cbab-4deb-9291-e2d6bfe04b50'
  ReservedCode1: '95e6cbc7-4587-47b3-97b2-f1c9f799a40f'
  ReservedCode2: '95e6cbc7-4587-47b3-97b2-f1c9f799a40f'
---

---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '7bef9db1-1064-43d4-a4e3-2dcf3f36acf2'
  PropagateID: '7bef9db1-1064-43d4-a4e3-2dcf3f36acf2'
  ReservedCode1: 'b0bd0063-a202-4cbe-966b-74213509eac1'
  ReservedCode2: 'b0bd0063-a202-4cbe-966b-74213509eac1'
---

---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '638960de-a7dd-445a-9b1c-a0b707f5bc80'
  PropagateID: '638960de-a7dd-445a-9b1c-a0b707f5bc80'
  ReservedCode1: 'aebf384d-0e03-4315-8201-5322089d2fd2'
  ReservedCode2: 'aebf384d-0e03-4315-8201-5322089d2fd2'
---

---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4d97ea82-30ab-4ae4-8597-11d7c126251b'
  PropagateID: '4d97ea82-30ab-4ae4-8597-11d7c126251b'
  ReservedCode1: 'de86012b-2848-4bb3-9310-41fd2fb7b81e'
  ReservedCode2: 'de86012b-2848-4bb3-9310-41fd2fb7b81e'
---

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
✅ 3. 🔐 混淆 app-update 子文件 (保护下载地址)
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

### app-update 子文件自动混淆

在 GitHub Actions 构建过程中，会自动混淆 `output/js/app-update/` 目录下的所有 JS 子文件：

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

A: 解压 APK 查看 `assets/output/js/app-update/` 目录下的 JS 文件，应该看到混淆后的代码。

---

## 📝 工作流文件

混淆步骤位于：
```
.github/workflows/android-release-offline.yml
```

关键步骤：
```yaml
- name: 🔐 执行 JS 混淆
  run: |
    # 混淆 app-update 子文件（已拆分为多文件目录）
    for f in output/js/app-update/*.js; do
      npx javascript-obfuscator "$f" --output "$f" ...
    done
```