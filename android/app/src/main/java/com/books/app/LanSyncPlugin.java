package com.books.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
import android.net.wifi.WifiManager;
import android.util.Log;

/**
 * LanSyncPlugin — 局域网同步 Capacitor 插件
 *
 * 启动嵌入式 HTTP Server（NanoHTTPD），提供 /info、/download、/upload 端点。
 * 通过 evaluateJs 调用 JS 侧的 exportData/importFromZip，用 CountDownLatch 同步等待。
 *
 * 安全：配对码校验 + 私有 IP 过滤 + 10 分钟无活动自动关闭。
 */
@CapacitorPlugin(name = "LanSync")
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

    // 组播锁：多数 Android 设备默认过滤组播包，NSD/mDNS 发现必须持有 MulticastLock 才能收到应答
    private WifiManager.MulticastLock multicastLock;

    // 串行 resolve 队列：NsdManager 同一时间只允许一个 resolveService 在跑，
    // 并发调用第二个会立即 FAIL（errorCode 3/4），必须排队逐个解析
    private final java.util.ArrayDeque<NsdServiceInfo> resolveQueue = new java.util.ArrayDeque<>();
    private NsdManager.ResolveListener activeResolveListener;
    private boolean resolving = false;

    // 注册成功后的实际服务名（NSD 冲突时系统可能改名），用于过滤自身发现
    private volatile String selfServiceName;

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

        // 先停止旧的发现（内部会释放组播锁）
        stopDiscoveryInternal();

        // 组播锁：声明了 CHANGE_WIFI_MULTICAST_STATE 权限但未持锁时，
        // mDNS 组播应答会被系统 WiFi 驱动丢弃，表现为“搜不到设备”。
        // 必须在 stopDiscoveryInternal() 之后获取，否则刚拿到的锁会被其释放。
        acquireMulticastLock();

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
                String name = serviceInfo.getServiceName();
                // 过滤自身：发现自己注册的服务无意义且会造成“连自己”死循环
                if (selfServiceName != null && selfServiceName.equals(name)) {
                    Log.d(TAG, "NSD skip self: " + name);
                    return;
                }
                Log.d(TAG, "NSD service found: " + name);
                // 入队串行 resolve：NsdManager 不允许并发 resolveService
                synchronized (resolveQueue) {
                    resolveQueue.add(serviceInfo);
                }
                processResolveQueue();
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "NSD service lost: " + serviceInfo.getServiceName());
                // 从前端设备列表移除下线设备
                String js = "window.BK.LanSyncPanel&&window.BK.LanSyncPanel.removeDevice&&window.BK.LanSyncPanel.removeDevice(null,'" + escapeJson(serviceInfo.getServiceName()) + "')";
                try {
                    bridge.eval(js, null);
                } catch (Exception e) {
                    Log.e(TAG, "evaluateJs failed: " + e.getMessage());
                }
            }
        };

        nsdManager.discoverServices(NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, nsdDiscoveryListener);
        call.resolve();
    }

    /**
     * 串行处理 resolve 队列：同一时间只发起一个 resolveService，
     * 完成（成功/失败）后取下一个，避免 NsdManager FAIL 错误
     */
    private void processResolveQueue() {
        NsdManager.ResolveListener listener;
        NsdServiceInfo info;
        synchronized (resolveQueue) {
            if (resolving || nsdManager == null) return;
            info = resolveQueue.poll();
            if (info == null) return;
            resolving = true;
        }
        final NsdServiceInfo target = info;
        listener = new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                Log.e(TAG, "NSD resolve failed: " + errorCode);
                synchronized (resolveQueue) { resolving = false; }
                processResolveQueue();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
                synchronized (resolveQueue) { resolving = false; }
                try {
                    deliverResolved(info);
                } finally {
                    processResolveQueue();
                }
            }
        };
        activeResolveListener = listener;
        try {
            nsdManager.resolveService(target, listener);
        } catch (Exception e) {
            Log.e(TAG, "resolveService error: " + e.getMessage());
            synchronized (resolveQueue) { resolving = false; }
            processResolveQueue();
        }
    }

    /** resolve 成功：提取 name/ip/port/code（TXT record）并回调 JS */
    private void deliverResolved(NsdServiceInfo info) {
        String name = info.getServiceName();
        int port = info.getPort();
        String host = info.getHost() != null ? info.getHost().getHostAddress() : "";

        // 从 TXT record 读取配对码（注册端 setAttribute("code", ...) 写入）
        String code = "";
        Map<String, byte[]> attrs = info.getAttributes();
        if (attrs != null && attrs.get("code") != null) {
            code = new String(attrs.get("code"), java.nio.charset.StandardCharsets.UTF_8);
        }

        String json = "{\"name\":\"" + escapeJson(name) + "\",\"ip\":\"" + escapeJson(host)
            + "\",\"port\":" + port + ",\"code\":\"" + escapeJson(code) + "\"}";
        String js = "window.BK.LanSync._onDeviceFound('" + json.replace("'", "\\'") + "')";
        try {
            bridge.eval(js, null);
        } catch (Exception e) {
            Log.e(TAG, "evaluateJs failed: " + e.getMessage());
        }
    }

    /** 获取组播锁（幂等）；NSD 发现期间必须持有，否则收不到 mDNS 应答 */
    private void acquireMulticastLock() {
        if (multicastLock != null && multicastLock.isHeld()) return;
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            multicastLock = wm.createMulticastLock("bk-lan-sync");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
            Log.d(TAG, "MulticastLock acquired");
        } catch (Exception e) {
            Log.e(TAG, "MulticastLock acquire error: " + e.getMessage());
        }
    }

    /** 释放组播锁（幂等） */
    private void releaseMulticastLock() {
        if (multicastLock != null && multicastLock.isHeld()) {
            try {
                multicastLock.release();
                Log.d(TAG, "MulticastLock released");
            } catch (Exception e) {
                Log.e(TAG, "MulticastLock release error: " + e.getMessage());
            }
        }
        multicastLock = null;
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
        synchronized (resolveQueue) {
            resolveQueue.clear();
            resolving = false;
        }
        activeResolveListener = null;
        releaseMulticastLock();
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
        selfServiceName = null;
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
            // 配对码放入 TXT record：发现方 resolve 后可直接拿到 code，
            // 否则设备列表按钮无配对码，服务端一律返回 403 invalid_code
            serviceInfo.setAttribute("code", pairCode);

            nsdRegistrationListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo info) {
                    // 记录实际注册名（NSD 冲突时系统可能追加后缀），供发现时过滤自身
                    selfServiceName = info.getServiceName();
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
                public void onServiceUnregistered(NsdServiceInfo info) {
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
            Map<String, List<String>> rawParams = session.getParameters();
            HashMap<String, String> params = new HashMap<>();
            for (Map.Entry<String, List<String>> entry : rawParams.entrySet()) {
                if (!entry.getValue().isEmpty()) {
                    params.put(entry.getKey(), entry.getValue().get(0));
                }
            }

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

            bridge.eval(js, null);

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
        // InetAddress.getLocalHost() 在 Android 上返回 127.0.0.1/localhost，
        // 必须遍历网卡接口取 WiFi/以太网的 site-local IPv4，否则二维码里是 127.0.0.1 根本不可连
        try {
            java.util.Enumeration<java.net.NetworkInterface> nis =
                java.net.NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                java.net.NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address
                        && addr.isSiteLocalAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "getLocalIpAddress error: " + e.getMessage());
        }
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
