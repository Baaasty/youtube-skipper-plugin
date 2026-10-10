// Läuft in der MAIN-World der YouTube-Seite (Zugriff auf Player-API und ytcfg).
// Kommuniziert ausschließlich per CustomEvent (String-Payload) mit content.js.
(() => {
  if (window.__ytSkipperMainWorld) return;
  window.__ytSkipperMainWorld = true;

  const REQ = 'ytskipper:request-player';
  const RES = 'ytskipper:player-response';
  const SEEK = 'ytskipper:seek';

  function getPlayerResponse() {
    const player = document.getElementById('movie_player');
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        const r = player.getPlayerResponse();
        if (r && r.videoDetails) return r;
      }
    } catch (e) { /* Player noch nicht bereit */ }
    return window.ytInitialPlayerResponse || null;
  }

  function trackName(t) {
    if (!t || !t.name) return '';
    if (t.name.simpleText) return t.name.simpleText;
    if (Array.isArray(t.name.runs)) return t.name.runs.map((r) => r.text).join('');
    return '';
  }

  // Parameter des "Transkript anzeigen"-Endpunkts aus den Seitendaten (für den get_transcript-Fallback).
  function findTranscriptParams(videoId) {
    const sources = [];
    try { const app = document.querySelector('ytd-app'); if (app && app.data) sources.push(app.data); } catch (e) { /* ignore */ }
    if (window.ytInitialData) sources.push(window.ytInitialData);
    for (const src of sources) {
      try {
        const text = JSON.stringify(src);
        if (videoId && !text.includes('"videoId":"' + videoId + '"')) continue;
        const m = text.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
        if (m) return m[1];
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function ytcfgGet(key) {
    try { return window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get(key) : undefined; } catch (e) { return undefined; }
  }

  document.addEventListener(REQ, (e) => {
    const wantedId = typeof e.detail === 'string' ? e.detail : '';
    const r = getPlayerResponse();
    let payload = null;
    if (r && r.videoDetails && (!wantedId || r.videoDetails.videoId === wantedId)) {
      const tracks = (r.captions && r.captions.playerCaptionsTracklistRenderer &&
        r.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      payload = {
        videoId: r.videoDetails.videoId,
        title: r.videoDetails.title || '',
        lengthSeconds: Number(r.videoDetails.lengthSeconds) || 0,
        description: r.videoDetails.shortDescription || '',
        isLive: !!(r.videoDetails.isLive || r.videoDetails.isLiveContent),
        captionTracks: tracks.map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode || '',
          kind: t.kind || '',
          name: trackName(t),
        })),
        transcriptParams: findTranscriptParams(r.videoDetails.videoId),
        clientVersion: ytcfgGet('INNERTUBE_CLIENT_VERSION') || '',
        apiKey: ytcfgGet('INNERTUBE_API_KEY') || '',
      };
    }
    document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(payload) }));
  });

  document.addEventListener(SEEK, (e) => {
    const t = Number(e.detail);
    if (!Number.isFinite(t)) return;
    const player = document.getElementById('movie_player');
    try {
      if (player && typeof player.seekTo === 'function') { player.seekTo(t, true); return; }
    } catch (err) { /* fallback unten */ }
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  });
})();
