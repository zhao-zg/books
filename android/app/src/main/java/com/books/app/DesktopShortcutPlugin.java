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
 * 使用 ShortcutManager.requestPinShortcut（API 26+），点击后通过 Intent 传递书籍 ID，
 * 主 Activity 接收后在 WebView 中路由到对应书籍。
 */
@CapacitorPlugin(name = "DesktopShortcut")
public class DesktopShortcutPlugin extends Plugin {

    private static final String TAG = "DesktopShortcut";
    // 与 MainActivity 中 intent-filter 的 scheme 保持一致
    private static final String SCHEME = "bookapp";
    private static final String HOST = "book";

    @PluginMethod
    public void create(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("需要 Android 8.0 及以上版本");
            return;
        }

        String bookId = call.getString("bookId");
        String bookTitle = call.getString("bookTitle", "书籍");
        String coverBase64 = call.getString("coverBase64", "");

        if (bookId == null || bookId.isEmpty()) {
            call.reject("bookId 不能为空");
            return;
        }

        try {
            ShortcutManager shortcutManager = getContext().getSystemService(ShortcutManager.class);

            if (shortcutManager.isRequestPinShortcutSupported()) {
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
            } else {
                // 某些厂商 ROM 不支持 requestPinShortcut
                call.reject("当前设备不支持创建桌面快捷方式");
            }
        } catch (Exception e) {
            Log.e(TAG, "创建快捷方式失败", e);
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
     * 用书名首字生成一个彩色圆形图标
     */
    private Icon buildTextIcon(String bookTitle) {
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

        return Icon.createWithBitmap(bitmap);
    }
}
