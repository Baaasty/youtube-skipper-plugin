'use strict';

const CATEGORIES = [
  ['sponsor', 'Sponsor (bezahlte Werbung)'],
  ['selfpromo', 'Eigenwerbung (Merch, Kurse, Patreon)'],
  ['interaction', 'Like/Abo-Aufrufe'],
  ['intro', 'Intro'],
  ['outro', 'Outro / Abspann'],
  ['preview', 'Vorschau / Recap'],
  ['filler', 'Füller / Abschweifungen'],
  ['music_offtopic', 'Musik (Off-Topic, SponsorBlock)'],
];

const DEFAULTS = {
  autoSkip: true, useSponsorBlock: true, autoAnalyze: false, showBar: true, language: '',
  model: 'claude-opus-5-5',
  skipCategories: { sponsor: true, selfpromo: true, interaction: false, intro: false, outro: false, preview: false, filler: false, music_offtopic: false },
};

const $ = (id) => document.getElementById(id);

function renderCategories(selected) {
  const box = $('categories');
  box.replaceChildren();
  for (const [key, label] of CATEGORIES) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.cat = key; cb.checked = !!selected[key];
    l.append(cb, ' ', label);
    box.appendChild(l);
  }
}

async function load() {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULTS, ...settings, skipCategories: { ...DEFAULTS.skipCategories, ...(settings.skipCategories || {}) } };
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  $('apiKey').value = apiKey;
  $('model').value = s.model;
  $('autoAnalyze').checked = s.autoAnalyze;
  $('autoSkip').checked = s.autoSkip;
  $('useSponsorBlock').checked = s.useSponsorBlock;
  $('showBar').checked = s.showBar;
  $('language').value = s.language;
  renderCategories(s.skipCategories);
  await renderUsage();
}

async function save() {
  const skipCategories = {};
  for (const cb of document.querySelectorAll('#categories input')) skipCategories[cb.dataset.cat] = cb.checked;
  const settings = {
    model: $('model').value,
    autoAnalyze: $('autoAnalyze').checked,
    autoSkip: $('autoSkip').checked,
    useSponsorBlock: $('useSponsorBlock').checked,
    showBar: $('showBar').checked,
    language: $('language').value.trim().toLowerCase(),
    skipCategories,
  };
  await chrome.storage.sync.set({ settings });
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
  $('saved').textContent = 'Gespeichert ✓';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n); }

async function renderUsage() {
  const { usageTotals = {} } = await chrome.storage.local.get('usageTotals');
  const tbody = $('usage').querySelector('tbody');
  tbody.replaceChildren();
  for (const [model, u] of Object.entries(usageTotals)) {
    const tr = document.createElement('tr');
    for (const v of [model, u.calls, fmt(u.input + u.cacheWrite), fmt(u.cacheRead), fmt(u.output), u.usd.toFixed(4)]) {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (!tbody.childElementCount) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 6; td.textContent = 'Noch keine API-Aufrufe.'; tr.appendChild(td); tbody.appendChild(tr);
  }
  const all = await chrome.storage.local.get(null);
  const n = Object.keys(all).filter((k) => k.startsWith('analysis:')).length;
  $('cacheInfo').textContent = `${n} Video-Analysen im Cache`;
}

$('save').addEventListener('click', save);
if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embed');
$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  await renderUsage();
});
$('resetUsage').addEventListener('click', async () => {
  await chrome.storage.local.remove('usageTotals');
  await renderUsage();
});
load();
