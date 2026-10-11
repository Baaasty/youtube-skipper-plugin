// Reine Hilfsfunktionen ohne DOM-Zugriff (testbar mit Node, siehe test/).
(function (root) {
  'use strict';

  const CATEGORY_LABELS = {
    sponsor: 'Sponsor',
    selfpromo: 'Eigenwerbung',
    interaction: 'Like/Abo-Aufruf',
    intro: 'Intro',
    outro: 'Outro',
    preview: 'Vorschau/Recap',
    filler: 'Füller',
    music_offtopic: 'Musik (Off-Topic)',
    conclusion: 'Fazit',
    chapter: 'Kapitel',
  };

  // Übersetzung über chrome.i18n; außerhalb der Extension (Node-Tests) Fallback auf den Schlüssel.
  function t(key, subs) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
        const list = subs === undefined ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);
        const msg = chrome.i18n.getMessage(key, list);
        if (msg) return msg;
      }
    } catch (e) { /* ignore */ }
    return key;
  }

  function categoryLabel(cat) {
    const msg = t('cat_' + cat);
    return msg !== 'cat_' + cat ? msg : (CATEGORY_LABELS[cat] || cat);
  }

  const INTRO_RE = /\b(intro|einleitung|einführung|begrüßung|begruessung|vorstellung|welcome|opening|hallo|start)\b/i;
  const CONCLUSION_RE = /\b(fazit|zusammenfassung|schluss|ergebnis|resümee|resumee|conclusion|summary|recap|verdict|final thoughts|takeaways|wrap[- ]?up|ending|outro|abschluss|ende)\b/i;
  const SPONSOR_RE = /\b(sponsor|werbung|anzeige|ad\b|advertisement|partner)\b/i;

  // USD pro 1M Tokens (Stand Oktober 2026) – nur für Schätzungen.
  const PRICES = {
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  };

  // Grobe Token-Schätzung für Transkripttext (ca. 3,3 Zeichen pro Token bei deutschem/englischem Text).
  function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 3.3);
  }

  function estimateCostUsd(model, inputTokens, outputTokens) {
    const p = PRICES[model];
    if (!p) return null;
    return (inputTokens * p.input + (outputTokens || 0) * p.output) / 1e6;
  }

  function formatUsd(usd) {
    if (usd === null || usd === undefined) return '';
    if (usd < 0.01) return '< 0,01 $';
    return usd.toFixed(2).replace('.', ',') + ' $';
  }

  function formatTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace('.', ',') + 'k' : String(n);
  }

  // Kapitel im YouTube-Beschreibungsformat ("0:00 Titel").
  function chaptersToDescription(chapters) {
    return (chapters || []).map((c) => `${formatTime(c.start)} ${c.title}`).join('\n');
  }

  function segmentKey(seg) {
    return seg.category + '@' + Math.round(seg.start);
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function parseTimestamp(str) {
    const parts = str.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  // Kapitel aus der Videobeschreibung ("0:00 Intro", "[12:30] Fazit", "1:02:10 - Ende").
  function parseDescriptionChapters(description, lengthSeconds) {
    const chapters = [];
    const re = /^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|.]?\s*(.+?)\s*$/;
    for (const line of String(description || '').split(/\r?\n/)) {
      const m = line.match(re);
      if (!m) continue;
      const start = parseTimestamp(m[1]);
      if (start === null) continue;
      chapters.push({ start, title: m[2].replace(/^[-–—:|.]\s*/, '').trim() });
    }
    chapters.sort((a, b) => a.start - b.start);
    // YouTube verlangt, dass Kapitel bei 0:00 beginnen und mindestens 3 Stück sind.
    if (chapters.length < 3 || chapters[0].start !== 0) return [];
    return chapters.map((c, i) => ({
      ...c,
      end: i + 1 < chapters.length ? chapters[i + 1].start : (lengthSeconds || chapters[i].start + 60),
    }));
  }

  function classifyChapterTitle(title) {
    if (SPONSOR_RE.test(title)) return 'sponsor';
    if (INTRO_RE.test(title)) return 'intro';
    if (CONCLUSION_RE.test(title)) return 'conclusion';
    return 'chapter';
  }

  function chaptersToSegments(chapters, source) {
    return chapters.map((c) => ({
      start: c.start,
      end: c.end,
      category: classifyChapterTitle(c.title),
      title: c.title,
      source: source || 'chapters',
    }));
  }

  // Transkriptzeilen zu kompakten Blöcken zusammenfassen (spart Tokens), Format "[m:ss] Text".
  function compactTranscript(lines, opts) {
    const maxSpan = (opts && opts.maxSpan) || 10;
    const maxChars = (opts && opts.maxChars) || 240;
    const blocks = [];
    let cur = null;
    for (const l of lines) {
      const text = String(l.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!cur || l.start - cur.start >= maxSpan || cur.text.length + text.length > maxChars) {
        cur = { start: l.start, text };
        blocks.push(cur);
      } else {
        cur.text += ' ' + text;
      }
    }
    return blocks;
  }

  function transcriptToText(lines) {
    return compactTranscript(lines).map((b) => `[${formatTime(b.start)}] ${b.text}`).join('\n');
  }

  function normalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Lokale Volltextsuche ohne KI: bewertet Blöcke nach Treffern der Suchbegriffe.
  function searchTranscript(lines, query, limit) {
    const terms = normalize(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
    if (!terms.length) return [];
    const blocks = compactTranscript(lines, { maxSpan: 10, maxChars: 200 });
    const scored = [];
    for (const b of blocks) {
      const text = normalize(b.text);
      let score = 0;
      let allHit = true;
      for (const t of terms) {
        const idx = text.indexOf(t);
        if (idx === -1) { allHit = false; continue; }
        score += 1;
        // Wortgrenze = besserer Treffer
        const before = idx === 0 ? ' ' : text[idx - 1];
        if (!/[\p{L}\p{N}]/u.test(before)) score += 0.5;
      }
      if (score > 0) scored.push({ start: b.start, text: b.text, score: score + (allHit ? terms.length : 0) });
    }
    scored.sort((a, b) => b.score - a.score || a.start - b.start);
    return scored.slice(0, limit || 8);
  }

  // Segmente verschiedener Quellen zusammenführen; Überlappungen gleicher Kategorie vereinigen.
  function mergeSegments(lists) {
    const all = [].concat(...lists.filter(Boolean)).filter((s) =>
      Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
    );
    all.sort((a, b) => a.start - b.start);
    const out = [];
    for (const s of all) {
      const last = out[out.length - 1];
      if (last && last.category === s.category && s.category !== 'chapter' && s.start <= last.end + 1) {
        last.end = Math.max(last.end, s.end);
        if (!last.title && s.title) last.title = s.title;
        if (last.source !== s.source) last.source = last.source + '+' + s.source;
      } else {
        out.push({ ...s });
      }
    }
    return out;
  }

  function findNextSegment(segments, categories, currentTime) {
    const cats = new Set(categories);
    const inside = segments.find((s) => cats.has(s.category) && currentTime >= s.start && currentTime < s.end);
    if (inside) return inside;
    return segments.find((s) => cats.has(s.category) && s.start > currentTime) || null;
  }

  const lib = {
    CATEGORY_LABELS,
    t,
    categoryLabel,
    PRICES,
    estimateTokens,
    estimateCostUsd,
    formatUsd,
    formatTokens,
    chaptersToDescription,
    segmentKey,
    formatTime,
    parseTimestamp,
    parseDescriptionChapters,
    classifyChapterTitle,
    chaptersToSegments,
    compactTranscript,
    transcriptToText,
    searchTranscript,
    mergeSegments,
    findNextSegment,
  };

  root.YTSkipperLib = lib;
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this);
