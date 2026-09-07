// ── Pages Function: 服务端伪装拦截 ──
// 未验证访客：返回自包含伪装页（零外部资源引用），不触发任何 JS/CSS 请求
// 验证方式：URL 含 ?zzg 参数、或 Cookie bk_access=ok
// 放行例外（APK 内检查更新需要跨域）：version.json、changelog.json、*.apk

const COOKIE_NAME = 'bk_access';
const COOKIE_VALUE = 'ok';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 年（秒）

// 判断是否已验证
function isVerified(request, url) {
  // 1. Cookie
  const cookie = request.headers.get('Cookie') || '';
  if (cookie.includes(COOKIE_NAME + '=' + COOKIE_VALUE)) return true;
  // 2. URL 参数 ?zzg
  if (url.searchParams.has('zzg')) return true;
  return false;
}

// 判断是否为放行例外（APK 更新检查需要跨域访问的资源）
function isExempt(path) {
  if (path === '/version.json') return true;
  if (path === '/changelog.json') return true;
  if (path.endsWith('.apk')) return true;
  return false;
}

// 自包含伪装页 HTML（零外部引用，内联 CSS + JS）
const DISGUISE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<meta name="theme-color" content="#F5F4F1">
<title>书报</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:#F5F4F1;color:#333;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:40px 24px}
.icon{font-size:4em;margin-bottom:24px;cursor:default;user-select:none;-webkit-tap-highlight-color:transparent}
.title{font-size:1.25em;font-weight:600;color:#333;margin-bottom:12px}
.sub{font-size:0.875em;color:#999;text-align:center;line-height:1.7;max-width:280px}
</style>
</head>
<body>
<div class="icon" id="trigger">📦</div>
<div class="title" id="maintTitle">请下载 APK 离线使用</div>
<div class="sub" id="maintSub">请下载APK离线使用，在线版已不支持，请谅解</div>
<script>
(function(){
  // iOS 文案适配
  var isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
  var icon=document.getElementById('trigger');
  var title=document.getElementById('maintTitle');
  var sub=document.getElementById('maintSub');
  if(isIOS){if(icon)icon.textContent='📲';if(title)title.textContent='添加到主屏幕';if(sub)sub.textContent='请发送到桌面缓存使用，在线版已不支持，请谅解';}
  else{if(icon)icon.textContent='📦';if(title)title.textContent='请下载 APK 离线使用';if(sub)sub.textContent='请下载APK离线使用，在线版已不支持，请谅解';}
  // 点击图标 20 次写 Cookie 放行
  var cnt=0,t=0;
  if(icon)icon.addEventListener('click',function(){
    clearTimeout(t);cnt++;
    if(cnt>=20){
      document.cookie='bk_access=ok;path=/;max-age=31536000;samesite=lax';
      location.reload();
    }else{t=setTimeout(function(){cnt=0;},999);}
  });
  // URL 带 ?zzg 参数时，页面已由服务端放行（Cookie 由服务端 Set-Cookie 写入）
})();
</script>
</body>
</html>`;

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 已验证访客：全部放行，并刷新 Cookie（延长有效期）
  if (isVerified(request, url)) {
    const response = await next();
    // 若来自 URL 参数验证（无 Cookie），写 Cookie 持久化
    const cookie = request.headers.get('Cookie') || '';
    if (!cookie.includes(COOKIE_NAME + '=' + COOKIE_VALUE)) {
      const newHeaders = new Headers(response.headers);
      newHeaders.append(
        'Set-Cookie',
        `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }
    return response;
  }

  // 未验证访客：放行例外资源（APK 更新检查需要跨域）
  if (isExempt(path)) {
    return next();
  }

  // 其余所有请求（含 / 和 JS/CSS/JSON 等）：直接返回自包含伪装页
  // 零外部引用 → 浏览器不会发起任何额外请求
  return new Response(DISGUISE_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
