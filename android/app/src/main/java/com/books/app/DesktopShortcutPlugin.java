package com.books.app;

import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DesktopShortcutPlugin
 * 在 Android 桌面创建书籍快捷方式。
 * 策略（按优先级）：
 * 1. API 26+ 且 requestPinShortcutSupported → requestPinShortcut（系统确认弹窗）
 * 2. API 26+ 不支持 requestPinShortcut → 先注册动态快捷方式，再 requestPinShortcut
 * 3. API 25 及以下 → INSTALL_SHORTCUT 广播
 * 点击快捷方式后通过 Intent 传递书籍 ID，主 Activity 接收后在 WebView 中路由到对应书籍。
 */
@CapacitorPlugin(name = "DesktopShortcut")
public class DesktopShortcutPlugin extends Plugin {

    private static final String TAG = "DesktopShortcut";
    // 与 MainActivity 中 intent-filter 的 scheme 保持一致
    private static final String SCHEME = "bookapp";
    private static final String HOST = "book";

    @PluginMethod
    public void create(PluginCall call) {
        String bookId = call.getString("bookId");
        String bookTitle = call.getString("bookTitle", "书籍");
        String coverBase64 = call.getString("coverBase64", "");

        if (bookId == null || bookId.isEmpty()) {
            call.reject("bookId 不能为空");
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Android 8+：优先使用 ShortcutManager.requestPinShortcut
                ShortcutManager shortcutManager = getContext().getSystemService(ShortcutManager.class);

                if (shortcutManager.isRequestPinShortcutSupported()) {
                    requestPinShortcut(call, bookId, bookTitle, coverBase64);
                    return;
                }
                // 某些厂商 ROM 不支持 requestPinShortcut，
                // 尝试先注册为动态快捷方式再 requestPinShortcut
                Log.w(TAG, "requestPinShortcut 不支持，尝试动态快捷方式方案");
                requestPinViaDynamic(call, bookId, bookTitle, coverBase64, shortcutManager);
                return;
            }

            // Android 7 及以下：使用广播
            installShortcutByBroadcast(call, bookId, bookTitle, coverBase64);

        } catch (Exception e) {
            Log.e(TAG, "创建快捷方式失败", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    /**
     * Android 8+ 方式：requestPinShortcut（标准流程）
     */
    private void requestPinShortcut(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        try {
            ShortcutManager shortcutManager = getContext().getSystemService(ShortcutManager.class);

            Intent shortcutIntent = buildShortcutIntent(bookId);
            Icon icon = buildIcon(coverBase64, bookTitle);

            ShortcutInfo shortcutInfo = new ShortcutInfo.Builder(getContext(), "book_" + bookId)
                    .setShortLabel(bookTitle.length() > 10 ? bookTitle.substring(0, 10) : bookTitle)
                    .setLongLabel("《" + bookTitle + "》")
                    .setIcon(icon)
                    .setIntent(shortcutIntent)
                    .build();

            // 请求固定快捷方式（系统会弹出确认对话框）
            shortcutManager.requestPinShortcut(shortcutInfo, null);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", "已请求创建桌面快捷方式");
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "requestPinShortcut 失败，降级到广播方式", e);
            installShortcutByBroadcast(call, bookId, bookTitle, coverBase64);
        }
    }

    /**
     * 不支持 requestPinShortcut 时的替代方案：
     * 先将快捷方式注册为动态快捷方式，然后再 requestPinShortcut
     * （某些 ROM 在快捷方式已存在于动态列表时才允许 pin）
     */
    private void requestPinViaDynamic(PluginCall call, String bookId, String bookTitle,
                                       String coverBase64, ShortcutManager shortcutManager) {
        try {
            Intent shortcutIntent = buildShortcutIntent(bookId);
            Icon icon = buildIcon(coverBase64, bookTitle);

            String shortcutId = "book_" + bookId;

            ShortcutInfo shortcutInfo = new ShortcutInfo.Builder(getContext(), shortcutId)
                    .setShortLabel(bookTitle.length() > 10 ? bookTitle.substring(0, 10) : bookTitle)
                    .setLongLabel("《" + bookTitle + "》")
                    .setIcon(icon)
                    .setIntent(shortcutIntent)
                    .build();

            // 注册为动态快捷方式（使用 addDynamicShortcuts 避免覆盖已有的）
            try {
                shortcutManager.addDynamicShortcuts(java.util.Collections.singletonList(shortcutInfo));
                Log.i(TAG, "动态快捷方式注册成功: " + shortcutId);
            } catch (Exception e) {
                Log.w(TAG, "动态快捷方式注册失败（可能已达上限），继续尝试 pin", e);
            }

            // 注册后再次尝试 requestPinShortcut
            // 注意：isRequestPinShortcutSupported() 取决于 Launcher，不会因注册动态快捷方式而改变
            // 但某些 ROM（如部分 MIUI 版本）在快捷方式存在于动态列表时才能 pin
            try {
                if (shortcutManager.isRequestPinShortcutSupported()) {
                    shortcutManager.requestPinShortcut(shortcutInfo, null);
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("message", "已请求创建桌面快捷方式");
                    call.resolve(ret);
                    return;
                }
            } catch (Exception e) {
                Log.w(TAG, "注册动态快捷方式后 requestPinShortcut 仍失败", e);
            }

            // 不支持 pin：动态快捷方式已注册成功，用户可在应用长按菜单中拖到桌面
            // 降级到广播方式作为额外尝试
            Log.w(TAG, "动态快捷方式已注册，降级广播方式作为额外尝试");
            installShortcutByBroadcast(call, bookId, bookTitle, coverBase64);
        } catch (Exception e) {
            Log.e(TAG, "动态快捷方式方案失败", e);
            installShortcutByBroadcast(call, bookId, bookTitle, coverBase64);
        }
    }

    /**
     * 降级方式：通过 INSTALL_SHORTCUT 广播创建桌面快捷方式
     * 适用于 Android 7 及以下，或厂商 ROM 不支持 requestPinShortcut 的场景
     */
    private void installShortcutByBroadcast(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        try {
            Intent shortcutIntent = buildShortcutIntent(bookId);

            Intent addIntent = new Intent("com.android.launcher.action.INSTALL_SHORTCUT");
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_INTENT, shortcutIntent);
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_NAME, "《" + bookTitle + "》");
            addIntent.putExtra("duplicate", false);

            // 图标：广播方式统一使用 Bitmap（EXTRA_SHORTCUT_ICON 只接受 Bitmap）
            Bitmap bmp = buildIconBitmap(coverBase64, bookTitle);
            if (bmp != null) {
                addIntent.putExtra(Intent.EXTRA_SHORTCUT_ICON, bmp);
            }

            getContext().sendBroadcast(addIntent);

            JSObject ret = new JSObject();
            ret.put("success", true);
            // 广播方式无法确认是否成功（Android 8+ 已废弃该广播，部分 ROM 会静默忽略）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ret.put("message", "已注册快捷方式，请查看桌面；也可长按应用图标拖出快捷方式");
            } else {
                ret.put("message", "已发送桌面快捷方式广播");
            }
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "广播创建快捷方式失败", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    /**
     * 构建点击快捷方式后的深链 Intent
     */
    private Intent buildShortcutIntent(String bookId) {
        Uri deepLink = Uri.parse(SCHEME + "://" + HOST + "/" + Uri.encode(bookId));
        Intent intent = new Intent(Intent.ACTION_VIEW, deepLink);
        intent.setClass(getContext(), MainActivity.class);
        intent.putExtra("bookId", bookId);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    /**
     * 生成快捷方式图标：优先用封面图，否则用书名首字生成彩色图标
     */
    private Icon buildIcon(String coverBase64, String bookTitle) {
        try {
            if (coverBase64 != null && !coverBase64.isEmpty()) {
                String b64 = coverBase64;
                if (b64.contains(",")) {
                    b64 = b64.substring(b64.indexOf(',') + 1);
                }
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) {
                    // 裁剪为正方形，缩放到快捷方式图标尺寸
                    int size = Math.min(bmp.getWidth(), bmp.getHeight());
                    int x = (bmp.getWidth() - size) / 2;
                    int y = (bmp.getHeight() - size) / 2;
                    Bitmap cropped = Bitmap.createBitmap(bmp, x, y, size, size);
                    Bitmap scaled = Bitmap.createScaledBitmap(cropped, 108, 108, true);
                    if (cropped != bmp && !cropped.isRecycled()) cropped.recycle();
                    if (bmp != cropped && !bmp.isRecycled()) bmp.recycle();
                    return Icon.createWithBitmap(scaled);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "封面图解码失败，使用文字图标", e);
        }

        // 降级：生成书名首字彩色图标
        return buildTextIcon(bookTitle);
    }

    /**
     * 构建 Bitmap 图标（用于广播方式降级）
     */
    private Bitmap buildIconBitmap(String coverBase64, String bookTitle) {
        try {
            if (coverBase64 != null && !coverBase64.isEmpty()) {
                String b64 = coverBase64;
                if (b64.contains(",")) {
                    b64 = b64.substring(b64.indexOf(',') + 1);
                }
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) {
                    int size = Math.min(bmp.getWidth(), bmp.getHeight());
                    int x = (bmp.getWidth() - size) / 2;
                    int y = (bmp.getHeight() - size) / 2;
                    Bitmap cropped = Bitmap.createBitmap(bmp, x, y, size, size);
                    Bitmap scaled = Bitmap.createScaledBitmap(cropped, 108, 108, true);
                    if (cropped != bmp && !cropped.isRecycled()) cropped.recycle();
                    if (bmp != cropped && !bmp.isRecycled()) bmp.recycle();
                    return scaled;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "封面图解码失败，使用文字图标", e);
        }
        return buildTextBitmap(bookTitle);
    }

    /**
     * 用书名首字生成一个彩色圆形图标（Icon 版本）
     */
    private Icon buildTextIcon(String bookTitle) {
        Bitmap bitmap = buildTextBitmap(bookTitle);
        return Icon.createWithBitmap(bitmap);
    }

    /**
     * 用书名首字生成一个彩色圆角矩形图标（Bitmap 版本）
     */
    private Bitmap buildTextBitmap(String bookTitle) {
        int size = 108;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);

        // 使用书名 hash 决定颜色
        int color = bookTitle != null ? bookTitle.hashCode() : 0;
        int hue = Math.abs(color % 360);
        float[] hsv = {hue, 0.4f, 0.85f};
        int bgColor = Color.HSVToColor(hsv);

        // 画圆角矩形背景
        Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        bgPaint.setColor(bgColor);
        bgPaint.setStyle(Paint.Style.FILL);
        Rect rect = new Rect(0, 0, size, size);
        float radius = 18f;
        canvas.drawRoundRect(rect.left, rect.top, rect.right, rect.bottom, radius, radius, bgPaint);

        // 画首字
        String firstChar = "书";
        if (bookTitle != null && !bookTitle.isEmpty()) {
            firstChar = bookTitle.substring(0, 1);
        }
        Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        textPaint.setColor(Color.WHITE);
        textPaint.setTextSize(52f);
        textPaint.setTypeface(Typeface.DEFAULT_BOLD);
        textPaint.setTextAlign(Paint.Align.CENTER);
        // 垂直居中
        Rect textBounds = new Rect();
        textPaint.getTextBounds(firstChar, 0, firstChar.length(), textBounds);
        float textY = size / 2f + textBounds.height() / 2f - textBounds.bottom / 2f;
        canvas.drawText(firstChar, size / 2f, textY, textPaint);

        return bitmap;
    }
}
