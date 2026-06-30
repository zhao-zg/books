# .github/ — CI/CD 与发布

## OVERVIEW
4 个 GitHub Actions workflow + 发布流程文档 + 代码规范文件。

## WORKFLOWS
| 文件 | 触发 | 职责 |
|------|------|------|
| `android-release-offline.yml` | push tag `v*` | 主发布：生成网站 → 加密 app-update.js → 构建签名 APK → GitHub Release |
| `deploy.yml` | push main | 部署静态网站到 Cloudflare Pages |
| `auto-download.yml` | 定时/手动 | 自动下载 resource 文件 |
| `test-cloudflare.yml` | 手动 | 测试 Cloudflare Pages 构建 |

## RELEASE FLOW
```
.\release.bat → 更新 app_config.json + git tag → push
→ android-release-offline.yml:
    python main.py → encrypt_app_update.py → cap sync → gradlew assembleRelease → sign → Release
```

## KEY FILES
- [copilot-instructions.md](copilot-instructions.md) — 项目编码规范：弹框开发、前端 JS 职责表、构建命令、反模式，**改代码前必读**
- [RELEASE_PROCESS.md](RELEASE_PROCESS.md) — 发布步骤详解
- [instructions/python-generator.instructions.md](instructions/python-generator.instructions.md) — Python 生成器约定
- [instructions/android-tts.instructions.md](instructions/android-tts.instructions.md) — Android TTS 插件约定
- `skills/` — 自定义 AI 技能

## ANTI-PATTERNS
- **禁止本地运行 `encrypt_app_update.py`**：只在 `android-release-offline.yml` 中执行
- **禁止手动创建 tag**（绕过 `release.bat`）：会跳过版本号更新步骤
- **禁止修改 workflow 中的签名密钥变量名**：与 repo Secrets 强绑定
