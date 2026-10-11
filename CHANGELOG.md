# Changelog

## 0.4.0

- Build-Skript `node scripts/build.mjs` erzeugt ein Store-fähiges ZIP unter `dist/`
- GitHub Actions: CI (Syntax, Tests, Build-Artefakt) und Release bei Tags `v*`
- PRIVACY.md und CHANGELOG.md
- README: Konzept für ein Verkaufsmodell mit Backend-Proxy

## 0.3.0

- Kostenschätzung (Tokens, Preis) vor der KI-Analyse
- Obergrenze für die automatische Analyse nach Videolänge
- Kapitel (YouTube-Format) und Transkript in die Zwischenablage kopieren
- Einzelne Segmente pro Video ignorieren
- Zweisprachiges UI (Deutsch/Englisch) über `chrome.i18n`

## 0.2.0

- Segmentmarker in der YouTube-Fortschrittsleiste
- „Überspringen“-Knopf im Player
- Tastenkürzel Alt+S / Alt+I / Alt+F / Alt+K
- Kapitel aus YouTubes eigener Kapitelleiste
- Statistik „gesparte Zeit“

## 0.1.0

- Transkript-Abruf, Suchleiste unter dem Video, Toolbar-Popup mit Suche/Chat und Einstellungen
- SponsorBlock, Kapitel aus der Beschreibung, KI-Analyse mit Claude
- Auto-Skip mit Rückgängig, Analyse-Cache, Nutzungsstatistik
