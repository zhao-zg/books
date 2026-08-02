package com.books.app;

import android.content.ContentResolver;
import android.content.ContentValues;
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
 * 三种方式全部执行，哪个生效算哪个：
 * 1. addDynamicShortcuts — 注册动态快捷方式（长按图标可见）
 * 2. requestPinShortcut — 请求固定到桌面（原生 ROM 弹确认框）
 * 3. INSTALL_SHORTCUT 广播 — 直接写入桌面（部分国产 ROM 仍然支持）
 * 4. Launcher ContentProvider — 直接往桌面数据库写记录（MIUI/EMUI 等的终极方案）
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
            Intent shortcutIntent = buildDeepLinkIntent(bookId);
            Bitmap bmp = buildBitmap(coverBase64, bookTitle);
            Icon icon = Icon.createWithBitmap(bmp);

            // 方式1：注册动态快捷方式（长按应用图标可看到）
            tryDynamic(bookId, bookTitle, shortcutIntent, icon);

            // 方式2：requestPinShortcut（原生 ROM 会弹确认框直接加到桌面）
            tryRequestPin(bookId, bookTitle, shortcutIntent, icon);

            // 方式3：INSTALL_SHORTCUT 广播（部分国产 ROM 仍然支持，可直接加到桌面）
            tryBroadcast(bookId, bookTitle, shortcutIntent, bmp);

            // 方式4：Launcher ContentProvider（MIUI/EMUI/ColorOS 等国产 ROM 终极方案）
            tryLauncherProvider(bookId, bookTitle, shortcutIntent, bmp);

            resolveWith(call, "created", "《" + bookTitle + "》快捷方式已添加");

        } catch (Exception e) {
            Log.e(TAG, "创建快捷方式异常", e);
            call.reject("创建快捷方式失败: " + e.getMessage());
        }
    }

    // ── 方式1：动态快捷方式 ─────────────────────────────────────────────

    private void tryDynamic(String bookId, String bookTitle, Intent intent, Icon icon) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            ShortcutManager sm = getContext().getSystemService(ShortcutManager.class);
            if (sm == null) return;

            ShortcutInfo info = buildShortcutInfo(bookId, bookTitle, intent, icon);
            sm.addDynamicShortcuts(Collections.singletonList(info));
            Log.i(TAG, "动态快捷方式注册成功");
        } catch (Exception e) {
            Log.w(TAG, "动态快捷方式注册失败: " + e.getMessage());
        }
    }

    // ── 方式2：requestPinShortcut ────────────────────────────────────────

    private void tryRequestPin(String bookId, String bookTitle, Intent intent, Icon icon) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            ShortcutManager sm = getContext().getSystemService(ShortcutManager.class);
            if (sm == null || !sm.isRequestPinShortcutSupported()) return;

            ShortcutInfo info = buildShortcutInfo(bookId, bookTitle, intent, icon);
            sm.requestPinShortcut(info, null);
            Log.i(TAG, "requestPinShortcut 已请求");
        } catch (Exception e) {
            Log.w(TAG, "requestPinShortcut 失败: " + e.getMessage());
        }
    }

    // ── 方式3：INSTALL_SHORTCUT 广播 ─────────────────────────────────────

    private void tryBroadcast(String bookId, String bookTitle, Intent shortcutIntent, Bitmap bmp) {
        try {
            Intent addIntent = new Intent("com.android.launcher.action.INSTALL_SHORTCUT");
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_INTENT, shortcutIntent);
            addIntent.putExtra(Intent.EXTRA_SHORTCUT_NAME, "《" + bookTitle + "》");
            addIntent.putExtra("duplicate", false);
            if (bmp != null) {
                addIntent.putExtra(Intent.EXTRA_SHORTCUT_ICON, bmp);
            }
            getContext().sendBroadcast(addIntent);
            Log.i(TAG, "广播已发送");
        } catch (Exception e) {
            Log.w(TAG, "广播发送失败: " + e.getMessage());
        }
    }

    // ── 方式4：Launcher ContentProvider ─────────────────────────────────
    // 部分国产 ROM（MIUI/EMUI/ColorOS）通过 ContentProvider 管理桌面快捷方式，
    // 可以直接写入数据库来创建快捷方式。

    private void tryLauncherProvider(String bookId, String bookTitle, Intent shortcutIntent, Bitmap bmp) {
        // 常见国产 ROM 的 Launcher Provider URI
        String[] providerUris = {
            "content://com.android.launcher3.settings/favorites",   // AOSP/Pixel
            "content://com.android.launcher.settings/favorites",     // 旧版 AOSP
            "content://com.miui.launcher.settings/favorites",        // MIUI
            "content://com.huawei.android.launcher.settings/favorites", // EMUI
            "content://com.oppo.launcher.settings/favorites",        // ColorOS
            "content://com.vivo.launcher.settings/favorites",       // OriginOS
            "content://com.samsung.android.app.launcher.settings/favorites" // OneUI
        };

        for (String uriStr : providerUris) {
            try {
                ContentResolver cr = getContext().getContentResolver();
                Uri uri = Uri.parse(uriStr);

                ContentValues values = new ContentValues();
                values.put("title", "《" + bookTitle + "》");
                values.put("intent", shortcutIntent.toUri(0));
                values.put("itemType", 1); // 1 = APPLICATION
                values.put("container", -100); // -100 = CONTAINER_DESKTOP
                values.put("screen", -1); // 自动选择屏幕
                values.put("cellX", -1); // 自动选择位置
                values.put("cellY", -1);
                values.put("spanX", 1);
                values.put("spanY", 1);

                cr.insert(uri, values);
                Log.i(TAG, "Provider 写入成功: " + uriStr);
                return; // 第一个成功的就够了
            } catch (Exception e) {
                // 这个 Provider 不存在或没权限，试下一个
            }
        }
        Log.w(TAG, "所有 Launcher Provider 均不可用");
    }

    // ── 辅助方法 ──────────────────────────────────────────────────────

    private void resolveWith(PluginCall call, String result, String message) {
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("result", result);
        ret.put("message", message);
        call.resolve(ret);
    }

    private ShortcutInfo buildShortcutInfo(String bookId, String bookTitle, Intent intent, Icon icon) {
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

    private Bitmap buildBitmap(String coverBase64, String bookTitle) {
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

    private Bitmap cropCenterSquare(Bitmap bmp) {
        int size = Math.min(bmp.getWidth(), bmp.getHeight());
        int x = (bmp.getWidth() - size) / 2;
        int y = (bmp.getHeight() - size) / 2;
        return Bitmap.createBitmap(bmp, x, y, size, size);
    }

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
