const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

loadDotEnv();

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const LOCATION_FILE = path.join(__dirname, "data", "locations.json");
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const DEFAULT_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,https://*.crazygames.com";

const rooms = new Map();
const mapillaryImageCache = new Map();
const mapillarySequenceCache = new Map();
const googleStreetViewCache = new Map();
const locations = loadLocations();

if (locations.length < 2) {
  console.warn("Add at least two locations in data/locations.json for better games.");
}

if (getPlayableLocations().length < 2) {
  console.warn("Add at least two 360 panorama locations for the default game.");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/events/")) {
      setCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }

      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      console.error(error);
    }

    sendJson(res, statusCode, { error: error.message || "Something went wrong on the server." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LocGusser is running at http://localhost:${PORT}`);
  console.log(`Listening on ${HOST}:${PORT}`);
});

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms.entries()) {
    const changed = syncRoom(room, now);
    const idleFor = now - Math.max(room.updatedAt, room.createdAt);

    if (idleFor > ROOM_TTL_MS) {
      rooms.delete(code);
      continue;
    }

    if (changed) {
      broadcast(room);
    }
  }
}, 1000);

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, locations: locations.length, rooms: rooms.size });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, getConfigPayload(req));
    return;
  }

  const panoramaMatch = url.pathname.match(/^\/api\/mapillary\/([A-Za-z0-9_-]+)\/panorama\.jpg$/);
  if (req.method === "GET" && panoramaMatch) {
    await serveMapillaryPanorama(res, panoramaMatch[1]);
    return;
  }

  const navigationMatch = url.pathname.match(/^\/api\/mapillary\/([A-Za-z0-9_-]+)\/navigation$/);
  if (req.method === "GET" && navigationMatch) {
    await serveMapillaryNavigation(res, navigationMatch[1], url.searchParams.get("sequenceId"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/mapillary-token") {
    assertRuntimeConfigWriteAllowed(req);

    const body = await readJson(req);
    setMapillaryToken(body.token);

    sendJson(res, 200, getConfigPayload(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/google-maps-key") {
    assertRuntimeConfigWriteAllowed(req);

    const body = await readJson(req);
    setGoogleMapsKey(body.key);

    sendJson(res, 200, getConfigPayload(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(req);
    const playerName = cleanName(body.playerName);
    const room = createRoom(playerName);
    rooms.set(room.code, room);
    sendJson(res, 201, { roomCode: room.code, playerId: room.hostId, room: getRoomView(room, room.hostId) });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,8})(?:\/([a-z-]+))?$/);
  if (roomMatch) {
    const code = roomMatch[1].toUpperCase();
    const action = roomMatch[2] || "state";
    const room = rooms.get(code);

    if (!room) {
      sendJson(res, 404, { error: "Room not found." });
      return;
    }

    syncRoom(room);

    if (req.method === "GET" && action === "state") {
      const playerId = url.searchParams.get("playerId") || "";
      sendJson(res, 200, getRoomView(room, playerId));
      return;
    }

    if (req.method === "POST" && action === "join") {
      const body = await readJson(req);
      const player = addPlayer(room, cleanName(body.playerName));
      room.updatedAt = Date.now();
      broadcast(room);
      sendJson(res, 200, { roomCode: room.code, playerId: player.id, room: getRoomView(room, player.id) });
      return;
    }

    if (req.method === "POST" && action === "start") {
      const body = await readJson(req);
      assertHost(room, body.playerId);
      await startGame(room, body);
      broadcast(room);
      sendJson(res, 200, getRoomView(room, body.playerId));
      return;
    }

    if (req.method === "POST" && action === "guess") {
      const body = await readJson(req);
      submitGuess(room, body.playerId, body.latitude, body.longitude);
      broadcast(room);
      sendJson(res, 200, getRoomView(room, body.playerId));
      return;
    }

    if (req.method === "POST" && action === "next") {
      const body = await readJson(req);
      assertHost(room, body.playerId);
      advanceRound(room);
      broadcast(room);
      sendJson(res, 200, getRoomView(room, body.playerId));
      return;
    }

    if (req.method === "POST" && action === "leave") {
      const body = await readJson(req);
      leaveRoom(room, body.playerId);
      broadcast(room);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const eventsMatch = url.pathname.match(/^\/events\/([A-Z0-9]{4,8})$/);
  if (req.method === "GET" && eventsMatch) {
    const code = eventsMatch[1].toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      sendJson(res, 404, { error: "Room not found." });
      return;
    }

    attachEvents(req, res, room, url.searchParams.get("playerId") || "");
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

function loadLocations() {
  const raw = fs.readFileSync(LOCATION_FILE, "utf8");
  const parsed = JSON.parse(raw);

  return parsed
    .map((location, index) => ({
      id: String(location.id || `location-${index + 1}`),
      title: String(location.title || "Unknown place"),
      city: String(location.city || ""),
      country: String(location.country || ""),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      difficulty: String(location.difficulty || "medium"),
      provider: String(location.provider || "photo"),
      imageUrl: String(location.imageUrl || ""),
      googlePanoId: String(location.googlePanoId || ""),
      streetViewHeading: Number(location.streetViewHeading || 0),
      mapillaryImageId: String(location.mapillaryImageId || ""),
      mapillarySequenceId: String(location.mapillarySequenceId || ""),
      isPano: Boolean(location.isPano),
      imageDistanceKm: Number(location.imageDistanceKm || 0),
      attribution: String(location.attribution || "")
    }))
    .filter((location) => Number.isFinite(location.latitude) && Number.isFinite(location.longitude));
}

function createRoom(playerName) {
  const code = createRoomCode();
  const player = createPlayer(playerName);
  const now = Date.now();

  return {
    code,
    hostId: player.id,
    status: "lobby",
    players: new Map([[player.id, player]]),
    settings: {
      roundCount: Math.min(5, Math.max(1, getPlayableLocations().length)),
      roundTimeSec: 90
    },
    rounds: [],
    roundIndex: 0,
    clients: new Set(),
    createdAt: now,
    updatedAt: now
  };
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";

    for (let index = 0; index < 5; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }

  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function createPlayer(playerName) {
  return {
    id: crypto.randomUUID(),
    name: playerName,
    totalScore: 0,
    connected: true,
    joinedAt: Date.now(),
    guesses: {}
  };
}

function addPlayer(room, playerName) {
  const player = createPlayer(playerName);
  room.players.set(player.id, player);
  return player;
}

function cleanName(name) {
  const trimmed = String(name || "").trim().replace(/\s+/g, " ");

  if (!trimmed) {
    return "Player";
  }

  return trimmed.slice(0, 24);
}

async function startGame(room, body = {}) {
  const playableLocations = getPlayableLocations();
  const locationPool = playableLocations.length ? playableLocations : locations;
  const roundCount = clamp(Number(body.roundCount || room.settings.roundCount), 1, Math.max(1, locationPool.length));
  const roundTimeSec = clamp(Number(body.roundTimeSec || room.settings.roundTimeSec), 30, 240);
  const selectedLocations = shuffle(locationPool).slice(0, roundCount);
  const preparedLocations = await Promise.all(selectedLocations.map(prepareStreetViewLocation));
  const now = Date.now();

  for (const player of room.players.values()) {
    player.totalScore = 0;
    player.guesses = {};
  }

  room.settings = { roundCount, roundTimeSec };
  room.status = "playing";
  room.roundIndex = 0;
  room.rounds = preparedLocations.map((location, index) => ({
    index,
    locationId: location.id,
    location,
    startedAt: index === 0 ? now : null,
    endsAt: index === 0 ? now + roundTimeSec * 1000 : null,
    completedAt: null
  }));
  room.updatedAt = now;
}

function advanceRound(room) {
  syncRoom(room);

  if (room.status !== "playing") {
    return;
  }

  const currentRound = room.rounds[room.roundIndex];
  if (currentRound && !currentRound.completedAt) {
    currentRound.completedAt = Date.now();
  }

  if (room.roundIndex >= room.rounds.length - 1) {
    room.status = "results";
    room.updatedAt = Date.now();
    return;
  }

  room.roundIndex += 1;
  const nextRound = room.rounds[room.roundIndex];
  const now = Date.now();
  nextRound.startedAt = now;
  nextRound.endsAt = now + room.settings.roundTimeSec * 1000;
  nextRound.completedAt = null;
  room.updatedAt = now;
}

function submitGuess(room, playerId, latitude, longitude) {
  syncRoom(room);

  const player = room.players.get(String(playerId || ""));
  const currentRound = getCurrentRound(room);

  if (!player || room.status !== "playing" || !currentRound || currentRound.completedAt) {
    return;
  }

  const guessedLat = Number(latitude);
  const guessedLng = Number(longitude);

  if (!Number.isFinite(guessedLat) || !Number.isFinite(guessedLng)) {
    return;
  }

  if (player.guesses[currentRound.index]) {
    return;
  }

  const location = getRoundLocation(currentRound);
  const distanceKm = haversineKm(location.latitude, location.longitude, guessedLat, guessedLng);
  const score = getScore(distanceKm);

  player.guesses[currentRound.index] = {
    latitude: guessedLat,
    longitude: guessedLng,
    distanceKm,
    score,
    guessedAt: Date.now()
  };
  player.totalScore += score;
  room.updatedAt = Date.now();

  if (allPlayersGuessed(room, currentRound)) {
    currentRound.completedAt = Date.now();
  }
}

function leaveRoom(room, playerId) {
  const player = room.players.get(String(playerId || ""));

  if (!player) {
    return;
  }

  player.connected = false;
  room.updatedAt = Date.now();
}

function syncRoom(room, now = Date.now()) {
  if (room.status !== "playing") {
    return false;
  }

  const currentRound = getCurrentRound(room);

  if (!currentRound || currentRound.completedAt) {
    return false;
  }

  if (currentRound.endsAt && now >= currentRound.endsAt) {
    currentRound.completedAt = now;
    room.updatedAt = now;
    return true;
  }

  if (allPlayersGuessed(room, currentRound)) {
    currentRound.completedAt = now;
    room.updatedAt = now;
    return true;
  }

  return false;
}

function allPlayersGuessed(room, round) {
  const players = Array.from(room.players.values());

  if (!players.length) {
    return false;
  }

  return players.every((player) => Boolean(player.guesses[round.index]));
}

function getCurrentRound(room) {
  return room.rounds[room.roundIndex] || null;
}

function getRoundLocation(round) {
  return round?.location || locations.find((location) => location.id === round?.locationId) || locations[0];
}

function getPlayableLocations() {
  return locations.filter((location) => {
    if (location.provider !== "mapillary") {
      return true;
    }

    return Boolean(location.mapillaryImageId && location.isPano);
  });
}

function getRoomView(room, playerId) {
  syncRoom(room);

  const currentRound = getCurrentRound(room);
  const player = room.players.get(String(playerId || ""));
  const myGuess = player && currentRound ? player.guesses[currentRound.index] || null : null;
  const isRoundComplete = Boolean(currentRound && currentRound.completedAt);
  const reveal = Boolean(myGuess || isRoundComplete || room.status === "results");
  const location = currentRound ? getRoundLocation(currentRound) : null;

  return {
    code: room.code,
    hostId: room.hostId,
    you: player ? serializePlayer(player, room, currentRound) : null,
    status: room.status,
    settings: room.settings,
    serverTime: Date.now(),
    roundIndex: room.roundIndex,
    roundCount: room.rounds.length || room.settings.roundCount,
    players: Array.from(room.players.values()).map((roomPlayer) => serializePlayer(roomPlayer, room, currentRound)),
    leaderboard: getLeaderboard(room),
    currentRound: currentRound
      ? {
          index: currentRound.index,
          number: currentRound.index + 1,
          startedAt: currentRound.startedAt,
          endsAt: currentRound.endsAt,
          completedAt: currentRound.completedAt,
          isComplete: isRoundComplete,
          myGuess,
          view: serializeLocation(location, reveal),
          guesses: reveal ? getRoundGuesses(room, currentRound) : []
        }
      : null
  };
}

function serializePlayer(player, room, currentRound) {
  return {
    id: player.id,
    name: player.name,
    totalScore: player.totalScore,
    connected: player.connected,
    isHost: player.id === room.hostId,
    hasGuessed: currentRound ? Boolean(player.guesses[currentRound.index]) : false
  };
}

function getLeaderboard(room) {
  return Array.from(room.players.values())
    .map((player) => ({
      id: player.id,
      name: player.name,
      totalScore: player.totalScore,
      isHost: player.id === room.hostId
    }))
    .sort((first, second) => second.totalScore - first.totalScore || first.name.localeCompare(second.name));
}

function getRoundGuesses(room, round) {
  return Array.from(room.players.values())
    .map((player) => {
      const guess = player.guesses[round.index];

      if (!guess) {
        return null;
      }

      return {
        playerId: player.id,
        playerName: player.name,
        latitude: guess.latitude,
        longitude: guess.longitude,
        distanceKm: guess.distanceKm,
        score: guess.score
      };
    })
    .filter(Boolean)
    .sort((first, second) => second.score - first.score);
}

function serializeLocation(location, reveal) {
  const base = {
    id: location.id,
    provider: location.provider,
    imageUrl: location.imageUrl,
    googlePanoId: location.googlePanoId,
    googleCopyright: location.googleCopyright,
    googleDate: location.googleDate,
    streetViewHeading: Number(location.streetViewHeading || 0),
    panoramaUrl: location.panoramaUrl,
    mapillaryImageId: location.mapillaryImageId,
    mapillarySequenceId: location.mapillarySequenceId,
    isPano: Boolean(location.isPano),
    imageDistanceKm: Number(location.imageDistanceKm || 0),
    attribution: location.attribution,
    country: location.country,
    difficulty: location.difficulty,
    streetViewStatus: location.streetViewStatus || ""
  };

  if (!reveal) {
    return base;
  }

  return {
    ...base,
    title: location.title,
    city: location.city,
    latitude: location.latitude,
    longitude: location.longitude
  };
}

async function prepareStreetViewLocation(location) {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    const googleView = await prepareGoogleStreetViewLocation(location);

    if (googleView.streetViewStatus === "ready" || location.provider !== "mapillary") {
      return googleView;
    }
  }

  const view = { ...location };

  if (view.provider !== "mapillary") {
    return view;
  }

  view.attribution = view.attribution || "Mapillary";

  if (view.mapillaryImageId) {
    view.isPano = Boolean(view.isPano);
    view.streetViewStatus = view.isPano ? "ready" : "not-pano";
    view.panoramaUrl = view.isPano ? `/api/mapillary/${encodeURIComponent(view.mapillaryImageId)}/panorama.jpg` : "";
    return view;
  }

  if (!process.env.MAPILLARY_ACCESS_TOKEN) {
    view.streetViewStatus = "missing-token";
    return view;
  }

  try {
    const image = await findNearestMapillaryImage(view.latitude, view.longitude);

    if (!image) {
      view.streetViewStatus = "not-found";
      return view;
    }

    view.mapillaryImageId = image.id;
    view.mapillarySequenceId = image.sequence || "";
    view.isPano = Boolean(image.isPano);
    view.imageDistanceKm = image.distanceKm;
    view.panoramaUrl = view.isPano ? `/api/mapillary/${encodeURIComponent(view.mapillaryImageId)}/panorama.jpg` : "";
    view.streetViewStatus = "ready";
    return view;
  } catch (error) {
    console.warn(`Mapillary lookup failed for ${view.id}: ${error.message}`);
    view.streetViewStatus = "lookup-failed";
    return view;
  }
}

async function prepareGoogleStreetViewLocation(location) {
  const view = {
    ...location,
    provider: "google",
    attribution: "Google Street View",
    isPano: true,
    panoramaUrl: "",
    streetViewStatus: "ready"
  };

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    view.googlePanoId = "";
    view.streetViewStatus = "missing-google-key";
    return view;
  }

  if (view.googlePanoId) {
    view.streetViewStatus = "ready";
    return view;
  }

  try {
    const metadata = await findGoogleStreetView(location.latitude, location.longitude);

    if (!metadata) {
      view.googlePanoId = "";
      view.streetViewStatus = "google-not-found";
      return view;
    }

    view.googlePanoId = metadata.panoId;
    view.googleCopyright = metadata.copyright;
    view.googleDate = metadata.date;
    view.streetViewHeading = Number.isFinite(view.streetViewHeading) && view.streetViewHeading
      ? view.streetViewHeading
      : getBearingDegrees(metadata.latitude, metadata.longitude, location.latitude, location.longitude);
    view.streetViewStatus = "ready";
    return view;
  } catch (error) {
    console.warn(`Google Street View lookup failed for ${view.id}: ${error.message}`);
    view.googlePanoId = "";
    view.streetViewStatus = "google-lookup-failed";
    return view;
  }
}

async function findGoogleStreetView(latitude, longitude) {
  const key = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;

  if (googleStreetViewCache.has(key)) {
    return googleStreetViewCache.get(key);
  }

  const params = new URLSearchParams({
    location: `${latitude},${longitude}`,
    radius: "80",
    source: "outdoor",
    key: process.env.GOOGLE_MAPS_API_KEY
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Google Street View returned ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "ZERO_RESULTS" || payload.status === "NOT_FOUND") {
    googleStreetViewCache.set(key, null);
    return null;
  }

  if (payload.status !== "OK" || !payload.pano_id) {
    throw new Error(`Google Street View status ${payload.status || "UNKNOWN"}`);
  }

  const metadata = {
    panoId: String(payload.pano_id),
    latitude: Number(payload.location?.lat),
    longitude: Number(payload.location?.lng),
    copyright: String(payload.copyright || "Google"),
    date: String(payload.date || "")
  };

  googleStreetViewCache.set(key, metadata);
  return metadata;
}

async function findNearestMapillaryImage(latitude, longitude) {
  const token = process.env.MAPILLARY_ACCESS_TOKEN;
  const radii = [0.0008, 0.0015, 0.003, 0.006, 0.012];

  for (const radius of radii) {
    const params = new URLSearchParams({
      access_token: token,
      fields: "id,geometry,is_pano,sequence,computed_compass_angle",
      bbox: [
        longitude - radius,
        latitude - radius,
        longitude + radius,
        latitude + radius
      ].join(","),
      limit: "30"
    });
    const response = await fetch(`https://graph.mapillary.com/images?${params.toString()}`);

    if (!response.ok) {
      if (response.status >= 500 && radius < radii[radii.length - 1]) {
        continue;
      }

      throw new Error(`Mapillary returned ${response.status}`);
    }

    const payload = await response.json();
    const candidates = Array.isArray(payload.data) ? payload.data : [];
    const best = candidates
      .filter((image) => image?.is_pano)
      .map((image) => {
        const coordinates = image?.geometry?.coordinates;

        if (!Array.isArray(coordinates) || coordinates.length < 2) {
          return null;
        }

        const distanceKm = haversineKm(latitude, longitude, coordinates[1], coordinates[0]);
        const score =
          distanceKm * 1000 -
          180 -
          (image.sequence ? 80 : 0) -
          (Number.isFinite(image.computed_compass_angle) ? 20 : 0);

        return {
          id: image.id,
          sequence: image.sequence || "",
          isPano: Boolean(image.is_pano),
          distanceKm,
          score
        };
      })
      .filter(Boolean)
      .sort((first, second) => first.score - second.score || first.distanceKm - second.distanceKm)[0];

    if (best) {
      return best;
    }
  }

  return null;
}

async function serveMapillaryPanorama(res, imageId) {
  if (!process.env.MAPILLARY_ACCESS_TOKEN) {
    sendJson(res, 401, { error: "Mapillary token missing." });
    return;
  }

  const metadata = await getMapillaryImageMetadata(imageId);

  if (!metadata?.isPano || !metadata?.thumbOriginalUrl) {
    sendJson(res, 404, { error: "360 panorama image not available." });
    return;
  }

  const response = await fetch(metadata.thumbOriginalUrl);

  if (!response.ok) {
    sendJson(res, 502, { error: "Could not load Mapillary panorama image." });
    return;
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=1800"
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

async function serveMapillaryNavigation(res, imageId, sequenceId) {
  if (!process.env.MAPILLARY_ACCESS_TOKEN) {
    sendJson(res, 401, { error: "Mapillary token missing." });
    return;
  }

  const cleanImageId = String(imageId || "");
  const cleanSequenceId = String(sequenceId || "");

  if (!cleanImageId || !cleanSequenceId) {
    sendJson(res, 400, { error: "Mapillary image and sequence are required." });
    return;
  }

  try {
    const imageIds = await getMapillarySequenceImageIds(cleanSequenceId);
    const imageIndex = imageIds.indexOf(cleanImageId);

    if (imageIndex < 0) {
      sendJson(res, 404, { error: "Image was not found in this street sequence." });
      return;
    }

    const [previous, next] = await Promise.all([
      findSequencePanorama(imageIds, imageIndex, -1, cleanSequenceId),
      findSequencePanorama(imageIds, imageIndex, 1, cleanSequenceId)
    ]);

    sendJson(res, 200, {
      current: makeStreetScene(cleanImageId, cleanSequenceId),
      previous,
      next
    });
  } catch (error) {
    console.warn(`Mapillary navigation failed for ${cleanImageId}: ${error.message}`);
    sendJson(res, 502, { error: "Could not load Mapillary street movement." });
  }
}

async function getMapillaryImageMetadata(imageId) {
  if (mapillaryImageCache.has(imageId)) {
    return mapillaryImageCache.get(imageId);
  }

  const params = new URLSearchParams({
    access_token: process.env.MAPILLARY_ACCESS_TOKEN,
    fields: "id,is_pano,thumb_original_url"
  });
  const response = await fetch(`https://graph.mapillary.com/${encodeURIComponent(imageId)}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Mapillary returned ${response.status}`);
  }

  const payload = await response.json();
  const metadata = {
    id: payload.id,
    isPano: Boolean(payload.is_pano),
    thumbOriginalUrl: payload.thumb_original_url || ""
  };
  mapillaryImageCache.set(imageId, metadata);

  return metadata;
}

async function getMapillarySequenceImageIds(sequenceId) {
  if (mapillarySequenceCache.has(sequenceId)) {
    return mapillarySequenceCache.get(sequenceId);
  }

  const params = new URLSearchParams({
    access_token: process.env.MAPILLARY_ACCESS_TOKEN,
    sequence_id: sequenceId
  });
  const response = await fetch(`https://graph.mapillary.com/image_ids?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Mapillary returned ${response.status}`);
  }

  const payload = await response.json();
  const imageIds = Array.isArray(payload.data)
    ? payload.data.map((image) => String(image?.id || "")).filter(Boolean)
    : [];

  mapillarySequenceCache.set(sequenceId, imageIds);
  return imageIds;
}

async function findSequencePanorama(imageIds, imageIndex, direction, sequenceId) {
  const maxSteps = 12;

  for (let step = 1; step <= maxSteps; step += 1) {
    const candidateId = imageIds[imageIndex + direction * step];

    if (!candidateId) {
      return null;
    }

    try {
      const metadata = await getMapillaryImageMetadata(candidateId);

      if (metadata?.isPano && metadata?.thumbOriginalUrl) {
        return makeStreetScene(candidateId, sequenceId);
      }
    } catch (error) {
      console.warn(`Mapillary image metadata failed for ${candidateId}: ${error.message}`);
    }
  }

  return null;
}

function makeStreetScene(imageId, sequenceId) {
  return {
    provider: "mapillary",
    mapillaryImageId: imageId,
    mapillarySequenceId: sequenceId,
    isPano: true,
    panoramaUrl: `/api/mapillary/${encodeURIComponent(imageId)}/panorama.jpg`,
    attribution: "Mapillary",
    streetViewStatus: "ready"
  };
}

function attachEvents(req, res, room, playerId) {
  const player = room.players.get(String(playerId || ""));

  if (player) {
    player.connected = true;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const client = { res, playerId: String(playerId || "") };
  room.clients.add(client);
  writeEvent(client, getRoomView(room, playerId));

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.clients.delete(client);

    const remainingForPlayer = Array.from(room.clients).some((item) => item.playerId === client.playerId);
    const leavingPlayer = room.players.get(client.playerId);

    if (leavingPlayer && !remainingForPlayer) {
      leavingPlayer.connected = false;
      broadcast(room);
    }
  });
}

function broadcast(room) {
  for (const client of room.clients) {
    writeEvent(client, getRoomView(room, client.playerId));
  }
}

function writeEvent(client, payload) {
  client.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(req, res) {
  const origin = String(req.headers.origin || "");
  const allowedOrigins = getAllowedOrigins();

  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.some((allowedOrigin) => isOriginAllowed(origin, allowedOrigin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getAllowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, allowedOrigin) {
  if (origin === allowedOrigin) {
    return true;
  }

  if (!allowedOrigin.includes("*.")) {
    return false;
  }

  try {
    const candidate = new URL(origin);
    const allowed = new URL(allowedOrigin.replace("*.", ""));
    const allowedHost = allowed.hostname;

    return candidate.protocol === allowed.protocol &&
      (candidate.hostname === allowedHost || candidate.hostname.endsWith(`.${allowedHost}`));
  } catch (error) {
    return false;
  }
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallbackContent) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(fallbackContent);
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function getConfigPayload(req) {
  const hasGoogleMapsApiKey = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  const hasMapillaryToken = Boolean(process.env.MAPILLARY_ACCESS_TOKEN);

  return {
    hasGoogleMapsApiKey,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    hasMapillaryToken,
    canEditProviderKeys: canWriteRuntimeConfig(req),
    streetViewProvider: hasGoogleMapsApiKey ? "Google Street View" : hasMapillaryToken ? "Mapillary" : "None"
  };
}

function assertRuntimeConfigWriteAllowed(req) {
  if (canWriteRuntimeConfig(req)) {
    return;
  }

  const error = new Error("Provider keys must be configured on the backend.");
  error.statusCode = 403;
  throw error;
}

function canWriteRuntimeConfig(req) {
  if (!req) {
    return false;
  }

  const adminToken = String(process.env.ADMIN_SETUP_TOKEN || "");
  const requestToken = String(req.headers["x-admin-setup-token"] || "");

  if (adminToken && requestToken) {
    const adminBuffer = Buffer.from(adminToken);
    const requestBuffer = Buffer.from(requestToken);

    if (adminBuffer.length === requestBuffer.length && crypto.timingSafeEqual(adminBuffer, requestBuffer)) {
      return true;
    }
  }

  const remoteAddress = String(req.socket?.remoteAddress || "");
  return remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
}

function setGoogleMapsKey(rawKey) {
  const key = String(rawKey || "").trim();

  if (key.length < 20) {
    const error = new Error("Paste a valid Google Maps API key.");
    error.statusCode = 400;
    throw error;
  }

  process.env.GOOGLE_MAPS_API_KEY = key;
  googleStreetViewCache.clear();
  saveDotEnvValue("GOOGLE_MAPS_API_KEY", key);

  return key;
}

function setMapillaryToken(rawToken) {
  const token = String(rawToken || "").trim();

  if (token.length < 16) {
    const error = new Error("Paste a valid Mapillary access token.");
    error.statusCode = 400;
    throw error;
  }

  process.env.MAPILLARY_ACCESS_TOKEN = token;
  saveDotEnvValue("MAPILLARY_ACCESS_TOKEN", token);

  return token;
}

function saveDotEnvValue(key, value) {
  const envPath = path.join(__dirname, ".env");
  const line = `${key}=${value}`;
  const lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split(/\r?\n/)
    : [];
  let wrote = false;
  const nextLines = lines.map((currentLine) => {
    if (currentLine.trim().startsWith(`${key}=`)) {
      wrote = true;
      return line;
    }

    return currentLine;
  });

  if (!wrote) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }

    nextLines.push(line);
  }

  fs.writeFileSync(envPath, `${nextLines.filter((item, index) => item !== "" || index < nextLines.length - 1).join("\n")}\n`);
}

function assertHost(room, playerId) {
  if (room.hostId !== String(playerId || "")) {
    const error = new Error("Only the host can do that.");
    error.statusCode = 403;
    throw error;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return radiusKm * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function getBearingDegrees(fromLat, fromLng, toLat, toLng) {
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return 0;
  }

  const startLat = toRadians(fromLat);
  const endLat = toRadians(toLat);
  const deltaLng = toRadians(toLng - fromLng);
  const y = Math.sin(deltaLng) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLng);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function getScore(distanceKm) {
  return Math.max(0, Math.round(5000 * Math.exp(-distanceKm / 900)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function shuffle(items) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}
