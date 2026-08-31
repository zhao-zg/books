package com.books.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
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

    // NSD 注册监听器
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener nsdRegistrationListener;
    // NSD 发现监听器（H3：APK↔APK 自动发现）
    private NsdManager.DiscoveryListener nsdDiscoveryListener;
    private static final String NSD_SERVICE_TYPE = "_bk-sync._tcp.";

    // 自动关闭：定时器
    private ScheduledExecutorService idleExecutor;

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

            // 启动自动关闭定时器：每分钟检查一次，10 分钟无活动自动 stopServer
            startIdleTimer();

            // 服务启动后自动注册 NSD（APK↔APK 自动发现）
            registerNsdInternal();

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
        stopServerInternal();
        call.resolve();
    }

    private void stopServerInternal() {
        stopIdleTimer();
        unregisterNsdInternal();
        stopDiscoveryInternal();
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    // ── 自动关闭定时器 ────────────────────────────────────────────────

    private void startIdleTimer() {
        stopIdleTimer();
        idleExecutor = Executors.newSingleThreadScheduledExecutor();
        idleExecutor.scheduleAtFixedRate(new Runnable() {
            @Override
            public void run() {
                if (server == null) return;
                long idleSeconds = (System.currentTimeMillis() - lastRequestTime) / 1000;
                if (idleSeconds >= MAX_IDLE_MINUTES * 60L) {
                    Log.d(TAG, "Auto-stop: idle " + idleSeconds + "s >= " + (MAX_IDLE_MINUTES * 60) + "s");
                    stopServerInternal();
                }
            }
        }, 60, 60, TimeUnit.SECONDS); // 每分钟检查
    }

    private void stopIdleTimer() {
        if (idleExecutor != null) {
            idleExecutor.shutdownNow();
            idleExecutor = null;
        }
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
        registerNsdInternal();
        call.resolve();
    }

    @PluginMethod
    public void unregisterNsd(PluginCall call) {
        unregisterNsdInternal();
        call.resolve();
    }

    // ── NSD 发现（H3：APK↔APK 自动发现）───────────────────────────────

    @PluginMethod
    public void discover(PluginCall call) {
        if (nsdManager == null) {
            nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        }
        if (nsdManager == null) {
            call.reject("NSD service unavailable");
            return;
        }

        // 先停止旧的发现
        stopDiscoveryInternal();

        nsdDiscoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.e(TAG, "NSD discovery start failed: " + errorCode);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                Log.e(TAG, "NSD discovery stop failed: " + errorCode);
            }

            @Override
            public void onDiscoveryStarted(String serviceType) {
                Log.d(TAG, "NSD discovery started: " + serviceType);
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
                Log.d(TAG, "NSD discovery stopped: " + serviceType);
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "NSD service found: " + serviceInfo.getServiceName());
                // 解析服务获取 IP+端口
                nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                    @Override
                    public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                        Log.e(TAG, "NSD resolve failed: " + errorCode);
                    }

                    @Override
                    public void onServiceResolved(NsdServiceInfo info) {
                        String name = info.getServiceName();
                        int port = info.getPort();
                        String host = info.getHost() != null ? info.getHost().getHostAddress() : "";

                        // 通过 evaluateJs 回调 JS 侧的 _onDeviceFound
                        String json = "{\"name\":\"" + escapeJson(name) + "\",\"ip\":\"" + escapeJson(host) + "\",\"port\":" + port + "}";
                        String js = "window.BK.LanSync._onDeviceFound('" + json.replace("'", "\\'") + "')";
                        try {
                            bridge.evaluateJs(js, null);
                        } catch (Exception e) {
                            Log.e(TAG, "evaluateJs failed: " + e.getMessage());
                        }
                    }
                });
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "NSD service lost: " + serviceInfo.getServiceName());
            }
        };

        nsdManager.discoverServices(NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, nsdDiscoveryListener);
        call.resolve();
    }

    @PluginMethod
    public void stopDiscover(PluginCall call) {
        stopDiscoveryInternal();
        call.resolve();
    }

    private void stopDiscoveryInternal() {
        if (nsdManager != null && nsdDiscoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(nsdDiscoveryListener);
            } catch (Exception e) {
                Log.e(TAG, "NSD stop discovery error: " + e.getMessage());
            }
            nsdDiscoveryListener = null;
        }
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

    private void registerNsdInternal() {
        if (server == null) return;
        try {
            if (nsdManager == null) {
                nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
            }
            if (nsdManager == null) return;

            // 先注销旧注册
            unregisterNsdInternal();

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
        } catch (Exception e) {
            Log.e(TAG, "NSD register internal error: " + e.getMessage());
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

            // 私有 IP 过滤（改用 session.getRemoteIpAddress 更可靠）
            String remoteIp = session.getRemoteIpAddress();
            if (!isPrivateIp(remoteIp)) {
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
            // 对 mode 和 books 做 JS 安全转义（防注入）
            String safeMode = mode != null ? mode.replaceAll("['\\\\]", "") : "data";
            String safeBooks = books != null ? books.replaceAll("['\\\\]", "") : "";
            String js = String.format(
                "window.BK.LanSync._handleDownload('%s','%s','%s')",
                safeMode, safeBooks, requestId
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

            // H1 修复：multipart/form-data 上传，NanoHTTPD parseBody 将文件存入临时路径
            // 客户端用 FormData + Blob 上传，NanoHTTPD 将文件部分存为临时文件，key 为文件字段名
            HashMap<String, String> files = new HashMap<>();
            session.parseBody(files);

            // NanoHTTPD 将 multipart 文件存为临时文件，key 为表单字段名（客户端用 'file'）
            String tmpFilePath = files.get("file");
            if (tmpFilePath == null) {
                // 兼容：某些 NanoHTTPD 版本用 "files" 作为 key
                tmpFilePath = files.get("postData");
            }
            if (tmpFilePath == null) {
                Response r = newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
                    "{\"error\":\"no_file_uploaded\"}");
                addCorsHeaders(r);
                return r;
            }

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
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
