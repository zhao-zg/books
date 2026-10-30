'use strict';
Object.assign(BKHighlight, {
        // ─── 文本节点遍历 ───────────────────────────────────────────
        getTextNodes: function (element) {
            var textNodes = [];
            var walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                null
            );
            var node;
            while ((node = walker.nextNode())) textNodes.push(node);
            return textNodes;
        },

        // ─── 选区 → 绝对字符偏移 ────────────────────────────────────
        getSelectionPosition: function (container, range) {
            var textNodes = this.getTextNodes(container);
            var charCount = 0, start = -1, end = -1;
            for (var i = 0; i < textNodes.length; i++) {
                var node = textNodes[i];
                var nodeLength = node.textContent.length;
                if (node === range.startContainer) start = charCount + range.startOffset;
                if (node === range.endContainer)   { end = charCount + range.endOffset; break; }
                charCount += nodeLength;
            }
            return (start >= 0 && end >= 0 && end > start) ? { start: start, end: end } : null;
        },

        // ─── 应用单个划线到 DOM ──────────────────────────────────────
        applyHighlight: function (highlight) {
            var container = document.querySelector('#carouselPageCurr .content')
                         || document.querySelector('#carouselPageCurr .bible-reading')
                         || document.querySelector('#app .content')
                         || document.querySelector('#app .bible-reading')
                         || document.querySelector('.content')
                         || document.querySelector('.bible-reading');
            if (!container) return;
            if (document.querySelector('.bk-highlight[data-highlight-id="' + highlight.id + '"]')) return;
            var textNodes = this.getTextNodes(container);
            var charCount = 0;
            var self = this;

            // 多节点跨段时，先用字符偏移提取全文做整体校验
            if (highlight.text) {
                var fullText = '';
                for (var j = 0; j < textNodes.length; j++) {
                    var tn = textNodes[j];
                    var tnStart = charCount;
                    var tnEnd   = tnStart + tn.textContent.length;
                    if (tnEnd > highlight.start && tnStart < highlight.end) {
                        var s = Math.max(0, highlight.start - tnStart);
                        var e = Math.min(tn.textContent.length, highlight.end - tnStart);
                        fullText += tn.textContent.substring(s, e);
                    }
                    charCount += tn.textContent.length;
                    if (tnStart >= highlight.end) break;
                }
                charCount = 0;
                if (fullText !== highlight.text) {
                    var pageText = '';
                    for (var k = 0; k < textNodes.length; k++) pageText += textNodes[k].textContent;

                    var candidates = [];
                    var searchFrom = 0;
                    while (true) {
                        var pos = pageText.indexOf(highlight.text, searchFrom);
                        if (pos < 0) break;
                        candidates.push(pos);
                        searchFrom = pos + 1;
                    }
                    if (!candidates.length) {
                        console.warn('[划线] 文本已不存在，跳过恢复:', highlight.text.substring(0, 20));
                        return;
                    }

                    var bestPos = -1;
                    if (highlight.prefix !== undefined && highlight.suffix !== undefined) {
                        var bestScore = -1;
                        for (var ci = 0; ci < candidates.length; ci++) {
                            var cp = candidates[ci];
                            var ce = cp + highlight.text.length;
                            var actualPrefix = pageText.substring(Math.max(0, cp - 25), cp);
                            var actualSuffix = pageText.substring(ce, Math.min(pageText.length, ce + 25));
                            var score = self._overlapRight(highlight.prefix, actualPrefix) +
                                        self._overlapLeft(highlight.suffix, actualSuffix);
                            if (score > bestScore ||
                                (score === bestScore && Math.abs(cp - highlight.start) < Math.abs(bestPos - highlight.start))) {
                                bestScore = score;
                                bestPos = cp;
                            }
                        }
                    } else {
                        var bestDist = Infinity;
                        for (var di = 0; di < candidates.length; di++) {
                            var dist = Math.abs(candidates[di] - highlight.start);
                            if (dist < bestDist) { bestDist = dist; bestPos = candidates[di]; }
                        }
                    }

                    highlight.start = bestPos;
                    highlight.end   = bestPos + highlight.text.length;
                    var newCtx = self._extractContext(pageText, highlight.start, highlight.end);
                    highlight.prefix = newCtx.prefix;
                    highlight.suffix = newCtx.suffix;
                    var selfHeal = self;
                    setTimeout(function() { selfHeal.saveHighlights(); }, 0);
                    charCount = 0;
                }
            }

            for (var i = 0; i < textNodes.length; i++) {
                var node       = textNodes[i];
                var nodeLength = node.textContent.length;
                var nodeStart  = charCount;
                var nodeEnd    = charCount + nodeLength;

                if (nodeEnd > highlight.start && nodeStart < highlight.end) {
                    var startOffset = Math.max(0, highlight.start - nodeStart);
                    var endOffset   = Math.min(nodeLength, highlight.end - nodeStart);

                    var range = document.createRange();
                    range.setStart(node, startOffset);
                    range.setEnd(node, endOffset);

                    var mark = document.createElement('mark');
                    mark.className = 'bk-highlight';

                    if (highlight.color && highlight.color !== 'note' && self.config.colors[highlight.color]) {
                        mark.style.backgroundColor = self.config.colors[highlight.color];
                        mark.dataset.color = highlight.color;
                    } else {
                        mark.style.backgroundColor = 'transparent';
                    }

                    if (highlight.underline) {
                        mark.dataset.underline = 'true';
                    }
                    if (highlight.note) {
                        mark.dataset.note = 'true';
                    }

                    mark.dataset.highlightId = highlight.id;

                    try {
                        range.surroundContents(mark);
                        if (highlight.note && (nodeStart + endOffset >= highlight.end)) {
                            self._insertNoteIcon(mark, highlight.id);
                        }
                    } catch (e) {
                        console.warn('[划线] 无法应用划线:', e);
                    }
                }

                charCount += nodeLength;
            }
        },

        _insertNoteIcon: function (markEl, highlightId) {
            if (document.querySelector('.bk-hl-note-icon[data-highlight-id="' + highlightId + '"]')) return;
            var next = markEl.nextSibling;
            if (next && next.classList && next.classList.contains('bk-hl-note-icon')) return;
            var icon = document.createElement('span');
            icon.className = 'bk-hl-note-icon';
            icon.textContent = '📝';
            icon.dataset.highlightId = highlightId;
            markEl.parentNode.insertBefore(icon, markEl.nextSibling);
        },

        // ─── TextQuoteSelector 辅助函数 ─────────────────────────────────
        _extractContext: function (pageText, start, end, win) {
            win = win || 25;
            return {
                prefix: pageText.substring(Math.max(0, start - win), start),
                suffix: pageText.substring(end, Math.min(pageText.length, end + win))
            };
        },

        _overlapRight: function (saved, actual) {
            var i = saved.length - 1, j = actual.length - 1, count = 0;
            while (i >= 0 && j >= 0 && saved[i] === actual[j]) { i--; j--; count++; }
            return count;
        },

        _overlapLeft: function (saved, actual) {
            var i = 0, count = 0;
            while (i < saved.length && i < actual.length && saved[i] === actual[i]) { i++; count++; }
            return count;
        },

        // ─── 恢复全部划线 ─────────────────────────────────────────────
        restoreHighlights: function () {
            var self = this;
            var gen = ++this._restoreGen;
            return this.loadHighlights().then(function () {
                if (self._restoreGen !== gen) return;
                var seen = {};
                self.highlights = self.highlights.filter(function (h) {
                    if (seen[h.id]) return false;
                    seen[h.id] = true;
                    return true;
                });
                self.highlights.forEach(function (h) { self.applyHighlight(h); });
            });
        },

        // ─── 清除所有 DOM 标记 ────────────────────────────────────
        clearAllMarks: function () {
            document.querySelectorAll('.bk-hl-note-icon').forEach(function (el) { el.remove(); });
            document.querySelectorAll('.bk-highlight').forEach(function (mark) {
                var parent = mark.parentNode;
                while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                parent.removeChild(mark);
            });
            // normalize 所有 .content / .bible-reading 容器，避免文本节点碎片化
            document.querySelectorAll('.content, .bible-reading').forEach(function (c) { c.normalize(); });
        },

});
