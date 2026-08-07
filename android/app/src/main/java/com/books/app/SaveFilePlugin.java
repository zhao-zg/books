package com.books.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

import java.io.OutputStream;

/**
 * SaveFilePlugin — 通过 Android SAF (Storage Access Framework) 让用户选择保存位置
 *
 * 使用 ACTION_CREATE_DOCUMENT Intent 弹出系统文件选择器：
 *   1. 用户选择保存目录和文件名
 *   2. 系统返回 content:// URI
 *   3. 通过 ContentResolver 写入数据
 *
 * 降级策略：如果 SAF 不可用（极低版本），回退到旧流程（缓存 + Share）
 *
 * JS 调用方式：
 *   Capacitor.Plugins.SaveFile.save({
 *     filename: '书名.txt',
 *     data: '<base64>',
 *     mimeType: 'text/plain'
 *   })
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private static final String TAG = "SaveFilePlugin";

    // 暂存当前调用，Activity 返回后取回
    private PluginCall pendingCall = null;
    private String pendingBase64 = null;

    /**
     * 弹出系统"另存为"对话框，用户选择保存位置后写入数据
     *
     * @param call  Capacitor PluginCall
     *   - filename: 建议文件名（含扩展名）
     *   - data:     base64 编码的文件内容
     *   - mimeType: MIME 类型，默认 application/octet-stream
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

        // 暂存数据，等 Activity 结果回来后使用
        pendingCall = call;
        pendingBase64 = base64Data;

        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, filename);

            // 保存调用引用，startActivityForResult 需要桥接
            startActivityForResult(call, intent, "handleSaveResult");
        } catch (Exception e) {
            Log.e(TAG, "SAF 启动失败", e);
            // 降级：清除暂存
            pendingCall = null;
            pendingBase64 = null;
            call.reject("无法打开系统保存对话框: " + e.getMessage());
        }
    }

    /**
     * SAF 对话框返回结果回调
     */
    @ActivityCallback
    private void handleSaveResult(PluginCall call, Activity activity, Intent data) {
        // Capacitor 6 @ActivityCallback 的 call 参数可能为 null，取回暂存
        PluginCall savedCall = (call != null) ? call : pendingCall;

        if (data == null || data.getData() == null) {
            // 用户取消了保存
            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("saved", false);
                ret.put("reason", "cancelled");
                savedCall.resolve(ret);
            }
            pendingCall = null;
            pendingBase64 = null;
            return;
        }

        Uri uri = data.getData();
        String base64 = pendingBase64;

        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

            ContentResolver resolver = getContext().getContentResolver();
            OutputStream os = resolver.openOutputStream(uri);
            if (os == null) {
                throw new Exception("无法打开输出流");
            }
            try {
                os.write(bytes);
                os.flush();
            } finally {
                os.close();
            }

            Log.i(TAG, "文件已保存: " + uri.toString());

            if (savedCall != null) {
                JSObject ret = new JSObject();
                ret.put("saved", true);
                ret.put("uri", uri.toString());
                savedCall.resolve(ret);
            }

        } catch (Exception e) {
            Log.e(TAG, "写入文件失败", e);
            if (savedCall != null) {
                savedCall.reject("保存失败: " + e.getMessage());
            }
        } finally {
            pendingCall = null;
            pendingBase64 = null;
        }
    }
}
