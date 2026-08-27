    // ——————————————————————————————————
    // Changelog 辅助函数
    // ——————————————————————————————————

    function _getCapacitorHttp() {
        if (!window.Capacitor) return null;
        return window.Capacitor.CapacitorHttp
            || (window.Capacitor.Plugins && (window.Capacitor.Plugins.CapacitorHttp || window.Capacitor.Plugins.Http))
            || null;
    }

    function fetchChangelog(serverUrl) {
        var fullUrl = serverUrl + 'changelog.json?t=' + Date.now();
        var CapacitorHttp = _getCapacitorHttp();
        console.log('[Changelog] 请求: ' + fullUrl + ' 方式: ' + (CapacitorHttp ? 'CapacitorHttp' : 'fetch'));

        var promise;
        if (CapacitorHttp) {
            promise = CapacitorHttp.get({ url: fullUrl, connectTimeout: 5000, readTimeout: 8000 })
                .then(function(resp) {
                    console.log('[Changelog] CapacitorHttp 响应: HTTP ' + resp.status);
                    if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
                    return (typeof resp.data === 'string') ? JSON.parse(resp.data) : resp.data;
                });
        } else {
            promise = fetch(fullUrl, { cache: 'no-cache' })
                .then(function(resp) {
                    console.log('[Changelog] fetch 响应: HTTP ' + resp.status);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                });
        }

        return promise.then(function(data) {
            console.log('[Changelog] 加载成功');
            return data;
        }).catch(function(e) {
            console.warn('[Changelog] 加载失败: ' + (e.message || e) + '，已失效 version 缓存');
            // 请求失败，version 缓存可能已过期（该服务器可能已不可达）
            if (window.BK && window.BK.RaceFastest) {
                window.BK.RaceFastest.invalidateVersion();
            }
            return null;
        });
    }

    function fetchChangelogRace(serverUrls) {
        if (!serverUrls || !serverUrls.length) return Promise.resolve(null);
        var chain = Promise.resolve(null);
        serverUrls.forEach(function(u) {
            chain = chain.then(function(v) { return v || fetchChangelog(u); });
        });
        return chain;
    }

    function getVersionsBetween(changelog, fromVer, toVer) {
        if (!changelog) return [];
        var from = fromVer.replace('v', '');
        var to = toVer.replace('v', '');
        return Object.keys(changelog).filter(function(v) {
            return AppUpdate.compareVersion(v, from) > 0 && AppUpdate.compareVersion(v, to) <= 0;
        }).sort(function(a, b) {
            var c = AppUpdate.compareVersion(b, a);
            return c > 0 ? -1 : (c < 0 ? 1 : 0);
        });
    }

    function renderSingleVersionHtml(version, entry) {
        var THEME = getTheme();
        var html = '<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #eee;">';
        html += '<div style="font-weight:600;color:' + THEME.brand + ';margin-bottom:5px;">v' + version;
        if (entry.date) html += ' <span style="font-weight:400;color:#999;font-size:0.75em;">' + entry.date + '</span>';
        html += '</div>';
        if (entry['new'] && entry['new'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#16a34a;font-size:0.75em;font-weight:600;">✨ 新增</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['new'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        if (entry['opt'] && entry['opt'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#3D8A5A;font-size:0.75em;font-weight:600;">⚡ 优化</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['opt'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        if (entry['fix'] && entry['fix'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#dc2626;font-size:0.75em;font-weight:600;">🔧 修复</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['fix'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        html += '</div>';
        return html;
    }

    function fillChangelogPanel(dialogId, changelog, currentVer, latestVer, comparison) {
        var clInline    = document.getElementById(dialogId + '-cl-inline');
        var histContent = document.getElementById(dialogId + '-hist-content');
        var histBtn     = document.getElementById(dialogId + '-hist-btn');

        var currentClean = currentVer.replace('v', '');
        var latestClean  = latestVer.replace('v', '');

        if (comparison > 0 && clInline) {
            var displayVersions = getVersionsBetween(changelog, currentClean, latestClean);
            if (displayVersions.length > 0) {
                var html = '';
                if (displayVersions.length > 1) {
                    html += '<div style="margin-bottom:8px;font-size:0.75em;color:#666;">本次更新包含以下版本：</div>';
                }
                displayVersions.forEach(function(v) {
                    if (changelog[v]) html += renderSingleVersionHtml(v, changelog[v]);
                });
                clInline.innerHTML = html;
            } else {
                clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">暂无更新说明</div>';
            }
            clInline.style.display = 'block';
        }

        var historyVersions = Object.keys(changelog).filter(function(v) {
            return AppUpdate.compareVersion(v, currentClean) <= 0;
        }).sort(function(a, b) {
            return AppUpdate.compareVersion(b, a);
        });
        if (histContent && historyVersions.length > 0) {
            var _PAGE = 5;
            var _histShown = 0;
            function _renderHistPage() {
                var end = Math.min(_histShown + _PAGE, historyVersions.length);
                var frag = '';
                for (var i = _histShown; i < end; i++) {
                    if (changelog[historyVersions[i]]) frag += renderSingleVersionHtml(historyVersions[i], changelog[historyVersions[i]]);
                }
                _histShown = end;
                var oldMore = histContent.querySelector('.hist-more-btn');
                if (oldMore) histContent.removeChild(oldMore);
                var tmp = document.createElement('div');
                tmp.innerHTML = frag;
                while (tmp.firstChild) histContent.appendChild(tmp.firstChild);
                if (_histShown < historyVersions.length) {
                    var moreBtn = document.createElement('button');
                    moreBtn.className = 'hist-more-btn';
                    moreBtn.style.cssText = 'width:100%;padding:9px;background:#F1F0ED;color:#9A958C;border:1px solid #E5E2DD;border-radius:6px;font-size:0.8125em;cursor:pointer;margin-top:4px;';
                    moreBtn.textContent = '更多（还有 ' + (historyVersions.length - _histShown) + ' 个版本）';
                    moreBtn.onclick = _renderHistPage;
                    histContent.appendChild(moreBtn);
                }
            }
            _renderHistPage();
            if (histBtn) histBtn.style.display = 'block';
        }
    }

    function createUpdateDialog(dialogId, title, statusId, btnId) {
        var THEME = getTheme();

        var html = '<div class="bk-update-card" style="background:var(--card-bg,#FFFFFF);border-radius:24px;max-width:400px;width:100%;max-height:88vh;overflow:hidden;box-shadow:none;display:flex;flex-direction:column;">';

        html += '<div id="' + dialogId + '-panel-main" style="display:flex;flex-direction:column;flex:1;min-height:0;">';
        html += '<div class="bk-drawer-header">';
        html += '<div class="bk-drawer-title">' + title + '</div>';
        html += '<button id="' + dialogId + '-close" class="bk-drawer-close" aria-label="关闭">×</button>';
        html += '</div>';
        html += '<div class="bk-drawer-divider"></div>';
        html += '<div class="bk-drawer-body">';
        html += '<div id="' + statusId + '" style="color:var(--text-muted,#9A958C);font-size:0.875em;line-height:1.7;">正在检查更新...</div>';
        html += '<div id="' + dialogId + '-version-pill" class="bk-chip-sage" style="display:none;margin-top:12px;"></div>';
        html += '<div class="bk-label-muted" style="margin-top:16px;">更新内容</div>';
        html += '<div id="' + dialogId + '-cl-inline" style="display:none;color:var(--text-muted,#9A958C);font-size:0.8125em;line-height:1.7;"></div>';
        html += '<div id="' + dialogId + '-hist-btn" style="display:none;margin-top:14px;color:var(--brand,#3D8A5A);font-size:0.8125em;font-weight:600;cursor:pointer;">📖 历史版本 ›</div>';
        html += '</div>';
        html += '<div class="bk-drawer-actions">';
        html += '<button id="' + dialogId + '-cancel" class="bk-btn bk-btn-secondary" style="display:none">稍后</button>';
        html += '<button id="' + btnId + '" class="bk-btn bk-btn-primary" style="display:none">立即更新</button>';
        html += '</div>';
        html += '</div>';

        html += '<div id="' + dialogId + '-panel-hist" style="display:none;flex-direction:column;flex:1;min-height:0;">';
        html += '<div style="padding:16px 24px;border-bottom:1px solid var(--border,#E5E2DD);display:flex;align-items:center;flex-shrink:0;">';
        html += '<button id="' + dialogId + '-hist-back" style="background:none;border:none;color:var(--brand,#3D8A5A);font-size:0.875em;font-weight:600;cursor:pointer;padding:4px 10px 4px 0;">← 返回</button>';
        html += '<span style="font-size:0.9375em;font-weight:600;color:var(--heading,#1A1918);">📖 历史版本</span>';
        html += '</div>';
        html += '<div id="' + dialogId + '-hist-content" class="bk-drawer-body"></div>';
        html += '</div>';

        html += '</div>';

        var dlg = window.BK.openDialog({ id: dialogId, html: html });
        if (!dlg) return function() {};

        var _panel = 'main';

        function _show(name) {
            ['main', 'hist'].forEach(function(p) {
                var el = document.getElementById(dialogId + '-panel-' + p);
                if (el) el.style.display = (p === name) ? 'block' : 'none';
            });
            _panel = name;
        }

        function _navTo(name) {
            window.BK.backStack.push(function() { _show('main'); });
            _show(name);
        }

        function _close() {
            if (_panel !== 'main') window.BK.backStack.discard();
            dlg.close();
        }

        var el;
        el = document.getElementById(dialogId + '-hist-btn');
        if (el) el.onclick = function() { _navTo('hist'); };
        el = document.getElementById(dialogId + '-hist-back');
        if (el) el.onclick = function() { history.back(); };
        el = document.getElementById(dialogId + '-close');
        if (el) el.onclick = _close;
        el = document.getElementById(dialogId + '-cancel');
        if (el) el.onclick = _close;

        return _close;
    }
    
    function handleVersionComparison(dialogId, statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, downloadUrl) {
        var currentClean = currentVersion.replace('v', '');
        var latestClean = latestVersion.replace('v', '');

        var vpill = document.getElementById(dialogId + '-version-pill');
        if (vpill) {
            if (comparison > 0 && sizeText) {
                vpill.textContent = '更新大小 ' + sizeText.replace(/[()]/g, '').trim();
                vpill.style.display = 'inline-flex';
            } else {
                vpill.style.display = 'none';
            }
        }

        if (comparison > 0) {
            statusEl.innerHTML = '✅ 发现新版本<br>当前: v' + currentClean + '<br>最新: v' + latestClean + sizeText;
            btnEl.style.display = 'block';
            btnEl.textContent = '立即更新';
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else if (comparison === 0) {
            statusEl.innerHTML = '✅ 已是最新版本<br>版本: v' + currentClean;
            btnEl.style.display = 'block';
            btnEl.textContent = '重新下载';
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else if (comparison === null) {
            statusEl.innerHTML = '⚠️ 无法比较版本<br>当前: ' + currentVersion + '<br>最新: v' + latestClean;
            btnEl.style.display = 'block';
            btnEl.textContent = '下载最新版';
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else {
            statusEl.innerHTML = '当前: v' + currentClean + '<br>远程: v' + latestClean;
        }
    }
    
    // Cloudflare 更新检查
    AppUpdate.showCloudflareUpdateDialog = function() {
        var CLOUDFLARE_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
        
        createUpdateDialog('cloudflareUpdateDialog', '发现新版本', 'cfCheckStatus', 'cfUpdateBtn');
        
        var statusEl = document.getElementById('cfCheckStatus');
        var btnEl = document.getElementById('cfUpdateBtn');
        
        if (!statusEl || !btnEl) return;
        
        getCurrentApkVersion().then(function(currentVersion) {
            statusEl.innerHTML = '当前版本: ' + currentVersion + '<br>正在检查远程版本...';

            // ★ 使用全局 version 竞速：一次竞速，结果缓存 5 分钟复用
            var Race = window.BK && window.BK.RaceFastest;
            var racePromise = Race
                ? Race.version().then(function(result) {
                    return { serverUrl: result.serverUrl, versionInfo: result.data };
                  })
                : (function() {
                    // 兜底：手动竞速（同样使用 CapacitorHttp 绕过 CORS）
                    var ts = Date.now();
                    var CapacitorHttp = _getCapacitorHttp();
                    console.log('[更新检查] 兜底竞速请求方式: ' + (CapacitorHttp ? 'CapacitorHttp' : 'fetch') + '，' + CLOUDFLARE_SERVERS.length + ' 个服务器');
                    var fetches = CLOUDFLARE_SERVERS.map(function(serverUrl) {
                        var fullUrl = serverUrl + 'version.json?t=' + ts;
                        if (CapacitorHttp) {
                            return CapacitorHttp.get({ url: fullUrl, connectTimeout: 5000, readTimeout: 8000 })
                                .then(function(resp) {
                                    console.log('[更新检查] 兜底竞速 CapacitorHttp 响应: ' + serverUrl + ' → HTTP ' + resp.status);
                                    if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
                                    var d = (typeof resp.data === 'string') ? JSON.parse(resp.data) : resp.data;
                                    return { serverUrl: serverUrl, versionInfo: d };
                                })
                                .catch(function(e) {
                                    console.warn('[更新检查] 兜底竞速 CapacitorHttp 失败: ' + serverUrl + ' → ' + (e.message || e));
                                    throw e;
                                });
                        }
                        return fetch(fullUrl, { cache: 'no-cache' })
                            .then(function(r) {
                                console.log('[更新检查] 兜底竞速 fetch 响应: ' + serverUrl + ' → HTTP ' + r.status);
                                if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
                            })
                            .then(function(d) { return { serverUrl: serverUrl, versionInfo: d }; })
                            .catch(function(e) {
                                console.warn('[更新检查] 兜底竞速 fetch 失败: ' + serverUrl + ' → ' + (e.message || e));
                                throw e;
                            });
                    });
                    var race = typeof Promise.any === 'function'
                        ? Promise.any(fetches)
                        : new Promise(function(resolve) {
                            var done = false;
                            fetches.forEach(function(p) { p.then(function(d) { if (!done) { done = true; resolve(d); } }).catch(function() {}); });
                            setTimeout(function() { if (!done) resolve(null); }, 8000);
                        });
                    return race;
                })();

            return racePromise.then(function(result) {
                if (!result) { statusEl.innerHTML = '❌ 所有服务器均无法访问'; return; }
                var serverUrl = result.serverUrl;
                var versionInfo = result.versionInfo;

                var latestVersion = versionInfo.apk_version || versionInfo.version || '未知';
                var apkFile = versionInfo.apk_file || ('Books-v' + latestVersion + '.apk');
                var apkSize = versionInfo.apk_size;

                // APK 下载：优先从 Cloudflare Pages 下载（APK 已随站点部署）
                // apk_url 为相对路径（如 /Books-vX.Y.Z.apk），用响应成功的 serverUrl 拼接
                var downloadUrl;
                var apkUrlFromServer = versionInfo.apk_url;
                if (apkUrlFromServer && apkUrlFromServer.indexOf('/') === 0) {
                    // 相对路径，用 Cloudflare 服务器地址拼接
                    downloadUrl = serverUrl.replace(/\/$/, '') + apkUrlFromServer;
                } else if (apkUrlFromServer) {
                    // 绝对路径，直接使用
                    downloadUrl = apkUrlFromServer;
                } else {
                    // 兜底：GitHub Release + 镜像代理
                    downloadUrl = 'https://github.com/zhao-zg/books/releases/download/v' + latestVersion + '/' + apkFile;
                    var mirrors = (window.BK_SERVERS && window.BK_SERVERS.github_mirrors) || [];
                    if (mirrors.length > 0) {
                        downloadUrl = mirrors[0] + downloadUrl;
                    }
                }
                var comparison = AppUpdate.compareVersion(latestVersion.replace('v', ''), currentVersion.replace('v', ''));
                var sizeText = apkSize ? ' (' + (apkSize / 1024 / 1024).toFixed(1) + ' MB)' : '';

                handleVersionComparison('cloudflareUpdateDialog', statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, downloadUrl);

                if (comparison > 0) {
                    var clInline = document.getElementById('cloudflareUpdateDialog-cl-inline');
                    if (clInline) {
                        clInline.style.display = 'block';
                        clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                    }
                }

                // ★ changelog 也走最快服务器（复用 version 竞速结果），不再逐个试
                fetchChangelog(serverUrl).then(function(changelog) {
                    if (changelog) fillChangelogPanel('cloudflareUpdateDialog', changelog, currentVersion, latestVersion, comparison);
                });
            }).catch(function(error) {
                statusEl.innerHTML = '❌ 所有服务器均无法访问';
                // ★ 竞速失败：清理缓存，下次重新竞速
                if (window.BK && window.BK.RaceFastest) {
                    window.BK.RaceFastest.invalidateVersion();
                }
            });
        }).catch(function(error) {
            statusEl.innerHTML = '❌ 检查失败: ' + error.message;
        });
    };
    
    // GitHub 更新检查
    AppUpdate.showGitHubUpdateDialog = function() {
        var GITHUB_API_URL = (window.BK_SERVERS && window.BK_SERVERS.github_api) ||
            'https://api.github.com/repos/zhao-zg/books/releases/latest';
        
        createUpdateDialog('githubUpdateDialog', '发现新版本', 'ghCheckStatus', 'ghUpdateBtn');
        
        var statusEl = document.getElementById('ghCheckStatus');
        var btnEl = document.getElementById('ghUpdateBtn');
        
        if (!statusEl || !btnEl) return;
        
        getCurrentApkVersion().then(function(currentVersion) {
            statusEl.innerHTML = '当前版本: ' + currentVersion + '<br>正在检查远程版本...';
            
            return fetch(GITHUB_API_URL)
                .then(function(response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                })
                .then(function(release) {
                    var apk = release.assets.find(function(a) {
                        return a.name.endsWith('.apk');
                    });
                    
                    if (!apk) {
                        statusEl.innerHTML = '❌ 未找到 APK 文件';
                        return;
                    }
                    
                    var latestVersion = release.tag_name;
                    var comparison = AppUpdate.compareVersion(latestVersion.replace('v', ''), currentVersion.replace('v', ''));
                    var sizeText = ' (' + (apk.size / 1024 / 1024).toFixed(1) + ' MB)';

                    handleVersionComparison('githubUpdateDialog', statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, apk.browser_download_url);

                    if (comparison > 0) {
                        var clInline = document.getElementById('githubUpdateDialog-cl-inline');
                        if (clInline) {
                            clInline.style.display = 'block';
                            clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                        }
                    }

                    // ★ changelog 走 version 竞速的最快服务器
                    var CL_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
                    var Race = window.BK && window.BK.RaceFastest;
                    var clPromise = Race
                        ? Race.version().then(function(r) { return fetchChangelog(r.serverUrl); })
                        : fetchChangelogRace(CL_SERVERS);
                    clPromise.then(function(changelog) {
                        if (changelog) fillChangelogPanel('githubUpdateDialog', changelog, currentVersion, latestVersion, comparison);
                    }).catch(function() {
                        // ★ changelog 竞速失败：清理缓存，下次重新竞速
                        if (window.BK && window.BK.RaceFastest) {
                            window.BK.RaceFastest.invalidateVersion();
                        }
                    });
                });
        }).catch(function(error) {
            statusEl.innerHTML = '❌ 检查失败: ' + error.message;
        });
    };
    
    // PWA 更新检查对话框
    AppUpdate.showPwaUpdateDialog = function(options) {
        var root = (options && options.root) || './';
        var extStatusEl = (options && options.statusEl) || null;

        var closeDialog = createUpdateDialog('pwaUpdateDialog', '发现新版本', 'pwaCheckStatus', 'pwaUpdateBtn');

        var statusEl = document.getElementById('pwaCheckStatus');
        var btnEl    = document.getElementById('pwaUpdateBtn');
        if (!statusEl || !btnEl) return;

        var currentVersion = '';
        try { currentVersion = localStorage.getItem('bk_pwa_version') || ''; } catch(e) {}

        statusEl.innerHTML = (currentVersion ? '当前版本: v' + currentVersion + '<br>' : '') + '正在检查远程版本...';

        fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(v) {
                var remoteVersion = v.version || v.apk_version || '';
                var comparison = currentVersion
                    ? AppUpdate.compareVersion(remoteVersion, currentVersion)
                    : 0;

                if (comparison <= 0) {
                    statusEl.innerHTML = '✅ 已是最新版本<br>版本: v' + remoteVersion;
                    if (extStatusEl) { extStatusEl.textContent = '✓ 已是最新版本 v' + remoteVersion; extStatusEl.className = 'cache-status success'; }
                    btnEl.style.display = 'block';
                    btnEl.textContent = '强制重新加载';
                    btnEl.onclick = function() {
                        closeDialog();
                        var steps = [];
                        if ('caches' in window) {
                            steps.push(caches.keys().then(function(keys) {
                                return Promise.all(keys.filter(function(k) { return k.startsWith('bk-') || k.startsWith('books-'); }).map(function(k) { return caches.delete(k); }));
                            }));
                        }
                        try { localStorage.removeItem('bk_pwa_version'); } catch(ex) {}
                        try { localStorage.removeItem('bk_all_cached'); } catch(ex) {}
                        Promise.all(steps).then(function() { window.location.replace(root + 'index.html'); });
                    };
                } else {
                    var currentClean = (currentVersion || '').replace('v', '');
                    var remoteClean  = remoteVersion.replace('v', '');
                    statusEl.innerHTML = '✅ 发现新版本<br>' +
                        (currentClean ? '当前: v' + currentClean + '<br>' : '') +
                        '最新: v' + remoteClean;
                    if (extStatusEl) { extStatusEl.textContent = '发现新版本 v' + remoteVersion; extStatusEl.className = 'cache-status'; }

                    var clInline = document.getElementById('pwaUpdateDialog-cl-inline');
                    if (clInline) {
                        clInline.style.display = 'block';
                        clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                    }

                    btnEl.style.display = 'block';
                    btnEl.textContent = '立即更新';
                    btnEl.onclick = function() {
                        closeDialog();
                        window.__bkUpdateInProgress = true;
                        if (window.BK && window.BK.errorLog) window.BK.errorLog.clear();

                        if (window.showMandatoryInstallDialog) {
                            // 单次 reload：清缓存 → 重建 → 激活新 SW → reload
                            window.showMandatoryInstallDialog('update', remoteVersion, function() {
                                // 缓存重建完成，锁定 controllerchange 防额外 reload，再激活新 SW
                                window.__bkSwRefreshing = true;
                                if (window.__bkSwWaiting) {
                                    try { window.__bkSwWaiting.postMessage({type:'SKIP_WAITING'}); } catch(ex){}
                                    window.__bkSwWaiting = null;
                                }
                                try { localStorage.setItem('bk_pwa_version', remoteVersion); } catch(ex) {}
                                try { localStorage.removeItem('bk_all_cached'); } catch(ex) {}
                                window.__bkUpdateInProgress = false;
                                setTimeout(function() { window.location.replace(root + 'index.html'); }, 800);
                            });
                        } else {
                            // fallback：showMandatoryInstallDialog 不可用时走原流程
                            // 缓存名固定 bk-main，新资源覆盖写入，无需清理旧缓存
                            window.__bkSwRefreshing = true;
                            if (window.__bkSwWaiting) {
                                try { window.__bkSwWaiting.postMessage({type:'SKIP_WAITING'}); } catch(ex){}
                                window.__bkSwWaiting = null;
                            }
                            try { localStorage.setItem('bk_pwa_version', remoteVersion); } catch(ex) {}
                            try { localStorage.removeItem('bk_all_cached'); } catch(ex) {}
window.__bkUpdateInProgress = false;
                            setTimeout(function() { window.location.replace(root + 'index.html'); }, 800);
                        }
                    };
                }

                fetchChangelog(root).then(function(changelog) {
                    if (changelog) fillChangelogPanel('pwaUpdateDialog', changelog, currentVersion || '0', remoteVersion, comparison);
                });
            })
            .catch(function(e) {
                statusEl.innerHTML = '❌ 检查失败: ' + e.message;
                if (extStatusEl) { extStatusEl.textContent = '检查失败：' + e.message; extStatusEl.className = 'cache-status error'; }
                // ★ PWA version.json 请求失败：清理竞速缓存，下次重新竞速
                if (window.BK && window.BK.RaceFastest) {
                    window.BK.RaceFastest.invalidateVersion();
                }
            });
    };

