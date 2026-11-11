# Worldfootball — Fußball und Region

Ein Nachrichtenmagazin für **Gladbeck**, **Gelsenkirchen** und den **Fußball in Westfalen**. Die Seite bündelt Meldungen der Stadtportale mit Vereins-, Verbands- und Fußballnachrichten. Stadtmeldungen können auch Kultur, Verkehr oder andere regionale Themen behandeln; der Feed ist kein reiner Fußballticker.

**Website:** [worldfootball-newspage.vercel.app](https://worldfootball-newspage.vercel.app)

## Funktionen

- Magazinansicht mit Nachrichtenkarten und einer Artikelvorschau aus Titel, Datum und Zusammenfassung; der vollständige Artikel bleibt bei der verlinkten Originalquelle.
- Suche, Quellenfilter und Sortierung nach Datum oder Quelle.
- Merkliste für gespeicherte Artikel auf diesem Gerät sowie helle und dunkle Ansicht. Merkliste und Theme werden im jeweiligen Browser gespeichert, ohne Benutzerkonto oder geräteübergreifende Synchronisierung.
- Quellenstatus mit Artikelanzahl und Zeitpunkt der letzten erfolgreichen Datenübernahme.
- Wetter für Gladbeck über [Open-Meteo](https://open-meteo.com), einschließlich aktueller Werte und einer Vorhersage für vier Tage.
- Artikelbilder werden aus den Originalquellen übernommen, sofern dort eine nutzbare Bildadresse vorliegt. Fehlende Veröffentlichungsdaten bleiben unbekannt.

## Nachrichtenquellen und Aktualisierung

| Quelle | Inhalt | Abruf |
| --- | --- | --- |
| [Stadt Gladbeck](https://www.gladbeck.de/) | Regionale Stadtmeldungen | RSS |
| [Stadt Gelsenkirchen](https://www.gelsenkirchen.de/) | Regionale Stadtmeldungen | Atom |
| [FLVW · Westfalen](https://flvw.de/) | Fußball und Sport aus dem Verband | RSS |
| [fussball.de](https://www.fussball.de/) | Fußballnachrichten, darunter regionale Beiträge | HTML-Auswertung |

Der Server speichert Nachrichten für **30 Minuten** und Wetterdaten für **15 Minuten** zwischen. Nach Ablauf lädt die nächste API-Anfrage neue Daten; es gibt keinen dauerhaft laufenden Hintergrundabruf. Gleichzeitige Anfragen teilen sich dieselbe laufende Aktualisierung. Die angezeigten Meldungen können daher älter als ihr Abrufzeitpunkt sein.

Bei einem Quellenausfall bleiben deren zuletzt erfolgreich geladene Artikel nach Möglichkeit erhalten und die Quelle wird als `stale` gekennzeichnet. Dieser Cache gilt pro laufender Serverinstanz und ist kein dauerhaftes Archiv: Nach einem Neustart oder einem neuen Vercel-Aufruf ohne vorhandenen Instanzcache müssen die Daten erneut geladen werden. Ohne frühere Daten zeigt eine ausgefallene Quelle den Status `error`. Eine erreichbare Quelle ohne nutzbare Artikel wird als `empty` ausgewiesen. Ausfälle und leere Ergebnisse werden nicht durch erfundene Meldungen ersetzt.

## Lokal starten

Voraussetzung ist **Node.js 24**. API-Schlüssel sind nicht erforderlich.

```bash
npm ci
npm start
```

Die Anwendung läuft auf [localhost:3000](http://localhost:3000). Der Port lässt sich über `PORT` ändern. `npm run dev` startet den Entwicklungsmodus mit automatischem Neustart bei Serveränderungen.

```bash
npm test
```

Die Tests prüfen unter anderem API-Antworten, Quellenzustände, URL- und Bildnormalisierung, Deduplizierung, Cache-Laufzeiten, parallele Anfragen und die Wiederherstellung nach Ausfällen. Sie verwenden kontrollierte Testdaten und benötigen keine externen Nachrichtendienste.

## Deployment

### Vercel

Das GitHub-Repository in Vercel importieren und **Express** sowie **Node.js 24.x** verwenden. `vercel.json` enthält die Installations- und Laufzeitkonfiguration. Ein zusätzlicher Build-Befehl und Umgebungsvariablen sind für diese Anwendung nicht erforderlich.

`server.js` exportiert die Express-Anwendung; Dateien aus `public/` werden über das Vercel-CDN ausgeliefert. API-Anfragen laden und aktualisieren die Daten nach dem oben beschriebenen Cache-Verhalten.

### Render

Alternativ enthält `render.yaml` die Konfiguration für einen Node-Web-Service mit `npm install`, `node server.js` und `/api/health` als Health-Check.

## API

| Endpoint | Antwort |
| --- | --- |
| `/api/news` | Artikel, Quellenstatus, Abrufzeitpunkt und Fehler |
| `/api/weather` | Aktuelles Wetter, Vorhersage, Abrufzeitpunkt und optionaler Fehler |
| `/api/health` | Serverstatus, Artikelanzahl und Wetterverfügbarkeit |

`/api/news` liefert diese Felder:

- `items`: Artikel mit `title`, `summary`, `url`, `image`, `pubDate`, `source`, `sourceKey` und `regional`. Artikel-URLs sind deduplizierte HTTP(S)-Adressen; `image` ist eine absolute HTTP(S)-Adresse oder `null`, `pubDate` ein ISO-Zeitstempel oder `null`. Die Oberfläche stellt Zusammenfassungen als Plaintext dar.
- `updatedAt`: Zeitpunkt des letzten Aktualisierungsversuchs für den gesamten Feed, kein Veröffentlichungsdatum.
- `errors`: Immer ein Array aus `{ source, error }`, auch bei teilweisen Ausfällen.
- `sources`: Vier Einträge mit `{ key, name, url, status, count, updatedAt, error? }`. `count` zählt die tatsächlich ausgegebenen Artikel nach Deduplizierung. `updatedAt` bezeichnet die letzte erfolgreiche Datenübernahme der jeweiligen Quelle und bleibt bei `stale` unverändert; ohne vorherigen Erfolg ist es `null`.

Die Quellen-IDs sind `gladbeck`, `gelsenkirchen`, `westfalen` für den FLVW und `fussball` für fussball.de. Auch regionale fussball.de-Artikel behalten `sourceKey: "fussball"`; ihre regionale Einordnung steht separat in `regional`.

| Quellenstatus | Bedeutung |
| --- | --- |
| `ok` | Abruf erfolgreich, nutzbare Artikel vorhanden |
| `empty` | Abruf erfolgreich, keine nutzbaren Artikel gefunden |
| `partial` | fussball.de liefert Artikel, aber eine der beiden abgefragten Seiten ist ausgefallen |
| `stale` | Aktueller Abruf fehlgeschlagen; zuletzt verfügbare Artikel werden weiter angezeigt |
| `error` | Abruf fehlgeschlagen; keine früheren Artikel verfügbar |

`/api/health` kann auch dann `ok: true` melden, wenn einzelne externe Quellen ausfallen. Für deren Zustand sind `sources` und `errors` in `/api/news` sowie `error` in `/api/weather` maßgeblich.
