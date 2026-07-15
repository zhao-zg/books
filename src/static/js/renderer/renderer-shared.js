/*!
 * renderer.js - renderer-shared.js - Shared header + dev mode detection
 *
 * Part of the BKRenderer module suite (split from renderer.js).
 * Provides: var win = window; + local dev mode flag.
 */

'use strict';
var win = window;

// -- Local dev mode detection --
(function () {
  var h = win.location.hostname, p = win.location.protocol;
  win.__BK_LOCAL_DEV__ = (h === 'localhost' || h === '127.0.0.1' || h === '' ||
    p === 'file:' || /^192\.168\.\d+\.\d+$/.test(h) ||
    /^10\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]');
})();
