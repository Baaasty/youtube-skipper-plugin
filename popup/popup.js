'use strict';
const L = globalThis.YTSkipperLib;
const $ = (id) => document.getElementById(id);

let tabId = null;
let snap = null;
let lastQueryHighlight = '';

// ---------- Tabs ----------
for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    try { localStorage.setItem('yts-tab', b.dataset.tab); } catch (e) { /* ignore */ }
  });
}
try {
  const t = location.hash === '#settings' ? 'settings' : localStorage.getItem('yts-tab');
  if (t === 'settings') document.querySelector('.tab[data-tab="settings"]').click();
} catch (e) { /* ignore */ }

// ---------- Verbindung zum YouTube-Tab ----------
async function findTab() {
  const isWatch = (t) => /^https:\/\/www\.youtube\.com\/watch/.test(t.url || '');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isWatch(active)) return active;
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || null;
}

function send(msg) {
  return new Promise((resolve) => {
    if (tabId === null) { resolve({ active: false }); return; }
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ active: false, error: chrome.runtime.lastError.message });
      else resolve(res || { active: false });
    });
  });
}

async function refresh() {
  snap = await send({ type: 'ui:state' });
  render();
}

async function act(msg) {
  setBusy(true);
  snap = await send(msg);
  render();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'ui:changed' && sender.tab && sender.tab.id === tabId) refresh();
});

// ---------- Rendering ----------
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children || []) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function highlightText(text, query) {
  if (!query) return [text];
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  if (!terms.length) return [text];
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(el('mark', null, [m[0]]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function hitRow(start, label, highlight) {
  return el('div', { className: 'hit', onclick: () => send({ type: 'ui:seek', t: start }) }, [
    el('span', { className: 'time' }, [L.formatTime(start)]),
    el('span', null, highlightText(label, highlight)),
  ]);
}

function copyButton(label, getText) {
  const b = el('button', { className: 'chip small' }, [label]);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = 'Kopiert ✓'; }
    catch (e) { b.textContent = 'Kopieren fehlgeschlagen'; }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
}

function setBusy(b) {
  for (const id of ['askAI', 'analyze']) $(id).disabled = b || !(snap && snap.hasTranscript);
}

function render() {
  const ok = snap && snap.active;
  $('novideo').hidden = !!ok;
  $('video').hidden = !ok;
  if (!ok) return;

  $('title').textContent = snap.title || 'Video';
  $('title').title = snap.title || '';
  $('status').textContent = snap.status || '';
  $('status').classList.toggle('error', !!snap.error);

  const tl = $('timeline');
  tl.replaceChildren();
  if (snap.lengthSeconds) {
    for (const s of snap.segments) {
      const left = (s.start / snap.lengthSeconds) * 100;
      const width = Math.max(0.4, ((s.end - s.start) / snap.lengthSeconds) * 100);
      tl.appendChild(el('span', {
        className: 'c-' + s.category, style: `left:${left}%;width:${width}%`,
        title: `${L.CATEGORY_LABELS[s.category] || s.category}${s.title ? ': ' + s.title : ''} (${L.formatTime(s.start)} – ${L.formatTime(s.end)})`,
        onclick: () => send({ type: 'ui:seek', t: s.start }),
      }));
    }
  }

  for (const b of document.querySelectorAll('[data-jump]')) b.disabled = !snap.jumps[b.dataset.jump];
  $('analyze').textContent = snap.busy ? '… Analyse' : (snap.hasAnalysis ? '🔄 Analyse' : '✨ Analyse');
  $('query').disabled = !snap.hasTranscript;
  $('searchLocal').disabled = !snap.hasTranscript;
  setBusy(snap.busy);

  const chat = $('chat');
  chat.replaceChildren();
  for (const m of snap.chat) {
    const box = el('div', { className: 'msg ' + m.role }, [m.text]);
    for (const h of m.matches || []) box.appendChild(hitRow(h.start, h.label, m.highlight));
    chat.appendChild(box);
  }
  if (snap.chat.length) chat.appendChild(el('button', { className: 'link', onclick: () => act({ type: 'ui:clearChat' }) }, ['Verlauf leeren']));
  chat.scrollTop = chat.scrollHeight;

  const extras = $('extras');
  extras.replaceChildren();
  if (snap.summary) extras.appendChild(el('details', null, [el('summary', null, ['Zusammenfassung (KI)']), el('div', { className: 'msg' }, [snap.summary])]));
  if (snap.chapters.length) {
    const list = el('div', { className: 'chapters' });
    for (const c of snap.chapters) list.appendChild(hitRow(c.start, c.title));
    list.appendChild(copyButton('Kapitel kopieren (YouTube-Format)', () => L.chaptersToDescription(snap.chapters)));
    extras.appendChild(el('details', null, [el('summary', null, [`Kapitel (${snap.chapters.length})`]), list]));
  }
  const segs = snap.segments.filter((s) => s.category !== 'chapter');
  if (segs.length) {
    const list = el('div', { className: 'chapters' });
    for (const s of segs) {
      const row = hitRow(s.start, `${L.CATEGORY_LABELS[s.category] || s.category} bis ${L.formatTime(s.end)}${s.title ? ' · ' + s.title : ''} (${s.source})`);
      row.appendChild(el('button', {
        className: 'x', title: 'Dieses Segment für dieses Video ignorieren',
        onclick: (e) => { e.stopPropagation(); act({ type: 'ui:ignoreSegment', key: L.segmentKey(s) }); },
      }, ['✕']));
      list.appendChild(row);
    }
    extras.appendChild(el('details', null, [el('summary', null, [`Segmente (${segs.length})`]), list]));
  }
  if (snap.transcript && snap.transcript.length) {
    const list = el('div', { className: 'transcript' });
    const det = el('details', null, [el('summary', null, ['Transkript']), list]);
    det.addEventListener('toggle', () => {
      if (det.open && !list.childElementCount) {
        list.appendChild(copyButton('Transkript kopieren', () => snap.transcript.map((b) => `[${L.formatTime(b.start)}] ${b.text}`).join('\n')));
        for (const b of snap.transcript) list.appendChild(hitRow(b.start, b.text));
      }
    });
    extras.appendChild(det);
  }
  if (snap.costEstimate && !snap.hasAnalysis) {
    extras.appendChild(el('div', { className: 'stats' }, ['KI-Analyse ' + snap.costEstimate]));
  }
}

// ---------- Aktionen ----------
const query = $('query');
const doLocal = () => { const q = query.value.trim(); if (q) { lastQueryHighlight = q; query.value = ''; act({ type: 'ui:search', query: q }); } };
const doAI = () => { const q = query.value.trim(); if (q) { query.value = ''; act({ type: 'ui:ask', question: q }); } };
query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (e.ctrlKey || e.metaKey || e.shiftKey) doAI(); else doLocal(); } });
$('searchLocal').addEventListener('click', doLocal);
$('askAI').addEventListener('click', doAI);
$('analyze').addEventListener('click', () => act({ type: 'ui:analyze', force: !!(snap && snap.hasAnalysis) }));
for (const b of document.querySelectorAll('[data-jump]')) b.addEventListener('click', () => act({ type: 'ui:jump', action: b.dataset.jump }));

async function renderStats() {
  const { skipStats = { count: 0, seconds: 0 } } = await chrome.storage.local.get('skipStats');
  const min = Math.round(skipStats.seconds / 60);
  $('stats').textContent = skipStats.count
    ? `⏱ ${min < 1 ? Math.round(skipStats.seconds) + ' s' : min + ' min'} gespart · ${skipStats.count} Segmente übersprungen · Tastenkürzel: Alt+S Sponsor, Alt+I Intro, Alt+F Fazit, Alt+K Suche`
    : 'Tastenkürzel: Alt+S Sponsor, Alt+I Intro, Alt+F Fazit, Alt+K Suche (änderbar unter chrome://extensions/shortcuts)';
}

// ---------- Start ----------
(async () => {
  renderStats();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.skipStats) renderStats(); });
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  $('keyWarn').hidden = !!apiKey;
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.apiKey) $('keyWarn').hidden = !!ch.apiKey.newValue; });
  const tab = await findTab();
  tabId = tab ? tab.id : null;
  await refresh();
  if (snap && snap.active) query.focus();
})();
