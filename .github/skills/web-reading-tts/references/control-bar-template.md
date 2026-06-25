# Control Bar Template

```html
<div class="bottom-control-bar" id="bottomControlBar" style="display:none;">
  <button class="control-btn play-pause-btn" id="playPauseBtn" aria-label="播放">
    <span class="play-icon">▶</span>
    <span class="pause-icon" style="display:none;">⏸</span>
  </button>

  <div class="progress-section">
    <div class="progress-column">
      <input type="range" id="progressBar" class="progress-bar" min="0" max="100" value="0" step="0.1">
      <span class="speech-time" id="speechTime">00:00 / 00:00</span>
    </div>
    <select id="rateSelect" class="control-select" title="语速">
      <option value="0.5">0.5x</option>
      <option value="0.75">0.75x</option>
      <option value="1" selected>1x</option>
      <option value="1.25">1.25x</option>
      <option value="1.5">1.5x</option>
      <option value="2">2x</option>
    </select>
  </div>
</div>
```
