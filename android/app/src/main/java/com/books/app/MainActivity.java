package com.books.app;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";
    // 深链 scheme & host，与 AndroidManifest.xml 中 intent-filter 一致
    private static final String DEEP_LINK_SCHEME = "bookapp";
    private static final String DEEP_LINK_HOST = "book";

    // 暂存从深链 Intent 中提取的 bookId，等 WebView 就绪后注入
    private String pendingBookId = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 最早安装崩溃日志收集器（在 super.onCreate 前），覆盖尽可能多的异常
        Thread.setDefaultUncaughtExceptionHandler(new CrashReporter(this));

        // 重要：必须在 super.onCreate() 之前注册插件！
        registerPlugin(ApkInstallerPlugin.class);
        registerPlugin(ImageSaverPlugin.class);
        registerPlugin(NativeTTSPlugin.class);
        registerPlugin(CrashLogPlugin.class);
        registerPlugin(SaveFilePlugin.class);

        // 在 super.onCreate() 之前检查深链 Intent
        checkDeepLinkIntent(getIntent());

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

        // 如果有暂存的 bookId，等 WebView 就绪后注入路由
        if (pendingBookId != null) {
            navigateToBook(pendingBookId);
            pendingBookId = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask 模式：Activity 复用时通过 onNewIntent 接收新 Intent
        checkDeepLinkIntent(intent);
        if (pendingBookId != null) {
            navigateToBook(pendingBookId);
            pendingBookId = null;
        }
    }

    /**
     * 检查 Intent 是否是深链（bookapp://book/{bookId}），提取 bookId
     */
    private void checkDeepLinkIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = intent.getData();
        if (uri == null) {
            // 也检查 extra 中的 bookId（快捷方式可能通过 extra 传递）
            String bookId = intent.getStringExtra("bookId");
            if (bookId != null && !bookId.isEmpty()) {
                Log.i(TAG, "深链(Extra) bookId=" + bookId);
                pendingBookId = bookId;
            }
            return;
        }
        if (DEEP_LINK_SCHEME.equals(uri.getScheme()) && DEEP_LINK_HOST.equals(uri.getHost())) {
            // 路径格式: /{bookId}
            String path = uri.getPath();
            if (path != null && path.length() > 1) {
                String bookId = path.substring(1); // 去掉前导 "/"
                try {
                    bookId = java.net.URLDecoder.decode(bookId, "UTF-8");
                } catch (Exception e) { /* 保留原始值 */ }
                Log.i(TAG, "深链(URI) bookId=" + bookId);
                pendingBookId = bookId;
            }
        }
    }

    /**
     * 通过 JS 注入导航到对应书籍的章节列表
     * 等待 BKRouter 就绪后执行路由，避免 WebView 未加载完成时调用失败
     */
    private void navigateToBook(final String bookId) {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) {
            Log.w(TAG, "WebView 未就绪，无法导航到 bookId=" + bookId);
            return;
        }
        // 延迟执行，确保前端 JS 框架（BKRouter）已初始化
        webView.postDelayed(() -> {
            try {
                String js = "if(window.BKRouter&&window.BKRouter.navigate){" +
                    "window.BKRouter.navigate('" + escapeJs(bookId) + "');" +
                    "}else{console.warn('[DeepLink] BKRouter未就绪，延迟重试');" +
                    "setTimeout(function(){" +
                    "if(window.BKRouter&&window.BKRouter.navigate)" +
                    "window.BKRouter.navigate('" + escapeJs(bookId) + "');" +
                    "},500);}";
                webView.evaluateJavascript(js, null);
                Log.i(TAG, "已注入深链路由 bookId=" + bookId);
            } catch (Exception e) {
                Log.e(TAG, "注入深链路由失败", e);
            }
        }, 300);
    }

    /**
     * 简单的 JS 字符串转义，防止 bookId 中的特殊字符破坏 JS 语法
     */
    private String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
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
