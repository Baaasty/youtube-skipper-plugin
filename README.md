# YouTube Skipper (Chrome-Extension)

Chrome-Erweiterung (Manifest V3), die das Transkript eines YouTube-Videos mit Zeitstempeln lädt und darauf aufbauend

- **Intro skippen**, **Sponsor skippen** und **Zum Fazit** als Buttons anbietet,
- eine **Textsuche** im Transkript (kostenlos, lokal) und einen kleinen **KI-Chat** („Wo erklärt er die Installation?“) bereitstellt,
- **Werbe-/Sponsor-Segmente automatisch überspringt** (SponsorBlock-Community-Daten und/oder KI-Erkennung),
- Kapitel aus der Videobeschreibung oder per KI erzeugt.

Keine Build-Tools nötig: Ordner als „entpackte Erweiterung“ laden.

---

## 1. Ist das technisch umsetzbar?

Ja. Alle drei Bausteine existieren und werden von dieser Extension kombiniert:

| Baustein | Wie | Kosten |
|---|---|---|
| Transkript mit Timestamps | Untertitelspur des Videos (auch automatisch erzeugte), die YouTube ohnehin an den Player liefert | kostenlos |
| Sponsor-/Intro-/Outro-Segmente | [SponsorBlock](https://sponsor.ajay.app)-API (Community-Daten, Millionen Videos) | kostenlos |
| Inhaltliche Suche, Fazit finden, Kapitel, Sponsor-Erkennung ohne Community-Daten | Claude API (Transkript + Frage → JSON mit Sekundenangaben) | Cent-Bruchteile pro Video, s. u. |

**Wichtige Einschränkungen:**

- **Kein offizielles Transkript-API für fremde Videos.** Die YouTube Data API (`captions.download`) funktioniert nur für eigene Videos mit OAuth. Jede Transkript-Extension (auch diese) nutzt daher die interne Untertitel-URL aus der Player-Antwort bzw. den internen `get_transcript`-Endpunkt. Das läuft im Browser des Nutzers mit dessen Session und ist stabil, kann aber bei YouTube-Änderungen brechen und muss gepflegt werden. Videos ohne Untertitel (selten, z. B. reine Musik) liefern kein Transkript.
- **„Live“ auswerten ist nicht nötig:** Das Transkript ist für das ganze Video sofort da, die KI-Analyse passiert einmalig beim Öffnen (Ergebnis wird pro Video gecacht). Echte Livestreams haben kein fertiges Transkript; dafür bräuchte man Speech-to-Text im Browser (z. B. Whisper via WebGPU) – möglich, aber ein eigenes Projekt.
- **Lizenz der SponsorBlock-Daten: CC BY-NC-SA 4.0.** Für private Nutzung und Open-Source perfekt, für ein **kommerzielles Produkt nicht ohne Lizenzvereinbarung**. Diese Extension kann SponsorBlock deshalb abschalten und die Segmente rein per KI erkennen.
- **Chrome Web Store:** Erweiterungen, die YouTube-Werbung (die eingeblendeten Ads) blockieren, verstoßen gegen YouTubes Nutzungsbedingungen. Das Überspringen von *im Video eingesprochenen* Sponsor-Segmenten ist etwas anderes und wird seit Jahren von SponsorBlock u. a. im Store angeboten.

## 2. Welche APIs und was kosten sie?

### Claude API (für KI-Suche, Fazit, Kapitel, Sponsor-Erkennung)

Ein typisches 20-Minuten-Video ergibt rund 3.000 Wörter Transkript, komprimiert etwa **5.000 Input-Tokens**. Die Analyse liefert ca. 500 Output-Tokens, eine Chat-Frage ca. 150.

| Modell | Preis Input / Output pro 1M Tokens | ≈ Analyse pro 20-min-Video | ≈ Chat-Frage (Transkript aus Cache) |
|---|---|---|---|
| Claude Opus 5.5 (Standard) | 4 $ / 20 $ | 0,03 $ | 0,005 $ |
| Claude Sonnet 5.5 | 2 $ / 10 $ | 0,015 $ | 0,003 $ |
| Claude Haiku 5.5 | 0,10 $ / 0,50 $ | 0,001 $ | 0,0002 $ |

Das Transkript wird mit Prompt-Caching gesendet, Folgefragen zum selben Video lesen es aus dem Cache (deutlich günstiger). Die Analyse wird pro Video lokal gespeichert, ein zweites Öffnen kostet nichts.

**Rechenbeispiel Verkaufsmodell:** Ein Nutzer, der 10 Videos am Tag mit Opus 5.5 analysiert und 5 Fragen stellt, kostet rund 0,33 $/Tag ≈ 10 $/Monat; mit Sonnet 5.5 ≈ 5 $/Monat, mit Haiku 5.5 unter 0,50 $/Monat. Eine Haiku-Standardstufe mit optionaler Opus-Premium-Stufe passt in ein Abo von 3–6 €/Monat. Für den Verkauf gehört der API-Key **nicht** in die Extension, sondern hinter einen kleinen Backend-Proxy mit Login und Kontingent pro Nutzer. Für den Privatgebrauch (so wie hier gebaut) genügt der eigene Key in den Einstellungen.

Alternative ohne Transkript-Scraping: Google Gemini kann YouTube-URLs direkt als Video-Input verarbeiten (Audio + Bild). Das ist robuster gegen YouTube-Änderungen, aber pro Video deutlich teurer (Video-Tokens) und langsamer als die Transkript-Variante.

### SponsorBlock (kostenlos)

`GET https://sponsor.ajay.app/api/skipSegments/<sha256-Präfix>?categories=[…]` liefert Sponsor, Eigenwerbung, Intro, Outro, Interaktionsaufrufe, Vorschau, Füller. Die Extension sendet nur die ersten 4 Hex-Zeichen des Video-ID-Hashes (datenschutzfreundlich). Kein Key nötig, Rate-Limits sind großzügig. Deckt vor allem populäre Videos ab, bei kleinen Kanälen fehlen oft Daten – dann springt die KI ein.

### Was ohne KI und ohne SponsorBlock geht

- Kapitel aus der Videobeschreibung (`0:00 Intro`, `12:30 Fazit` …) werden geparst; Titel wie „Intro“, „Fazit“, „Zusammenfassung“, „Sponsor“ werden automatisch Kategorien zugeordnet, die Buttons funktionieren dann sofort.
- Die Volltextsuche im Transkript läuft komplett lokal.

## 3. Installation

1. Repository klonen oder als ZIP laden.
2. Chrome → `chrome://extensions` → „Entwicklermodus“ einschalten → „Entpackte Erweiterung laden“ → diesen Ordner wählen.
3. Icon der Erweiterung anklicken → Tab „Einstellungen“ → Anthropic-API-Key eintragen (für die KI-Funktionen; Auto-Skip per SponsorBlock und Textsuche funktionieren auch ohne Key).
4. Ein YouTube-Video öffnen. Unter dem Video erscheint die Suchleiste, das Popup oben zeigt Suche/Chat und Einstellungen.

## 4. Bedienung

**Popup (Klick auf das Icon oben in der Toolbar)** – zwei Tabs:

- **Suche**: Titel und Status des aktuellen Videos, Segmentleiste, Buttons ⏩ Intro / 💰 Sponsor / 🎯 Fazit / ✨ Analyse, Suchfeld mit Chat-Verlauf, Zusammenfassung, Kapitel und Transkript. Alles ist anklickbar und springt im YouTube-Tab. Das Popup findet den YouTube-Tab auch, wenn gerade ein anderer Tab aktiv ist.
- **Einstellungen**: API-Key, Modell, Auto-Skip-Kategorien, SponsorBlock, Sprache, Nutzungsstatistik.

**Suchleiste in YouTube (unter dem Video)** – kompakte Zeile mit Eingabefeld, 🔍 (lokale Volltextsuche, kostenlos), „KI fragen“ (inhaltliche Frage an Claude), den Sprungknöpfen Intro / Sponsor / Fazit, ✨ Analyse und einer dünnen Segmentleiste. Ergebnisse klappen darunter auf; Popup und Suchleiste zeigen denselben Chat-Verlauf.

- `Enter` = Textsuche, `Strg+Enter` = KI-Frage. Treffer sind anklickbar.
- **Auto-Skip** überspringt die gewählten Kategorien automatisch, mit Toast und „Rückgängig“.
- **✨ Analyse** erkennt Kapitel, Intro, Sponsor, Eigenwerbung, Fazit und Outro per Claude und schreibt eine Kurzzusammenfassung. Ergebnis wird pro Video gecacht.

Die Oberfläche ist zweisprachig (Deutsch/Englisch) und folgt der Browsersprache. Tastenkürzel Alt+S (Sponsor), Alt+I (Intro), Alt+F (Fazit), Alt+K (Suchfeld) lassen sich unter `chrome://extensions/shortcuts` ändern.

## 5. Aufbau

```
manifest.json              MV3-Manifest
content/main-world.js      läuft in der Seiten-World: liest Player-Antwort (Untertitelspuren, Beschreibung), seekTo
content/lib.js             reine Logik: Kapitel-Parser, Transkript-Kompaktierung, Suche, Segment-Merge (Node-Tests)
content/content.js         Suchleiste unter dem Video, Transkript-Abruf, Auto-Skip, Zustand fürs Popup
content/panel.css          Styles
background/background.js   Service Worker: SponsorBlock, Claude-API (JSON-Schema-Antworten, Prompt-Caching), Cache, Statistik
_locales/de, _locales/en  Sprachdateien (chrome.i18n)
popup/                     Toolbar-Popup mit Tabs „Suche“ (Chat, Sprungknöpfe) und „Einstellungen“
options/                   Einstellungsseite (im Popup eingebettet, auch als eigene Seite)
test/lib.test.mjs          Unit-Tests (node --test)
test/e2e.mjs               End-to-End-Test mit Playwright und gemockter YouTube-Seite
scripts/build.mjs          ZIP-Build ohne Abhängigkeiten
.github/workflows/         CI und Release
```

Transkript-Abruf: 1) Untertitelspur aus der Player-Antwort (`fmt=json3`), bevorzugt manuelle Spur in der eingestellten Sprache, sonst automatische; 2) Fallback auf den internen `get_transcript`-Endpunkt.

Claude-Aufrufe gehen direkt aus dem Service Worker an `api.anthropic.com` (ohne SDK, damit kein Build-Schritt nötig ist). Antworten werden per `output_config.format` als JSON-Schema erzwungen; bei Opus/Sonnet ist der serverseitige Refusal-Fallback aktiviert.

## 6. Tests

```
npm test
```

## 7. Verkaufsmodell (Konzept)

Für den Privatgebrauch trägt jeder Nutzer seinen eigenen Anthropic-Key ein. Für ein verkauftes Produkt gehört der Key nicht in die Extension, sondern hinter einen kleinen Backend-Proxy:

1. **Login** in der Extension (z. B. E-Mail-Link oder Google), der Proxy gibt ein kurzlebiges Token zurück.
2. **Proxy-Endpunkt** `/analyze` und `/ask`: nimmt Transkript und Frage entgegen, ruft die Claude API mit dem Firmen-Key auf, gibt das JSON zurück. Die Extension spricht dann nur noch mit dem Proxy; `background.js` braucht dafür nur eine andere URL und das Token statt des API-Keys.
3. **Kontingent pro Nutzer** (z. B. 50 Analysen/Monat im Basis-Abo, mehr im Premium-Abo). Die Token-Zahlen aus `usage` jeder Antwort reichen zur Abrechnung.
4. **Preisgestaltung:** Mit Haiku 5.5 kostet ein aktiver Nutzer unter 0,50 $/Monat, mit Opus 5.5 rund 10 $/Monat (10 Analysen + 5 Fragen pro Tag). Ein Basis-Abo um 3 €/Monat auf Haiku und ein Premium-Abo um 8 €/Monat auf Opus/Sonnet lassen Marge.
5. **SponsorBlock** bleibt wegen der Lizenz (CC BY-NC-SA) im kommerziellen Produkt aus oder wird lizenziert; die KI-Erkennung übernimmt.

Für den Chrome Web Store sind `PRIVACY.md` als Datenschutzerklärung und `node scripts/build.mjs` für das Upload-ZIP vorgesehen.

## 8. Bekannte Grenzen / Ideen

- Shorts und Livestreams werden nicht unterstützt.
- Die KI-Zeitangaben sind so genau wie die Transkriptblöcke (ca. 10 s); für sekundengenaues Sponsor-Skipping sind SponsorBlock-Daten besser.
- Mögliche Erweiterungen: Whisper-Transkription für Videos ohne Untertitel, Backend-Proxy für ein Abo-Modell (siehe Abschnitt 7). Der Stand der Planung steht in `ROADMAP.md`.
