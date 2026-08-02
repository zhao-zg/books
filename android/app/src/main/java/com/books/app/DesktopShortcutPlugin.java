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

import java.util.Collections;

/**
 * DesktopShortcutPlugin
 * 在 Android 桌面创建书籍快捷方式。
 *
 * 兼容策略（按优先级尝试，确保所有路径都有 resolve/reject）：
 * 1. API 26+ 且 requestPinShortcutSupported → requestPinShortcut（系统确认弹窗）
 * 2. API 26+ 不支持 pin → addDynamicShortcuts + 尝试 pin + 降级广播
 * 3. API 25 及以下 → INSTALL_SHORTCUT 广播
 *
 * 点击快捷方式后通过深链 Intent 传递书籍 ID，
 * 主 Activity 接收后在 WebView 中路由到对应书籍。
 */
@CapacitorPlugin(name = "DesktopShortcut")
public class DesktopShortcutPlugin extends Plugin {

    private static final String TAG = "DesktopShortcut";
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

        Log.i(TAG, "创建快捷方式: bookId=" + bookId + " title=" + bookTitle);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                createOnApi26(call, bookId, bookTitle, coverBase64);
            } else {
                createByBroadcast(call, bookId, bookTitle, coverBase64);
            }
        } catch (Exception e) {
            Log.e(TAG, "创建快捷方式异常", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    /**
     * Android 8+ (API 26) 创建快捷方式
     * 优先 requestPinShortcut，不支持则降级
     */
    private void createOnApi26(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        ShortcutManager sm = getContext().getSystemService(ShortcutManager.class);
        if (sm == null) {
            Log.w(TAG, "ShortcutManager 不可用，降级广播");
            createByBroadcast(call, bookId, bookTitle, coverBase64);
            return;
        }

        // 1. 尝试 requestPinShortcut（标准方式）
        if (sm.isRequestPinShortcutSupported()) {
            Log.i(TAG, "使用 requestPinShortcut（标准方式）");
            try {
                ShortcutInfo info = buildShortcutInfo(bookId, bookTitle, coverBase64);
                sm.requestPinShortcut(info, null);
                resolveWith(call, "pin_requested", "请在弹窗中确认添加到桌面");
                return;
            } catch (Exception e) {
                Log.w(TAG, "requestPinShortcut 异常，尝试降级", e);
            }
        }

        // 2. requestPinShortcut 不支持：注册动态快捷方式 + 再尝试 pin
        Log.i(TAG, "requestPinShortcut 不支持，尝试动态快捷方式方案");
        try {
            ShortcutInfo info = buildShortcutInfo(bookId, bookTitle, coverBase64);

            // 先注册为动态快捷方式（用户可长按应用图标看到）
            try {
                sm.addDynamicShortcuts(Collections.singletonList(info));
                Log.i(TAG, "动态快捷方式注册成功");
            } catch (Exception e) {
                Log.w(TAG, "动态快捷方式注册失败: " + e.getMessage());
            }

            // 再尝试 pin（某些 ROM 在动态快捷方式存在后允许 pin）
            try {
                if (sm.isRequestPinShortcutSupported()) {
                    sm.requestPinShortcut(info, null);
                    resolveWith(call, "pin_requested", "请在弹窗中确认添加到桌面");
                    return;
                }
            } catch (Exception e) {
                Log.w(TAG, "动态注册后 requestPinShortcut 仍失败", e);
            }

            // 3. 仍然不支持 pin：广播作为最后手段
            Log.i(TAG, "所有 pin 方式均不支持，广播作为最后手段");
            createByBroadcast(call, bookId, bookTitle, coverBase64);

        } catch (Exception e) {
            Log.e(TAG, "动态快捷方式方案异常", e);
            createByBroadcast(call, bookId, bookTitle, coverBase64);
        }
    }

    /**
     * 通过 INSTALL_SHORTCUT 广播创建快捷方式
     * Android 8+ 已废弃，仅作为最后降级手段
     */
    private void createByBroadcast(PluginCall call, String bookId, String bookTitle, String coverBase64) {
        try {
            Intent shortcutIntent = buildDeepLinkIntent(bookId);

            Intent addIntent = new Intent("com.android.launcher.action.INSTALL_SHORTCUT");
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_INTENT, shortcutIntent);
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_NAME, "《" + bookTitle + "》");
            addIntent.putExtra("duplicate", false);

            // 广播方式只接受 Bitmap，不能放 Icon
            Bitmap bmp = buildBitmap(coverBase64, bookTitle);
            if (bmp != null) {
                addIntent.putExtra(Intent.EXTRA_SHORTCUT_ICON, bmp);
            }

            getContext().sendBroadcast(addIntent);
            Log.i(TAG, "广播已发送");

            // 广播无法确认结果
            resolveWith(call, "broadcast_sent",
                    "已注册，请查看桌面；也可长按应用图标拖出快捷方式");
        } catch (Exception e) {
            Log.e(TAG, "广播创建快捷方式失败", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    // ── 辅助方法 ──────────────────────────────────────────────────────

    private void resolveWith(PluginCall call, String result, String message) {
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("result", result);
        ret.put("message", message);
        call.resolve(ret);
    }

    private ShortcutInfo buildShortcutInfo(String bookId, String bookTitle, String coverBase64) {
        Intent intent = buildDeepLinkIntent(bookId);
        Icon icon = buildIcon(coverBase64, bookTitle);

        String shortLabel = bookTitle.length() > 10 ? bookTitle.substring(0, 10) : bookTitle;

        return new ShortcutInfo.Builder(getContext(), "book_" + bookId)
                .setShortLabel(shortLabel)
                .setLongLabel("《" + bookTitle + "》")
                .setIcon(icon)
                .setIntent(intent)
                .build();
    }

    private Intent buildDeepLinkIntent(String bookId) {
        Uri deepLink = Uri.parse(SCHEME + "://" + HOST + "/" + Uri.encode(bookId));
        Intent intent = new Intent(Intent.ACTION_VIEW, deepLink);
        intent.setClass(getContext(), MainActivity.class);
        intent.putExtra("bookId", bookId);
        intent.addCategory(Intent.CATEGORY_DEFAULT);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    // ── 图标生成 ──────────────────────────────────────────────────────

    /**
     * 生成 Icon（用于 ShortcutInfo）
     */
    private Icon buildIcon(String coverBase64, String bookTitle) {
        Bitmap bmp = buildBitmap(coverBase64, bookTitle);
        return Icon.createWithBitmap(bmp);
    }

    /**
     * 生成 Bitmap 图标：优先用封面图，否则用书名首字彩色图标
     */
    private Bitmap buildBitmap(String coverBase64, String bookTitle) {
        // 尝试用封面图
        if (coverBase64 != null && !coverBase64.isEmpty()) {
            try {
                String b64 = coverBase64;
                if (b64.contains(",")) {
                    b64 = b64.substring(b64.indexOf(',') + 1);
                }
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) {
                    Bitmap square = cropCenterSquare(bmp);
                    Bitmap scaled = Bitmap.createScaledBitmap(square, 108, 108, true);
                    if (square != bmp && !square.isRecycled()) square.recycle();
                    if (bmp != square && !bmp.isRecycled()) bmp.recycle();
                    return scaled;
                }
            } catch (Exception e) {
                Log.w(TAG, "封面图解码失败，使用文字图标", e);
            }
        }
        return buildTextBitmap(bookTitle);
    }

    /**
     * 裁剪为正方形（取中心区域）
     */
    private Bitmap cropCenterSquare(Bitmap bmp) {
        int size = Math.min(bmp.getWidth(), bmp.getHeight());
        int x = (bmp.getWidth() - size) / 2;
        int y = (bmp.getHeight() - size) / 2;
        return Bitmap.createBitmap(bmp, x, y, size, size);
    }

    /**
     * 用书名首字生成彩色圆角矩形图标
     */
    private Bitmap buildTextBitmap(String bookTitle) {
        int size = 108;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);

        int color = bookTitle != null ? bookTitle.hashCode() : 0;
        int hue = Math.abs(color % 360);
        float[] hsv = {hue, 0.4f, 0.85f};
        int bgColor = Color.HSVToColor(hsv);

        Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        bgPaint.setColor(bgColor);
        bgPaint.setStyle(Paint.Style.FILL);
        float radius = 18f;
        canvas.drawRoundRect(0, 0, size, size, radius, radius, bgPaint);

        String firstChar = "书";
        if (bookTitle != null && !bookTitle.isEmpty()) {
            firstChar = bookTitle.substring(0, 1);
        }
        Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        textPaint.setColor(Color.WHITE);
        textPaint.setTextSize(52f);
        textPaint.setTypeface(Typeface.DEFAULT_BOLD);
        textPaint.setTextAlign(Paint.Align.CENTER);
        Rect textBounds = new Rect();
        textPaint.getTextBounds(firstChar, 0, firstChar.length(), textBounds);
        float textY = size / 2f + textBounds.height() / 2f - textBounds.bottom / 2f;
        canvas.drawText(firstChar, size / 2f, textY, textPaint);

        return bitmap;
    }
}
