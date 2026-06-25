/**
 * 开发者调试控制台
 * 脚本加载时立刻开始无条件缓冲所有 console 输出（最多 500 条）。
 * 通过 window.BKDevConsole.init() 创建可视面板（展示历史缓冲）。
 * 通过 window.BKDevConsole.destroy() 仅移除面板，缓冲继续运行。
 */
(function() {
    'use strict';

    var _origConsole = {
        log:   console.log.bind(console),
        warn:  console.warn.bind(console),
        error: console.error.bind(console),
        info:  console.info.bind(console),
        debug: console.debug.bind(console)
    };
    var _devLogBuf = [];

    function _hook(level) {
        return function() {
            _origConsole[level].apply(console, arguments);
            var msg = Array.prototype.slice.call(arguments).map(function(a) {
                if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(ex) { return String(a); }
            }).join(' ');
            var entry = { t: Date.now(), level: level, text: msg };
            _devLogBuf.push(entry);
            if (_devLogBuf.length > 500) _devLogBuf.shift();
            var body = document.getElementById('bk-dev-console-body');
            if (body) {
                body.appendChild(_buildLogRow(entry));
                while (body.childNodes.length > 500) body.removeChild(body.firstChild);
                var el = document.getElementById('bk-dev-console');
                if (el && el.classList.contains('expanded')) body.scrollTop = body.scrollHeight;
            }
        };
    }
    console.log   = _hook('log');
    console.warn  = _hook('warn');
    console.error = _hook('error');
    console.info  = _hook('info');
    console.debug = _hook('debug');

    window.addEventListener('error', function(e) {
        var src = e.filename ? (e.filename.replace(/^.*\//, '') + ':' + e.lineno + ':' + e.colno + ' ') : '';
        var msg = src + (e.message || String(e));
        if (e.error && e.error.stack) msg += '\n' + e.error.stack;
        _origConsole.error('[uncaught]', msg);
        var entry = { t: Date.now(), level: 'error', text: '[uncaught] ' + msg };
        _devLogBuf.push(entry);
        if (_devLogBuf.length > 500) _devLogBuf.shift();
        var body = document.getElementById('bk-dev-console-body');
        if (body) {
            body.appendChild(_buildLogRow(entry));
            while (body.childNodes.length > 500) body.removeChild(body.firstChild);
            var el = document.getElementById('bk-dev-console');
            if (el && el.classList.contains('expanded')) body.scrollTop = body.scrollHeight;
        }
    });

    window.addEventListener('unhandledrejection', function(e) {
        var reason = e.reason;
        var msg = reason instanceof Error
            ? reason.message + (reason.stack ? '\n' + reason.stack : '')
            : String(reason);
        _origConsole.error('[unhandledrejection]', msg);
        var entry = { t: Date.now(), level: 'error', text: '[unhandledrejection] ' + msg };
        _devLogBuf.push(entry);
        if (_devLogBuf.length > 500) _devLogBuf.shift();
        var body = document.getElementById('bk-dev-console-body');
        if (body) {
            body.appendChild(_buildLogRow(entry));
            while (body.childNodes.length > 500) body.removeChild(body.firstChild);
            var el = document.getElementById('bk-dev-console');
            if (el && el.classList.contains('expanded')) body.scrollTop = body.scrollHeight;
        }
    });

    function _buildLogRow(entry) {
        var d  = new Date(entry.t);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        var row = document.createElement('div');
        row.className = 'bk-dev-log' + (entry.level === 'log' ? '' : ' ' + entry.level);
        row.textContent = hh + ':' + mm + ':' + ss + ' ' + entry.text;
        return row;
    }

    function init() {
        if (document.getElementById('bk-dev-console')) return;
        var el = document.createElement('div');
        el.id = 'bk-dev-console';
        el.className = 'collapsed';
        el.innerHTML = [
            '<div id="bk-dev-console-bar">',
            '  <span id="bk-dev-console-title">DEV ▲</span>',
            '  <div id="bk-dev-console-actions">',
            '    <button class="bk-dev-btn" id="bk-dev-clear">清除</button>',
            '    <button class="bk-dev-btn" id="bk-dev-copy">复制</button>',
            '    <button class="bk-dev-btn" id="bk-dev-close">✕</button>',
            '  </div>',
            '</div>',
            '<div id="bk-dev-console-body"></div>'
        ].join('');
        document.body.appendChild(el);

        var bar   = document.getElementById('bk-dev-console-bar');
        var body  = document.getElementById('bk-dev-console-body');
        var title = document.getElementById('bk-dev-console-title');

        if (_devLogBuf.length) {
            var frag = document.createDocumentFragment();
            for (var bi = 0; bi < _devLogBuf.length; bi++) frag.appendChild(_buildLogRow(_devLogBuf[bi]));
            body.appendChild(frag);
        }

        bar.addEventListener('click', function(e) {
            if (e.target.classList.contains('bk-dev-btn')) return;
            var c = el.classList;
            if (c.contains('collapsed')) {
                c.remove('collapsed'); c.add('expanded');
                title.textContent = 'DEV ▼';
                body.scrollTop = body.scrollHeight;
            } else {
                c.remove('expanded'); c.add('collapsed');
                title.textContent = 'DEV ▲';
            }
        });

        document.getElementById('bk-dev-clear').addEventListener('click', function(e) {
            e.stopPropagation();
            body.innerHTML = '';
            _devLogBuf = [];
        });

        document.getElementById('bk-dev-copy').addEventListener('click', function(e) {
            e.stopPropagation();
            var txt = _devLogBuf.map(function(r) { return '[' + r.level + '] ' + r.text; }).join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).catch(function() {});
            } else {
                var ta = document.createElement('textarea');
                ta.value = txt;
                ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch(ex) {}
                document.body.removeChild(ta);
            }
        });

        document.getElementById('bk-dev-close').addEventListener('click', function(e) {
            e.stopPropagation();
            try { localStorage.setItem('bk_dev_mode', '0'); } catch(ex) {}
            var tog = document.getElementById('devModeToggle');
            if (tog) tog.checked = false;
            destroy();
        });
    }

    function destroy() {
        var el = document.getElementById('bk-dev-console');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    window.BKDevConsole = { init: init, destroy: destroy };
})();
