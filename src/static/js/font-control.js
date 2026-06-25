/* Shared font size controls for BK site
   Auto-initializes when DOM is ready
   Note: 主要逻辑已移至 theme-toggle.js，此文件仅用于连接底部控制栏按钮
*/
(function() {
  'use strict';

  function initFontControls() {
    const fontSmaller = document.getElementById('fontSmaller');
    const fontReset = document.getElementById('fontReset');
    const fontLarger = document.getElementById('fontLarger');

    if (!fontSmaller || !fontReset || !fontLarger) {
      return; // 字体控件不存在(如主页)
    }

    // 使用 theme-toggle.js 提供的全局函数
    if (window.BKFontControl) {
      fontSmaller.addEventListener('click', window.BKFontControl.decrease);
      fontReset.addEventListener('click', window.BKFontControl.reset);
      fontLarger.addEventListener('click', window.BKFontControl.increase);
    } else {
      console.warn('BKFontControl not found, font controls may not work');
    }
  }

  // 在DOM加载完成后自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFontControls);
  } else {
    initFontControls();
  }
})();
