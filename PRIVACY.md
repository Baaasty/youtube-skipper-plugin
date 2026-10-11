# Datenschutzerklärung – YouTube Skipper

Stand: Oktober 2026

## Welche Daten verarbeitet die Erweiterung?

- **Video-ID, Titel, Beschreibung und Untertitel** des gerade geöffneten YouTube-Videos. Sie werden im Browser gelesen, um Kapitel, Segmente und das Transkript anzuzeigen.
- **Anthropic-API-Key**, wenn du ihn in den Einstellungen einträgst. Er wird ausschließlich lokal im Browser gespeichert (`chrome.storage.local`) und nie an andere Dienste als `api.anthropic.com` gesendet.
- **Einstellungen** (Modell, Kategorien, Sprache) werden über `chrome.storage.sync` gespeichert und – falls du in Chrome angemeldet bist – über dein Google-Konto synchronisiert.
- **Nutzungsstatistik** (Token-Zähler, gesparte Zeit) wird nur lokal gespeichert.

## Welche Daten verlassen den Browser?

| Empfänger | Daten | Wann |
|---|---|---|
| `www.youtube.com` | Untertitel-Abruf mit deiner bestehenden YouTube-Sitzung | bei jedem geöffneten Video |
| `sponsor.ajay.app` (SponsorBlock) | die ersten 4 Zeichen des SHA-256-Hashes der Video-ID | bei jedem Video, solange SponsorBlock aktiviert ist |
| `api.anthropic.com` (Claude API) | Videotitel, Transkript (Text), deine Frage, dein API-Key | nur bei „Analyse“, „KI fragen“ oder aktivierter Auto-Analyse |

Es gibt keinen eigenen Server des Entwicklers, kein Tracking und keine Werbung. Die Erweiterung sammelt keine personenbezogenen Daten.

## Speicherdauer

- Analyse-Ergebnisse werden pro Video lokal zwischengespeichert (maximal 100 Videos) und können in den Einstellungen gelöscht werden.
- Alle Daten werden beim Deinstallieren der Erweiterung entfernt.

## Drittanbieter

- SponsorBlock-Daten stehen unter CC BY-NC-SA 4.0 (https://sponsor.ajay.app).
- Für die Claude API gelten die Nutzungsbedingungen und die Datenschutzerklärung von Anthropic (https://www.anthropic.com/privacy).

## Kontakt

Fragen zum Datenschutz bitte als Issue im GitHub-Repository stellen.
