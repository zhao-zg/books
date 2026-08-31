package com.books.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import org.nanohttpd.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

/**
 * LanSyncPlugin — 局域网同步 Capacitor 插件
 *
 * 启动嵌入式 HTTP Server（NanoHTTPD），提供 /info、/download、/upload 端点。
 * 通过 evaluateJs 调用 JS 侧的 exportData/importFromZip，用 CountDownLatch 同步等待。
 *
 * 安全：配对码校验 + 私有 IP 过滤 + 10 分钟无活动自动关闭。
 */
public class LanSyncPlugin extends Plugin {

    private static final String TAG = "LanSyncPlugin";
    private static final int DEFAULT_PORT = 18080;
    private static final int MAX_IDLE_MINUTES = 10;
    private static final int JS_TIMEOUT_SECONDS = 30;
    private static final int MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB

    private SyncServer server;
    private String pairCode;
    private volatile long lastRequestTime;

    // JS 桥梁：requestId → CountDownLatch + 结果
    private final ConcurrentHashMap<String, CountDownLatch> pendingLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> pendingResults = new ConcurrentHashMap<>();

    // NSD 注册监听器（T5 实现）
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener nsdRegistrationListener;
    private static final String NSD_SERVICE_TYPE = "_bk-sync._tcp.";

    // ── 插件方法 ──────────────────────────────────────────────────────────

    @PluginMethod
    public void startServer(PluginCall call) {
        if (server != null) {
            JSObject ret = new JSObject();
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            call.resolve(ret);
            return;
        }

        try {
            pairCode = generatePairCode();
            int port = call.getInt("port", DEFAULT_PORT);

            server = new SyncServer(port);
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
            lastRequestTime = System.currentTimeMillis();

            JSObject ret = new JSObject();
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to start server: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        if (server != null) {
            server.stop();
            server = null;
        }
        unregisterNsdInternal();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", server != null && server.isAlive());
        if (server != null) {
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            long idleSeconds = (System.currentTimeMillis() - lastRequestTime) / 1000;
            ret.put("idleSeconds", idleSeconds);
        }
        call.resolve(ret);
    }

    /**
     * JS 桥回调：JS 处理完成后调用此方法，唤醒等待的 HTTP 线程
     */
    @PluginMethod
    public void deliverResult(PluginCall call) {
        String requestId = call.getString("requestId", "");
        String data = call.getString("data", "");

        pendingResults.put(requestId, data);
        CountDownLatch latch = pendingLatches.get(requestId);
        if (latch != null) {
            latch.countDown();
        }
        call.resolve();
    }

    @PluginMethod
    public void registerNsd(PluginCall call) {
        if (server == null) {
            call.reject("Server not running");
            return;
        }

        try {
            nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);

            NsdServiceInfo serviceInfo = new NsdServiceInfo();
            serviceInfo.setServiceName("书报-" + getDeviceShortId());
            serviceInfo.setServiceType(NSD_SERVICE_TYPE);
            serviceInfo.setPort(server.getListeningPort());

            nsdRegistrationListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo info) {
                    Log.d(TAG, "NSD registered: " + info.getServiceName());
                }

                @Override
                public void onRegistrationFailed(NsdServiceInfo info, int errorCode) {
                    Log.e(TAG, "NSD registration failed: " + errorCode);
                }

                @Override
                public void onUnregistrationFailed(NsdServiceInfo info, int errorCode) {
                    Log.e(TAG, "NSD unregistration failed: " + errorCode);
                }

                @Override
                public void onUnregistered(NsdServiceInfo info) {
                    Log.d(TAG, "NSD unregistered");
                }
            };

            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, nsdRegistrationListener);
            call.resolve();
        } catch (Exception e) {
            call.reject("NSD registration failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void unregisterNsd(PluginCall call) {
        unregisterNsdInternal();
        call.resolve();
    }

    // ── NSD 内部 ──────────────────────────────────────────────────────────

    private void unregisterNsdInternal() {
        if (nsdManager != null && nsdRegistrationListener != null) {
            try {
                nsdManager.unregisterService(nsdRegistrationListener);
            } catch (Exception e) {
                Log.e(TAG, "NSD unregister error: " + e.getMessage());
            }
            nsdRegistrationListener = null;
        }
    }

    private String getDeviceShortId() {
        try {
            String id = android.provider.Settings.Secure.getString(
                getContext().getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID
            );
            if (id != null && id.length() >= 4) {
                return id.substring(0, 4).toUpperCase();
            }
        } catch (Exception e) { }
        return "XXXX";
    }

    // ── HTTP Server ────────────────────────────────────────────────────────

    private class SyncServer extends NanoHTTPD {

        SyncServer(int port) {
            super(port);
        }

        @Override
        public Response serve(IHTTPSession session) {
            lastRequestTime = System.currentTimeMillis();

            // CORS 预检
            if (session.getMethod() == Method.OPTIONS) {
                Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
                addCorsHeaders(r);
                return r;
            }

            String uri = session.getUri();
            HashMap<String, String> params = new HashMap<>(session.getParameters());

            // 配对码校验
            String code = params.get("code");
            if (code == null || !code.equals(pairCode)) {
                Response r = newFixedLengthResponse(Response.Status.FORBIDDEN, "application/json",
                    "{\"error\":\"invalid_code\"}");
                addCorsHeaders(r);
                return r;
            }

            // 私有 IP 过滤
            if (!isPrivateIp(session.getRemoteHostName())) {
                Response r = newFixedLengthResponse(Response.Status.FORBIDDEN, "application/json",
                    "{\"error\":\"forbidden_network\"}");
                addCorsHeaders(r);
                return r;
            }

            try {
                if (uri.equals("/info")) {
                    return handleInfo();
                } else if (uri.equals("/download")) {
                    return handleDownload(params.get("mode"), params.get("books"));
                } else if (uri.equals("/upload")) {
                    return handleUpload(session);
                } else {
                    Response r = newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json",
                        "{\"error\":\"not_found\"}");
                    addCorsHeaders(r);
                    return r;
                }
            } catch (Exception e) {
                Response r = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                    "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}");
                addCorsHeaders(r);
                return r;
            }
        }

        // ── 端点处理 ─────────────────────────────────────────────────

        private Response handleInfo() throws Exception {
            String requestId = UUID.randomUUID().toString();
            String result = callJsAndWait("info", requestId,
                "window.BK.LanSync._handleInfo('" + requestId + "')");

            Response r = newFixedLengthResponse(Response.Status.OK, "application/json", result);
            addCorsHeaders(r);
            return r;
        }

        private Response handleDownload(String mode, String books) throws Exception {
            String requestId = UUID.randomUUID().toString();
            String js = String.format(
                "window.BK.LanSync._handleDownload('%s','%s','%s')",
                mode != null ? mode : "data",
                books != null ? books : "",
                requestId
            );
            String base64 = callJsAndWait("download", requestId, js);

            byte[] zipBytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP);
            InputStream is = new ByteArrayInputStream(zipBytes);
            Response r = newFixedLengthResponse(Response.Status.OK, "application/zip", is, zipBytes.length);
            addCorsHeaders(r);
            return r;
        }

        private Response handleUpload(IHTTPSession session) throws Exception {
            // 读取请求体
            int contentLength = Integer.parseInt(
                session.getHeaders().getOrDefault("content-length", "0"));
            if (contentLength > MAX_BODY_SIZE) {
                Response r = newFixedLengthResponse(Response.Status.PAYLOAD_TOO_LARGE, "application/json",
                    "{\"error\":\"body_too_large\"}");
                addCorsHeaders(r);
                return r;
            }

            // NanoHTTPD 将 body 存入 files map
            HashMap<String, String> files = new HashMap<>();
            session.parseBody(files);
            String tmpFilePath = files.get("files");

            // 读取临时文件为 byte[]
            java.nio.file.Path tmpPath = java.nio.file.Paths.get(tmpFilePath);
            byte[] zipBytes = java.nio.file.Files.readAllBytes(tmpPath);

            // 转 base64 传给 JS
            String base64 = android.util.Base64.encodeToString(zipBytes, android.util.Base64.NO_WRAP);
            String requestId = UUID.randomUUID().toString();
            String js = String.format(
                "window.BK.LanSync._handleUpload('%s','%s')",
                base64, requestId
            );
            String resultJson = callJsAndWait("upload", requestId, js);

            Response r = newFixedLengthResponse(Response.Status.OK, "application/json", resultJson);
            addCorsHeaders(r);
            return r;
        }

        // ── JS 桥梁 ─────────────────────────────────────────────────

        private String callJsAndWait(String tag, String requestId, String js) throws Exception {
            CountDownLatch latch = new CountDownLatch(1);
            pendingLatches.put(requestId, latch);

            bridge.evaluateJs(js, null);

            if (!latch.await(JS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                pendingLatches.remove(requestId);
                pendingResults.remove(requestId);
                throw new Exception("JS timeout: " + tag);
            }

            pendingLatches.remove(requestId);
            return pendingResults.remove(requestId);
        }

        // ── CORS ─────────────────────────────────────────────────────

        private void addCorsHeaders(Response r) {
            r.setChunkedTransfer(false);
            r.addHeader("Access-Control-Allow-Origin", "*");
            r.addHeader("Access-Control-Allow-Private-Network", "true");
            r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            r.addHeader("Access-Control-Allow-Headers", "Content-Type");
        }
    }

    // ── 工具方法 ──────────────────────────────────────────────────────────

    private static String generatePairCode() {
        java.util.Random rnd = new java.security.SecureRandom();
        int code = 100000 + rnd.nextInt(900000);
        return String.valueOf(code);
    }

    private static String getLocalIpAddress() {
        try {
            return InetAddress.getLocalHost().getHostAddress();
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static boolean isPrivateIp(String host) {
        if (host == null) return false;
        try {
            InetAddress addr = InetAddress.getByName(host);
            return addr.isSiteLocalAddress() || addr.isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}
