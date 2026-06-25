package com.books.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 最早安装崩溃日志收集器（在 super.onCreate 前），覆盖尽可能多的异常
        Thread.setDefaultUncaughtExceptionHandler(new CrashReporter(this));

        // 重要：必须在 super.onCreate() 之前注册插件！
        registerPlugin(ApkInstallerPlugin.class);
        registerPlugin(ImageSaverPlugin.class);
        registerPlugin(NativeTTSPlugin.class);
        registerPlugin(CrashLogPlugin.class);
        super.onCreate(savedInstanceState);

        // 启动加载页统一由 HTML #cxSplash 处理（APP / PWA 共用）

        // ── 修复后台切回黑屏 ──────────────────────────────────────────
        // 1. WebView 背景色设为白色，防止渲染表面被回收后重建时出现黑屏
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.setBackgroundColor(Color.WHITE);
            // 保持硬件加速层，避免后台回来时重新创建 GPU 表面
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        }
        // 2. 窗口 DecorView 也设白色背景，防止 Window 层面出现黑帧
        getWindow().getDecorView().setBackgroundColor(Color.WHITE);

        // 设置状态栏颜色
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            // 1. 禁用 edge-to-edge：状态栏占独立空间，WebView 从下方开始
            //    不加这行：Capacitor 6 + targetSdk 34 默认让 WebView 延伸到状态栏背后
            //    WebView 内容（蓝紫 header）透过状态栏合成 → 等同 PWA 里 Chrome 的处理
            WindowCompat.setDecorFitsSystemWindows(window, true);
            // 2. 清除半透明标志（某些主题会预设），确保 setStatusBarColor 生效
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            // 3. 纯白底色：亮度 243/255，与 PWA manifest theme_color #f6f7fb (247/255) 一致
            window.setStatusBarColor(0xFFF0F3F9);
            // 4. 深色图标（时间/电池）：黑色图标 on 近白色背景 → 最高对比度
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                View decorView = window.getDecorView();
                int flags = decorView.getSystemUiVisibility();
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                decorView.setSystemUiVisibility(flags);
            }
        }
    }

    @Override
    public void onResume() {
        // 先恢复 WebView 定时器（BridgeActivity.onResume 内部也会调用，这里确保提前触发）
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.resumeTimers();
        }
        super.onResume();
    }

    @Override
    public void onPause() {
        // 仅调用 super.onPause()，不额外冻结 WebView
        // BridgeActivity 内部会暂停定时器，但 WebView 渲染表面保持存活
        super.onPause();
    }
}
