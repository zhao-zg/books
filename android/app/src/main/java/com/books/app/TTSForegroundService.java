package com.books.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * TTSForegroundService — Android Foreground Service for background-safe TTS.
 *
 * Protects against background kill via:
 *   1. Foreground Service + persistent notification
 *   2. PARTIAL_WAKE_LOCK (keeps CPU awake so TTS callbacks fire on schedule)
 *   3. AudioFocus management
 *
 * Communication with NativeTTSPlugin:
 *   JS  → Service  : startForegroundService(Intent) with ACTION_SPEAK / STOP / PAUSE / RESUME
 *   Service → Plugin: static volatile Listener callback
 */
public class TTSForegroundService extends Service {

    // ── Intent Actions ────────────────────────────────────────────────────
    public static final String ACTION_SPEAK    = "com.books.tts.SPEAK";
    public static final String ACTION_STOP     = "com.books.tts.STOP";
    public static final String ACTION_PAUSE    = "com.books.tts.PAUSE";
    public static final String ACTION_RESUME   = "com.books.tts.RESUME";
    public static final String ACTION_SET_RATE = "com.books.tts.SET_RATE"; // 仅更新倍率，不重启播放

    // ── Callback interface (set by NativeTTSPlugin) ───────────────────────
    public interface Listener {
        void onFinished();
        void onError(String message);
        /** Called after each chunk completes; charsDone / totalChars gives accurate progress. */
        void onProgress(int charsDone, int totalChars);
        /** Called every ~100 ms while playing; posMs/totalMs are absolute positions in full text,
         *  charsDone is the real-time character progress based on MediaPlayer playback position. */
        default void onPosition(long posMs, long totalMs, int charsDone) {}
    }
    public static volatile Listener listener = null;

    // ── Constants ─────────────────────────────────────────────────────────
    private static final String CHANNEL_ID = "books_tts_channel";
    private static final int    NOTIF_ID   = 8001;
    private static final int    CHUNK_SIZE = 200;   // chars per chunk

    // ── TTS ───────────────────────────────────────────────────────────────
    private volatile TextToSpeech tts;  // volatile: 后台线程(UtteranceProgressListener)需要可见性
    private volatile boolean      ttsReady      = false;
    private int                   ttsInitRetries = 0;  // TTS 初始化重试计数
    private static final int      MAX_TTS_RETRIES = 3;
    private static final long[]   TTS_RETRY_DELAYS = {500, 1000, 2000}; // 指数退避（ms）
    private volatile boolean      ttsInitFailed  = false; // 所有重试均失败后置 true

    // ── Playback State ────────────────────────────────────────────────────
    private final List<String>  chunks     = new ArrayList<>();
    private volatile int        chunkIndex = 0;
    private volatile boolean    isPaused     = false;
    private volatile boolean    pausedByUser = false; // true=用户手动暂停，false=系统失焦自动暂停
    private volatile boolean    isStopped  = false;
    private volatile boolean    loopEnabled = false; // 循环播放开关，由 JS speak() 的 loop 参数控制
    private volatile int        speakGen   = 0;   // generation counter for stale-callback guard
    private float               playRate   = 1.0f;
    private String              playLang   = "zh-CN";
    private int                 totalTextLength = 0; // set in handleSpeak; used for progress
    private long                chunkStartPositionMs = 0; // 当前 chunk 开始时的媒体位置（ms）
    private long                currentChunkActualDurationMs = 0; // 当前 chunk 音频实际时长（ms，来自 MediaPlayer.getDuration）
    private long                sliceStartPositionMs  = 0; // seek 点偏移，从 JS 传入的 startSecs * 1000
    private long                fullTotalDurationMs   = 0; // 全文稿总时长，从 JS 的 totalSecs * 1000
    private String              playTitle            = "";  // 锁屏/通知栏标题（篇章）
    private String              playArtist           = "";  // 锁屏/通知栏副标题（训练名）
    private Bitmap              appIconBitmap        = null; // APP 图标，缓存避免重复解码

    // 定期向 JS 推送播放位置，保持 APP 内进度条与 MediaSession 同步
    private volatile Runnable   positionRunnable     = null;
    // 自然播放结束后延迟销毁 Service 的 Runnable；循环播放时在宽限期内取消，避免 TTS 反复初始化
    private volatile Runnable   _pendingStop         = null;

    // ── MediaPlayer（synthesizeToFile → MediaPlayer + PlaybackParams 变速）───────
    private MediaPlayer         mediaPlayer          = null;
    // N+1 预生成：播放 chunk N 期间提前合成 chunk N+1，消除 chunk 间停顿
    private volatile File       nextTempFile         = null;  // 预合成完成的下一 chunk 文件
    private volatile int        synthForChunk        = -1;    // 正在合成哪个 chunk（-1 = 无）

    // ── Direct-speak mode (speak() fallback when synthesizeToFile fails) ──
    private volatile boolean    useSpeakDirect       = false;  // true = 使用 speak() 直接播放（降级模式）
    private static final int    MAX_SYNTH_FAILURES   = 2;      // 连续 N 次合成失败后切换到 speak() 模式
    private int                 synthFailureCount    = 0;      // 当前会话连续合成失败计数
    private int                 directSpeakCharsDone = 0;      // speak 模式已完成 chunk 的累计字符数

    // ── System Resources ──────────────────────────────────────────────────
    private AudioManager                          audioManager;
    private AudioFocusRequest                     audioFocusRequest; // API 26+
    private AudioManager.OnAudioFocusChangeListener audioFocusListener;
    private PowerManager.WakeLock                 wakeLock;
    private MediaSession                            mediaSession;
    private Handler                               mainHandler;
    // 专用播放派发线程：息屏后主线程被 Doze 节流，chunk 间切换会被挂起；
    // 独立的 THREAD_PRIORITY_AUDIO 线程不受影响，配合 WakeLock 可持续播放。
    private HandlerThread                         ttsHandlerThread;
    private Handler                               ttsHandler;

    // ═══════════════════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
        ttsHandlerThread = new HandlerThread("BooksTTSWorker", android.os.Process.THREAD_PRIORITY_AUDIO);
        ttsHandlerThread.start();
        ttsHandler = new Handler(ttsHandlerThread.getLooper());
        createNotificationChannel();

        // 解码 APP 图标，供通知栏大图和锁屏封面使用
        try {
            appIconBitmap = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        } catch (Exception ignored) {}

        // WakeLock: prevents Android from throttling CPU / deferring callbacks
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Books:TTSWakeLock");
        }

        // MediaSession: 向系统声明这是媒体播放器。
        // 国产 ROM（MIUI/EMUI/ColorOS）看到 MediaSession 处于 active 状态，
        // 就不会将该服务当作普通后台服务杀掉。
        // 使用框架内置 API（API 21+），无需额外依赖。
        mediaSession = new MediaSession(this, "BooksTTSSession");
        mediaSession.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setActive(true);

        // ★ 最早调用 startForeground()：在 onCreate() 阶段就满足要求。
        // OnePlus/ColorOS 等 ROM 会激进延迟服务调度，导致 5 秒计时器在
        // onStartCommand() 被调用前就到期。这里是防止崩溃的最早时机。
        Notification earlyNotif = buildNotification(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, earlyNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, earlyNotif);
        }

        // Callback: 处理锁屏/通知栏媒体控件的点击事件（播放/暂停/停止/拖动进度条）
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()  { mainHandler.post(() -> handleResume()); }
            @Override public void onPause()  { mainHandler.post(() -> handlePause()); }
            @Override public void onStop()   { mainHandler.post(() -> handleStop()); }
        });
        initTts();
    }

    /** 初始化 TTS 引擎，失败时最多自动重试 MAX_TTS_RETRIES 次。 */
    private void initTts() {
        ttsInitFailed = false;
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                ttsInitRetries = 0;
                ttsReady = true;
                ttsInitFailed = false;
                // 仅在确认初始化成功后才设置 UtteranceProgressListener，
                // 避免在 retry 过程中对已作废的 tts 实例设置监听器。
                TextToSpeech ready = tts;
                if (ready != null) {
                    ready.setOnUtteranceProgressListener(buildUtteranceListener());
                }
                // If a speak request arrived before init completed, start now
                if (!chunks.isEmpty() && !isStopped && !isPaused) {
                    playChunkOnly(); // setTtsParams() 内嵌在 doSynthesizeChunk() 中
                }
            } else {
                // OxygenOS/MIUI 上 TTS 引擎首次初始化偶发 ERROR，稍后重试通常成功
                ttsInitRetries++;
                android.util.Log.w("TTSFgSvc", "TTS init failed, retry " + ttsInitRetries + "/" + MAX_TTS_RETRIES);
                if (ttsInitRetries < MAX_TTS_RETRIES) {
                    TextToSpeech old = tts;
                    tts = null;
                    try { if (old != null) old.shutdown(); } catch (Exception ignored) {}
                    long delay = TTS_RETRY_DELAYS[Math.min(ttsInitRetries - 1, TTS_RETRY_DELAYS.length - 1)];
                    android.util.Log.w("TTSFgSvc", "retrying in " + delay + "ms");
                    mainHandler.postDelayed(() -> {
                        if (!isStopped) initTts();
                    }, delay);
                } else {
                    ttsInitFailed = true;
                    notifyError("TTS 初始化失败，请检查系统语音引擎");
                }
            }
        });
    }

    /** 构建 UtteranceProgressListener（拆出以便 initTts 成功后单独设置）。 */
    private UtteranceProgressListener buildUtteranceListener() {
        return new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                if (useSpeakDirect) {
                    // speak() 模式：音频开始播放，启动位置广播
                    mainHandler.post(() -> {
                        if (!isStopped && !isPaused) {
                            startPositionBroadcast();
                            updatePlaybackState(true);
                        }
                    });
                }
            }

            @Override
            public void onDone(String utteranceId) {
                if (useSpeakDirect) {
                    // ── speak() 直接播放模式：onDone = 音频播放完毕 ─────────
                    int gen = parseGen(utteranceId);
                    if (gen != speakGen || isStopped || isPaused) return;
                    final int capturedGen = gen;
                    mainHandler.post(() -> {
                        if (speakGen != capturedGen || isStopped) return;
                        onDirectSpeakChunkDone(capturedGen);
                    });
                } else {
                    // ── synthesizeToFile 模式：onDone = 文件写入完毕 ────────
                    int gen = parseGen(utteranceId);
                    int chunkOfUid = parseChunk(utteranceId);
                    File tempFile = new File(getCacheDir(), "tts_" + utteranceId + ".wav");

                    if (gen != speakGen || isStopped || isPaused) {
                        // 守卫触发：该合成结果已过期，直接删除临时文件。
                        deleteTempFile(tempFile);
                        return;
                    }

                    final int capturedGen = gen;
                    final File capturedFile = tempFile;
                    mainHandler.post(() -> {
                        if (speakGen != capturedGen || isStopped || isPaused) {
                            deleteTempFile(capturedFile);
                            return;
                        }
                        if (chunkOfUid == chunkIndex) {
                            // 当前正等待合成的 chunk → 立即开始播放
                            startMediaPlayer(capturedFile, capturedGen);
                        } else if (chunkOfUid == chunkIndex + 1) {
                            // N+1 预生成完成 → 存储，等当前 chunk 播完后零间隙衔接
                            deleteTempFile(nextTempFile); // 清理上一轮可能残留的旧预生成文件
                            nextTempFile = capturedFile;
                        } else {
                            // 意外的 uid（不应发生），清理文件
                            deleteTempFile(capturedFile);
                        }
                    });
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String utteranceId) {
                if (useSpeakDirect) {
                    // speak() 模式：朗读出错，跳过当前 chunk 继续
                    int gen = parseGen(utteranceId);
                    if (gen != speakGen || isStopped) return;
                    final int capturedGen = gen;
                    mainHandler.post(() -> {
                        if (speakGen != capturedGen || isStopped) return;
                        onDirectSpeakChunkDone(capturedGen); // 当作完成，跳到下一个
                    });
                } else {
                    // synthesizeToFile 模式：合成失败，清理文件并跳过
                    int gen = parseGen(utteranceId);
                    int chunkOfUid = parseChunk(utteranceId);
                    File tempFile = new File(getCacheDir(), "tts_" + utteranceId + ".wav");
                    deleteTempFile(tempFile); // 合成失败，文件可能不完整
                    if (gen != speakGen || isStopped) return;
                    if (chunkOfUid != chunkIndex) return; // 只处理当前 chunk 的错误
                    final int capturedGen = gen;
                    mainHandler.post(() -> {
                        if (speakGen != capturedGen || isStopped) return;
                        onChunkPlaybackComplete(capturedGen);
                    });
                }
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Android 要求 startForegroundService() 后 5 秒内必须调 startForeground()。
        // 在所有分支之前统一调用：无论 Intent 为 null、系统重建，还是任何 ACTION，
        // 都能保证在 onStartCommand() 入口处立即满足要求，避免超时崩溃。
        Notification notif0 = buildNotification(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif0, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, notif0);
        }

        if (intent == null || intent.getAction() == null) {
            // START_STICKY 重建 or 系统传入空 Intent：直接停止即可。
            stopSelf();
            return START_NOT_STICKY;
        }

        switch (intent.getAction()) {
            case ACTION_SPEAK:    handleSpeak(intent);   break;
            case ACTION_STOP:     handleStop();           break;
            case ACTION_PAUSE:    handlePause();          break;
            case ACTION_RESUME:   handleResume();         break;
            case ACTION_SET_RATE: handleSetRate(intent);  break;
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        isStopped = true;
        ttsReady  = false;
        if (mainHandler != null) mainHandler.removeCallbacksAndMessages(null);
        if (ttsHandler  != null) ttsHandler.removeCallbacksAndMessages(null);
        positionRunnable  = null;
        synthForChunk = -1;
        releaseMediaPlayer();
        deleteTempFile(nextTempFile);
        nextTempFile = null;
        cleanTempFiles();
        if (ttsHandlerThread != null) { ttsHandlerThread.quitSafely(); ttsHandlerThread = null; }
        releaseWakeLock();
        abandonAudioFocus();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        TextToSpeech t = tts;
        tts = null;
        if (t != null) {
            t.stop();
            t.shutdown();
        }
        super.onDestroy();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Action handlers
    // ═══════════════════════════════════════════════════════════════════════

    private void handleSpeak(Intent intent) {
        // 取消宽限期内挂起的延迟停止，循环播放时复用现有 TTS 实例而无需重建 Service
        cancelPendingStop();
        String text   = intent.getStringExtra("text");
        String lang   = intent.getStringExtra("lang");
        String title  = intent.getStringExtra("title");
        String artist = intent.getStringExtra("artist");
        if (lang   != null && !lang.isEmpty())   playLang   = lang;
        if (title  != null && !title.isEmpty())  playTitle  = title;
        if (artist != null && !artist.isEmpty()) playArtist = artist;
        playRate             = intent.getFloatExtra("rate", 1.0f);
        loopEnabled          = intent.getBooleanExtra("loop", false);
        // JS 现在传完整文本，seek 偏移由 startSecs/totalSecs 比率计算 chunkIndex 实现，
        // 循环时 chunkIndex=0 对应全文开头，不再受熄屏截断位置影响。
        sliceStartPositionMs = 0;
        fullTotalDurationMs  = (long)(intent.getFloatExtra("totalSecs", 0f) * 1000L);

        // startForeground() 已在 onStartCommand() 最顶部统一调用，此处更新通知为播放状态。
        updateNotification(true);

        if (text == null || text.trim().isEmpty()) {
            notifyError("文本为空");
            return;
        }

        // Reset state
        isStopped    = false;
        isPaused     = false;
        pausedByUser = false;
        chunkIndex   = 0;
        chunkStartPositionMs = 0;
        currentChunkActualDurationMs = 0;
        speakGen++;
        // 重置播放模式和失败计数（每次新 speak 从 synthesizeToFile 开始尝试）
        useSpeakDirect = false;
        synthFailureCount = 0;
        directSpeakCharsDone = 0;
        // 重置流水线状态：清理上次会话可能剩下的预生成文件
        synthForChunk = -1;
        releaseMediaPlayer();
        deleteTempFile(nextTempFile);
        nextTempFile = null;
        cleanTempFiles();
        chunks.clear();
        chunks.addAll(splitText(text, CHUNK_SIZE));
        totalTextLength = text.length();

        // 根据 startSecs/totalSecs 比率跳到正确的起始 chunk（替代之前由 JS sliceText 实现的 seek）
        float seekSecs  = intent.getFloatExtra("startSecs", 0f);
        float totalSecs = intent.getFloatExtra("totalSecs", 0f);
        if (seekSecs > 0f && totalSecs > 0f && totalTextLength > 0) {
            int targetChar = (int)(totalTextLength * (seekSecs / totalSecs));
            int cumLen = 0;
            for (int i = 0; i < chunks.size(); i++) {
                if (cumLen + chunks.get(i).length() > targetChar) {
                    chunkIndex = i;
                    break;
                }
                cumLen += chunks.get(i).length();
            }
        }

        updateMediaMetadata(); // 让锁屏/通知栏知道标题和总时长

        if (!requestAudioFocus()) {
            // 音频焦点申请被拒（OxygenOS/MIUI 省电策略等），降级继续播放。
            // TTS 引擎不强依赖焦点，绝大多数情况下仍可正常发声；
            // 拒绝报错反而让用户完全无法使用，降级比报错更合理。
            android.util.Log.w("TTSFgSvc", "requestAudioFocus failed, continuing anyway");
        }

        acquireWakeLock();
        updatePlaybackState(true);

        if (ttsReady) {
            // 先显式 stop() 确保引擎当前无正在进行的合成任务，延迟 200ms 等硬件缓冲区排空。
            TextToSpeech t = tts;
            if (t != null) t.stop();
            final int gen = speakGen;
            ttsHandler.postDelayed(() -> {
                if (speakGen != gen || isStopped) return;
                playChunkOnly(); // setTtsParams() 已内嵌在 doSynthesizeChunk() 中
            }, 200);
        } else if (ttsInitFailed) {
            // 上次全部重试均失败，用户再次点播放时允许重新初始化。
            android.util.Log.w("TTSFgSvc", "Re-attempting TTS init after previous failure");
            ttsInitRetries = 0;
            ttsInitFailed = false;
            initTts();
            // chunks 已设置好，initTts 成功后的回调里会自动调用 playChunkOnly()
        }
        // else: TTS 仍在初始化中，OnInitListener 成功时会自动调用 playChunkOnly()
    }

    private void handleSetRate(Intent intent) {
        float newRate = intent.getFloatExtra("rate", playRate);
        playRate = newRate;
        if (useSpeakDirect) {
            // speak 模式：通过 setSpeechRate 应用新倍率（当前正在朗读的 chunk 不受影响，下一个 chunk 生效）
            TextToSpeech t = tts;
            if (t != null) t.setSpeechRate(Math.max(0.1f, newRate));
        } else {
            // synthesizeToFile 模式：通过 MediaPlayer.setPlaybackParams() 更新倍率，无需重启合成/播放。
            // API >= 23 才支持 PlaybackParams。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && mediaPlayer != null) {
                try {
                    PlaybackParams pp = new PlaybackParams();
                    pp.setSpeed(Math.max(0.1f, newRate));
                    pp.setPitch(1.0f);
                    mediaPlayer.setPlaybackParams(pp);
                } catch (Exception e) {
                    android.util.Log.w("TTSFgSvc", "setPlaybackParams failed: " + e.getMessage());
                }
            }
        }
        // 更新 MediaSession 锁屏进度条采用新倍率（暂停时也需更新）
        updatePlaybackState(!isPaused && !isStopped);
    }

    private void handleStop() {
        isStopped    = true;
        isPaused     = false;
        pausedByUser = false;
        speakGen++;
        cancelPendingStop();
        stopPositionBroadcast();
        synthForChunk = -1;
        releaseMediaPlayer();
        if (tts != null) tts.stop();
        cleanTempFiles();
        deleteTempFile(nextTempFile);
        nextTempFile = null;
        releaseWakeLock();
        abandonAudioFocus();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    private void handlePause() {
        if (isPaused || isStopped) return;
        cancelPendingStop();
        pausedByUser = true; // 用户主动暂停，焦点归还后不自动恢复
        isPaused = true;
        speakGen++; // 使进行中的合成回调失效
        synthForChunk = -1; // 合成已取消
        stopPositionBroadcast();

        // 取消 TTS 引擎中正在进行的合成任务
        if (tts != null) tts.stop();

        // 暂停 MediaPlayer（保留位置，恢复时可继续）
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) mediaPlayer.pause();
            } catch (Exception ignored) {}
        }

        // 删除预生成的 N+1 文件（暂停后状态重置，恢复时重新预生成）
        deleteTempFile(nextTempFile);
        nextTempFile = null;

        // 冻结位置：暂停后 getCurrentPositionMs() 依赖 mediaPlayer.getCurrentPosition()（不变）
        updateNotification(false);
    }

    private void handleResume() {
        if (!isPaused || isStopped) return;
        cancelPendingStop();
        isPaused     = false;
        pausedByUser = false;
        speakGen++;
        updateNotification(true);

        if (useSpeakDirect) {
            // speak 模式：没有 MediaPlayer，直接从当前 chunk 重新朗读
            startPositionBroadcast();
            ttsHandler.post(this::playDirectSpeakChunk);
            return;
        }

        if (mediaPlayer != null) {
            // MediaPlayer 处于暂停状态，直接恢复；同时应用最新倍率（暂停期间可能已更改）
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PlaybackParams pp = new PlaybackParams();
                    pp.setSpeed(Math.max(0.1f, playRate));
                    pp.setPitch(1.0f);
                    mediaPlayer.setPlaybackParams(pp);
                }
                mediaPlayer.start();
                startPositionBroadcast();
                // 补发 N+1 预生成（暂停时已取消）
                final int prefetchIdx = chunkIndex + 1;
                final int gen = speakGen;
                ttsHandler.post(() -> {
                    if (speakGen != gen || isStopped || isPaused) return;
                    if (prefetchIdx < chunks.size() && synthForChunk != prefetchIdx) {
                        doSynthesizeChunk(prefetchIdx);
                    }
                });
            } catch (Exception e) {
                android.util.Log.w("TTSFgSvc", "MediaPlayer resume failed, re-synthesizing");
                releaseMediaPlayer();
                ttsHandler.post(this::playChunkOnly);
            }
        } else {
            // 合成被中断（暂停时 tts.stop() 取消了进行中的合成）→ 重新合成当前 chunk
            ttsHandler.post(this::playChunkOnly);
        }
    }

    /**
     * 系统失焦导致的自动暂停（如接电话、其他媒体 App 接管音频焦点）。
     * 不设置 pausedByUser，焦点归还后（AUDIOFOCUS_GAIN）可自动恢复。
     */
    private void handleFocusLossPause() {
        if (isPaused || isStopped) return;
        pausedByUser = false;
        isPaused = true;
        speakGen++;
        synthForChunk = -1;
        stopPositionBroadcast();
        if (tts != null) tts.stop();
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) mediaPlayer.pause();
            } catch (Exception ignored) {}
        }
        deleteTempFile(nextTempFile);
        nextTempFile = null;
        updateNotification(false);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TTS core
    // ═══════════════════════════════════════════════════════════════════════

    private void setTtsParams() {
        // 始终使用 setLanguage()，跟随系统设定的默认音色。
        Locale locale;
        try {
            locale = Locale.forLanguageTag(playLang);
        } catch (Exception e) {
            locale = Locale.CHINA;
        }
        int r = tts.setLanguage(locale);
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
            tts.setLanguage(Locale.CHINA);
        }
        // 合成始终用 1.0f：变速由 MediaPlayer.PlaybackParams 实现（时间拉伸，不变调）。
        // 对于 API < 23 无法使用 PlaybackParams 的设备，播放速度固定为 1x。
        tts.setSpeechRate(1.0f);
    }


    /**
     * 合成当前 chunkIndex 对应的 chunk 到临时文件（synthesizeToFile）。
     * 每块播放前由 ttsHandler 调用；预生成 N+1 时也走此方法（传入 idx）。
     * N+1 预生成：startMediaPlayer 播放开始后会再次调用 doSynthesizeChunk(chunkIndex+1)。
     */
    private void playChunkOnly() {
        if (useSpeakDirect) {
            playDirectSpeakChunk();
            return;
        }
        // 若该 chunk 的合成已经由预生成发起，直接等待 onDone()，不重复提交。
        if (synthForChunk == chunkIndex) return;
        if (!ttsReady || isStopped || isPaused) return;
        if (chunkIndex >= chunks.size()) {
            notifyFinished();
            return;
        }
        acquireWakeLock();
        doSynthesizeChunk(chunkIndex);
        chunkStartPositionMs = calculateChunkStartPositionMs();
        updatePlaybackState(true);
    }

    /**
     * 向 TTS 引擎提交指定 chunk 的合成任务（写入临时 WAV 文件）。
     * 合成结果通过 UtteranceProgressListener.onDone() 返回。
     * uid 格式 "g<gen>_c<idx>" 与现有 parseGen/parseChunk 兼容。
     */
    private void doSynthesizeChunk(int idx) {
        TextToSpeech t = tts;
        if (t == null || !ttsReady || isStopped) return;
        if (idx < 0 || idx >= chunks.size()) return;
        String text = chunks.get(idx);
        String uid  = "g" + speakGen + "_c" + idx;
        File outFile = new File(getCacheDir(), "tts_" + uid + ".wav");
        // 每块重设语言 + 1.0f 合成速率（华为/讯飞等引擎切换后可能重置语言或音色）
        setTtsParams();
        synthForChunk = idx;
        int ret = t.synthesizeToFile(text, (Bundle) null, outFile, uid);
        if (ret == TextToSpeech.ERROR) {
            // 首次失败重试一次
            setTtsParams();
            synthForChunk = idx;
            ret = t.synthesizeToFile(text, (Bundle) null, outFile, uid);
        }
        if (ret == TextToSpeech.ERROR) {
            // 引擎彻底拒绝
            synthFailureCount++;
            android.util.Log.w("TTSFgSvc", "synthesizeToFile failed for chunk " + idx
                    + " (" + synthFailureCount + "/" + MAX_SYNTH_FAILURES + ")");
            if (synthFailureCount >= MAX_SYNTH_FAILURES) {
                // 连续失败达阈值，切换到 speak() 直接播放模式
                android.util.Log.w("TTSFgSvc", "synthesizeToFile consistently failing, switching to speak() direct mode");
                useSpeakDirect = true;
                synthFailureCount = 0;
                synthForChunk = -1;
                final int gen = speakGen;
                ttsHandler.post(() -> {
                    if (speakGen != gen || isStopped || isPaused) return;
                    playDirectSpeakChunk();
                });
                return;
            }
            // 未达阈值，视同该 chunk 播放完毕，跳过继续
            synthForChunk = -1;
            final int gen = speakGen;
            mainHandler.post(() -> {
                if (speakGen != gen || isStopped) return;
                onChunkPlaybackComplete(gen);
            });
        }
    }

    /**
     * speak() 直接播放模式：使用 TextToSpeech.speak() 朗读当前 chunk。
     * 作为 synthesizeToFile 的降级方案，适用于华为/OPPO 等设备。
     * 变速通过 tts.setSpeechRate() 实现（无法变速不变调，但保证有声音）。
     */
    private void playDirectSpeakChunk() {
        TextToSpeech t = tts;
        if (t == null || !ttsReady || isStopped || isPaused) return;
        if (chunkIndex >= chunks.size()) {
            mainHandler.post(this::notifyFinished);
            return;
        }
        String text = chunks.get(chunkIndex);
        String uid  = "g" + speakGen + "_c" + chunkIndex;
        setTtsParams();
        // speak 模式下变速通过 setSpeechRate 实现（合成和播放一体，不像 MediaPlayer 可以变速不变调）
        t.setSpeechRate(Math.max(0.1f, playRate));
        int ret = t.speak(text, TextToSpeech.QUEUE_ADD, null, uid);
        if (ret == TextToSpeech.ERROR) {
            // speak() 被拒绝。引擎通常仍会触发 onError 回调 → buildUtteranceListener 中处理。
            // 不在此处调用 onDirectSpeakChunkDone，避免与 onError 回调双重推进。
            android.util.Log.w("TTSFgSvc", "speak() returned ERROR for chunk " + chunkIndex);
        }
        // 更新进度位置
        chunkStartPositionMs = calculateChunkStartPositionMs();
        acquireWakeLock();
        updatePlaybackState(true);
        startPositionBroadcast();
        // 推送当前位置
        Listener cb = listener;
        if (cb != null) {
            long totalMs = fullTotalDurationMs > 0 ? fullTotalDurationMs : getTotalDurationMs();
            cb.onPosition(chunkStartPositionMs, totalMs, directSpeakCharsDone);
        }
    }

    /**
     * speak 模式下 chunk 朗读完成（由 UtteranceProgressListener.onDone 触发，main thread）。
     * 推进 chunkIndex 并开始朗读下一个 chunk。
     */
    private void onDirectSpeakChunkDone(int gen) {
        if (speakGen != gen || isStopped || isPaused) return;

        // 上报进度
        directSpeakCharsDone = 0;
        for (int i = 0; i <= chunkIndex && i < chunks.size(); i++) {
            directSpeakCharsDone += chunks.get(i).length();
        }
        if (totalTextLength > 0) {
            Listener cb = listener;
            if (cb != null) cb.onProgress(directSpeakCharsDone, totalTextLength);
        }

        chunkIndex++;
        if (chunkIndex >= chunks.size()) {
            stopPositionBroadcast();
            notifyFinished();
            return;
        }

        // 更新位置并朗读下一个 chunk
        chunkStartPositionMs = calculateChunkStartPositionMs();
        ttsHandler.post(() -> {
            if (speakGen != gen || isStopped || isPaused) return;
            playDirectSpeakChunk();
        });
    }

    /** 开始每 50ms 向 JS 推送一次实际播放位置。重入安全。 */
    private void startPositionBroadcast() {
        if (positionRunnable != null) return; // 已在运行
        positionRunnable = () -> {
            if (isStopped || isPaused || positionRunnable == null) return;
            Listener cb = listener;
            if (cb != null) {
                long posMs   = getCurrentPositionMs();
                long totalMs = fullTotalDurationMs > 0 ? fullTotalDurationMs : getTotalDurationMs();
                int  charsDone = calculateCharsDone();
                cb.onPosition(posMs, totalMs, charsDone);
            }
            mainHandler.postDelayed(positionRunnable, 50);
        };
        mainHandler.postDelayed(positionRunnable, 50);
    }

    private void stopPositionBroadcast() {
        if (positionRunnable != null) {
            mainHandler.removeCallbacks(positionRunnable);
            positionRunnable = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MediaPlayer — 播放已合成的 WAV 文件，通过 PlaybackParams 实现变速不变调
    // ═══════════════════════════════════════════════════════════════════════

    @SuppressWarnings("NewApi")
    private void startMediaPlayer(File file, int gen) {
        if (speakGen != gen || isStopped || isPaused) {
            deleteTempFile(file);
            return;
        }
        if (!file.exists() || file.length() == 0) {
            onChunkPlaybackComplete(gen);
            return;
        }

        releaseMediaPlayer();
        MediaPlayer mp = new MediaPlayer();
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            mp.setAudioAttributes(attrs);
            mp.setDataSource(file.getAbsolutePath());
            mp.prepare();
            try { currentChunkActualDurationMs = mp.getDuration(); } catch (Exception e) { currentChunkActualDurationMs = 0; }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PlaybackParams pp = new PlaybackParams();
                pp.setSpeed(Math.max(0.1f, playRate));
                pp.setPitch(1.0f);
                mp.setPlaybackParams(pp);
            }

            final File capturedFile = file;
            mp.setOnCompletionListener(completedMp -> {
                deleteTempFile(capturedFile);
                onChunkPlaybackComplete(gen);
            });
            mp.setOnErrorListener((errMp, what, extra) -> {
                android.util.Log.e("TTSFgSvc", "MediaPlayer error " + what + "/" + extra);
                deleteTempFile(capturedFile);
                onChunkPlaybackComplete(gen);
                return true;
            });

            mediaPlayer = mp;
            mp.start();
            acquireWakeLock();
            updatePlaybackState(true);
            Listener immediateCb = listener;
            if (immediateCb != null) {
                long posMs   = chunkStartPositionMs;
                long totalMs = fullTotalDurationMs > 0 ? fullTotalDurationMs : getTotalDurationMs();
                int  charsDone = calculateCharsDone();
                immediateCb.onPosition(posMs, totalMs, charsDone);
            }
            startPositionBroadcast();

            final int prefetchIdx = chunkIndex + 1;
            ttsHandler.post(() -> {
                if (speakGen != gen || isStopped || isPaused) return;
                if (prefetchIdx < chunks.size() && synthForChunk != prefetchIdx) {
                    doSynthesizeChunk(prefetchIdx);
                }
            });

        } catch (Exception e) {
            android.util.Log.e("TTSFgSvc", "MediaPlayer start failed", e);
            mp.release();
            mediaPlayer = null;
            deleteTempFile(file);
            onChunkPlaybackComplete(gen);
        }
    }

    private void onChunkPlaybackComplete(int gen) {
        releaseMediaPlayer();
        if (speakGen != gen || isStopped || isPaused) {
            deleteTempFile(nextTempFile);
            nextTempFile = null;
            return;
        }

        chunkIndex++;

        if (totalTextLength > 0) {
            int charsDone = 0;
            for (int i = 0; i < chunkIndex && i < chunks.size(); i++) charsDone += chunks.get(i).length();
            Listener cb = listener;
            if (cb != null) cb.onProgress(charsDone, totalTextLength);
        }

        if (chunkIndex >= chunks.size()) {
            deleteTempFile(nextTempFile);
            nextTempFile = null;
            notifyFinished();
            return;
        }

        chunkStartPositionMs = calculateChunkStartPositionMs();

        File prefetched = nextTempFile;
        nextTempFile = null;

        if (prefetched != null && prefetched.exists() && prefetched.length() > 0) {
            startMediaPlayer(prefetched, gen);
        } else if (synthForChunk == chunkIndex) {
            deleteTempFile(prefetched);
        } else {
            deleteTempFile(prefetched);
            ttsHandler.post(this::playChunkOnly);
        }
    }

    private void releaseMediaPlayer() {
        MediaPlayer mp = mediaPlayer;
        mediaPlayer = null;
        if (mp != null) {
            try {
                if (mp.isPlaying()) mp.stop();
                mp.reset();
                mp.release();
            } catch (Exception ignored) {}
        }
    }

    private void cleanTempFiles() {
        try {
            File cacheDir = getCacheDir();
            File[] files = cacheDir.listFiles(
                    (dir, name) -> name.startsWith("tts_g") && name.endsWith(".wav"));
            if (files != null) {
                for (File f : files) f.delete();
            }
        } catch (Exception ignored) {}
    }

    private static void deleteTempFile(File file) {
        if (file != null && file.exists()) { file.delete(); }
    }

    private static int parseGen(String uid) {
        if (uid == null || !uid.startsWith("g")) return -1;
        int sep = uid.indexOf('_');
        if (sep < 0) return -1;
        try { return Integer.parseInt(uid.substring(1, sep)); }
        catch (NumberFormatException e) { return -1; }
    }

    private static int parseChunk(String uid) {
        if (uid == null) return -1;
        int ci = uid.indexOf("_c");
        if (ci < 0) return -1;
        try { return Integer.parseInt(uid.substring(ci + 2)); }
        catch (NumberFormatException e) { return -1; }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Notification
    // ═══════════════════════════════════════════════════════════════════════

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "朗读", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("文章朗读播放控制");
            ch.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private void updatePlaybackState(boolean playing) {
        if (mediaSession == null) return;
        int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        long posMs = getCurrentPositionMs();
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setState(state, posMs, playing ? playRate : 0f)
            .setActions(PlaybackState.ACTION_PLAY_PAUSE |
                        PlaybackState.ACTION_PAUSE |
                        PlaybackState.ACTION_PLAY |
                        PlaybackState.ACTION_STOP)
            .build());
    }

    private void updateMediaMetadata() {
        if (mediaSession == null) return;
        long durationMs = fullTotalDurationMs > 0 ? fullTotalDurationMs : getTotalDurationMs();
        String displayTitle  = (playTitle  != null && !playTitle.isEmpty())  ? playTitle  : "书报 · 朗读";
        String displayArtist = (playArtist != null && !playArtist.isEmpty()) ? playArtist : "";
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, displayTitle)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs > 0 ? durationMs : -1);
        if (!displayArtist.isEmpty()) {
            meta.putString(MediaMetadata.METADATA_KEY_ARTIST, displayArtist);
        }
        if (appIconBitmap != null) {
            meta.putBitmap(MediaMetadata.METADATA_KEY_ART, appIconBitmap);
        }
        mediaSession.setMetadata(meta.build());
    }

    private long getCurrentPositionMs() {
        if (mediaPlayer != null) {
            try {
                long audioPosMs = mediaPlayer.getCurrentPosition();
                long wallPosMs = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                        ? (long)(audioPosMs / Math.max(0.1f, playRate))
                        : audioPosMs;
                return chunkStartPositionMs + wallPosMs;
            } catch (Exception ignored) {}
        }
        return chunkStartPositionMs;
    }

    private long getTotalDurationMs() {
        if (totalTextLength <= 0) return 0;
        return (long)(totalTextLength / (250.0f * Math.max(0.1f, playRate)) * 60 * 1000L);
    }

    private long calculateChunkStartPositionMs() {
        int cumChars = 0;
        for (int i = 0; i < chunkIndex && i < chunks.size(); i++) {
            cumChars += chunks.get(i).length();
        }
        long totalMs = fullTotalDurationMs > 0 ? fullTotalDurationMs : getTotalDurationMs();
        if (totalTextLength <= 0 || totalMs <= 0) return sliceStartPositionMs;
        return sliceStartPositionMs + (long)((float) cumChars / totalTextLength * totalMs);
    }

    private int calculateCharsDone() {
        if (totalTextLength <= 0) return 0;
        if (useSpeakDirect) {
            return Math.min(directSpeakCharsDone, totalTextLength);
        }
        int cumChars = 0;
        int ci = chunkIndex;
        for (int i = 0; i < ci && i < chunks.size(); i++) {
            cumChars += chunks.get(i).length();
        }
        if (mediaPlayer != null && ci >= 0 && ci < chunks.size()) {
            try {
                int chunkLen = chunks.get(ci).length();
                long audioPosMs = mediaPlayer.getCurrentPosition();
                long chunkDurationMs = currentChunkActualDurationMs > 0
                        ? currentChunkActualDurationMs
                        : (long)(chunkLen / (float) totalTextLength * fullTotalDurationMs);
                if (chunkDurationMs > 0) {
                    cumChars += (int)(audioPosMs / (float) chunkDurationMs * chunkLen);
                }
            } catch (Exception ignored) {}
        }
        return Math.min(cumChars, totalTextLength);
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification(boolean playing) {
        int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT;

        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, openApp, piFlags);

        Intent stopI = new Intent(this, TTSForegroundService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopI, piFlags);

        String toggleAction = playing ? ACTION_PAUSE : ACTION_RESUME;
        String toggleLabel  = playing ? "暂停"       : "继续";
        int    toggleIcon   = playing
                ? android.R.drawable.ic_media_pause
                : android.R.drawable.ic_media_play;
        Intent toggleI = new Intent(this, TTSForegroundService.class).setAction(toggleAction);
        PendingIntent togglePi = PendingIntent.getService(this, 2, toggleI, piFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
            builder.setSound(null);
        }

        String notifTitle = (playTitle != null && !playTitle.isEmpty()) ? playTitle : "书报 · 朗读";
        builder.setContentTitle(notifTitle)
               .setContentText(playing ? "正在朗读..." : "已暂停")
               .setSmallIcon(R.mipmap.ic_launcher)
               .setContentIntent(openPi)
               .setOngoing(true);
        if (appIconBitmap != null) {
            builder.setLargeIcon(appIconBitmap);
        }
        builder
               .addAction(toggleIcon, toggleLabel, togglePi)
               .addAction(android.R.drawable.ic_delete, "停止", stopPi);

        Notification.MediaStyle style = new Notification.MediaStyle()
                .setShowActionsInCompactView(0, 1);
        if (mediaSession != null) {
            style.setMediaSession(mediaSession.getSessionToken());
        }
        builder.setStyle(style);

        return builder.build();
    }

    private void updateNotification(boolean playing) {
        updatePlaybackState(playing);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(playing));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Audio Focus
    // ═══════════════════════════════════════════════════════════════════════

    private boolean requestAudioFocus() {
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return true;

        audioFocusListener = change -> {
            if (change == AudioManager.AUDIOFOCUS_LOSS) {
                handleFocusLossPause();
            } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
                if (isPaused && !pausedByUser) handleResume();
            }
        };

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(audioFocusListener)
                    .build();
            return audioManager.requestAudioFocus(audioFocusRequest)
                    == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else {
            return audioManager.requestAudioFocus(
                    audioFocusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else if (audioFocusListener != null) {
            audioManager.abandonAudioFocus(audioFocusListener);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(2 * 60 * 60 * 1000L);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    private void notifyFinished() {
        if (loopEnabled && !isStopped) {
            chunkIndex           = 0;
            chunkStartPositionMs = 0;
            currentChunkActualDurationMs = 0;
            sliceStartPositionMs = 0;
            speakGen++;
            synthForChunk = -1;
            deleteTempFile(nextTempFile);
            nextTempFile = null;
            updateNotification(true);
            final int gen = speakGen;
            ttsHandler.postDelayed(() -> {
                if (speakGen != gen || isStopped || isPaused) return;
                playChunkOnly();
            }, 50);
            return;
        }
        finishPlayback();
        Listener cb = listener;
        if (cb != null) cb.onFinished();
    }

    private void notifyError(String msg) {
        finishPlayback();
        Listener cb = listener;
        if (cb != null) cb.onError(msg);
    }

    private void finishPlayback() {
        stopPositionBroadcast();
        updateNotification(false);
        schedulePendingStop();
    }

    private void schedulePendingStop() {
        cancelPendingStop();
        _pendingStop = new Runnable() {
            @Override public void run() {
                _pendingStop = null;
                releaseWakeLock();
                abandonAudioFocus();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                } else {
                    stopForeground(true);
                }
                stopSelf();
            }
        };
        mainHandler.postDelayed(_pendingStop, 2000);
    }

    private void cancelPendingStop() {
        if (_pendingStop != null) {
            mainHandler.removeCallbacks(_pendingStop);
            _pendingStop = null;
        }
    }

    private static List<String> splitText(String text, int maxLen) {
        List<String> result = new ArrayList<>();
        if (text == null || text.isEmpty()) return result;

        String[] segs = text.split("(?<=[。！？；…\n])");
        StringBuilder cur = new StringBuilder();
        for (String seg : segs) {
            if (cur.length() + seg.length() <= maxLen) {
                cur.append(seg);
            } else {
                if (cur.length() > 0) result.add(cur.toString());
                if (seg.length() > maxLen) {
                    for (int i = 0; i < seg.length(); i += maxLen) {
                        result.add(seg.substring(i, Math.min(i + maxLen, seg.length())));
                    }
                    cur = new StringBuilder();
                } else {
                    cur = new StringBuilder(seg);
                }
            }
        }
        if (cur.length() > 0) result.add(cur.toString());
        return result;
    }
}
