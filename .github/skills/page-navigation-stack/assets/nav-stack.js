(function() {
  'use strict';

  function isCapacitor() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  }

  function isPWA() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function handleBackCommon(targetHandler) {
    if (window.__appHandlingBack || window.__appExiting) return;
    window.__appHandlingBack = true;
    try {
      targetHandler();
    } finally {
      setTimeout(function() { window.__appHandlingBack = false; }, 50);
    }
  }

  function setupBackHandler(handleBack) {
    if (!isCapacitor() && !isPWA()) return;

    if (isCapacitor()) {
      window.Capacitor.Plugins.App.addListener('backButton', function() {
        handleBackCommon(handleBack);
      });
    } else if (isPWA()) {
      window.addEventListener('popstate', function() {
        if (window.__appExiting) return;
        handleBackCommon(handleBack);
      });
    }
  }

  function initContentPage() {
    setupBackHandler(function() {
      window.location.replace('./index.html');
    });
  }

  function initDirectoryPage() {
    setupBackHandler(function() {
      window.location.replace('../index.html');
    });
  }

  function initHomePage() {
    setupBackHandler(function() {
      if (isCapacitor()) {
        window.Capacitor.Plugins.App.exitApp();
      } else {
        window.__appExiting = true;
        window.close();
        setTimeout(function() { window.history.back(); }, 150);
      }
    });
  }

  window.CXNavStack = {
    initContentPage: initContentPage,
    initDirectoryPage: initDirectoryPage,
    initHomePage: initHomePage
  };
})();
