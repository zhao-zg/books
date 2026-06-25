(function () {
  'use strict';

  var deferredInstallPrompt = null;

  function byId(id) { return document.getElementById(id); }

  function isAndroidBrowser() {
    return /Android/i.test(navigator.userAgent || '');
  }

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isCapacitorApp() {
    return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function show(el, visible) {
    if (!el) return;
    el.hidden = !visible;
  }

  async function swQuery(type) {
    if (!('serviceWorker' in navigator)) return null;
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active) return null;

    return new Promise(function (resolve) {
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { resolve(event.data || null); };
      reg.active.postMessage({ type: type }, [channel.port2]);
    });
  }

  async function refreshCacheInfo() {
    var status = byId('cacheStatus');
    if (!status) return;
    var info = await swQuery('CACHE_INFO');
    if (!info || !info.ok) {
      status.textContent = '缓存信息不可用';
      return;
    }
    status.textContent = '缓存条目: ' + info.entryCount;
  }

  async function clearCache() {
    var result = await swQuery('CLEAR_CACHE');
    if (result && result.ok) {
      await refreshCacheInfo();
      alert('缓存已清理');
      return;
    }
    alert('清理失败');
  }

  async function renderEnvButtons() {
    var btnDownloadApk = byId('btnDownloadApk');
    var btnInstallPwa = byId('btnInstallPwa');
    var btnCacheInfo = byId('btnCacheInfo');
    var btnClearCache = byId('btnClearCache');

    var capacitor = isCapacitorApp();
    var standalone = isStandalonePwa();
    var androidBrowser = isAndroidBrowser();
    var hasSw = 'serviceWorker' in navigator;

    show(btnDownloadApk, !capacitor && androidBrowser && !standalone);
    show(btnInstallPwa, !capacitor && !standalone && Boolean(deferredInstallPrompt));
    show(btnCacheInfo, hasSw);
    show(btnClearCache, hasSw);

    if (btnDownloadApk) {
      btnDownloadApk.onclick = function () {
        window.location.href = './latest.apk';
      };
    }

    if (btnInstallPwa) {
      btnInstallPwa.onclick = async function () {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        renderEnvButtons();
      };
    }

    if (btnCacheInfo) btnCacheInfo.onclick = refreshCacheInfo;
    if (btnClearCache) btnClearCache.onclick = clearCache;
  }

  function initNavigationByPageType() {
    if (!window.CXNavStack) return;
    var type = window.CXPageType || 'content';
    if (type === 'home') window.CXNavStack.initHomePage();
    else if (type === 'directory') window.CXNavStack.initDirectoryPage();
    else window.CXNavStack.initContentPage();
  }

  function initSpeechIfAvailable() {
    if (!window.CXSpeech || !window.CXSpeech.init) return;
    var textProvider = window.CXSpeechTextProvider;
    if (typeof textProvider !== 'function') return;

    window.CXSpeech.init({
      getText: textProvider,
      lang: 'zh-CN'
    });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderEnvButtons();
  });

  window.addEventListener('load', async function () {
    initNavigationByPageType();
    initSpeechIfAvailable();
    await renderEnvButtons();
    await refreshCacheInfo();
  });
})();
