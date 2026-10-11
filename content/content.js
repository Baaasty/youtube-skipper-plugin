// Isolated-World Content-Script: Transkript laden, KI-Suchleiste unter dem Video, Auto-Skip,
// Zustand für das Toolbar-Popup bereitstellen.
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
    showBar: true,
    language: '',
    model: 'claude-opus-5-5',
    autoAnalyzeMaxMinutes: 60,
    skipCategories: {
      sponsor: true, selfpromo: true, interaction: false, intro: false,
      outro: false, preview: false, filler: false, music_offtopic: false,
    },
  };

  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  let state = null;       // Zustand des aktuellen Videos
  let bar = null;         // Suchleiste (DOM)
  let lastUrl = '';
  let toastEl = null;
  let resultsOpen = true;

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
      loadSettings().then(() => {
        if (!settings.showBar && bar) { bar.remove(); bar = null; }
        render();
      });
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
    // Leiste neu einhängen, falls YouTube den Bereich unter dem Video neu aufgebaut hat.
    if (state && settings.showBar && bar && !document.contains(bar)) { bar = null; render(); }
    if (state && state.segments.length && !document.querySelector('#movie_player .ytp-progress-bar .yts-markers')) renderMarkers();
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const id = getVideoId();
    if (!id) { teardown(); return; }
    if (state && state.videoId === id) return;
    onVideoChanged(id).catch((e) => { LOG(e); setStatus('Fehler: ' + e.message, true); });
  }

  function teardown() {
    if (state && state.video) state.video.removeEventListener('timeupdate', onTimeUpdate);
    state = null;
    const markers = document.querySelector('#movie_player .yts-markers');
    if (markers) markers.remove();
    if (skipBtn) { skipBtn.remove(); skipBtn = null; }
    if (bar) bar.remove();
    bar = null;
    notifyPopup();
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
    // Bevorzugt die echten Parameter aus den Seitendaten, sonst minimale Protobuf-Variante (Feld 1 = videoId).
    const bytes = [0x0a, vid.length].concat(Array.from(vid, (c) => c.charCodeAt(0)));
    const params = info.transcriptParams || btoa(String.fromCharCode(...bytes));
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
      chat: [], busy: false, status: 'Lade Videodaten…', error: '', ignored: new Set(),
    };
    render();

    const [info, ignoredStore] = await Promise.all([requestPlayerInfo(videoId), chrome.storage.local.get('ignored:' + videoId)]);
    if (!state || state.videoId !== videoId) return;
    state.ignored = new Set(ignoredStore['ignored:' + videoId] || []);
    state.info = info;
    attachVideo();

    state.chapters = chaptersFromInfo(info);
    addSegments(L.chaptersToSegments(state.chapters, 'chapters'));
    renderMarkers();

    if (settings.useSponsorBlock) {
      sendMessage({ type: 'sponsorblock', videoId }).then((res) => {
        if (!state || state.videoId !== videoId) return;
        if (res.segments) addSegments(res.segments);
        else if (res.error) LOG('SponsorBlock:', res.error);
        render();
      });
    }

    setStatus('Lade Transkript…');
    try {
      state.transcript = await fetchTranscript(info);
      if (!state || state.videoId !== videoId) return;
      state.transcriptText = L.transcriptToText(state.transcript.lines);
      setStatus(`Transkript geladen (${state.transcript.lines.length} Zeilen${state.transcript.kind === 'asr' ? ', automatisch' : ''}) · KI-Analyse ${costEstimate()}`);
    } catch (e) {
      if (!state || state.videoId !== videoId) return;
      setStatus('Kein Transkript: ' + e.message, true);
    }
    render();

    if (settings.autoAnalyze && state.transcript) {
      const minutes = (info.lengthSeconds || 0) / 60;
      if (settings.autoAnalyzeMaxMinutes > 0 && minutes > settings.autoAnalyzeMaxMinutes) {
        setStatus(`Auto-Analyse übersprungen: Video länger als ${settings.autoAnalyzeMaxMinutes} min (manuell per ✨ Analyse, ${costEstimate()})`);
      } else {
        runAnalysis(false).catch((e) => setStatus('KI-Analyse fehlgeschlagen: ' + e.message, true));
      }
    }
  }

  // Schätzung für eine KI-Analyse des aktuellen Transkripts.
  function costEstimate() {
    if (!state || !state.transcriptText) return '';
    const inTok = L.estimateTokens(state.transcriptText) + 400;
    const usd = L.estimateCostUsd(settings.model, inTok, 600);
    return `≈ ${L.formatTokens(inTok)} Tokens` + (usd === null ? '' : ` ≈ ${L.formatUsd(usd)}`);
  }

  async function ignoreSegment(key) {
    if (!state) return;
    state.ignored.add(key);
    state.segments = state.segments.filter((s) => L.segmentKey(s) !== key);
    try { await chrome.storage.local.set({ ['ignored:' + state.videoId]: [...state.ignored] }); } catch (e) { /* ignore */ }
    renderMarkers();
    render();
  }

  function chaptersFromInfo(info) {
    const yt = info.ytChapters && Array.isArray(info.ytChapters.chapters) ? info.ytChapters.chapters : [];
    const sorted = yt.filter((c) => Number.isFinite(c.start)).sort((a, b) => a.start - b.start);
    if (sorted.length >= 2) {
      return sorted.map((c, i) => ({
        start: c.start, title: c.title || `Kapitel ${i + 1}`,
        end: i + 1 < sorted.length ? sorted[i + 1].start : info.lengthSeconds,
      }));
    }
    return L.parseDescriptionChapters(info.description, info.lengthSeconds);
  }

  function attachVideo() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) { setTimeout(attachVideo, 500); return; }
    if (!state) return;
    if (state.video === v) return;
    if (state.video) state.video.removeEventListener('timeupdate', onTimeUpdate);
    state.video = v;
    v.addEventListener('timeupdate', onTimeUpdate);
  }

  function addSegments(segs) {
    if (!state || !segs || !segs.length) return;
    state.segments = L.mergeSegments([state.segments, segs]).filter((s) => !state.ignored.has(L.segmentKey(s)));
    renderMarkers();
  }

  const SKIPPABLE = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'filler', 'music_offtopic'];

  // ---------- Statistik: gesparte Zeit ----------
  async function recordSkip(seg) {
    try {
      const { skipStats = { count: 0, seconds: 0 } } = await chrome.storage.local.get('skipStats');
      skipStats.count += 1;
      skipStats.seconds += Math.max(0, seg.end - seg.start);
      await chrome.storage.local.set({ skipStats });
    } catch (e) { /* ignore */ }
  }

  function skipSegment(seg, undoable) {
    state.skipped.add(seg.category + '@' + seg.start.toFixed(1));
    seek(seg.end);
    recordSkip(seg);
    const label = L.CATEGORY_LABELS[seg.category] || seg.category;
    showToast(`${label} übersprungen (${L.formatTime(seg.start)} – ${L.formatTime(seg.end)})`,
      undoable ? { label: 'Rückgängig', onClick: () => seek(seg.start) } : null);
  }

  // ---------- Marker in der YouTube-Fortschrittsleiste ----------
  function renderMarkers() {
    if (!state || !state.info || !state.info.lengthSeconds) return;
    const barEl = document.querySelector('#movie_player .ytp-progress-bar');
    if (!barEl) return;
    let host = barEl.querySelector('.yts-markers');
    if (!host) { host = document.createElement('div'); host.className = 'yts-markers'; barEl.appendChild(host); }
    host.replaceChildren();
    const len = state.info.lengthSeconds;
    for (const s of state.segments) {
      if (s.category === 'chapter') continue;
      const m = document.createElement('span');
      m.className = 'c-' + s.category;
      m.style.left = (s.start / len * 100) + '%';
      m.style.width = Math.max(0.2, (s.end - s.start) / len * 100) + '%';
      m.title = `${L.CATEGORY_LABELS[s.category] || s.category} ${L.formatTime(s.start)} – ${L.formatTime(s.end)}`;
      host.appendChild(m);
    }
  }

  // ---------- Überspringen-Knopf im Player ----------
  let skipBtn = null;
  function updateSkipButton(t) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    const seg = state.segments.find((s) => SKIPPABLE.includes(s.category) && t >= s.start && t < s.end - 0.5);
    if (!seg) { if (skipBtn) skipBtn.hidden = true; return; }
    if (!skipBtn || !document.contains(skipBtn)) {
      skipBtn = el('button', { className: 'yts-skip-btn', onclick: () => { if (skipBtn._seg) skipSegment(skipBtn._seg, true); } });
      player.appendChild(skipBtn);
    }
    skipBtn._seg = seg;
    skipBtn.textContent = `${L.CATEGORY_LABELS[seg.category] || seg.category} überspringen ⏭`;
    skipBtn.hidden = false;
  }

  function setStatus(text, isError) {
    if (!state) return;
    state.status = text;
    state.error = isError ? text : '';
    renderStatus();
    notifyPopup();
  }

  // ---------- Auto-Skip ----------
  function onTimeUpdate() {
    if (!state || !state.video) return;
    const t = state.video.currentTime;
    if (settings.autoSkip) {
      for (const s of state.segments) {
        if (!settings.skipCategories[s.category]) continue;
        if (t >= s.start && t < s.end - 0.3) {
          if (state.skipped.has(s.category + '@' + s.start.toFixed(1))) continue;
          skipSegment(s, true);
          return;
        }
      }
    }
    updateSkipButton(t);
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

  const JUMPS = {
    intro: { cats: ['intro'], label: 'Intro', mode: 'skip' },
    sponsor: { cats: ['sponsor', 'selfpromo'], label: 'Sponsor', mode: 'skip' },
    conclusion: { cats: ['conclusion', 'outro'], label: 'Fazit', mode: 'to' },
  };

  function hasJump(key) {
    return !!state && state.segments.some((s) => JUMPS[key].cats.includes(s.category));
  }

  function jump(key) {
    const j = JUMPS[key];
    if (!j || !state) return;
    if (j.mode === 'skip') {
      const seg = L.findNextSegment(state.segments, j.cats, currentTime());
      if (!seg) { setStatus(`Kein ${j.label}-Segment bekannt – ggf. KI-Analyse starten.`); return; }
      skipSegment(seg, false);
    } else {
      // Erste Kategorie bevorzugen (Fazit vor Outro).
      let seg = null;
      for (const cat of j.cats) { seg = state.segments.find((s) => s.category === cat); if (seg) break; }
      if (!seg) { setStatus(`${j.label} nicht gefunden – ggf. KI-Analyse starten.`); return; }
      seek(seg.start);
      showToast(`${j.label} → ${L.formatTime(seg.start)}`);
    }
  }

  // ---------- KI ----------
  async function runAnalysis(force) {
    if (!state || !state.transcript || state.busy) return;
    const videoId = state.videoId;
    state.busy = true;
    setStatus('KI-Analyse läuft…');
    render();
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
    } catch (e) {
      setStatus('KI-Analyse fehlgeschlagen: ' + e.message, true);
    } finally {
      if (state && state.videoId === videoId) { state.busy = false; render(); }
    }
  }

  async function askAI(question) {
    if (!state || !state.transcript || state.busy) return;
    const videoId = state.videoId;
    state.chat.push({ role: 'user', text: question });
    state.busy = true;
    resultsOpen = true;
    render();
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
      if (state && state.videoId === videoId) { state.busy = false; render(); }
    }
  }

  function localSearch(query) {
    if (!state || !state.transcript) return;
    const hits = L.searchTranscript(state.transcript.lines, query, 8);
    state.chat.push({ role: 'user', text: query });
    state.chat.push({
      role: 'bot',
      text: hits.length ? `${hits.length} Treffer im Transkript:` : 'Keine Treffer im Transkript. Versuche „KI fragen“ für eine inhaltliche Suche.',
      matches: hits.map((h) => ({ start: h.start, label: h.text })),
      highlight: query,
    });
    resultsOpen = true;
    render();
  }

  // ---------- Schnittstelle zum Popup ----------
  function snapshot() {
    if (!state) return { active: false };
    return {
      active: true,
      videoId: state.videoId,
      title: state.info ? state.info.title : '',
      lengthSeconds: state.info ? state.info.lengthSeconds : 0,
      currentTime: currentTime(),
      status: state.status,
      error: state.error,
      busy: state.busy,
      hasTranscript: !!state.transcript,
      hasAnalysis: !!state.analysis,
      summary: state.analysis ? state.analysis.summary : '',
      segments: state.segments,
      chapters: state.chapters,
      chat: state.chat,
      jumps: { intro: hasJump('intro'), sponsor: hasJump('sponsor'), conclusion: hasJump('conclusion') },
      costEstimate: costEstimate(),
      transcript: state.transcript ? L.compactTranscript(state.transcript.lines) : [],
    };
  }

  function notifyPopup() {
    try {
      chrome.runtime.sendMessage({ type: 'ui:changed' }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* kein Empfänger */ }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ui:') || msg.type === 'ui:changed') return undefined;
    handleUi(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  });

  async function handleUi(msg) {
    switch (msg.type) {
      case 'ui:state': return snapshot();
      case 'ui:seek': seek(Number(msg.t)); return snapshot();
      case 'ui:search': localSearch(String(msg.query || '')); return snapshot();
      case 'ui:ask': await askAI(String(msg.question || '')); return snapshot();
      case 'ui:analyze': await runAnalysis(!!msg.force); return snapshot();
      case 'ui:jump': jump(msg.action); return snapshot();
      case 'ui:clearChat': if (state) state.chat = []; render(); return snapshot();
      case 'ui:command': runCommand(msg.command); return snapshot();
      case 'ui:ignoreSegment': await ignoreSegment(String(msg.key || '')); return snapshot();
      default: throw new Error('Unbekannt: ' + msg.type);
    }
  }

  function runCommand(command) {
    if (!state) return;
    if (command === 'skip-sponsor') jump('sponsor');
    else if (command === 'skip-intro') jump('intro');
    else if (command === 'jump-conclusion') jump('conclusion');
    else if (command === 'focus-search') {
      const input = bar && bar.querySelector('.yts-input');
      if (input) { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); input.focus(); input.select(); }
    }
  }

  // ---------- Suchleiste ----------
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

  function ensureBar() {
    if (!settings.showBar || !state) return false;
    if (bar && document.contains(bar)) return true;
    const host = document.querySelector('#below') || document.querySelector('#primary-inner') || document.querySelector('#secondary-inner');
    if (!host) { setTimeout(render, 700); return false; }
    bar = el('div', { id: 'yt-skipper-bar' });
    host.prepend(bar);
    return true;
  }

  function renderStatus() {
    const s = bar && bar.querySelector('.yts-status');
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

  function render() {
    notifyPopup();
    if (!state || !ensureBar()) return;
    // Eingabe und Fokus über das Neu-Rendern hinweg erhalten.
    const oldInput = bar.querySelector('.yts-input');
    const keep = oldInput ? { value: oldInput.value, focused: document.activeElement === oldInput, pos: oldInput.selectionStart } : null;
    bar.replaceChildren();
    const hasTranscript = !!state.transcript;
    const length = (state.info && state.info.lengthSeconds) || 0;

    // Segmentleiste
    const timeline = el('div', { className: 'yts-bar-timeline' });
    if (length) {
      for (const s of state.segments) {
        const left = (s.start / length) * 100;
        const width = Math.max(0.4, ((s.end - s.start) / length) * 100);
        timeline.appendChild(el('span', {
          className: 'c-' + s.category,
          style: `left:${left}%;width:${width}%`,
          title: `${L.CATEGORY_LABELS[s.category] || s.category}${s.title ? ': ' + s.title : ''} (${L.formatTime(s.start)} – ${L.formatTime(s.end)}, ${s.source})`,
          onclick: () => seek(s.start),
        }));
      }
    }
    bar.appendChild(timeline);

    // Suchzeile
    const input = el('input', {
      type: 'text', className: 'yts-input',
      placeholder: hasTranscript ? 'Im Video suchen … (Enter = Text, Strg+Enter = KI)' : 'Kein Transkript verfügbar',
      disabled: !hasTranscript,
    });
    const doLocal = () => { const q = input.value.trim(); if (q) { input.value = ''; localSearch(q); } };
    const doAI = () => { const q = input.value.trim(); if (q) { input.value = ''; askAI(q); } };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (e.shiftKey || e.ctrlKey || e.metaKey) doAI(); else doLocal(); }
      e.stopPropagation();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());

    const chip = (key, icon, label) => el('button', {
      className: 'yts-chip', disabled: !hasJump(key), title: label, onclick: () => jump(key),
    }, [icon + ' ' + label]);

    bar.appendChild(el('div', { className: 'yts-bar-row' }, [
      el('span', { className: 'yts-logo', title: 'YouTube Skipper' }, ['⏭']),
      input,
      el('button', { className: 'yts-chip', disabled: !hasTranscript, onclick: doLocal, title: 'Volltextsuche im Transkript (kostenlos)' }, ['🔍']),
      el('button', { className: 'yts-chip primary', disabled: !hasTranscript || state.busy, onclick: doAI, title: 'Inhaltliche Frage an Claude' }, ['KI fragen']),
      chip('intro', '⏩', 'Intro'),
      chip('sponsor', '💰', 'Sponsor'),
      chip('conclusion', '🎯', 'Fazit'),
      el('button', {
        className: 'yts-chip', disabled: !hasTranscript || state.busy,
        title: 'Kapitel, Intro/Outro, Sponsor und Fazit per Claude erkennen',
        onclick: () => runAnalysis(!!state.analysis),
      }, [state.busy ? '…' : (state.analysis ? '🔄' : '✨'), ' Analyse']),
      el('button', {
        className: 'yts-chip', title: resultsOpen ? 'Ergebnisse einklappen' : 'Ergebnisse ausklappen',
        onclick: () => { resultsOpen = !resultsOpen; render(); },
      }, [resultsOpen ? '▴' : '▾']),
    ]));

    // Ergebnisse / Chat
    if (resultsOpen && (state.chat.length || state.chapters.length || state.analysis || state.segments.length)) {
      const box = el('div', { className: 'yts-results' });
      if (state.chat.length) {
        for (const m of state.chat) {
          const msg = el('div', { className: 'yts-msg ' + m.role }, [m.text]);
          for (const hit of m.matches || []) msg.appendChild(hitRow(hit.start, hit.label, m.highlight));
          box.appendChild(msg);
        }
        box.appendChild(el('button', { className: 'yts-link', onclick: () => { state.chat = []; render(); } }, ['Verlauf leeren']));
      }
      if (state.analysis && state.analysis.summary) {
        box.appendChild(el('details', null, [el('summary', null, ['Zusammenfassung (KI)']), el('div', { className: 'yts-msg' }, [state.analysis.summary])]));
      }
      if (state.chapters.length) {
        const list = el('div', { className: 'yts-chapters' });
        for (const c of state.chapters) list.appendChild(hitRow(c.start, c.title));
        box.appendChild(el('details', null, [el('summary', null, [`Kapitel (${state.chapters.length})`]), list]));
      }
      const segs = state.segments.filter((s) => s.category !== 'chapter');
      if (segs.length) {
        const list = el('div', { className: 'yts-chapters' });
        for (const s of segs) {
          const row = hitRow(s.start, `${L.CATEGORY_LABELS[s.category] || s.category} bis ${L.formatTime(s.end)}${s.title ? ' · ' + s.title : ''} (${s.source})`);
          row.appendChild(el('button', {
            className: 'yts-x', title: 'Dieses Segment für dieses Video ignorieren',
            onclick: (e) => { e.stopPropagation(); ignoreSegment(L.segmentKey(s)); },
          }, ['✕']));
          list.appendChild(row);
        }
        box.appendChild(el('details', null, [el('summary', null, [`Segmente (${segs.length})`]), list]));
      }
      bar.appendChild(box);
      box.scrollTop = box.scrollHeight;
    }

    bar.appendChild(el('div', { className: 'yts-status' + (state.error ? ' yts-error' : '') }, [state.status]));

    if (keep && !input.disabled) {
      input.value = keep.value;
      if (keep.focused) {
        input.focus({ preventScroll: true });
        try { input.setSelectionRange(keep.pos, keep.pos); } catch (e) { /* ignore */ }
      }
    }
  }

  // ---------- Start ----------
  loadSettings().then(() => {
    document.addEventListener('yt-navigate-finish', () => setTimeout(checkNavigation, 50));
    setInterval(checkNavigation, 1500);
    checkNavigation();
  });
})();
