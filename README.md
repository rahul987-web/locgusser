# LocGusser

A free friend-room location guessing game. One player creates a room, friends join with the room code, everyone guesses on a map, and the leaderboard updates live.

## Run LocGusser

```bash
npm run dev
```

Open `http://localhost:5173`.

Run syntax checks before publishing:

```bash
npm run check
```

## Turn on Google Street View

Real Google Street View needs a Google Maps API key with the Maps JavaScript API and Street View access enabled in Google Cloud.

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Put your Google Maps API key in `.env`:

```bash
GOOGLE_MAPS_API_KEY=your_key_here
```

Then restart:

```bash
npm run dev
```

## Play with friends

Run the server on a machine your friends can reach, then share the URL and room code. For LAN play, start it with:

```bash
HOST=0.0.0.0 npm run dev
```

Then share `http://YOUR-LAN-IP:5173`. Active rooms are stored in memory, so restarting the server clears current matches.

## Add locations

Edit `data/locations.json`. The default locations use latitude/longitude, and the server resolves a nearby Google Street View panorama when a round starts:

```json
{
  "id": "my-place",
  "title": "My Place",
  "city": "Delhi",
  "country": "India",
  "latitude": 28.6139,
  "longitude": 77.209,
  "difficulty": "medium",
  "provider": "google",
  "attribution": "Google Street View"
}
```

If you already know a Google panorama id, add it to skip automatic lookup:

```json
{
  "id": "google-place",
  "title": "Street near campus",
  "city": "New Delhi",
  "country": "India",
  "latitude": 28.545,
  "longitude": 77.1926,
  "difficulty": "hard",
  "provider": "google",
  "googlePanoId": "known_google_pano_id",
  "streetViewHeading": 90,
  "attribution": "Google Street View"
}
```

Use official APIs and follow each imagery provider's attribution rules. The guess map uses OpenStreetMap tiles, which is fine for light friend-group use.

## CrazyGames publishing

CrazyGames can host the static game client, but friend rooms need the Node backend to be deployed separately over HTTPS.

Build the upload folder with:

```bash
LOCGUSSER_API_BASE_URL=https://your-backend.example.com npm run build:crazygames
```

Then zip the contents of `dist/crazygames` and submit it at `https://developer.crazygames.com/submit`.

See [docs/CRAZYGAMES.md](docs/CRAZYGAMES.md) for the deployment checklist.
