// Service Worker: SponsorBlock-Abfragen, Claude-API-Aufrufe, Cache und Nutzungsstatistik.
'use strict';
importScripts('../content/lib.js');
const L = globalThis.YTSkipperLib;
const t = L.t;

const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments';
const SPONSORBLOCK_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'filler', 'music_offtopic'];
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';
// Modelle, die den serverseitigen Refusal-Fallback unterstützen.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const CACHE_LIMIT = 100;

const SYSTEM_PROMPT =
  'Du bist ein Assistent, der Transkripte von YouTube-Videos auswertet. ' +
  'Das Transkript besteht aus Zeilen im Format "[m:ss] Text" bzw. "[h:mm:ss] Text". ' +
  'Zeitangaben in deiner Antwort sind immer Sekunden ab Videobeginn (Zahl).';

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, title: { type: 'string' } },
        required: ['start', 'title'],
        additionalProperties: false,
      },
    },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          category: { type: 'string', enum: ['intro', 'sponsor', 'selfpromo', 'interaction', 'outro', 'conclusion'] },
          note: { type: 'string' },
        },
        required: ['start', 'end', 'category', 'note'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['chapters', 'segments', 'summary'],
  additionalProperties: false,
};

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, label: { type: 'string' } },
        required: ['start', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'matches'],
  additionalProperties: false,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.startsWith('ui:')) return undefined; // Popup/Content-Script-Nachrichten
  handle(msg)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ error: e && e.message ? e.message : String(e) }));
  return true; // asynchrone Antwort
});

async function handle(msg) {
  switch (msg.type) {
    case 'sponsorblock': return { segments: await fetchSponsorBlock(msg.videoId) };
    case 'analyze': return analyze(msg);
    case 'ask': return ask(msg);
    case 'clearCache': return clearCache();
    default: throw new Error('Unbekannter Nachrichtentyp: ' + msg.type);
  }
}

// ---------- SponsorBlock (kostenlos, Community-Daten, Lizenz CC BY-NC-SA 4.0) ----------
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchSponsorBlock(videoId) {
  if (!videoId) return [];
  // Datenschutzfreundliche Variante: nur Hash-Präfix senden, Server liefert alle passenden Videos.
  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const url = `${SPONSORBLOCK_API}/${prefix}?categories=${encodeURIComponent(JSON.stringify(SPONSORBLOCK_CATEGORIES))}`;
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('SponsorBlock ' + res.status);
  const list = await res.json();
  const entry = Array.isArray(list) ? list.find((v) => v.videoID === videoId) : null;
  if (!entry) return [];
  return (entry.segments || [])
    .filter((s) => s.actionType === undefined || s.actionType === 'skip')
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, source: 'sponsorblock' }));
}

// ---------- Claude ----------
async function getApiConfig() {
  const local = await chrome.storage.local.get('apiKey');
  const sync = await chrome.storage.sync.get('settings');
  const model = (sync.settings && sync.settings.model) || DEFAULT_MODEL;
  if (!local.apiKey) throw new Error(t('err_no_key'));
  return { apiKey: local.apiKey, model };
}

function transcriptBlock(title, transcriptText) {
  return {
    type: 'text',
    text: `Videotitel: ${title}\n\nTranskript:\n${transcriptText}`,
    // Das Transkript ist der stabile Präfix – wird für Analyse und alle Folgefragen gecacht.
    cache_control: { type: 'ephemeral' },
  };
}

async function claudeJson({ apiKey, model, userBlocks, schema, maxTokens, effort }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT + ' ' + t('prompt_language'),
    messages: [{ role: 'user', content: userBlocks }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // Erforderlich für direkte Aufrufe aus dem Browser (CORS).
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const res = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error?.message || detail; } catch (e) { /* ignore */ }
    if (res.status === 401) detail = t('err_key_invalid');
    if (res.status === 429) detail = t('err_rate_limit');
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  await recordUsage(model, data.usage);
  if (data.stop_reason === 'refusal') {
    const cat = data.stop_details && data.stop_details.category;
    throw new Error(t('err_refusal') + (cat ? ` (${cat})` : ''));
  }
  if (data.stop_reason === 'max_tokens') throw new Error(t('err_truncated'));
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { json: JSON.parse(text), usage: data.usage };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n) || 0)); }

async function analyze(msg) {
  const cacheKey = 'analysis:' + msg.videoId;
  if (!msg.force) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) return { ...cached[cacheKey].data, cached: true };
  }
  const { apiKey, model } = await getApiConfig();
  const len = Number(msg.lengthSeconds) || 0;
  const task =
    `Analysiere das Transkript (Videolänge ${Math.round(len)} s) und liefere:\n` +
    '1. "chapters": sinnvolle inhaltliche Kapitel (3–12 Stück, erstes bei 0) mit kurzem Titel.\n' +
    '2. "segments": Abschnitte, die Nutzer gern überspringen oder gezielt anspringen:\n' +
    '   - "intro": Begrüßung/Vorspann/Themenankündigung am Anfang ohne eigentlichen Inhalt\n' +
    '   - "sponsor": bezahlte Werbung für Fremdprodukte (Sponsor-Segmente, Rabattcodes)\n' +
    '   - "selfpromo": Eigenwerbung (Merch, Kurse, Patreon, eigene Produkte)\n' +
    '   - "interaction": Aufrufe zu Like/Abo/Kommentar/Glocke\n' +
    '   - "conclusion": das Fazit / die Zusammenfassung / das Endergebnis\n' +
    '   - "outro": Verabschiedung/Abspann nach dem Fazit\n' +
    '   Nur Segmente aufnehmen, die wirklich vorkommen. "start"/"end" in Sekunden, ' +
    'möglichst exakt an den Zeitmarken orientiert, "note" = 3–8 Wörter Begründung.\n' +
    '3. "summary": Zusammenfassung des Videos in 2–3 Sätzen.';
  const { json, usage } = await claudeJson({
    apiKey, model, schema: ANALYZE_SCHEMA, maxTokens: 8192, effort: 'medium',
    userBlocks: [transcriptBlock(msg.title, msg.transcriptText), { type: 'text', text: task }],
  });
  const data = {
    chapters: (json.chapters || []).map((c) => ({ start: clamp(c.start, 0, len || Infinity), title: String(c.title || '') }))
      .sort((a, b) => a.start - b.start),
    segments: (json.segments || [])
      .map((s) => ({ start: clamp(s.start, 0, len || Infinity), end: clamp(s.end, 0, len || Infinity), category: s.category, note: s.note }))
      .filter((s) => s.end > s.start),
    summary: String(json.summary || ''),
    model,
    usage,
    createdAt: Date.now(),
  };
  await storeCached(cacheKey, data);
  return { ...data, cached: false };
}

async function ask(msg) {
  const { apiKey, model } = await getApiConfig();
  const task =
    `Frage des Nutzers: ${msg.question}\n\n` +
    'Beantworte die Frage kurz anhand des Transkripts ("answer", 1–3 Sätze) und liste in "matches" die ' +
    'relevantesten Stellen (1–5) mit Startzeit in Sekunden und einem kurzen Label (max. 10 Wörter), ' +
    'sortiert nach Relevanz. Wenn das Thema im Video nicht vorkommt, sage das und lasse "matches" leer.';
  const { json } = await claudeJson({
    apiKey, model, schema: ASK_SCHEMA, maxTokens: 2048, effort: 'low',
    userBlocks: [transcriptBlock(msg.title, msg.transcriptText), { type: 'text', text: task }],
  });
  return {
    answer: String(json.answer || ''),
    matches: (json.matches || []).map((m) => ({ start: Math.max(0, Number(m.start) || 0), label: String(m.label || '') })),
  };
}

// ---------- Cache & Statistik ----------
async function storeCached(key, data) {
  await chrome.storage.local.set({ [key]: { data, t: Date.now() } });
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('analysis:')).sort((a, b) => all[a].t - all[b].t);
  if (keys.length > CACHE_LIMIT) await chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_LIMIT));
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('analysis:'));
  await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

async function recordUsage(model, usage) {
  if (!usage) return;
  const { usageTotals = {} } = await chrome.storage.local.get('usageTotals');
  const u = usageTotals[model] || { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  u.calls += 1; u.input += input; u.output += output; u.cacheRead += cacheRead; u.cacheWrite += cacheWrite;
  const p = L.PRICES[model];
  if (p) {
    u.usd += (input * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.cacheRead + output * p.output) / 1e6;
  }
  usageTotals[model] = u;
  await chrome.storage.local.set({ usageTotals });
}

// ---------- Tastenkürzel (chrome://extensions/shortcuts) ----------
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ui:command', command }, () => { void chrome.runtime.lastError; });
});
