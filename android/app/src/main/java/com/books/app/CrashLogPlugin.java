package com.books.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;

/**
 * CrashLogPlugin — Capacitor 插件，供 JS 在应用启动时读取上次崩溃日志。
 *
 * JS 调用：
 *   Capacitor.Plugins.CrashLog.getLastCrash()
 *     → Promise<{ log: string }>   // log 为空字符串表示无崩溃记录
 *
 * 读取后文件自动删除（一次性）。
 */
@CapacitorPlugin(name = "CrashLog")
public class CrashLogPlugin extends Plugin {

    @PluginMethod
    public void getLastCrash(PluginCall call) {
        File crashFile = new File(getContext().getFilesDir(), CrashReporter.CRASH_FILE);
        if (!crashFile.exists()) {
            call.resolve(new JSObject().put("log", ""));
            return;
        }
        try {
            // 读取文件内容（兼容 API 21+，不用 java.nio.file）
            FileInputStream fis  = new FileInputStream(crashFile);
            byte[]          data = new byte[(int) crashFile.length()];
            //noinspection ResultOfMethodCallIgnored
            fis.read(data);
            fis.close();
            String content = new String(data, "UTF-8");

            //noinspection ResultOfMethodCallIgnored
            crashFile.delete(); // 读过即清除，不重复上报

            call.resolve(new JSObject().put("log", content));
        } catch (Exception e) {
            call.resolve(new JSObject().put("log", ""));
        }
    }
}
