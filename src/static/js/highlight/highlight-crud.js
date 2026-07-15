'use strict';
Object.assign(BKHighlight, {
        // ─── 数据 CRUD ────────────────────────────────────────────
        addHighlight: function (color, underline) {
            var range = this._pendingRange;
            if (!range) return null;
            var rangeNode = range.commonAncestorContainer;
            var container = (rangeNode.nodeType === 3 ? rangeNode.parentElement : rangeNode).closest('.content');
            if (!container) return null;
            var position = this.getSelectionPosition(container, range);
            if (!position) return null;

            var textNodes = this.getTextNodes(container);
            var pageText = '';
            for (var ti = 0; ti < textNodes.length; ti++) pageText += textNodes[ti].textContent;
            var ctx = this._extractContext(pageText, position.start, position.end);

            var highlight = {
                id:        Date.now().toString(),
                start:     position.start,
                end:       position.end,
                text:      range.toString(),
                prefix:    ctx.prefix,
                suffix:    ctx.suffix,
                color:     (color === null || color === 'note' || color === undefined) ? null : (color || this.config.defaultColor),
                underline: !!underline,
                note:      '',
                timestamp: Date.now()
            };

            this.highlights.push(highlight);
            var self = this;
            this._pendingRange = null;
            this._suppressSelMenuUntil = Date.now() + 800;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
                self._suppressSelMenuUntil = 0;
            }).catch(function () {
                self._suppressSelMenuUntil = 0;
            });
            return highlight.id;
        },

        updateHighlight: function (id, changes) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            if (changes.color     !== undefined) h.color     = changes.color;
            if (changes.underline !== undefined) h.underline = changes.underline;
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeHighlight: function (id) {
            this.highlights = this.highlights.filter(function (h) { return h.id !== id; });
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeMark: function (id) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            h.color     = null;
            h.underline = false;
            if (!h.note) {
                this.removeHighlight(id);
                return;
            }
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        saveNote: function (id, text) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            h.note = text || '';
            if (!h.note && !h.color && !h.underline) {
                this.removeHighlight(id);
                return;
            }
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeNote: function (id) {
            this.saveNote(id, '');
        },

        clearAllHighlightsForce: function () {
            this.highlights = [];
            this.clearAllMarks();
            return BKStorage.clear();
        },

});
