package com.books.app;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * ImageSaverPlugin
 * 接受 base64 图片数据，保存到缓存目录后通过 Android 原生分享 Intent 打开系统分享菜单。
 * 用户可在分享菜单中选择：保存到相册、发送给微信好友等。
 */
@CapacitorPlugin(name = "ImageSaver")
public class ImageSaverPlugin extends Plugin {

    @PluginMethod
    public void shareImage(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String filename   = call.getString("filename", "image.jpg");
        String mimeType   = call.getString("mimeType", "image/jpeg");
        String title      = call.getString("title", "分享图片");

        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("base64Data 不能为空");
            return;
        }

        try {
            // 去掉 Data URI 前缀（如 data:image/jpeg;base64,）
            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(',') + 1);
            }

            byte[] imageBytes = Base64.decode(base64Data, Base64.DEFAULT);

            // 写入缓存目录（FileProvider 已覆盖 getCacheDir()）
            File cacheDir = new File(getContext().getCacheDir(), "books_shared");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            File imageFile = new File(cacheDir, filename);
            try (FileOutputStream fos = new FileOutputStream(imageFile)) {
                fos.write(imageBytes);
            }

            // 构造 FileProvider URI（authority 与 ApkInstallerPlugin 相同）
            Uri shareUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                imageFile
            );

            // 创建分享 Intent
            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType(mimeType);
            shareIntent.putExtra(Intent.EXTRA_STREAM, shareUri);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(shareIntent, title);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);

        } catch (Exception e) {
            call.reject("分享失败: " + e.getMessage());
        }
    }
}
