// End-to-End-Test: lädt die Extension in Chromium und spielt eine gemockte YouTube-Watch-Seite durch
// (Untertitel-Endpunkt, SponsorBlock und Claude API werden per Playwright-Route simuliert).
// Voraussetzung: `playwright` (lokal oder global installiert) und ein Chromium-Build.
// Aufruf: node test/e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* global fallback */ }
  const root = execSync('npm root -g').toString().trim();
  return require(path.join(root, 'playwright'));
}
const { chromium } = loadPlaywright();

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-skipper-e2e-'));

// 120 s stilles WAV als seekbares Testmedium (ein <video> spielt auch reine Audiodateien ab).
function writeSilentWav(file, seconds) {
  const rate = 8000, data = Buffer.alloc(rate * seconds, 0x80), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
writeSilentWav(SCR + '/test.wav', 120);
const VID = 'test0000001';
const out = [];
const log = (...a) => { console.log(...a); out.push(a.join(' ')); };
const fail = (m) => { log('FAIL:', m); process.exitCode = 1; };
const expect = (cond, m) => cond ? log('ok -', m) : fail(m);

const watchHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Testvideo - YouTube</title></head><body>
<div id="movie_player"><video class="html5-main-video" src="https://www.youtube.com/mock.wav" muted preload="auto"></video></div>
<div id="secondary"><div id="secondary-inner"><div id="related">Empfehlungen</div></div></div>
<script>
  const pr = {
    videoDetails: { videoId: '${VID}', title: 'Testvideo', lengthSeconds: '120',
      shortDescription: 'Beschreibung\\n0:00 Intro\\n0:20 Installation\\n1:00 Preise\\n1:30 Fazit' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=${VID}&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' } },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=${VID}&lang=de', languageCode: 'de', name: { runs: [{ text: 'Deutsch' }] } } ] } },
  };
  const p = document.getElementById('movie_player');
  p.getPlayerResponse = () => pr;
  p.seekTo = (t) => { document.querySelector('video').currentTime = t; };
  window.ytcfg = { get: (k) => ({ INNERTUBE_CLIENT_VERSION: '2.20260101.00.00', INNERTUBE_API_KEY: 'k' })[k] };
</script></body></html>`;

const transcriptEvents = [];
const texts = ['Hallo und herzlich willkommen zum Video', 'heute geht es um die Installation des Tools', 'zuerst laden wir das Paket herunter',
  'dieses Video wird gesponsert von Beispielfirma', 'mit dem Code SKIP gibt es zwanzig Prozent Rabatt', 'zurück zum Thema Installation',
  'die Konfiguration erfolgt über eine Datei', 'der Preis liegt bei zehn Euro pro Monat', 'das ist fair für den Funktionsumfang',
  'mein Fazit das Tool lohnt sich', 'vielen Dank fürs Zuschauen und bis zum nächsten Mal'];
texts.forEach((t, i) => transcriptEvents.push({ tStartMs: i * 11000, dDurationMs: 10000, segs: [{ utf8: t }] }));
transcriptEvents.push({ tStartMs: 500, dDurationMs: 1, aAppend: 1, segs: [{ utf8: '\n' }] });

const analyzeJson = { chapters: [{ start: 0, title: 'Intro' }, { start: 20, title: 'Installation' }, { start: 99, title: 'Fazit' }],
  segments: [{ start: 0, end: 10, category: 'intro', note: 'Begrüßung' }, { start: 33, end: 55, category: 'sponsor', note: 'Beispielfirma Rabattcode' },
    { start: 99, end: 110, category: 'conclusion', note: 'Fazit' }], summary: 'Das Video zeigt die Installation eines Tools.' };
const askJson = { answer: 'Der Preis wird bei 1:17 genannt: zehn Euro pro Monat.', matches: [{ start: 77, label: 'Preis zehn Euro pro Monat' }] };
const apiCalls = [];

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const ctx = await chromium.launchPersistentContext(SCR + '/profile-e2e', {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
await ctx.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('chrome-extension://')) return route.continue();
  if (url.startsWith('https://www.youtube.com/watch')) return route.fulfill({ contentType: 'text/html', body: watchHtml });
  if (url.startsWith('https://www.youtube.com/api/timedtext')) {
    expect(url.includes('lang=de') && url.includes('fmt=json3'), 'deutsche Spur mit fmt=json3 angefragt');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: transcriptEvents }) });
  }
  if (url === 'https://www.youtube.com/mock.wav') {
    const buf = fs.readFileSync(SCR + '/test.wav');
    const m = (route.request().headers()['range'] || '').match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = +m[1], end = m[2] ? +m[2] : buf.length - 1;
      return route.fulfill({ status: 206, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': String(end - start + 1) }, body: buf.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(buf.length) }, body: buf });
  }
  if (url.startsWith('https://sponsor.ajay.app/api/skipSegments/')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { videoID: 'other', segments: [{ segment: [1, 2], category: 'sponsor', UUID: 'x' }] },
      { videoID: VID, segments: [{ segment: [40, 55], category: 'sponsor', UUID: 'u1', actionType: 'skip' }, { segment: [110, 120], category: 'outro', UUID: 'u2', actionType: 'skip' }] } ]) });
  }
  if (url.startsWith('https://api.anthropic.com/v1/messages')) {
    const req = route.request();
    const body = JSON.parse(req.postData());
    apiCalls.push({ headers: req.headers(), body });
    const isAsk = JSON.stringify(body).includes('Frage des Nutzers');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(isAsk ? askJson : analyzeJson) }],
      usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 900, cache_read_input_tokens: isAsk ? 900 : 0 } }) });
  }
  return route.abort();
});

let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ apiKey: 'sk-ant-test' });
  await chrome.storage.sync.set({ settings: { autoSkip: true, useSponsorBlock: true, autoAnalyze: true, showPanel: true, language: 'de', model: 'claude-opus-5-5',
    skipCategories: { sponsor: true, selfpromo: true } } });
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('net::ERR')) errors.push(m.text()); });
await page.goto(`https://www.youtube.com/watch?v=${VID}`);
await page.waitForSelector('#yt-skipper-bar');
await page.waitForFunction(() => /Transkript geladen|KI-Analyse/.test(document.querySelector('#yt-skipper-bar .yts-status').textContent), null, { timeout: 15000 });
log('status:', await page.textContent('#yt-skipper-bar .yts-status'));
await page.waitForFunction(() => /KI-Analyse fertig/.test(document.querySelector('#yt-skipper-bar .yts-status').textContent), null, { timeout: 15000 }).catch(() => {});
log('status:', await page.textContent('#yt-skipper-bar .yts-status'));

const buttons = await page.$$eval('#yt-skipper-bar .yts-chip', (b) => b.map((x) => x.textContent.trim() + (x.disabled ? ' (aus)' : '')));
log('buttons:', buttons.join(' | '));
expect(buttons.some((b) => b.startsWith('⏩') && !b.includes('(aus)')), 'Intro-Button aktiv');
expect(buttons.some((b) => b.startsWith('💰') && !b.includes('(aus)')), 'Sponsor-Button aktiv');
expect(buttons.some((b) => b.startsWith('🎯') && !b.includes('(aus)')), 'Fazit-Button aktiv');
const segs = await page.$$eval('#yt-skipper-bar .yts-bar-timeline span', (s) => s.map((x) => x.title));
log('segmente:', segs.join(' || '));
expect(segs.some((t) => t.startsWith('Sponsor') && t.includes('sponsorblock')), 'SponsorBlock-Segment vorhanden (Service-Worker-Fetch)');
expect(segs.some((t) => t.includes('ai')), 'KI-Segmente vorhanden');
expect(segs.some((t) => t.startsWith('Sponsor') && t.includes('0:33 – 0:55')), 'überlappende Sponsor-Segmente (SB 40–55 + KI 33–55) vereinigt');
const chapters = await page.$$eval('#yt-skipper-bar .yts-chapters .yts-hit', (h) => h.map((x) => x.textContent));
expect(chapters.length === 4, 'Kapitel aus Beschreibung (' + chapters.length + ')');

// Claude-Request prüfen
expect(apiCalls.length >= 1, 'Analyse-Request an Claude gesendet (' + apiCalls.length + ')');
if (apiCalls[0]) {
  const { headers, body } = apiCalls[0];
  expect(headers['x-api-key'] === 'sk-ant-test' && headers['anthropic-version'] === '2023-06-01', 'API-Header gesetzt');
  expect(headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Browser-Access-Header gesetzt');
  expect(headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && body.fallbacks === 'default', 'Server-Fallback aktiviert');
  expect(body.model === 'claude-opus-5-5' && body.output_config.format.type === 'json_schema' && body.output_config.effort === 'medium', 'Modell/JSON-Schema/Effort korrekt');
  expect(body.messages[0].content[0].cache_control?.type === 'ephemeral' && body.messages[0].content[0].text.includes('[0:33] dieses Video wird gesponsert'), 'Transkriptblock mit cache_control und Zeitmarken');
}

// Zum Fazit
await page.click('#yt-skipper-bar .yts-chip:has-text("Fazit")');
await page.waitForTimeout(500);
let ct = await page.$eval('video', (v) => v.currentTime);
expect(Math.abs(ct - 90) < 1.5, 'Zum Fazit springt auf Kapitel „Fazit“ bei 1:30 (ist ' + ct.toFixed(1) + ')');

// Lokale Suche
await page.fill('#yt-skipper-bar .yts-input', 'Preis Euro');
await page.press('#yt-skipper-bar .yts-input', 'Enter');
await page.waitForSelector('#yt-skipper-bar .yts-msg.bot');
const hits = await page.$$eval('#yt-skipper-bar .yts-msg.bot .yts-hit', (h) => h.map((x) => x.textContent));
log('suche:', hits.join(' || '));
expect(hits.length >= 1 && hits[0].startsWith('1:17'), 'lokale Suche findet Preis-Stelle bei 1:17');
expect(await page.$$eval('#yt-skipper-bar mark', (m) => m.length) >= 2, 'Treffer hervorgehoben');
await page.click('#yt-skipper-bar .yts-msg.bot .yts-hit');
await page.waitForTimeout(400);
ct = await page.$eval('video', (v) => v.currentTime);
expect(Math.abs(ct - 77) < 1.5, 'Klick auf Treffer springt im Video (ist ' + ct.toFixed(1) + ')');

// KI fragen
await page.fill('#yt-skipper-bar .yts-input', 'Wo wird der Preis genannt?');
await page.click('#yt-skipper-bar .yts-chip:has-text("KI fragen")');
await page.waitForFunction(() => document.querySelectorAll('#yt-skipper-bar .yts-msg.bot').length >= 2, null, { timeout: 10000 });
const bot = await page.$$eval('#yt-skipper-bar .yts-msg.bot', (m) => m.map((x) => x.textContent));
log('ki:', bot[bot.length - 1]);
expect(bot[bot.length - 1].includes('zehn Euro') && bot[bot.length - 1].includes('1:17'), 'KI-Antwort mit Treffer gerendert');
expect(apiCalls.length === 2 && apiCalls[1].body.output_config.effort === 'low', 'Frage-Request mit effort=low');

// Auto-Skip: in Sponsor-Segment (33–55) hineinspielen
await page.$eval('video', (v) => { v.currentTime = 31; return v.play(); });
await page.waitForFunction(() => /übersprungen/.test(document.querySelector('.yts-toast')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(300);
const toast = await page.$eval('.yts-toast', (t) => t.textContent).catch(() => '');
ct = await page.$eval('video', (v) => v.currentTime);
log('toast:', toast, '| currentTime:', ct.toFixed(1));
expect(toast.includes('Sponsor übersprungen'), 'Auto-Skip-Toast');
expect(ct >= 55, 'Video nach Sponsor-Ende (≥55) fortgesetzt');
await page.click('.yts-toast button');
await page.waitForTimeout(300);
ct = await page.$eval('video', (v) => v.currentTime);
expect(ct >= 33 && ct < 36, 'Rückgängig springt zurück zum Segmentstart (ist ' + ct.toFixed(1) + ')');
await page.$eval('video', (v) => v.pause());

const usage = await sw.evaluate(() => chrome.storage.local.get(['usageTotals', 'analysis:test0000001']));
expect(usage.usageTotals?.['claude-opus-5-5']?.calls === 2 && usage['analysis:test0000001']?.data?.segments?.length === 3, 'Nutzungsstatistik und Analyse-Cache geschrieben');

// Cache-Treffer bei erneutem Laden
await page.goto('https://www.youtube.com/watch?v=' + VID);
await page.waitForFunction(() => /aus Cache/.test(document.querySelector('#yt-skipper-bar .yts-status')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
log('status 2. Laden:', await page.textContent('#yt-skipper-bar .yts-status'));
expect(apiCalls.length === 2, 'kein weiterer API-Aufruf beim zweiten Laden (Cache)');

// Toolbar-Popup: findet den YouTube-Tab, zeigt denselben Chat, kann suchen und springen
const extId = new URL(sw.url()).host;
const popup = await ctx.newPage();
popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForFunction(() => !document.getElementById('video').hidden && document.getElementById('title').textContent.length > 0, null, { timeout: 10000 });
expect((await popup.textContent('#title')) === 'Testvideo', 'Popup zeigt Titel des YouTube-Tabs');
expect((await popup.$$eval('#chat .msg', (m) => m.length)) === 0, 'Popup-Chat ist nach Neuladen der Seite leer');
expect((await popup.$$eval('#timeline span', (m) => m.length)) >= 5, 'Popup zeigt die Segmentleiste');
await popup.fill('#query', 'Konfiguration');
await popup.press('#query', 'Enter');
await popup.waitForFunction(() => /Konfiguration/.test(document.getElementById('chat').textContent) && document.querySelectorAll('#chat .hit').length > 0, null, { timeout: 10000 });
const popHits = await popup.$$eval('#chat .msg:last-of-type .hit', (h) => h.map((x) => x.textContent));
expect(popHits.some((h) => h.startsWith('1:06')), 'Suche aus dem Popup findet 1:06 (' + popHits.join(' | ') + ')');
expect((await popup.$$eval('#chat .msg', (m) => m.length)) === 2, 'Popup zeigt den Chat-Verlauf (Frage + Antwort)');
await popup.click('#chat .msg:last-of-type .hit');
await page.waitForTimeout(400);
ct = await page.$eval('video', (v) => v.currentTime);
expect(Math.abs(ct - 66) < 1.5, 'Klick im Popup springt im YouTube-Tab (ist ' + ct.toFixed(1) + ')');
expect(/Konfiguration/.test(await page.textContent('#yt-skipper-bar')), 'Popup-Suche erscheint auch in der Suchleiste der Seite');
await page.$eval('video', (v) => { v.currentTime = 3; });
await page.waitForTimeout(300);
await popup.click('[data-jump="intro"]');
await page.waitForTimeout(400);
ct = await page.$eval('video', (v) => v.currentTime);
expect(Math.abs(ct - 20) < 1.5, 'Intro skippen aus dem Popup (ist ' + ct.toFixed(1) + ')');
await popup.click('.tab[data-tab="settings"]');
const frame = popup.frameLocator('#settingsFrame');
await frame.locator('#apiKey').waitFor();
expect((await frame.locator('#model').inputValue()) === 'claude-opus-5-5', 'Einstellungen-Tab lädt gespeicherte Werte');
await popup.screenshot({ path: SCR + '/popup-settings.png' });
await popup.click('.tab[data-tab="search"]');
await popup.screenshot({ path: SCR + '/popup.png' });
await popup.close();

await page.screenshot({ path: SCR + '/e2e.png', fullPage: true });
log('page errors:', JSON.stringify(errors));
expect(errors.length === 0, 'keine JS-Fehler');
await ctx.close();
if (process.env.E2E_KEEP) log('Artefakte:', SCR); else fs.rmSync(SCR, { recursive: true, force: true });
log(process.exitCode ? 'E2E: FEHLER' : 'E2E: alle Prüfungen bestanden');
