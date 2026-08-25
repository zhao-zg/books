package com.books.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Map;

/**
 * SaveFilePlugin — 通过 Android SAF (Storage Access Framework) 让用户选择保存位置
 *
 * 支持两种模式：
 *   1. save() — 小文件一次写入（向后兼容）
 *   2. startWrite() + writeChunk() * N + finishWrite() — 大文件分块写入，避免 WebView 桥接 OOM
 *
 * 分块写入流程：
 *   JS: SaveFile.startWrite({ filename, mimeType, totalSize }) → 返回 sessionId
 *       → 系统弹出 SAF "另存为"对话框
 *       → 用户选择位置后返回 { uri, sessionId }
 *   JS: 循环 SaveFile.writeChunk({ sessionId, chunk: '<base64>' })
 *   JS: SaveFile.finishWrite({ sessionId })
 *
 * 额外能力：
 *   writeCache() — 直接写缓存目录（不弹 SAF），分块写入支持
 *   writeCacheChunk() — 分块写入缓存
 *   finishCacheWrite() — 完成缓存写入并返回 URI
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private static final String TAG = "SaveFilePlugin";

    // ── 小文件模式（向后兼容）──────────────────────────────────────────

    // 每请求独立的 base64 存储，避免共享字段被并发覆盖导致 0KB
    private final Map<String, String> pendingDataMap = new HashMap<>();
    private String pendingSaveId = null;

    /**
     * 小文件：弹出系统"另存为"对话框，用户选择后一次性写入
     */
    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename", "export");
        String base64Data = call.getString("data");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("data 不能为空");
            return;
        }

        String requestId = "save-" + System.currentTimeMillis();
        pendingSaveId = requestId;
        pendingDataMap.put(requestId, base64Data);

        // 关键修复：从 PluginCall 中移除大 base64 数据，防止 Capacitor 将其存入
        // Activity savedState Bundle，导致 SAF 对话框弹出时 onStop → Binder 事务超 1MB
        // 抛出 TransactionTooLargeException（崩溃 + 0KB 残留文件）
        if (call.getData() != null) {
            call.getData().remove("data");
        }

        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, filename);
            startActivityForResult(call, intent, "handleSaveResult");
        } catch (Exception e) {
            Log.e(TAG, "SAF 启动失败", e);
            pendingDataMap.remove(requestId);
            pendingSaveId = null;
            call.reject("无法打开系统保存对话框: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void handleSaveResult(PluginCall call, ActivityResult result) {
        PluginCall savedCall = call;
        Intent data = result != null ? result.getData() : null;

        // 检查 resultCode，用户取消时 resultCode != RESULT_OK
        int resultCode = result != null ? result.getResultCode() : 0;

        if (data == null || data.getData() == null || resultCode != android.app.Activity.RESULT_OK) {
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("saved", false);
                ret.put("reason", "cancelled");
                savedCall.resolve(ret);
            }
            // 清理当前请求数据
            if (pendingSaveId != null) pendingDataMap.remove(pendingSaveId);
            pendingSaveId = null;
            return;
        }

        Uri uri = data.getData();

        // 从 per-request Map 中取出 base64 数据
        String requestId = pendingSaveId;
        String base64 = (requestId != null) ? pendingDataMap.get(requestId) : null;

        // 关键防御：base64 为 null 或空时，拒绝而非写入 0 字节
        if (base64 == null || base64.isEmpty()) {
            Log.e(TAG, "handleSaveResult: base64 数据为空（requestId=" + requestId + "），可能被并发操作覆盖");
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("saved", false);
                ret.put("reason", "data_lost");
                savedCall.resolve(ret);
            }
            if (requestId != null) pendingDataMap.remove(requestId);
            pendingSaveId = null;
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (bytes.length == 0) {
                Log.e(TAG, "handleSaveResult: Base64.decode 返回空数组，base64 长度=" + base64.length());
                if (savedCall != null) savedCall.reject("解码后数据为空");
                return;
            }
            ContentResolver resolver = getContext().getContentResolver();
            OutputStream os = resolver.openOutputStream(uri);
            if (os == null) throw new Exception("无法打开输出流");
            try { os.write(bytes); os.flush(); } finally { os.close(); }

            Log.i(TAG, "文件已保存: " + uri.toString() + " 大小=" + bytes.length + " 字节");
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("saved", true);
                ret.put("uri", uri.toString());
                savedCall.resolve(ret);
            }
        } catch (Exception e) {
            Log.e(TAG, "写入文件失败", e);
            if (savedCall != null) savedCall.reject("保存失败: " + e.getMessage());
        } finally {
            if (requestId != null) pendingDataMap.remove(requestId);
            pendingSaveId = null;
        }
    }

    // ── 大文件模式：SAF 分块写入 ──────────────────────────────────────────

    // 当前活跃的 SAF 写入会话
    private String safSessionId = null;
    private Uri safSessionUri = null;
    private OutputStream safSessionStream = null;
    private PluginCall safPendingCall = null;

    /**
     * 大文件第一步：弹出 SAF 对话框，获取写入 URI
     * 返回 sessionId 用于后续 writeChunk / finishWrite
     */
    @PluginMethod
    public void startWrite(PluginCall call) {
        String filename = call.getString("filename", "export");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        long totalSize = call.getLong("totalSize", 0L);

        Log.i(TAG, "startWrite: filename=" + filename + " mimeType=" + mimeType + " totalSize=" + totalSize);

        safPendingCall = call;
        safSessionId = "saf-" + System.currentTimeMillis();

        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, filename);
            startActivityForResult(call, intent, "handleStartWriteResult");
        } catch (Exception e) {
            Log.e(TAG, "SAF 启动失败", e);
            safSessionId = null;
            safPendingCall = null;
            call.reject("无法打开系统保存对话框: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void handleStartWriteResult(PluginCall call, ActivityResult result) {
        PluginCall savedCall = (call != null) ? call : safPendingCall;
        Intent data = result != null ? result.getData() : null;
        int resultCode = result != null ? result.getResultCode() : 0;

        if (data == null || data.getData() == null || resultCode != android.app.Activity.RESULT_OK) {
            // 用户取消
            safSessionId = null;
            safPendingCall = null;
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("started", false);
                ret.put("reason", "cancelled");
                savedCall.resolve(ret);
            }
            return;
        }

        Uri uri = data.getData();
        safSessionUri = uri;

        try {
            ContentResolver resolver = getContext().getContentResolver();
            safSessionStream = resolver.openOutputStream(uri);
            if (safSessionStream == null) throw new Exception("无法打开输出流");

            Log.i(TAG, "startWrite 成功: uri=" + uri + " sessionId=" + safSessionId);
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("started", true);
                ret.put("uri", uri.toString());
                ret.put("sessionId", safSessionId);
                savedCall.resolve(ret);
            }
        } catch (Exception e) {
            Log.e(TAG, "startWrite 打开流失败", e);
            safSessionId = null;
            safSessionUri = null;
            if (savedCall != null) savedCall.reject("无法打开输出流: " + e.getMessage());
        } finally {
            safPendingCall = null;
        }
    }

    /**
     * 大文件第二步：写入一个数据块（base64 编码，每块不超过 2MB 原始数据）
     */
    @PluginMethod
    public void writeChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String chunk = call.getString("chunk");

        // 从 PluginCall 中移除大 chunk 数据，防止 Activity onStop 时
        // Capacitor savedState Bundle 超出 Binder 1MB 限制
        if (call.getData() != null) {
            call.getData().remove("chunk");
        }

        if (safSessionId == null || !safSessionId.equals(sessionId) || safSessionStream == null) {
            call.reject("无效的写入会话");
            return;
        }

        if (chunk == null || chunk.isEmpty()) {
            call.reject("chunk 不能为空");
            return;
        }

        try {
            byte[] bytes = Base64.decode(chunk, Base64.DEFAULT);
            safSessionStream.write(bytes);
            safSessionStream.flush();

            JSObject ret = new JSObject();
            ret.put("written", bytes.length);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "writeChunk 写入失败", e);
            call.reject("写入失败: " + e.getMessage());
        }
    }

    /**
     * 大文件第三步：完成写入，关闭流
     */
    @PluginMethod
    public void finishWrite(PluginCall call) {
        String sessionId = call.getString("sessionId");

        if (safSessionId == null || !safSessionId.equals(sessionId)) {
            call.reject("无效的写入会话");
            return;
        }

        try {
            if (safSessionStream != null) {
                safSessionStream.flush();
                safSessionStream.close();
            }
            Log.i(TAG, "finishWrite 成功: uri=" + safSessionUri);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("uri", safSessionUri != null ? safSessionUri.toString() : "");
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "finishWrite 关闭流失败", e);
            call.reject("关闭失败: " + e.getMessage());
        } finally {
            safSessionId = null;
            safSessionUri = null;
            safSessionStream = null;
        }
    }

    // ── 缓存目录分块写入（不走 SAF，不弹对话框）──────────────────────────

    private String cacheSessionId = null;
    private RandomAccessFile cacheSessionFile = null;
    private String cacheSessionPath = null;

    /**
     * 开始写缓存文件（不弹 SAF），返回 sessionId
     */
    @PluginMethod
    public void startCacheWrite(PluginCall call) {
        String filename = call.getString("filename", "export");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        Log.i(TAG, "startCacheWrite: filename=" + filename);

        try {
            File dir = new File(getContext().getCacheDir(), "bk-export");
            if (!dir.exists()) dir.mkdirs();

            File file = new File(dir, filename);
            cacheSessionPath = file.getAbsolutePath();
            cacheSessionFile = new RandomAccessFile(file, "rw");
            cacheSessionFile.setLength(0); // 清空已有内容

            cacheSessionId = "cache-" + System.currentTimeMillis();

            Log.i(TAG, "startCacheWrite 成功: path=" + cacheSessionPath + " sessionId=" + cacheSessionId);
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("sessionId", cacheSessionId);
            ret.put("path", cacheSessionPath);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "startCacheWrite 失败", e);
            call.reject("无法创建缓存文件: " + e.getMessage());
        }
    }

    /**
     * 写入一个数据块到缓存文件
     */
    @PluginMethod
    public void writeCacheChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String chunk = call.getString("chunk");

        // 从 PluginCall 中移除大 chunk 数据，防止 Activity onStop 时
        // Capacitor savedState Bundle 超出 Binder 1MB 限制
        if (call.getData() != null) {
            call.getData().remove("chunk");
        }

        if (cacheSessionId == null || !cacheSessionId.equals(sessionId) || cacheSessionFile == null) {
            call.reject("无效的缓存写入会话");
            return;
        }

        if (chunk == null || chunk.isEmpty()) {
            call.reject("chunk 不能为空");
            return;
        }

        try {
            byte[] bytes = Base64.decode(chunk, Base64.DEFAULT);
            cacheSessionFile.write(bytes);

            JSObject ret = new JSObject();
            ret.put("written", bytes.length);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "writeCacheChunk 写入失败", e);
            call.reject("写入失败: " + e.getMessage());
        }
    }

    /**
     * 完成缓存写入，返回 content:// URI（可分享）
     */
    @PluginMethod
    public void finishCacheWrite(PluginCall call) {
        String sessionId = call.getString("sessionId");

        if (cacheSessionId == null || !cacheSessionId.equals(sessionId)) {
            call.reject("无效的缓存写入会话");
            return;
        }

        try {
            if (cacheSessionFile != null) {
                cacheSessionFile.close();
            }

            // 构造 content URI（通过 FileProvider）
            File file = new File(cacheSessionPath);
            Uri fileUri = androidx.core.content.FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            Log.i(TAG, "finishCacheWrite 成功: path=" + cacheSessionPath + " uri=" + fileUri);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("path", cacheSessionPath);
            ret.put("uri", fileUri != null ? fileUri.toString() : "");
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "finishCacheWrite 失败", e);
            // 降级：返回文件路径，不用 FileProvider
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("path", cacheSessionPath);
            ret.put("uri", "");
            call.resolve(ret);
        } finally {
            cacheSessionId = null;
            cacheSessionFile = null;
            cacheSessionPath = null;
        }
    }
}
