# Worldfootball — Region News Page

Live-News aus **Gladbeck**, **Gelsenkirchen** und der **Fußball-Welt** — automatisch aktualisiert, mit Wetter-Widget für die Region.

## Features

- Aggregiert News aus drei Quellen:
  - **next.fussball.de** (DFB Amateurfußball-Portal, HTML-Scraping)
  - **gladbeck.de** (RSS-Feed)
  - **gelsenkirchen.de** (Atom-Feed)
- Wetter-Widget für Gladbeck via [Open-Meteo](https://open-meteo.com) — aktuell + 4-Tages-Vorhersage
- Server-Cache, Auto-Refresh: News alle 30 Min, Wetter alle 15 Min
- Iridescent-Tilt-Karten mit Click-to-Flip

## Lokal starten

```bash
npm install
npm start
```

Server läuft dann auf <http://localhost:3000>.

## Deploy auf Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Render erkennt die `render.yaml` automatisch — `Web Service`, Free Plan, Node Runtime.

## API

| Endpoint        | Beschreibung                       |
| --------------- | ---------------------------------- |
| `/api/news`     | Aggregierte News (JSON)            |
| `/api/weather`  | Aktuelles Wetter + 4-Tages-Forecast |
| `/api/health`   | Status                             |
