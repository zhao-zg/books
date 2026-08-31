package com.books.app;

import android.content.ContentResolver;
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
import android.provider.OpenableColumns;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";
    // 深链 scheme & host，与 AndroidManifest.xml 中 intent-filter 一致
    private static final String DEEP_LINK_SCHEME = "bookapp";
    private static final String DEEP_LINK_HOST = "book";

    // 暂存从深链 Intent 中提取的 bookId，等 WebView 就绪后注入
    private String pendingBookId = null;
    // 暂存从外部打开的文件路径，等 WebView 就绪后通知前端导入
    private String pendingOpenFile = null;

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
        registerPlugin(LanSyncPlugin.class);

        // 在 super.onCreate() 之前检查深链 Intent
        checkDeepLinkIntent(getIntent());
        // 在 super.onCreate() 之前检查外部文件打开 Intent
        checkOpenFileIntent(getIntent());

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
        // 如果有暂存的外部打开文件，等 WebView 就绪后通知前端
        if (pendingOpenFile != null) {
            notifyOpenFile(pendingOpenFile);
            pendingOpenFile = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask 模式：Activity 复用时通过 onNewIntent 接收新 Intent
        checkDeepLinkIntent(intent);
        checkOpenFileIntent(intent);
        if (pendingBookId != null) {
            navigateToBook(pendingBookId);
            pendingBookId = null;
        }
        if (pendingOpenFile != null) {
            notifyOpenFile(pendingOpenFile);
            pendingOpenFile = null;
        }
    }

    /**
     * 检查 MIME 类型是否是支持的文档格式
     */
    private boolean isSupportedMimeType(String mimeType) {
        if (mimeType == null) return false;
        // text/plain 包含 .txt；application/epub+zip 包含 .epub；
        // text/markdown 包含 .md；application/pdf 包含 .pdf
        // application/octet-stream 作为兜底（部分文件管理器发送时使用通用类型）
        return mimeType.equals("text/plain")
            || mimeType.equals("application/epub+zip")
            || mimeType.equals("text/markdown")
            || mimeType.equals("application/pdf")
            || mimeType.equals("application/octet-stream");
    }

    /**
     * 检查文件扩展名是否是支持的文档格式（MIME 为 null 时的兜底校验）
     */
    private boolean isSupportedExtension(String path) {
        if (path == null) return false;
        String lower = path.toLowerCase();
        return lower.endsWith(".txt")
            || lower.endsWith(".epub")
            || lower.endsWith(".md")
            || lower.endsWith(".markdown")
            || lower.endsWith(".pdf");
    }

    /**
     * 检查 Intent 是否是外部文件打开（ACTION_VIEW / ACTION_SEND），
     * 将文件复制到内部缓存目录后暂存路径，等 WebView 就绪后通知前端导入
     */
    private void checkOpenFileIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        Uri fileUri = null;

        if (Intent.ACTION_VIEW.equals(action)) {
            // 从文件管理器"打开方式"触发
            fileUri = intent.getData();
            // 排除深链 scheme（bookapp:// 由 checkDeepLinkIntent 处理）
            if (fileUri != null && DEEP_LINK_SCHEME.equals(fileUri.getScheme())) {
                return;
            }
        } else if (Intent.ACTION_SEND.equals(action)) {
            // 从其他应用"分享"触发
            fileUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }

        if (fileUri == null) return;

        // 只处理支持的文件类型
        String mimeType = intent.getType();
        if (mimeType != null && !isSupportedMimeType(mimeType)) {
            Log.w(TAG, "不支持的文件类型: " + mimeType);
            return;
        }
        // 兜底：MIME 为 null 时（file:// URI 常见），基于文件扩展名校验
        if (mimeType == null && fileUri != null) {
            String path = fileUri.getPath();
            if (path != null && !isSupportedExtension(path)) {
                Log.w(TAG, "不支持的文件扩展名: " + path);
                return;
            }
        }

        try {
            String[] result = copyToCache(fileUri);
            if (result != null) {
                String filePath = result[0];
                String fileName = result[1];
                // 用 JSON 格式暂存，方便前端解析
                pendingOpenFile = "{\"path\":\"" + escapeJs(filePath) +
                    "\",\"name\":\"" + escapeJs(fileName) + "\"}";
                Log.i(TAG, "外部文件打开: name=" + fileName + " path=" + filePath);
            }
        } catch (Exception e) {
            Log.e(TAG, "处理外部文件打开失败", e);
        }
    }

    /**
     * 将 content:// 或 file:// URI 的文件内容复制到应用内部缓存目录，
     * 返回 [绝对路径, 文件名]，失败返回 null
     */
    private String[] copyToCache(Uri uri) {
        try {
            ContentResolver resolver = getContentResolver();

            // 获取文件名
            String fileName = null;
            try (android.database.Cursor cursor = resolver.query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameIndex >= 0) {
                        fileName = cursor.getString(nameIndex);
                    }
                }
            }
            if (fileName == null) {
                // 从 URI 路径段提取文件名
                String lastSegment = uri.getLastPathSegment();
                fileName = (lastSegment != null) ? lastSegment : "unknown_file";
            }

            // 安全检查：文件名不允许包含路径分隔符（防止路径遍历攻击）
            if (fileName.contains("/") || fileName.contains("\\") || fileName.contains("..")) {
                Log.w(TAG, "文件名包含非法字符: " + fileName);
                fileName = fileName.replace("/", "_").replace("\\", "_");
            }

            // 读取并复制到缓存
            File cacheDir = new File(getCacheDir(), "open_file");
            if (!cacheDir.exists()) cacheDir.mkdirs();

            // 清理旧缓存文件（超过1小时的）
            cleanOldCache(cacheDir);

            File destFile = new File(cacheDir, fileName);
            // 如果同名文件已存在，加序号
            if (destFile.exists()) {
                String baseName = fileName;
                String ext = "";
                int dotIdx = fileName.lastIndexOf('.');
                if (dotIdx > 0) {
                    baseName = fileName.substring(0, dotIdx);
                    ext = fileName.substring(dotIdx);
                }
                int seq = 1;
                do {
                    destFile = new File(cacheDir, baseName + "_" + seq + ext);
                    seq++;
                } while (destFile.exists());
            }

            try (InputStream is = resolver.openInputStream(uri);
                 FileOutputStream os = new FileOutputStream(destFile)) {
                if (is == null) return null;
                byte[] buffer = new byte[8192];
                int len;
                while ((len = is.read(buffer)) != -1) {
                    os.write(buffer, 0, len);
                }
            }

            return new String[]{destFile.getAbsolutePath(), destFile.getName()};
        } catch (Exception e) {
            Log.e(TAG, "复制文件到缓存失败: " + uri, e);
            return null;
        }
    }

    /**
     * 清理缓存目录中超过1小时的文件
     */
    private void cleanOldCache(File cacheDir) {
        if (!cacheDir.isDirectory()) return;
        long threshold = System.currentTimeMillis() - 3600000; // 1小时
        File[] files = cacheDir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < threshold) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    /**
     * 通过 JS 注入通知前端有外部文件需要导入
     */
    private void notifyOpenFile(final String fileInfoJson) {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) {
            Log.w(TAG, "WebView 未就绪，无法通知外部文件打开");
            return;
        }
        webView.postDelayed(() -> {
            try {
                // 用 encodeURIComponent 编码 JSON，避免双引号破坏 JS 字符串
                String encoded = java.net.URLEncoder.encode(fileInfoJson, "UTF-8");
                String js = "if(window.BKOpenFile&&typeof window.BKOpenFile.handle==='function'){" +
                    "window.BKOpenFile.handle(decodeURIComponent('" + encoded + "'));" +
                    "}else{console.warn('[OpenFile] BKOpenFile 未就绪，延迟重试');" +
                    "setTimeout(function(){" +
                    "if(window.BKOpenFile&&typeof window.BKOpenFile.handle==='function')" +
                    "window.BKOpenFile.handle(decodeURIComponent('" + encoded + "'));" +
                    "},800);}";
                webView.evaluateJavascript(js, null);
                Log.i(TAG, "已通知前端外部文件打开");
            } catch (Exception e) {
                Log.e(TAG, "通知前端外部文件打开失败", e);
            }
        }, 500);
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
