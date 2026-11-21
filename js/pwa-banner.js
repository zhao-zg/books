/* PWA 安装横幅 — Soft Nordic（Ardot 设计稿 22:4）
   beforeinstallprompt 触发时在底部展示可关闭的安装提示条。
   与 theme-toggle.js 设置页"安装"按钮共享同一个 beforeinstallprompt 事件：
   任一方调用 prompt() 后置空 window._pwaInstallPrompt，另一方安全 no-op。 */
(function () {
  'use strict';
  var DISMISS_KEY = 'bk_pwa_banner_dismissed';
  var banner = null, promptEvt = null;

  function dismissed() { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; } }
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  function build() {
    banner = document.createElement('div');
    banner.id = 'bkPwaBanner';
    banner.className = 'bk-pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', '安装书报到主屏幕');
    banner.style.display = 'none';
    banner.innerHTML =
      '<div class="bk-pwa-banner-icon" aria-hidden="true">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>' +
      '</div>' +
      '<div class="bk-pwa-banner-text">' +
        '<div class="bk-pwa-banner-title">安装书报到主屏幕</div>' +
        '<div class="bk-pwa-banner-sub">随时离线阅读，体验更佳</div>' +
      '</div>' +
      '<button class="bk-pwa-banner-install" type="button">安装</button>' +
      '<button class="bk-pwa-banner-close" type="button" aria-label="关闭">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
      '</button>';
    document.body.appendChild(banner);
    banner.querySelector('.bk-pwa-banner-install').addEventListener('click', doInstall);
    banner.querySelector('.bk-pwa-banner-close').addEventListener('click', dismiss);
  }

  function setBodyVisible(on) {
    if (on) document.body.classList.add('bk-pwa-banner-visible');
    else document.body.classList.remove('bk-pwa-banner-visible');
  }
  function show() { if (banner) { banner.style.display = 'flex'; setBodyVisible(true); } }
  function hide() { if (banner) { banner.style.display = 'none'; setBodyVisible(false); } }

  function dismiss() { try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {} hide(); }

  function doInstall() {
    var p = promptEvt || window._pwaInstallPrompt;
    if (!p) { hide(); return; }
    promptEvt = null; window._pwaInstallPrompt = null;
    try { p.prompt(); } catch (e) { hide(); return; }
    var choice = (p.userChoice) ? p.userChoice : Promise.resolve();
    choice.then(function () { hide(); })['catch'](function () { hide(); });
  }

  function onBeforeInstallPrompt(e) {
    e.preventDefault();
    promptEvt = e;
    if (dismissed()) return;
    show();
  }
  function onAppInstalled() { promptEvt = null; window._pwaInstallPrompt = null; hide(); }

  ready(function () {
    build();
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
  });
})();
