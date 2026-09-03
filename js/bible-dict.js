/**
 * 经文字典 — 动态查询并渲染经节内容
 *
 * 数据来源：window.BK_SCRIPTURES_DATA（由 scripture-popup.js 异步加载 bible-text.json / scriptures-data.json）
 *
 * 用法：
 *   BKBibleDict.renderContainer(element)  // element 有 data-refs 属性
 *   toggleScripture() 中自动调用，无需手动触发
 */
(function () {
  'use strict';

  /**
   * 获取经文字典（在 ensureBibleText 回调中调用，数据已就绪）。
   * @returns {Object}
   */
  function getDict() {
    return window.BK_SCRIPTURES_DATA || {};
  }

  /**
   * 将字符串中的 HTML 特殊字符转义。
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 根据 data-refs 属性渲染经文容器（懒渲染，只渲染一次）。
   * @param {HTMLElement} container  带有 data-refs 属性的 .scripture-content 元素
   */
  function renderContainer(container) {
    if (!container) return;
    if (container.dataset.rendered) return;   // 已渲染过则跳过
    container.dataset.rendered = '1';

    var refs = (container.dataset.refs || '').trim();
    if (!refs) return;

    var dict = getDict();
    var html = refs.split(',').map(function (ref) {
      ref = ref.trim();
      var text = dict[ref];
      if (text) {
        return '<div class="verse-line">' + escapeHtml(text) + '</div>';
      }
      // 字典中找不到时，降级显示引用本身
      return '<div class="verse-line verse-line--missing">' + escapeHtml(ref) + '</div>';
    }).join('');
    container.innerHTML = html;
  }

  // 暴露公共接口
  window.BKBibleDict = {
    renderContainer: renderContainer
  };
})();
