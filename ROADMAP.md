# Roadmap – YouTube Skipper

Stand wird mit jedem Push aktualisiert. `[x]` = fertig und auf `main`, `[ ]` = offen, `[~]` = in Arbeit.

## v0.1 – Grundgerüst (fertig)

- [x] MV3-Extension, Transkript-Abruf (Untertitelspur + `get_transcript`-Fallback)
- [x] Suchleiste unter dem Video: Textsuche, KI-Frage, Intro/Sponsor/Fazit, Analyse, Segmentleiste
- [x] Toolbar-Popup mit Tabs „Suche“ (Chat, Sprungknöpfe, Kapitel, Transkript) und „Einstellungen“
- [x] Segmentquellen: SponsorBlock, Kapitel aus der Beschreibung, KI-Analyse (Claude, JSON-Schema, Prompt-Caching)
- [x] Auto-Skip mit Toast und „Rückgängig“, Analyse-Cache pro Video, Nutzungs-/Kostenstatistik
- [x] README mit Machbarkeit, APIs, Kosten, Lizenz

## v0.2 – Player-Integration (fertig)

- [x] Segmentmarker direkt in der YouTube-Fortschrittsleiste (farbig wie SponsorBlock)
- [x] „Überspringen“-Knopf im Player, sobald man sich in einem bekannten Segment befindet (auch für Kategorien ohne Auto-Skip)
- [x] Tastenkürzel: Sponsor skippen, Intro skippen, zum Fazit, Suchfeld fokussieren (konfigurierbar unter `chrome://extensions/shortcuts`)
- [x] Kapitel aus YouTubes eigener Kapitelleiste (auch automatisch erzeugte), nicht nur aus der Beschreibung
- [x] Statistik „gesparte Zeit“ und übersprungene Segmente im Popup

## v0.3 – Komfort und Kosten (fertig)

- [x] Kostenschätzung vor der KI-Analyse (Tokens/Preis für das aktuelle Modell) in der Statuszeile
- [x] Obergrenze für automatische Analyse (Videolänge), um lange Videos nicht ungefragt zu analysieren
- [x] Export: Kapitel als YouTube-Beschreibung und Transkript als Text in die Zwischenablage
- [x] Zweisprachiges UI (Deutsch/Englisch) über `chrome.i18n`
- [x] Segment-Korrektur: einzelnes Segment für dieses Video ignorieren

## v0.4 – Release-Reife (fertig)

- [x] Build-Skript, das ein Store-fähiges ZIP erzeugt
- [x] GitHub Action, die bei Tags das ZIP als Release-Artefakt anhängt
- [x] PRIVACY.md (Datenschutzerklärung für Store-Listing) und CHANGELOG.md
- [x] README-Abschnitt „Verkaufsmodell“: Backend-Proxy mit Nutzerkonten und Kontingent (Konzept)

## Ideen, nicht eingeplant

- Whisper/WebGPU-Transkription für Videos ohne Untertitel
- Shorts und eingebettete Player
- Livestreams (kein fertiges Transkript)
- Backend-Proxy als eigenes Projekt
