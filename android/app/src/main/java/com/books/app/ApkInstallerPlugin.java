package com.books.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String filePath = call.getString("filePath");
        
        if (filePath == null || filePath.isEmpty()) {
            call.reject("文件路径不能为空");
            return;
        }
        
        try {
            // 移除 file:// 前缀
            if (filePath.startsWith("file://")) {
                filePath = filePath.substring(7);
            }
            
            File file = new File(filePath);
            
            if (!file.exists()) {
                call.reject("文件不存在: " + filePath);
                return;
            }
            
            Uri uri;
            
            // Android 7.0+ 使用 FileProvider
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
                );
            } else {
                uri = Uri.fromFile(file);
            }
            
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            
            getActivity().startActivity(intent);
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", "安装程序已打开");
            call.resolve(ret);
            
        } catch (Exception e) {
            call.reject("打开安装程序失败: " + e.getMessage());
        }
    }
}
