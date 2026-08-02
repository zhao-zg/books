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

import java.net.URLDecoder;

/**
 * DesktopShortcutPlugin
 * 在 Android 桌面创建书籍快捷方式。
 * 优先使用 ShortcutManager.requestPinShortcut（API 26+），
 * 不支持时降级使用 ACTION_INSTALL_SHORTCUT 广播（API 25 及以下）。
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
                // 某些厂商 ROM 不支持 requestPinShortcut，降级到广播方式
                Log.w(TAG, "requestPinShortcut 不支持，降级使用广播方式");
            }

            // Android 7 及以下 或 厂商 ROM 不支持 requestPinShortcut：使用广播
            installShortcutByBroadcast(call, bookId, bookTitle, coverBase64);

        } catch (Exception e) {
            Log.e(TAG, "创建快捷方式失败", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    /**
     * Android 8+ 方式：requestPinShortcut
     */
    private void requestPinShortcut(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        try {
            ShortcutManager shortcutManager = getContext().getSystemService(ShortcutManager.class);

            // 构建深链 URI：bookapp://book/{bookId}
            Uri deepLink = Uri.parse(SCHEME + "://" + HOST + "/" + Uri.encode(bookId));

            Intent shortcutIntent = new Intent(Intent.ACTION_VIEW, deepLink);
            shortcutIntent.setClass(getContext(), MainActivity.class);
            shortcutIntent.putExtra("bookId", bookId);
            shortcutIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            ShortcutInfo.Builder infoBuilder = new ShortcutInfo.Builder(getContext(), "book_" + bookId)
                    .setShortLabel(bookTitle.length() > 10 ? bookTitle.substring(0, 10) : bookTitle)
                    .setLongLabel("《" + bookTitle + "》")
                    .setIntent(shortcutIntent);

            // 尝试用封面图生成图标
            Icon icon = buildIcon(coverBase64, bookTitle);
            infoBuilder.setIcon(icon);

            ShortcutInfo shortcutInfo = infoBuilder.build();

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
     * 降级方式：通过 INSTALL_SHORTCUT 广播创建桌面快捷方式
     * 适用于 Android 7 及以下，或厂商 ROM 不支持 requestPinShortcut 的场景
     */
    private void installShortcutByBroadcast(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        try {
            Uri deepLink = Uri.parse(SCHEME + "://" + HOST + "/" + Uri.encode(bookId));

            Intent shortcutIntent = new Intent(Intent.ACTION_VIEW, deepLink);
            shortcutIntent.setClass(getContext(), MainActivity.class);
            shortcutIntent.putExtra("bookId", bookId);
            shortcutIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            Intent addIntent = new Intent("com.android.launcher.action.INSTALL_SHORTCUT");
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_INTENT, shortcutIntent);
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_NAME, "《" + bookTitle + "》");
            addIntent.putExtra("duplicate", false);

            // 图标
            Icon icon = buildIcon(coverBase64, bookTitle);
            // 广播方式使用 Parcelable Icon（API 26+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                addIntent.putExtra(Intent.EXTRA_SHORTCUT_ICON, icon);
            } else {
                // API 25 及以下：使用 Bitmap
                Bitmap bmp = buildIconBitmap(coverBase64, bookTitle);
                if (bmp != null) {
                    addIntent.putExtra(Intent.EXTRA_SHORTCUT_ICON, bmp);
                }
            }

            getContext().sendBroadcast(addIntent);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", "已发送桌面快捷方式广播");
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "广播创建快捷方式失败", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
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
