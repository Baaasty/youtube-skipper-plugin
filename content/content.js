// Isolated-World Content-Script: Transkript laden, Panel rendern, Auto-Skip.
(() => {
  'use strict';
  if (window.__ytSkipperLoaded) return;
  window.__ytSkipperLoaded = true;

  const L = globalThis.YTSkipperLib;
  const LOG = (...a) => console.debug('[YT Skipper]', ...a);

  const DEFAULT_SETTINGS = {
    autoSkip: true,
    useSponsorBlock: true,
    autoAnalyze: false,
    showPanel: true,
    language: '',
    skipCategories: {
      sponsor: true, selfpromo: true, interaction: false, intro: false,
      outro: false, preview: false, filler: false, music_offtopic: false,
    },
  };

  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  let state = null;       // Zustand des aktuellen Videos
  let panel = null;       // Panel-DOM
  let lastUrl = '';
  let toastEl = null;

  // ---------- Einstellungen ----------
  async function loadSettings() {
    const stored = await chrome.storage.sync.get('settings');
    const s = stored.settings || {};
    settings = {
      ...DEFAULT_SETTINGS, ...s,
      skipCategories: { ...DEFAULT_SETTINGS.skipCategories, ...(s.skipCategories || {}) },
    };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      loadSettings().then(() => { if (panel) renderPanel(); });
    }
  });

  // ---------- Navigation ----------
  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
    } catch (e) { /* ignore */ }
    return null;
  }

  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const id = getVideoId();
    if (!id) { teardown(); return; }
    if (state && state.videoId === id) return;
    onVideoChanged(id).catch((e) => { LOG(e); setStatus('Fehler: ' + e.message, true); });
  }

  function teardown() {
    if (state && state.video) {
      state.video.removeEventListener('timeupdate', onTimeUpdate);
    }
    state = null;
    if (panel) panel.remove();
    panel = null;
  }

  // ---------- Kommunikation mit MAIN-World ----------
  function requestPlayerInfo(videoId, attempts = 20) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const ask = () => {
        tries += 1;
        const onRes = (e) => {
          document.removeEventListener('ytskipper:player-response', onRes);
          let data = null;
          try { data = JSON.parse(e.detail); } catch (err) { data = null; }
          if (data && data.videoId === videoId) { resolve(data); return; }
          if (tries >= attempts) { reject(new Error('Player-Daten nicht verfügbar')); return; }
          setTimeout(ask, 500);
        };
        document.addEventListener('ytskipper:player-response', onRes);
        document.dispatchEvent(new CustomEvent('ytskipper:request-player', { detail: videoId }));
      };
      ask();
    });
  }

  function seek(t) {
    document.dispatchEvent(new CustomEvent('ytskipper:seek', { detail: String(t) }));
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || { error: 'Keine Antwort vom Hintergrundskript' });
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  // ---------- Transkript ----------
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const pref = (settings.language || navigator.language || 'de').slice(0, 2).toLowerCase();
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asr = tracks.filter((t) => t.kind === 'asr');
    return manual.find((t) => t.languageCode.toLowerCase().startsWith(pref))
      || asr.find((t) => t.languageCode.toLowerCase().startsWith(pref))
      || manual[0] || asr[0] || tracks[0];
  }

  async function fetchTimedText(baseUrl) {
    const url = /[?&]fmt=/.test(baseUrl) ? baseUrl.replace(/fmt=[^&]*/, 'fmt=json3') : baseUrl + '&fmt=json3';
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('Untertitel-Abruf fehlgeschlagen (' + res.status + ')');
    const text = await res.text();
    if (!text) throw new Error('Untertitel-Antwort leer');
    const data = JSON.parse(text);
    const lines = [];
    for (const ev of data.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      const t = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      lines.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text: t });
    }
    return lines;
  }

  // Fallback: interne "get_transcript"-API (gleicher Endpunkt wie der "Transkript anzeigen"-Button).
  async function fetchViaInnerTube(info) {
    const vid = info.videoId;
    const bytes = [0x0a, vid.length].concat(Array.from(vid, (c) => c.charCodeAt(0)));
    const params = btoa(String.fromCharCode(...bytes));
    const url = 'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false'
      + (info.apiKey ? '&key=' + encodeURIComponent(info.apiKey) : '');
    const body = {
      context: { client: { clientName: 'WEB', clientVersion: info.clientVersion || '2.20240101.00.00', hl: 'de' } },
      params,
    };
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('get_transcript fehlgeschlagen (' + res.status + ')');
    const json = await res.json();
    const segs = json?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
      ?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments || [];
    const lines = [];
    for (const s of segs) {
      const r = s.transcriptSegmentRenderer;
      if (!r) continue;
      const text = (r.snippet?.runs || []).map((x) => x.text).join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push({ start: Number(r.startMs) / 1000, dur: (Number(r.endMs) - Number(r.startMs)) / 1000, text });
    }
    return lines;
  }

  async function fetchTranscript(info) {
    const track = pickTrack(info.captionTracks);
    const errors = [];
    if (track) {
      try {
        const lines = await fetchTimedText(track.baseUrl);
        if (lines.length) return { lines, lang: track.languageCode, kind: track.kind, source: 'captions' };
        errors.push('Untertitelspur leer');
      } catch (e) { errors.push(e.message); }
    } else {
      errors.push('Video hat keine Untertitelspur');
    }
    try {
      const lines = await fetchViaInnerTube(info);
      if (lines.length) return { lines, lang: '', kind: '', source: 'innertube' };
      errors.push('get_transcript leer');
    } catch (e) { errors.push(e.message); }
    throw new Error(errors.join('; '));
  }

  // ---------- Video-Lifecycle ----------
  async function onVideoChanged(videoId) {
    teardown();
    state = {
      videoId, info: null, video: null, transcript: null, transcriptText: '',
      chapters: [], segments: [], analysis: null, skipped: new Set(),
      chat: [], busy: false, status: 'Lade Videodaten…', error: '',
    };
    ensurePanel();
    renderPanel();

    const info = await requestPlayerInfo(videoId);
    if (!state || state.videoId !== videoId) return;
    state.info = info;
    attachVideo();

    state.chapters = L.parseDescriptionChapters(info.description, info.lengthSeconds);
    addSegments(L.chaptersToSegments(state.chapters, 'chapters'));

    if (settings.useSponsorBlock) {
      sendMessage({ type: 'sponsorblock', videoId }).then((res) => {
        if (!state || state.videoId !== videoId) return;
        if (res.segments) addSegments(res.segments);
        else if (res.error) LOG('SponsorBlock:', res.error);
        renderPanel();
      });
    }

    setStatus('Lade Transkript…');
    try {
      state.transcript = await fetchTranscript(info);
      if (!state || state.videoId !== videoId) return;
      state.transcriptText = L.transcriptToText(state.transcript.lines);
      setStatus(`Transkript geladen (${state.transcript.lines.length} Zeilen${state.transcript.kind === 'asr' ? ', automatisch' : ''})`);
    } catch (e) {
      if (!state || state.videoId !== videoId) return;
      setStatus('Kein Transkript: ' + e.message, true);
    }
    renderPanel();

    if (settings.autoAnalyze && state.transcript) {
      runAnalysis(false).catch((e) => setStatus('KI-Analyse fehlgeschlagen: ' + e.message, true));
    }
  }

  function attachVideo() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) { setTimeout(attachVideo, 500); return; }
    if (state.video === v) return;
    if (state.video) state.video.removeEventListener('timeupdate', onTimeUpdate);
    state.video = v;
    v.addEventListener('timeupdate', onTimeUpdate);
  }

  function addSegments(segs) {
    if (!state || !segs || !segs.length) return;
    state.segments = L.mergeSegments([state.segments, segs]);
  }

  function setStatus(text, isError) {
    if (!state) return;
    state.status = text;
    state.error = isError ? text : '';
    if (panel) renderStatus();
  }

  // ---------- Auto-Skip ----------
  function onTimeUpdate() {
    if (!state || !state.video || !settings.autoSkip) return;
    const t = state.video.currentTime;
    for (const s of state.segments) {
      if (!settings.skipCategories[s.category]) continue;
      if (t >= s.start && t < s.end - 0.3) {
        const key = s.category + '@' + s.start.toFixed(1);
        if (state.skipped.has(key)) continue;
        state.skipped.add(key);
        seek(s.end);
        showToast(`${L.CATEGORY_LABELS[s.category] || s.category} übersprungen (${L.formatTime(s.start)} – ${L.formatTime(s.end)})`,
          { label: 'Rückgängig', onClick: () => seek(s.start) });
        break;
      }
    }
  }

  function showToast(text, action) {
    if (toastEl) toastEl.remove();
    toastEl = el('div', { className: 'yts-toast' }, [text]);
    if (action) {
      toastEl.appendChild(el('button', { onclick: () => { action.onClick(); toastEl.remove(); toastEl = null; } }, [action.label]));
    }
    document.body.appendChild(toastEl);
    const mine = toastEl;
    setTimeout(() => { if (toastEl === mine) { mine.remove(); toastEl = null; } }, 5000);
  }

  // ---------- Sprung-Aktionen ----------
  function currentTime() { return state && state.video ? state.video.currentTime : 0; }

  function jumpSkip(categories, label) {
    const seg = L.findNextSegment(state.segments, categories, currentTime());
    if (!seg) { setStatus(`Kein ${label}-Segment bekannt – ggf. KI-Analyse starten.`); return; }
    seek(seg.end);
    showToast(`${label} übersprungen → ${L.formatTime(seg.end)}`);
  }

  function jumpTo(categories, label) {
    const seg = state.segments.find((s) => categories.includes(s.category));
    if (!seg) { setStatus(`${label} nicht gefunden – ggf. KI-Analyse starten.`); return; }
    seek(seg.start);
    showToast(`${label} → ${L.formatTime(seg.start)}`);
  }

  // ---------- KI ----------
  async function runAnalysis(force) {
    if (!state || !state.transcript || state.busy) return;
    const videoId = state.videoId;
    state.busy = true;
    setStatus('KI-Analyse läuft…');
    renderPanel();
    try {
      const res = await sendMessage({
        type: 'analyze', videoId, force: !!force,
        title: state.info.title, lengthSeconds: state.info.lengthSeconds,
        transcriptText: state.transcriptText,
      });
      if (!state || state.videoId !== videoId) return;
      if (res.error) throw new Error(res.error);
      state.analysis = res;
      const aiSegs = (res.segments || []).map((s) => ({ ...s, source: 'ai' }));
      const aiChapters = (res.chapters || []).map((c, i, arr) => ({
        start: c.start, title: c.title,
        end: i + 1 < arr.length ? arr[i + 1].start : state.info.lengthSeconds,
      }));
      if (aiChapters.length && !state.chapters.length) state.chapters = aiChapters;
      addSegments(aiSegs);
      setStatus(res.cached ? 'KI-Analyse (aus Cache)' : 'KI-Analyse fertig');
    } finally {
      if (state && state.videoId === videoId) { state.busy = false; renderPanel(); }
    }
  }

  async function askAI(question) {
    if (!state || !state.transcript || state.busy) return;
    const videoId = state.videoId;
    state.chat.push({ role: 'user', text: question });
    state.busy = true;
    renderPanel();
    try {
      const res = await sendMessage({
        type: 'ask', videoId, question, title: state.info.title, transcriptText: state.transcriptText,
      });
      if (!state || state.videoId !== videoId) return;
      if (res.error) throw new Error(res.error);
      state.chat.push({ role: 'bot', text: res.answer, matches: res.matches || [] });
    } catch (e) {
      state.chat.push({ role: 'bot', text: 'Fehler: ' + e.message, matches: [] });
    } finally {
      if (state && state.videoId === videoId) { state.busy = false; renderPanel(); }
    }
  }

  function localSearch(query) {
    const hits = L.searchTranscript(state.transcript.lines, query, 8);
    state.chat.push({ role: 'user', text: query });
    state.chat.push({
      role: 'bot',
      text: hits.length ? `${hits.length} Treffer im Transkript:` : 'Keine Treffer im Transkript. Versuche „KI fragen“ für eine inhaltliche Suche.',
      matches: hits.map((h) => ({ start: h.start, label: h.text })),
      highlight: query,
    });
    renderPanel();
  }

  // ---------- Panel ----------
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

  function ensurePanel() {
    if (!settings.showPanel) return;
    if (panel && document.contains(panel)) return;
    panel = el('div', { id: 'yt-skipper-panel' });
    const host = document.querySelector('#secondary-inner') || document.querySelector('#secondary') || document.querySelector('#below');
    if (!host) { setTimeout(ensurePanel, 700); return; }
    host.prepend(panel);
  }

  function renderStatus() {
    const s = panel && panel.querySelector('.yts-status');
    if (!s || !state) return;
    s.textContent = state.status;
    s.classList.toggle('yts-error', !!state.error);
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
    return el('div', { className: 'yts-hit', onclick: () => seek(start) }, [
      el('span', { className: 'yts-time' }, [L.formatTime(start)]),
      el('span', null, highlightText(label, highlight)),
    ]);
  }

  function renderPanel() {
    if (!panel || !state) return;
    ensurePanel();
    if (!document.contains(panel)) return;
    panel.replaceChildren();
    const hasTranscript = !!state.transcript;
    const length = (state.info && state.info.lengthSeconds) || 0;

    panel.appendChild(el('div', { className: 'yts-head' }, [
      el('span', { className: 'yts-title' }, ['⏭ YouTube Skipper']),
      el('span', { className: 'yts-status' + (state.error ? ' yts-error' : '') }, [state.status]),
    ]));

    // Segmentleiste
    if (length && state.segments.length) {
      const bar = el('div', { className: 'yts-bar' });
      for (const s of state.segments) {
        const left = (s.start / length) * 100;
        const width = Math.max(0.4, ((s.end - s.start) / length) * 100);
        bar.appendChild(el('span', {
          className: 'c-' + s.category,
          style: `left:${left}%;width:${width}%`,
          title: `${L.CATEGORY_LABELS[s.category] || s.category}${s.title ? ': ' + s.title : ''} (${L.formatTime(s.start)} – ${L.formatTime(s.end)}, ${s.source})`,
          onclick: () => seek(s.start),
        }));
      }
      panel.appendChild(bar);
    }

    // Buttons
    const has = (cats) => state.segments.some((s) => cats.includes(s.category));
    panel.appendChild(el('div', { className: 'yts-row' }, [
      el('button', { className: 'yts-btn', disabled: has(['intro']) ? null : 'disabled', onclick: () => jumpSkip(['intro'], 'Intro') }, ['⏩ Intro skippen']),
      el('button', { className: 'yts-btn', disabled: has(['sponsor', 'selfpromo']) ? null : 'disabled', onclick: () => jumpSkip(['sponsor', 'selfpromo'], 'Sponsor') }, ['💰 Sponsor skippen']),
      el('button', { className: 'yts-btn', disabled: has(['conclusion', 'outro']) ? null : 'disabled', onclick: () => jumpTo(['conclusion', 'outro'], 'Fazit') }, ['🎯 Zum Fazit']),
      el('button', {
        className: 'yts-btn primary', disabled: hasTranscript && !state.busy ? null : 'disabled',
        title: 'Kapitel, Intro/Outro, Sponsor und Fazit per Claude erkennen',
        onclick: () => runAnalysis(!!state.analysis).catch((e) => setStatus('KI-Analyse fehlgeschlagen: ' + e.message, true)),
      }, [state.analysis ? '🔄 KI-Analyse erneut' : '✨ KI-Analyse']),
    ]));

    // Kapitel
    if (state.chapters.length) {
      const list = el('div', { className: 'yts-chapters' });
      for (const c of state.chapters) list.appendChild(hitRow(c.start, c.title));
      panel.appendChild(el('details', null, [el('summary', null, [`Kapitel (${state.chapters.length})`]), list]));
    }

    // Suche / Chat
    const input = el('input', { type: 'text', placeholder: hasTranscript ? 'Stelle suchen, z. B. „Preis“ oder „wo erklärt er die Installation?“' : 'Kein Transkript verfügbar', disabled: hasTranscript ? null : 'disabled' });
    const doLocal = () => { const q = input.value.trim(); if (q) { localSearch(q); input.value = ''; } };
    const doAI = () => { const q = input.value.trim(); if (q) { askAI(q); input.value = ''; } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (e.shiftKey || e.ctrlKey) doAI(); else doLocal(); } e.stopPropagation(); });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    panel.appendChild(el('div', { className: 'yts-search' }, [
      input,
      el('button', { className: 'yts-btn', disabled: hasTranscript ? null : 'disabled', onclick: doLocal, title: 'Volltextsuche im Transkript (ohne KI, kostenlos)' }, ['🔍']),
      el('button', { className: 'yts-btn primary', disabled: hasTranscript && !state.busy ? null : 'disabled', onclick: doAI, title: 'Inhaltliche Frage an Claude (Strg+Enter)' }, ['KI fragen']),
    ]));

    if (state.chat.length) {
      const results = el('div', { className: 'yts-results' });
      for (const m of state.chat) {
        const box = el('div', { className: 'yts-msg ' + m.role }, [m.text]);
        for (const hit of m.matches || []) box.appendChild(hitRow(hit.start, hit.label, m.highlight));
        results.appendChild(box);
      }
      panel.appendChild(results);
      results.scrollTop = results.scrollHeight;
    }

    if (state.analysis && state.analysis.summary) {
      panel.appendChild(el('details', null, [el('summary', null, ['Zusammenfassung (KI)']), el('div', { className: 'yts-msg' }, [state.analysis.summary])]));
    }

    if (hasTranscript) {
      const tr = el('div', { className: 'yts-transcript' });
      const det = el('details', null, [el('summary', null, ['Transkript anzeigen']), tr]);
      det.addEventListener('toggle', () => {
        if (det.open && !tr.childElementCount) {
          for (const b of L.compactTranscript(state.transcript.lines)) tr.appendChild(hitRow(b.start, b.text));
        }
      });
      panel.appendChild(det);
    }

    panel.appendChild(el('div', { className: 'yts-small' }, [
      settings.autoSkip
        ? 'Auto-Skip aktiv: ' + Object.entries(settings.skipCategories).filter(([, v]) => v).map(([k]) => L.CATEGORY_LABELS[k]).join(', ')
        : 'Auto-Skip deaktiviert',
      ' · Quellen: ' + [...new Set(state.segments.map((s) => s.source))].join(', ') || '–',
    ]));
  }

  // ---------- Start ----------
  loadSettings().then(() => {
    document.addEventListener('yt-navigate-finish', () => setTimeout(checkNavigation, 50));
    setInterval(checkNavigation, 1500);
    checkNavigation();
  });
})();
