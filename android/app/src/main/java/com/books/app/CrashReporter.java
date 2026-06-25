package com.books.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * CrashReporter — 捕获未处理异常，写入 crash_log.txt，供 CrashLogPlugin 在下次启动时读取。
 *
 * 使用：在 MainActivity.onCreate() 最早处调用
 *   Thread.setDefaultUncaughtExceptionHandler(new CrashReporter(this));
 */
public class CrashReporter implements Thread.UncaughtExceptionHandler {

    public static final String CRASH_FILE = "crash_log.txt";

    private final Context context;
    private final Thread.UncaughtExceptionHandler defaultHandler;

    public CrashReporter(Context context) {
        this.context        = context.getApplicationContext();
        this.defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    @Override
    public void uncaughtException(Thread thread, Throwable ex) {
        try {
            // 获取版本号
            String versionName = "未知";
            try {
                PackageInfo pi = context.getPackageManager()
                        .getPackageInfo(context.getPackageName(), 0);
                versionName = pi.versionName;
            } catch (PackageManager.NameNotFoundException ignored) {}

            // 格式化堆栈信息
            StringWriter sw = new StringWriter();
            PrintWriter  pw = new PrintWriter(sw);
            String ts = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
                            .format(new Date());
            pw.println("Version: " + versionName);
            pw.println(ts + "  Thread: " + thread.getName());
            ex.printStackTrace(pw);
            pw.flush();

            // 写入 app 私有目录（不需要存储权限）
            File crashFile = new File(context.getFilesDir(), CRASH_FILE);
            FileOutputStream fos = new FileOutputStream(crashFile, false/*overwrite*/);
            fos.write(sw.toString().getBytes("UTF-8"));
            fos.close();
        } catch (Exception ignored) {
            // 崩溃处理本身不能崩溃
        }

        // 调用默认 handler（弹出"应用停止运行"对话框 / 触发 Android 崩溃报告）
        if (defaultHandler != null) {
            defaultHandler.uncaughtException(thread, ex);
        }
    }
}
