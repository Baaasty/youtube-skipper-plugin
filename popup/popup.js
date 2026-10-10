'use strict';
const KEYS = ['autoSkip', 'useSponsorBlock', 'autoAnalyze', 'showPanel'];
const DEFAULTS = { autoSkip: true, useSponsorBlock: true, autoAnalyze: false, showPanel: true };

(async () => {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  document.getElementById('keyWarn').hidden = !!apiKey;
  for (const k of KEYS) {
    const cb = document.getElementById(k);
    cb.checked = k in settings ? !!settings[k] : DEFAULTS[k];
    cb.addEventListener('change', async () => {
      const cur = (await chrome.storage.sync.get('settings')).settings || {};
      cur[k] = cb.checked;
      await chrome.storage.sync.set({ settings: cur });
    });
  }
  document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
