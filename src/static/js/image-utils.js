/**
 * 图片工具模块
 * 1. BK.loadRemoteImage() - 多服务器降级图片加载
 * 2. BK.ImageViewer       - 图片查看器（自动注入 HTML + 手势 + 分享）
 *
 * 全局接口：
 *   openImageViewer(src)  - 打开查看器
 *   closeImageViewer()    - 关闭查看器
 */
(function () {
    'use strict';
    window.BK = window.BK || {};

    // ── 1. 多服务器降级图片加载 ──────────────────────────────────────────────
    // container : DOM 元素，加载结果插入此处
    // servers   : 服务器前缀数组，如 ['https://a.com/', 'https://b.com/']
    // file      : 相对路径，如 'images/qr.png'
    // alt       : img alt 属性
    // options   : { loadingText, errorText, className, cacheBust, onLoad, onError }
    BK.loadRemoteImage = function (container, servers, file, alt, options) {
        if (!container) return;
        var opts = options || {};
        var loadingText = opts.loadingText !== undefined ? opts.loadingText : '加载中…';
        var errorText   = opts.errorText   !== undefined ? opts.errorText   : '加载失败';
        var className   = opts.className   || '';
        var cacheBust   = opts.cacheBust   !== false; // 默认 true

        if (loadingText) {
            container.innerHTML = '<div class="bk-remote-img-loading">' + loadingText + '</div>';
        }

        var ts    = cacheBust ? Date.now() : '';
        var tried = 0;

        function tryNext() {
            if (tried >= servers.length) {
                container.innerHTML = '<div class="bk-remote-img-loading">' + errorText + '</div>';
                if (opts.onError) opts.onError();
                return;
            }
            var url = servers[tried++] + file + (cacheBust ? '?t=' + ts : '');
            var img = new Image();
            img.onload = function () {
                if (!container || container.isConnected === false) return;
                container.innerHTML = '';
                if (className) img.className = className;
                img.alt = alt || '';
                container.appendChild(img);
                if (opts.onLoad) opts.onLoad(img);
            };
            img.onerror = tryNext;
            if (className) img.className = className;
            img.src = url;
        }
        tryNext();
    };

    // ── 2. 图片查看器 ────────────────────────────────────────────────────────
    // 单图模式：居中显示，支持双指缩放、双击还原
    // 多图模式：全屏竖向滚动容器，所有图片上下排列，自然滚动查看
    BK.ImageViewer = (function () {
        var _ready = false;
        var overlay, singleContent, singleImg, scrollEl;
        var _scale = 1, _tx = 0, _ty = 0;
        var _pinchStartDist = 0, _pinchStartScale = 1;
        var _panStartX = 0, _panStartY = 0, _panStartTx = 0, _panStartTy = 0;
        var _gestured = false;
        var _lastTap = 0;
        var _inBackStack = false; // 是否已注册到 backStack

        function applyTransform() {
            singleImg.style.transform = 'translate(' + _tx + 'px,' + _ty + 'px) scale(' + _scale + ')';
        }

        function resetTransform() {
            _scale = 1; _tx = 0; _ty = 0;
            singleImg.style.transition = 'transform .25s ease';
            applyTransform();
            setTimeout(function () { singleImg.style.transition = ''; }, 260);
        }

        function dist(t) {
            var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function isPortrait() { return overlay.classList.contains('portrait'); }

        var _ivLockCleanup = null; // lockOverlayScroll 返回的 cleanup 函数

        function close() {
            // 幂等检查：已关闭则直接返回，防止重复调用
            if (!overlay || !overlay.classList.contains('show')) return;

            overlay.classList.remove('show', 'portrait', 'multi');
            if (_ivLockCleanup) { _ivLockCleanup(); _ivLockCleanup = null; }
            resetTransform();
            scrollEl.innerHTML = '';

            // 消耗 backStack 条目（主动关闭时调用；系统返回键触发时已自动消耗）
            if (_inBackStack) {
                _inBackStack = false;
                if (window.BK && window.BK.backStack) {
                    window.BK.backStack.pop();
                }
            }
        }

        async function shareImage() {
            var src = '';
            // 多图模式：获取当前视口中心区域的图片
            if (overlay.classList.contains('multi')) {
                var imgs = scrollEl.querySelectorAll('img');
                var viewportCenter = window.innerHeight / 2;
                var bestImg = null;
                var minDistance = Infinity;

                for (var i = 0; i < imgs.length; i++) {
                    var rect = imgs[i].getBoundingClientRect();
                    var imgCenter = rect.top + rect.height / 2;
                    var distance = Math.abs(imgCenter - viewportCenter);
                    
                    // 找到距离视口中心最近的图片
                    if (distance < minDistance) {
                        minDistance = distance;
                        bestImg = imgs[i];
                    }
                }
                
                if (bestImg) {
                    src = bestImg.src;
                } else if (imgs.length > 0) {
                    src = imgs[0].src;
                }
            } else {
                src = singleImg.src;
            }
            if (!src) return;
            try {
                var resp = await fetch(src);
                var blob = await resp.blob();
                var ext = blob.type === 'image/png' ? 'png' : 'jpg';
                var parts = src.split('/');
                var filename = (parts[parts.length - 1].split('?')[0]) || ('image.' + ext);

                // Capacitor App：调用原生 ImageSaver 插件
                if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ImageSaver) {
                    var base64 = await new Promise(function (resolve, reject) {
                        var reader = new FileReader();
                        reader.onload = function () { resolve(reader.result); };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    await window.Capacitor.Plugins.ImageSaver.shareImage({
                        base64Data: base64,
                        filename: filename,
                        mimeType: blob.type,
                        title: '分享图片'
                    });
                    return;
                }

                // 浏览器：Web Share API（优先）
                var file = new File([blob], filename, { type: blob.type });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: filename });
                    return;
                }

                // fallback：触发下载
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            } catch (e) {
                if (e.name !== 'AbortError') console.error('分享失败:', e);
            }
        }

        function init() {
            if (_ready) return;
            _ready = true;

            var wrap = document.createElement('div');
            wrap.innerHTML = [
                '<div id="bkImageViewer" class="bk-image-viewer-overlay">',
                '  <button class="bk-image-viewer-share-btn" id="bkViewerShare" title="分享/保存">🔗</button>',
                '  <div class="bk-image-viewer-content" id="bkViewerContent">',
                '    <img id="bkViewerImage" src="" alt="查看图片">',
                '  </div>',
                '  <div class="bk-image-viewer-scroll" id="bkViewerScroll"></div>',
                '  <span class="bk-image-viewer-hint" id="bkViewerHint"></span>',
                '</div>'
            ].join('');
            while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

            overlay       = document.getElementById('bkImageViewer');
            singleContent = document.getElementById('bkViewerContent');
            singleImg     = document.getElementById('bkViewerImage');
            scrollEl      = document.getElementById('bkViewerScroll');

            // ── 单图模式：双击还原，单击关闭 ───────────────────────
            singleImg.addEventListener('touchend', function (e) {
                if (e.changedTouches.length !== 1 || e.touches.length > 0) return;
                if (_gestured) return;
                var now = Date.now();
                if (now - _lastTap < 300) {
                    // 双击：还原缩放
                    resetTransform();
                    _lastTap = 0;
                } else {
                    _lastTap = now;
                    setTimeout(function () {
                        if (_lastTap === now) { close(); }
                    }, 310);
                }
            });
            singleImg.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!_gestured) close();
            });

            // ── 单图模式：双指缩放、单指平移 ────────────────────────────
            singleImg.addEventListener('touchstart', function (e) {
                _gestured = false;
                if (e.touches.length === 2) {
                    e.preventDefault();
                    _pinchStartDist  = dist(e.touches);
                    _pinchStartScale = _scale;
                } else if (e.touches.length === 1) {
                    if (!isPortrait() || _scale > 1) e.preventDefault();
                    _panStartX = e.touches[0].clientX;
                    _panStartY = e.touches[0].clientY;
                    _panStartTx = _tx;
                    _panStartTy = _ty;
                }
            }, { passive: false });

            singleImg.addEventListener('touchmove', function (e) {
                _gestured = true;
                if (e.touches.length === 2) {
                    e.preventDefault();
                    var d = dist(e.touches);
                    _scale = Math.min(8, Math.max(1, _pinchStartScale * d / _pinchStartDist));
                    applyTransform();
                } else if (e.touches.length === 1) {
                    if (isPortrait() && _scale <= 1) return;
                    e.preventDefault();
                    _tx = _panStartTx + (e.touches[0].clientX - _panStartX);
                    _ty = _panStartTy + (e.touches[0].clientY - _panStartY);
                    applyTransform();
                }
            }, { passive: false });

            singleImg.addEventListener('touchend', function () {
                if (_scale <= 1) { _tx = 0; _ty = 0; applyTransform(); }
            });

            // ── 多图模式：双击返回顶部 ────────────────────────────
            var _lastScrollTap = 0;

            scrollEl.addEventListener('touchend', function (e) {
                if (e.changedTouches.length !== 1 || e.touches.length > 0) return;
                var now = Date.now();
                if (now - _lastScrollTap < 300) {
                    scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
                    _lastScrollTap = 0;
                } else {
                    _lastScrollTap = now;
                }
            });

            // ── 背景点击关闭（单图模式）──────────────────────────────────
            overlay.addEventListener('touchend', function (e) {
                if (!_gestured && e.target === overlay) close();
            });
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) close();
            });

            var shareBtn = document.getElementById('bkViewerShare');
            if (shareBtn) {
                shareBtn.addEventListener('click', shareImage);
                shareBtn.addEventListener('touchend', function (e) { e.preventDefault(); shareImage(); });
            }

            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && overlay.classList.contains('show')) close();
            });

            // ── lockOverlayScroll：防滚动穿透 + 点击空白区关闭 ────────
            if (window.BK && window.BK.lockOverlayScroll) {
                _ivLockCleanup = window.BK.lockOverlayScroll(overlay, function () { close(); });
            }
        }

        // open(src)              — 单图，向后兼容
        // open(src, images, idx) — 多图，images 为 URL 数组，idx 为起始索引（滚动定位）
        function open(src, images, idx) {
            init();
            var hint = document.getElementById('bkViewerHint');
            overlay.classList.remove('portrait', 'multi');
            overlay.classList.add('show');

            // 注册到 backStack，支持系统返回键关闭
            if (window.BK && window.BK.backStack) {
                _inBackStack = true;
                window.BK.backStack.push(function () {
                    _inBackStack = false;
                    close();
                });
            }

            if (Array.isArray(images) && images.length > 1) {
                // ── 多图模式：全屏竖向滚动 ──────────────────────────────
                overlay.classList.add('multi');
                singleContent.style.display = 'none';
                var shareBtn = document.getElementById('bkViewerShare');
                if (shareBtn) shareBtn.style.display = '';
                if (hint) hint.textContent = '上下滑动查看 · 单击关闭 · 双击返回顶部';

                scrollEl.innerHTML = '';
                for (var i = 0; i < images.length; i++) {
                    var imgEl = document.createElement('img');
                    imgEl.src = images[i];
                    imgEl.alt = '图片 ' + (i + 1);
                    // 直接绑定触摸和点击事件
                    (function (img) {
                        var _startY = 0, _startX = 0;
                        img.addEventListener('touchstart', function (e) {
                            if (e.touches.length === 1) {
                                _startX = e.touches[0].clientX;
                                _startY = e.touches[0].clientY;
                                img._tapMoved = false;
                            }
                        }, { passive: true });
                        // passive:false — 在滚动边界时调用 preventDefault，
                        // 阻止 lockOverlayScroll 拦截 touchmove（它会阻止 click 合成）
                        img.addEventListener('touchmove', function (e) {
                            if (e.touches.length === 1 && !img._tapMoved) {
                                var dx = Math.abs(e.touches[0].clientX - _startX);
                                var dy = Math.abs(e.touches[0].clientY - _startY);
                                if (dx > 8 || dy > 8) {
                                    img._tapMoved = true;
                                } else {
                                    // 检查是否在滚动边界
                                    var dir = e.touches[0].clientY < _startY ? 'up' : 'down';
                                    var atTop = scrollEl.scrollTop <= 0;
                                    var atBot = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1;
                                    if ((atTop && dir === 'up') || (atBot && dir === 'down')) {
                                        e.preventDefault(); // 阻止 lockOverlayScroll 在边界拦截
                                    }
                                }
                            }
                        }, { passive: false });
                        img.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (!img._tapMoved) close();
                        });
                    })(imgEl);
                    scrollEl.appendChild(imgEl);
                }

                // 滚动到被点击的图片
                var startIdx = (typeof idx === 'number' && idx > 0) ? idx : 0;
                if (startIdx > 0) {
                    setTimeout(function () {
                        var imgs = scrollEl.querySelectorAll('img');
                        if (imgs[startIdx]) imgs[startIdx].scrollIntoView({ behavior: 'instant' });
                    }, 30);
                }
            } else {
                // ── 单图模式 ─────────────────────────────────────────────
                singleContent.style.display = '';
                var shareBtn = document.getElementById('bkViewerShare');
                if (shareBtn) shareBtn.style.display = '';
                if (hint) hint.textContent = '双指缩放 · 双击还原 · 点击关闭';
                scrollEl.innerHTML = '';

                _scale = 1; _tx = 0; _ty = 0;
                singleImg.style.transition = '';
                applyTransform();
                singleImg.src = src;
                overlay.classList.remove('portrait');
                function fitWidth() {
                    var vw = overlay.clientWidth, vh = overlay.clientHeight;
                    var nw = singleImg.naturalWidth, nh = singleImg.naturalHeight;
                    if (!nw || !nh) return;
                    if (Math.min(vw, vh * nw / nh) < vw - 1) overlay.classList.add('portrait');
                }
                if (singleImg.complete && singleImg.naturalWidth) { fitWidth(); }
                else { singleImg.onload = fitWidth; }
            }
        }

        return { open: open, close: close };
    })();

    // 全局接口（兼容模板中的 onclick="openImageViewer(src)"）
    window.openImageViewer  = function (src, images, idx) { BK.ImageViewer.open(src, images, idx); };
    window.closeImageViewer = function ()                  { BK.ImageViewer.close(); };

})();
