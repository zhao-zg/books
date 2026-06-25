---
applyTo: "android/**"
---

# Android / Capacitor 规范

## 插件架构

| 文件 | 职责 |
|---|---|
| `NativeTTSPlugin.java` | Capacitor 桥接层；暴露 JS API，持有 `activeCall` |
| `TTSForegroundService.java` | 前台服务；实际驱动 Android TTS，保证息屏后继续播放 |
| `ApkInstallerPlugin.java` | APK 下载安装（应用内更新） |
| `ImageSaverPlugin.java` | 图片保存到相册 |
| `CrashLogPlugin.java` / `CrashReporter.java` | 崩溃日志收集 |

## NativeTTS JS API

```js
NativeTTS.speak({ text, lang?, rate?, title?, artist?, startSecs?, totalSecs?, loop? })
NativeTTS.stop()
NativeTTS.pause()
NativeTTS.resume()
// 事件（notifyListeners）
'ttsProgress'  → { done: charsDone, total: totalChars }
'ttsPosition'  → { posMs, totalMs }
```

**已移除，禁止重新添加**：`seekTo()`、`pendingSeekPositionMs`、`speakStartRunnable`、`chunkRetryCount`、MediaSession `onSeekTo` 回调。

## TTSForegroundService 关键约定

- `CHUNK_SIZE = 200`（每块字符数），不要随意调大，否则影响进度精度
- Intent Actions：`ACTION_SPEAK` / `ACTION_STOP` / `ACTION_PAUSE` / `ACTION_RESUME` / `ACTION_SET_RATE`
- Service → Plugin 回调通过 `static volatile Listener` 传递（线程安全）
- **循环播放**：`loop=true` 时由 Java `notifyFinished()` 直接重置 `chunkIndex=0` 并调 `playChunkOnly()`，不经过 JS roundtrip，息屏下可靠
- `startSecs` / `totalSecs` 传入时，Java 用 `startSecs/totalSecs` 比率计算起始 `chunkIndex`，`sliceStartPositionMs` 重置为 0（从整段文本头部朗读对应 chunk）
- **双模式播放**：默认使用 `synthesizeToFile` + `MediaPlayer`（支持变速不变调）。若连续 `MAX_SYNTH_FAILURES(2)` 次 `synthesizeToFile` 返回 ERROR（华为/OPPO 等自研 TTS 引擎常见问题），自动降级为 `tts.speak()` 直接播放（变速通过 `setSpeechRate` 实现，音调会变，但保证有声音）。`useSpeakDirect` 标志控制模式，每次新 `handleSpeak()` 重置为 synthesize 模式

## TTS 状态机（speech.js）

状态：`idle` → `playing` ⇄ `paused` → `idle`

- NativeTTS 的 pause/seek 均实现为 stop + 重新 speak（无 seekTo API）
- Web Speech API（非 Capacitor）：pause = cancel + 保存百分比，resume = `startSpeakingFromPercent`
- `speakGeneration` 计数器用于防止过期回调触发循环/重试

## Capacitor 版本

Capacitor 6；同步命令：

```bash
npx cap sync        # JS build → android/app/src/main/assets/public
npx cap open android  # 在 Android Studio 打开
```

## 签名与发布

密钥配置存于 GitHub Secrets，见 [.github/RELEASE_PROCESS.md](../RELEASE_PROCESS.md)。
本地不持有 keystore 时，只能通过 `.\release.bat` 推 tag 触发 CI 签名构建。
