import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../content/lib.js');

test('formatTime', () => {
  assert.equal(L.formatTime(0), '0:00');
  assert.equal(L.formatTime(65), '1:05');
  assert.equal(L.formatTime(3725), '1:02:05');
});

test('parseDescriptionChapters liest Kapitel aus der Beschreibung', () => {
  const desc = 'Mein Video\n0:00 Intro\n1:30 - Setup\n[10:05] Fazit\n12:00 Outro\nhttps://example.com';
  const ch = L.parseDescriptionChapters(desc, 800);
  assert.deepEqual(ch.map((c) => [c.start, c.end, c.title]), [
    [0, 90, 'Intro'], [90, 605, 'Setup'], [605, 720, 'Fazit'], [720, 800, 'Outro'],
  ]);
});

test('parseDescriptionChapters ignoriert unvollständige Listen', () => {
  assert.deepEqual(L.parseDescriptionChapters('1:00 Start\n2:00 Ende', 300), []);
  assert.deepEqual(L.parseDescriptionChapters('0:00 A\n1:00 B', 300), []);
});

test('classifyChapterTitle', () => {
  assert.equal(L.classifyChapterTitle('Intro'), 'intro');
  assert.equal(L.classifyChapterTitle('Mein Fazit'), 'conclusion');
  assert.equal(L.classifyChapterTitle('Sponsor: Foo'), 'sponsor');
  assert.equal(L.classifyChapterTitle('Installation'), 'chapter');
});

test('compactTranscript fasst Zeilen zusammen', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push({ start: i * 4, dur: 4, text: 'wort' + i });
  const blocks = L.compactTranscript(lines, { maxSpan: 15, maxChars: 500 });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks[0].text, 'wort0 wort1 wort2 wort3');
  assert.equal(blocks[1].start, 16);
});

test('searchTranscript findet Begriffe und bewertet Volltreffer höher', () => {
  const lines = [
    { start: 0, text: 'Hallo und willkommen zum Video' },
    { start: 20, text: 'Der Preis liegt bei 20 Euro' },
    { start: 40, text: 'Preis und Leistung passen zusammen' },
    { start: 60, text: 'Danke fürs Zuschauen' },
  ];
  const hits = L.searchTranscript(lines, 'Preis Leistung', 5);
  assert.equal(hits[0].start, 40);
  assert.equal(hits.length, 2);
  assert.deepEqual(L.searchTranscript(lines, 'xyz'), []);
});

test('mergeSegments vereinigt überlappende gleiche Kategorien, nicht aber Kapitel', () => {
  const merged = L.mergeSegments([
    [{ start: 10, end: 40, category: 'sponsor', source: 'sponsorblock' }],
    [{ start: 38, end: 50, category: 'sponsor', source: 'ai' }, { start: 100, end: 120, category: 'intro', source: 'ai' }],
    [{ start: 0, end: 60, category: 'chapter', title: 'A' }, { start: 60, end: 120, category: 'chapter', title: 'B' }],
  ]);
  const sponsor = merged.filter((s) => s.category === 'sponsor');
  assert.equal(sponsor.length, 1);
  assert.deepEqual([sponsor[0].start, sponsor[0].end, sponsor[0].source], [10, 50, 'sponsorblock+ai']);
  assert.equal(merged.filter((s) => s.category === 'chapter').length, 2);
});

test('findNextSegment liefert aktuelles oder nächstes Segment', () => {
  const segs = [
    { start: 0, end: 10, category: 'intro' },
    { start: 50, end: 70, category: 'sponsor' },
    { start: 200, end: 230, category: 'sponsor' },
  ];
  assert.equal(L.findNextSegment(segs, ['sponsor'], 60).start, 50);
  assert.equal(L.findNextSegment(segs, ['sponsor'], 80).start, 200);
  assert.equal(L.findNextSegment(segs, ['sponsor'], 240), null);
  assert.equal(L.findNextSegment(segs, ['intro'], 5).end, 10);
});
