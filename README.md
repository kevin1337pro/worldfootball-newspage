# Worldfootball — Region News Page

Live-News aus **Gladbeck**, **Gelsenkirchen** und der **Fußball-Welt** — automatisch aktualisiert, mit Wetter-Widget für die Region.

## Features

- Aggregiert News aus vier Quellen:
  - **next.fussball.de** (DFB Amateurfußball-Portal, HTML-Scraping)
  - **gladbeck.de** (RSS-Feed)
  - **gelsenkirchen.de** (Atom-Feed)
  - **flvw.de** (RSS-Feed des Fußball- und Leichtathletik-Verbands Westfalen)
- Wetter-Widget für Gladbeck via [Open-Meteo](https://open-meteo.com) — aktuell + 4-Tages-Vorhersage
- Server-Cache: News 30 Min, Wetter 15 Min; abgelaufene Daten werden bei der nächsten API-Anfrage aktualisiert
- Iridescent-Tilt-Karten mit Click-to-Flip

## Lokal starten

Node.js 24 wird lokal und auf Vercel verwendet. API-Schlüssel sind nicht erforderlich.

```bash
npm ci
npm start
```

Server läuft dann auf <http://localhost:3000>. Für den Entwicklungsmodus mit automatischem Neustart: `npm run dev`. Der Port lässt sich über `PORT` ändern.

`npm test` prüft die API, Cache-Laufzeiten, parallele Anfragen und Fehlerfälle ohne externe Dienste.

## Deploy auf Vercel

Das GitHub-Repository in Vercel importieren und das Framework **Express** sowie Node.js **24.x** auswählen. `vercel.json` enthält die Installations- und Laufzeitkonfiguration; ein Build-Befehl und Umgebungsvariablen sind nicht erforderlich.

`server.js` exportiert die Express-Anwendung. Dateien aus `public/` werden über das Vercel-CDN ausgeliefert. News und Wetter werden beim ersten API-Aufruf geladen und danach pro laufender Instanz zwischengespeichert. Gleichzeitige Anfragen teilen sich eine laufende Aktualisierung. Hintergrundtimer sind nicht nötig.

## Deploy auf Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Render erkennt die `render.yaml` automatisch — `Web Service`, Free Plan, Node Runtime.

## API

| Endpoint        | Beschreibung                       |
| --------------- | ---------------------------------- |
| `/api/news`     | Aggregierte News (JSON)            |
| `/api/weather`  | Aktuelles Wetter + 4-Tages-Forecast |
| `/api/health`   | Status                             |
