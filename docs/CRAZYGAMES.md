# CrazyGames Release Guide

LocGusser has two deployable parts:

- `public/` is the HTML5 game client that CrazyGames can host.
- `server.js` is the multiplayer API, room state, Server-Sent Events, and Mapillary image proxy. It must run on your own HTTPS host.

## 1. Deploy the backend

Deploy this repository to a Node 18+ host such as Render, Railway, Fly.io, a VPS, or any platform that supports long-running HTTP connections.

Set these environment variables on the backend:

```bash
HOST=0.0.0.0
PORT=5173
MAPILLARY_ACCESS_TOKEN=your_mapillary_token
ALLOWED_ORIGINS=https://*.crazygames.com,http://localhost:5173
```

Optional Google Street View mode:

```bash
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
```

If you use Google, restrict the key in Google Cloud by HTTP referrer before publishing.

Runtime key setup is only allowed from localhost by default. For a remote admin setup flow, set `ADMIN_SETUP_TOKEN` and send it in the `X-Admin-Setup-Token` header. Do not expose that token in the CrazyGames client.

## 2. Build the CrazyGames client

Run this locally after the backend is deployed:

```bash
LOCGUSSER_API_BASE_URL=https://your-backend.example.com npm run build:crazygames
```

The uploadable files will be in:

```text
dist/crazygames
```

Zip the contents of that folder, not the whole repository.

## 3. Submit

Submit the zip at:

```text
https://developer.crazygames.com/submit
```

The game already includes the CrazyGames SDK lifecycle hooks:

- loading starts while the app boots.
- loading stops after the first render.
- gameplay starts during active guessing.
- gameplay stops on menus, results, and waiting states.
- happytime fires for strong guesses.

## Production Notes

Current room state is in memory. That is fine for a first hosted version on one server instance, but rooms will be lost if the backend restarts. If you scale to multiple instances, replace the in-memory `rooms` map with Redis or another shared store.

Mapillary tokens stay on the backend. The client only receives `hasMapillaryToken`, so your token is not exposed in the browser.
