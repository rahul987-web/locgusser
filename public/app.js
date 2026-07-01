const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const SESSION_KEY = "locgusser-session";
const API_BASE_URL = normalizeApiBaseUrl(window.LOCGUSSER_API_BASE_URL || "");

let session = loadSession();
let state = null;
let config = { hasGoogleMapsApiKey: false, googleMapsApiKey: "", hasMapillaryToken: false, canEditProviderKeys: false };
let events = null;
let guessMap = null;
let googleStreetView = null;
let googleMapsPromise = null;
let pannellumViewer = null;
let draftGuess = null;
let lastRenderedRoundKey = "";
let activeStreetScene = null;
let activeStreetRoundKey = "";
let streetNavigation = null;
let streetNavigationKey = "";
let toastTimer = null;
let viewerLoadGeneration = 0;
let crazyGameplayActive = false;
let lastHappyRoundKey = "";
let crazyJoinListenerRegistered = false;
let crazyRoomKey = "";

boot();
setInterval(tickClock, 500);

async function boot() {
  await callCrazyGames("init");
  registerCrazyGamesJoinListener();
  callCrazyGames("loadingStart");

  try {
    config = await api("/api/config").catch(() => config);

    if (session?.roomCode && session?.playerId) {
      try {
        state = await api(`/api/rooms/${session.roomCode}/state?playerId=${session.playerId}`);
        connectEvents();
      } catch (error) {
        session = null;
        saveSession();
      }
    }
  } finally {
    render();
    callCrazyGames("loadingStop");
  }
}

function render() {
  cleanupInteractiveViews();

  if (!state || !session) {
    renderConnect();
  } else if (state.status === "lobby") {
    renderLobby();
  } else if (state.status === "playing") {
    renderGame();
  } else {
    renderResults();
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }

  setupTokenForms();
  syncCrazyGamesState();
  syncCrazyGamesRoom();
}

function renderConnect() {
  app.innerHTML = `
    ${topbar("")}
    <main class="container join-layout">
      <section class="preview-stage" aria-label="LocGusser preview">
        <div class="preview-content">
          <h1 class="preview-title">LocGusser</h1>
          <div class="preview-meta">
            <span class="chip"><i data-lucide="map-pin"></i> Guess</span>
            <span class="chip"><i data-lucide="users"></i> Rooms</span>
            <span class="chip"><i data-lucide="trophy"></i> Scores</span>
          </div>
        </div>
      </section>

      <section class="panel stack">
        <div class="tight-stack">
          <h2 class="section-title">Play</h2>
          <p class="muted small">Create a room or join with a code.</p>
        </div>

        <form class="form-grid" id="create-form">
          <div class="field">
            <label for="create-name">Name</label>
            <input id="create-name" name="playerName" maxlength="24" autocomplete="name" placeholder="Rahul" required>
          </div>
          <button class="button" type="submit"><i data-lucide="plus"></i>Create room</button>
        </form>

        <form class="form-grid" id="join-form">
          <div class="field">
            <label for="join-name">Name</label>
            <input id="join-name" name="playerName" maxlength="24" autocomplete="name" placeholder="Friend" required>
          </div>
          <div class="field">
            <label for="room-code">Room code</label>
            <div class="input-row">
              <input id="room-code" name="roomCode" maxlength="8" placeholder="ABCDE" value="${escapeAttribute(getInviteRoomCode())}" required>
              <button class="button secondary" type="submit"><i data-lucide="log-in"></i>Join</button>
            </div>
          </div>
        </form>
      </section>
    </main>
  `;

  document.querySelector("#create-form").addEventListener("submit", createRoom);
  document.querySelector("#join-form").addEventListener("submit", joinRoom);
}

function renderLobby() {
  const isHost = state.you?.isHost;

  app.innerHTML = `
    ${topbar(roomHeaderActions())}
    <main class="container join-layout">
      <section class="panel stack">
        <div class="tight-stack">
          <h1 class="section-title">
            <span>Lobby</span>
            <button class="button secondary" id="copy-code" type="button"><i data-lucide="copy"></i>${state.code}</button>
          </h1>
          <div class="room-code"><i data-lucide="hash"></i>${state.code}</div>
        </div>

        <div class="player-list">
          ${state.players.map(playerRow).join("")}
        </div>
      </section>

      <section class="panel stack">
        <h2 class="section-title">Match</h2>
        ${streetViewNotice()}
        <form class="form-grid" id="start-form">
          <div class="field">
            <label for="round-count">Rounds</label>
            <select id="round-count" name="roundCount" ${isHost ? "" : "disabled"}>
              ${[1, 2, 3, 4, 5, 6].map((count) => `
                <option value="${count}" ${count === state.settings.roundCount ? "selected" : ""}>${count}</option>
              `).join("")}
            </select>
          </div>
          <div class="field">
            <label for="round-time">Timer</label>
            <select id="round-time" name="roundTimeSec" ${isHost ? "" : "disabled"}>
              ${[45, 60, 90, 120, 180].map((seconds) => `
                <option value="${seconds}" ${seconds === state.settings.roundTimeSec ? "selected" : ""}>${formatSeconds(seconds)}</option>
              `).join("")}
            </select>
          </div>
          ${isHost
            ? `<button class="button" type="submit"><i data-lucide="play"></i>Start</button>`
            : `<div class="empty">Waiting for ${escapeHtml(hostName())}</div>`}
        </form>
      </section>
    </main>
  `;

  document.querySelector("#copy-code").addEventListener("click", copyRoomCode);

  if (isHost) {
    document.querySelector("#start-form").addEventListener("submit", startGame);
  }
}

function renderGame() {
  const round = state.currentRound;
  const isRevealed = round.isComplete || Boolean(round.myGuess);
  const roundKey = `${state.code}:${round.index}`;

  if (roundKey !== lastRenderedRoundKey) {
    draftGuess = null;
    activeStreetScene = null;
    activeStreetRoundKey = roundKey;
    streetNavigation = null;
    streetNavigationKey = "";
    lastRenderedRoundKey = roundKey;
  }

  const view = getActiveStreetView(round.view, roundKey);

  app.innerHTML = `
    ${topbar(roomHeaderActions())}
    <main class="game-layout">
      <section class="game-main">
        <div class="round-strip">
          ${stat("Round", `${round.number}/${state.roundCount}`)}
          ${stat("Timer", `<span id="timer-value">${timeLeft(round)}</span>`)}
          ${stat("Your score", formatNumber(state.you?.totalScore || 0))}
          ${stat("Players", `${state.players.length}`)}
        </div>

        <div class="play-surface">
          <section class="viewer-panel">
            ${viewerMarkup(view, isRevealed)}
          </section>

          <section class="map-panel ${isRevealed ? "revealed" : ""}">
            <div id="guess-map" aria-label="Guess map"></div>
            <div class="map-actions">
              <div class="map-status small">${mapStatus(round, isRevealed)}</div>
              ${mapAction(round, isRevealed)}
            </div>
          </section>
        </div>
      </section>

      <aside class="leaderboard-panel">
        ${roundResultMarkup(round, isRevealed)}
        <h2 class="section-title">Leaderboard</h2>
        <div class="score-list">
          ${state.leaderboard.map((player, index) => scoreRow(player, index)).join("")}
        </div>
        ${round.isComplete ? nextRoundMarkup() : guessProgressMarkup()}
      </aside>
    </main>
  `;

  setupViewer(view);
  setupStreetControls(view, roundKey);
  setupGuessMap(round, isRevealed);

  const submitButton = document.querySelector("#submit-guess");
  if (submitButton) {
    submitButton.addEventListener("click", submitGuess);
  }

  const nextButton = document.querySelector("#next-round");
  if (nextButton) {
    nextButton.addEventListener("click", nextRound);
  }
}

function renderResults() {
  app.innerHTML = `
    ${topbar(roomHeaderActions())}
    <main class="container join-layout">
      <section class="preview-stage" aria-label="Winner">
        <div class="preview-content">
          <h1 class="preview-title">${escapeHtml(state.leaderboard[0]?.name || "Results")}</h1>
          <div class="preview-meta">
            <span class="chip"><i data-lucide="trophy"></i>${formatNumber(state.leaderboard[0]?.totalScore || 0)} pts</span>
            <span class="chip"><i data-lucide="hash"></i>${state.code}</span>
          </div>
        </div>
      </section>

      <section class="panel stack">
        <h2 class="section-title">Final scores</h2>
        <div class="score-list">
          ${state.leaderboard.map((player, index) => scoreRow(player, index)).join("")}
        </div>
        ${state.you?.isHost
          ? `<button class="button" id="play-again" type="button"><i data-lucide="rotate-cw"></i>Play again</button>`
          : `<div class="empty">Host can start another match.</div>`}
      </section>
    </main>
  `;

  const playAgain = document.querySelector("#play-again");
  if (playAgain) {
    playAgain.addEventListener("click", () => {
      state.status = "lobby";
      renderLobby();
    });
  }
}

function topbar(actions) {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><i data-lucide="navigation"></i></div>
        <div>
          <h1 class="brand-title">LocGusser</h1>
          <p class="brand-subtitle">Street-view guessing with friends</p>
        </div>
      </div>
      <div class="topbar-actions">${actions || ""}</div>
    </header>
  `;
}

function roomHeaderActions() {
  if (!state) {
    return "";
  }

  return `
    <span class="chip"><i data-lucide="hash"></i>${state.code}</span>
    <button class="button ghost icon-button" id="leave-room" type="button" title="Leave room" aria-label="Leave room">
      <i data-lucide="log-out"></i>
    </button>
  `;
}

function stat(label, value) {
  return `
    <div class="stat">
      <p class="stat-label">${label}</p>
      <p class="stat-value">${value}</p>
    </div>
  `;
}

function playerRow(player) {
  return `
    <div class="player-row">
      <div class="player-name">
        <span class="status-dot ${player.connected ? "on" : ""}"></span>
        <span class="truncate">${escapeHtml(player.name)}</span>
        ${player.isHost ? `<span class="host-badge">HOST</span>` : ""}
      </div>
      <span class="muted small">${player.hasGuessed ? "Locked" : "Ready"}</span>
    </div>
  `;
}

function scoreRow(player, index) {
  return `
    <div class="score-row">
      <div class="score-name">
        <strong>${index + 1}</strong>
        <span class="truncate">${escapeHtml(player.name)}</span>
        ${player.isHost ? `<span class="host-badge">HOST</span>` : ""}
      </div>
      <strong>${formatNumber(player.totalScore)}</strong>
    </div>
  `;
}

function viewerMarkup(view, isRevealed) {
  const caption = isRevealed
    ? `${escapeHtml(view.title || "Location")} · ${escapeHtml([view.city, view.country].filter(Boolean).join(", "))}`
    : `${escapeHtml(view.country || "Mystery")} · ${escapeHtml(view.difficulty || "medium")}`;

  if (view.provider === "google") {
    if (!config.googleMapsApiKey) {
      return streetViewFallbackMarkup(
        "Google Street View key missing",
        "Add a Google Maps API key with Maps JavaScript API and Street View enabled.",
        config.canEditProviderKeys ? googleMapsKeyForm(true) : ""
      );
    }

    if (!view.googlePanoId) {
      const message = view.streetViewStatus === "google-not-found"
        ? "Google Street View did not find a panorama for this round."
        : "Google Street View could not prepare this round.";
      return streetViewFallbackMarkup("Google Street View unavailable", message);
    }

    return `
      <div id="google-street-viewer"></div>
      <div class="viewer-loading" id="viewer-loading">
        <i data-lucide="loader-circle"></i>
        <span>Loading Google Street View</span>
      </div>
      <div class="viewer-caption small">
        <span><i data-lucide="street-view"></i>${caption}</span>
        <span class="muted">Google Street View · ${escapeHtml(view.googleDate || view.attribution || "Google")}</span>
      </div>
    `;
  }

  if (view.provider === "mapillary") {
    if (!config.hasMapillaryToken) {
      return streetViewFallbackMarkup(
        "Mapillary token missing",
        config.canEditProviderKeys
          ? "Paste your free token once. The host game will restart automatically."
          : "The backend needs MAPILLARY_ACCESS_TOKEN configured before public play.",
        config.canEditProviderKeys ? mapillaryTokenForm(true) : ""
      );
    }

    if (!view.mapillaryImageId) {
      const message = view.streetViewStatus === "not-found"
        ? "No nearby 360 Mapillary panorama was found for this round."
        : "Mapillary scene lookup did not finish.";
      return streetViewFallbackMarkup("Street view unavailable", message);
    }

    if (!view.isPano) {
      return streetViewFallbackMarkup("360 panorama unavailable", "This location is not enabled for professional mode.");
    }

    if (!view.panoramaUrl) {
      return streetViewFallbackMarkup("Street view unavailable", "This Mapillary image did not provide a 360 file.");
    }

    return `
      <div id="pano-viewer"></div>
      ${streetControlsMarkup(view)}
      <div class="viewer-loading" id="viewer-loading">
        <i data-lucide="loader-circle"></i>
        <span>Loading 360 street view</span>
      </div>
      <div class="viewer-caption small">
        <span><i data-lucide="street-view"></i>${caption}</span>
        <span class="muted">${streetViewQuality(view)} · ${escapeHtml(view.attribution || "Mapillary")}</span>
      </div>
    `;
  }

  if (view.imageUrl) {
    return `
      <img class="viewer-media" src="${escapeAttribute(view.imageUrl)}" alt="">
      <div class="viewer-caption small">
        <span>${caption}</span>
        <span class="muted">${escapeHtml(view.attribution || "Photo")}</span>
      </div>
    `;
  }

  return `
    <div class="viewer-fallback">
      <div>
        <h2>Street view</h2>
        <p class="muted">Add imageUrl or mapillaryImageId in data/locations.json.</p>
      </div>
    </div>
  `;
}

function getActiveStreetView(baseView, roundKey) {
  if (activeStreetRoundKey !== roundKey) {
    activeStreetScene = null;
    activeStreetRoundKey = roundKey;
    streetNavigation = null;
    streetNavigationKey = "";
  }

  if (!activeStreetScene) {
    return baseView;
  }

  return {
    ...baseView,
    ...activeStreetScene,
    country: baseView.country,
    difficulty: baseView.difficulty,
    title: baseView.title,
    city: baseView.city,
    latitude: baseView.latitude,
    longitude: baseView.longitude,
    imageDistanceKm: baseView.imageDistanceKm
  };
}

function streetControlsMarkup(view) {
  if (!view.mapillarySequenceId) {
    return "";
  }

  return `
    <div class="street-controls" aria-label="Street movement">
      <button class="street-move road-back" data-street-direction="previous" type="button" title="Move back" aria-label="Move back">
        <i data-lucide="chevrons-down"></i>
      </button>
      <button class="street-move road-forward" data-street-direction="next" type="button" title="Move forward" aria-label="Move forward">
        <i data-lucide="chevrons-up"></i>
      </button>
    </div>
  `;
}

function setupViewer(view) {
  if (view.provider === "google" && view.googlePanoId) {
    setupGoogleStreetView(view);
    return;
  }

  if (view.provider === "mapillary" && view.panoramaUrl) {
    setupPannellumViewer(view);
    return;
  }
}

function setupGoogleStreetView(view) {
  const mount = document.querySelector("#google-street-viewer");
  const generation = viewerLoadGeneration + 1;
  viewerLoadGeneration = generation;

  if (!mount) {
    return;
  }

  loadGoogleMapsApi()
    .then(() => {
      if (viewerLoadGeneration !== generation || !window.google?.maps?.StreetViewPanorama) {
        return;
      }

      googleStreetView = new window.google.maps.StreetViewPanorama(mount, {
        pano: view.googlePanoId,
        pov: {
          heading: Number(view.streetViewHeading || 0),
          pitch: 0
        },
        zoom: 0,
        visible: true,
        addressControl: false,
        clickToGo: true,
        disableDefaultUI: false,
        fullscreenControl: true,
        linksControl: true,
        motionTracking: false,
        motionTrackingControl: false,
        panControl: true,
        showRoadLabels: false,
        zoomControl: true
      });

      googleStreetView.addListener("pano_changed", markViewerReady);
      googleStreetView.addListener("links_changed", markViewerReady);
      googleStreetView.addListener("status_changed", () => {
        const status = String(googleStreetView.getStatus?.() || "");

        if (status && status !== "OK") {
          showGoogleStreetViewError(`Google Street View returned ${status}.`);
        }
      });

      setTimeout(() => {
        const loading = document.querySelector("#viewer-loading");

        if (viewerLoadGeneration === generation && loading && !loading.classList.contains("hide")) {
          markViewerReady();
        }
      }, 5000);
    })
    .catch((error) => {
      if (viewerLoadGeneration === generation) {
        showGoogleStreetViewError(error.message || "Google Street View could not load.");
      }
    });
}

function loadGoogleMapsApi() {
  if (window.google?.maps?.StreetViewPanorama) {
    return Promise.resolve();
  }

  if (googleMapsPromise) {
    return googleMapsPromise;
  }

  googleMapsPromise = new Promise((resolve, reject) => {
    if (!config.googleMapsApiKey) {
      reject(new Error("Google Maps API key missing."));
      return;
    }

    const callbackName = "__locgusserGoogleMapsReady";
    window[callbackName] = () => resolve();

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsApiKey)}&v=weekly&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps JavaScript API failed to load."));
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}

function showGoogleStreetViewError(detail) {
  const mount = document.querySelector("#google-street-viewer");
  const panel = mount?.closest(".viewer-panel");

  if (panel) {
    panel.innerHTML = streetViewFallbackMarkup("Google Street View unavailable", detail);
  }
}

function setupStreetControls(view, roundKey) {
  const buttons = Array.from(document.querySelectorAll("[data-street-direction]"));

  if (!buttons.length) {
    return;
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const currentView = state?.currentRound
        ? getActiveStreetView(state.currentRound.view, roundKey)
        : view;
      moveStreet(button.dataset.streetDirection, currentView, roundKey);
    });
  }

  updateStreetControlsForScene(view, roundKey);
}

function updateStreetControlsForScene(view, roundKey) {
  loadStreetNavigation(view)
    .then((navigation) => {
      if (getCurrentRoundKey() === roundKey && getActiveStreetView(state.currentRound.view, roundKey).mapillaryImageId === view.mapillaryImageId) {
        setStreetButtonsState(navigation);
      }
    })
    .catch(() => {
      if (getCurrentRoundKey() === roundKey) {
        setStreetButtonsState({ previous: null, next: null });
      }
    });
}

async function moveStreet(direction, view, roundKey) {
  if (direction !== "previous" && direction !== "next") {
    return;
  }

  if (getCurrentRoundKey() !== roundKey) {
    return;
  }

  setStreetButtonsState(null, direction);

  try {
    const navigation = await loadStreetNavigation(view);

    if (getCurrentRoundKey() !== roundKey) {
      return;
    }

    const target = navigation?.[direction];

    if (!target) {
      setStreetButtonsState(navigation);
      showToast(direction === "next" ? "End of this street." : "Start of this street.");
      return;
    }

    activeStreetRoundKey = roundKey;
    activeStreetScene = target;
    streetNavigation = null;
    streetNavigationKey = "";
    render();
  } catch (error) {
    if (getCurrentRoundKey() === roundKey) {
      setStreetButtonsState(null);
      showToast(error.message || "Street movement unavailable.");
    }
  }
}

async function loadStreetNavigation(view) {
  if (!view.mapillaryImageId || !view.mapillarySequenceId) {
    return { previous: null, next: null };
  }

  const key = `${view.mapillarySequenceId}:${view.mapillaryImageId}`;

  if (streetNavigationKey === key && streetNavigation) {
    return streetNavigation;
  }

  const navigation = await api(
    `/api/mapillary/${encodeURIComponent(view.mapillaryImageId)}/navigation?sequenceId=${encodeURIComponent(view.mapillarySequenceId)}`
  );
  streetNavigationKey = key;
  streetNavigation = navigation;

  return navigation;
}

function setStreetButtonsState(navigation, busyDirection = "") {
  for (const button of document.querySelectorAll("[data-street-direction]")) {
    const direction = button.dataset.streetDirection;
    const isBusy = direction === busyDirection;
    const noTarget = navigation && !navigation[direction];

    button.disabled = Boolean(busyDirection) || Boolean(noTarget);
    button.classList.toggle("loading", isBusy);
  }
}

function getCurrentRoundKey() {
  return state?.currentRound ? `${state.code}:${state.currentRound.index}` : "";
}

function setupPannellumViewer(view, generation = viewerLoadGeneration + 1) {
  const mount = document.querySelector("#pano-viewer");
  viewerLoadGeneration = generation;

  if (!mount) {
    return;
  }

  mount.hidden = false;

  if (!window.pannellum || !hasWebGl()) {
    showStreetViewRendererError("Your browser needs WebGL enabled for the 360 street view.");
    return;
  }

  try {
    pannellumViewer = window.pannellum.viewer(mount, {
      type: "equirectangular",
      panorama: toApiAssetUrl(view.panoramaUrl),
      autoLoad: true,
      showControls: true,
      compass: false,
      hfov: 95,
      minHfov: 45,
      maxHfov: 115,
      yaw: 0,
      pitch: 0,
      mouseZoom: true,
      keyboardZoom: true
    });

    pannellumViewer.on("load", markViewerReady);
    pannellumViewer.on("error", () => {
      showStreetViewRendererError("The 360 street image could not be rendered.");
    });

    setTimeout(() => {
      const loading = document.querySelector("#viewer-loading");

      if (viewerLoadGeneration === generation && loading && !loading.classList.contains("hide")) {
        showStreetViewRendererError("Street view is taking too long to render. Refresh and try again.");
      }
    }, 10000);
  } catch (error) {
    showStreetViewRendererError("The 360 street viewer could not start.");
  }
}

function showStreetViewRendererError(detail) {
  const panoMount = document.querySelector("#pano-viewer");

  if (pannellumViewer) {
    try {
      pannellumViewer.destroy();
    } catch (error) {
      // Pannellum may fail to destroy after a WebGL error.
    }
    pannellumViewer = null;
  }

  const panel = panoMount?.closest(".viewer-panel");

  if (panel) {
    panel.innerHTML = streetViewFallbackMarkup("Street view renderer unavailable", detail);
  }
}

function hasWebGl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
  } catch (error) {
    return false;
  }
}

function markViewerReady() {
  const loading = document.querySelector("#viewer-loading");

  if (loading) {
    loading.classList.add("hide");
  }
}

function streetViewQuality(view) {
  if (view.isPano && view.mapillarySequenceId) {
    return "360 street view";
  }

  if (view.isPano) {
    return "360 panorama";
  }

  if (view.mapillarySequenceId) {
    return "Street sequence";
  }

  return "Street image";
}

function streetViewFallbackMarkup(title, detail, extraMarkup = "") {
  return `
    <div class="viewer-fallback">
      <div class="tight-stack">
        <i data-lucide="scan-search" class="fallback-icon"></i>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(detail)}</p>
        ${extraMarkup}
      </div>
    </div>
  `;
}

function streetViewNotice() {
  if (config.hasGoogleMapsApiKey) {
    return `
      <div class="result-banner">
        <p class="result-place">Google Street View ready</p>
        <span class="muted small">Rounds will use real Google road navigation.</span>
      </div>
    `;
  }

  if (config.hasMapillaryToken) {
    return `
      <div class="result-banner warning">
        <p class="result-place">Free street-view mode</p>
        <span class="muted small">Using Mapillary because no Google Maps API key is set.</span>
      </div>
    `;
  }

  return `
    <div class="result-banner warning">
      <p class="result-place">Google Street View key missing</p>
      <span class="muted small">${config.canEditProviderKeys
        ? "Paste a Google key for real Street View, or add a Mapillary token for free mode."
        : "Configure GOOGLE_MAPS_API_KEY or MAPILLARY_ACCESS_TOKEN on the backend before public release."}</span>
      ${config.canEditProviderKeys ? `
        <div class="setup-forms">
          ${googleMapsKeyForm(false)}
          ${mapillaryTokenForm(false)}
        </div>
      ` : ""}
    </div>
  `;
}

function googleMapsKeyForm(compact) {
  return `
    <form class="google-maps-key-form ${compact ? "compact" : ""}">
      <div class="input-row">
        <input
          name="key"
          type="password"
          autocomplete="off"
          placeholder="Google Maps API key"
          aria-label="Google Maps API key"
          required
        >
        <button class="button" type="submit"><i data-lucide="key-round"></i>Save</button>
      </div>
    </form>
  `;
}

function mapillaryTokenForm(compact) {
  return `
    <form class="mapillary-token-form ${compact ? "compact" : ""}">
      <div class="input-row">
        <input
          name="token"
          type="password"
          autocomplete="off"
          placeholder="Mapillary access token"
          aria-label="Mapillary access token"
          required
        >
        <button class="button" type="submit"><i data-lucide="key-round"></i>Save</button>
      </div>
    </form>
  `;
}

function setupTokenForms() {
  for (const form of document.querySelectorAll(".google-maps-key-form")) {
    form.addEventListener("submit", saveGoogleMapsKey);
  }

  for (const form of document.querySelectorAll(".mapillary-token-form")) {
    form.addEventListener("submit", saveMapillaryToken);
  }
}

async function saveGoogleMapsKey(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = form.querySelector("button");
  const key = new FormData(form).get("key");

  if (button) {
    button.disabled = true;
  }

  try {
    config = await api("/api/config/google-maps-key", {
      method: "POST",
      body: { key }
    });
    googleMapsPromise = null;
    showToast("Google Maps API key saved.");

    if (state?.status === "playing" && state.you?.isHost) {
      state = await api(`/api/rooms/${session.roomCode}/start`, {
        method: "POST",
        body: {
          playerId: session.playerId,
          roundCount: state.settings.roundCount,
          roundTimeSec: state.settings.roundTimeSec
        }
      });
      showToast("Google Street View rounds restarted.");
    } else if (state && session) {
      state = await api(`/api/rooms/${session.roomCode}/state?playerId=${session.playerId}`);
    }

    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function saveMapillaryToken(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = form.querySelector("button");
  const token = new FormData(form).get("token");

  if (button) {
    button.disabled = true;
  }

  try {
    config = await api("/api/config/mapillary-token", {
      method: "POST",
      body: { token }
    });
    showToast("Mapillary token saved.");

    if (state?.status === "playing" && state.you?.isHost) {
      state = await api(`/api/rooms/${session.roomCode}/start`, {
        method: "POST",
        body: {
          playerId: session.playerId,
          roundCount: state.settings.roundCount,
          roundTimeSec: state.settings.roundTimeSec
        }
      });
      showToast("Street-view rounds restarted.");
    } else if (state && session) {
      state = await api(`/api/rooms/${session.roomCode}/state?playerId=${session.playerId}`);
    }

    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function setupGuessMap(round, isRevealed) {
  const mount = document.querySelector("#guess-map");

  if (!mount || !window.L) {
    return;
  }

  const center = draftGuess
    ? [draftGuess.latitude, draftGuess.longitude]
    : isRevealed && round.view.latitude
      ? [round.view.latitude, round.view.longitude]
      : [20, 0];
  const zoom = draftGuess || isRevealed ? 5 : 2;

  guessMap = window.L.map(mount, {
    zoomControl: false,
    attributionControl: true
  }).setView(center, zoom);

  window.L.control.zoom({ position: "topright" }).addTo(guessMap);
  window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(guessMap);

  if (!round.myGuess && !round.isComplete) {
    guessMap.on("click", (event) => {
      draftGuess = {
        latitude: event.latlng.lat,
        longitude: event.latlng.lng
      };
      render();
    });
  }

  if (draftGuess) {
    window.L.marker([draftGuess.latitude, draftGuess.longitude]).addTo(guessMap);
  }

  if (round.myGuess) {
    window.L.marker([round.myGuess.latitude, round.myGuess.longitude], {
      title: "Your guess"
    }).addTo(guessMap);
  }

  if (isRevealed && round.view.latitude) {
    const actual = [round.view.latitude, round.view.longitude];
    window.L.circleMarker(actual, {
      radius: 9,
      color: "#0f1512",
      weight: 3,
      fillColor: "#58d68d",
      fillOpacity: 1
    }).addTo(guessMap);

    const guesses = round.guesses || [];
    for (const guess of guesses) {
      const guessed = [guess.latitude, guess.longitude];
      window.L.polyline([actual, guessed], { color: "#ffd166", weight: 2, opacity: 0.75 }).addTo(guessMap);
      window.L.circleMarker(guessed, {
        radius: 6,
        color: "#101412",
        weight: 2,
        fillColor: guess.playerId === state.you?.id ? "#66a6ff" : "#ffd166",
        fillOpacity: 0.95
      }).bindTooltip(guess.playerName).addTo(guessMap);
    }

    const bounds = window.L.latLngBounds([actual, ...guesses.map((guess) => [guess.latitude, guess.longitude])]);
    if (bounds.isValid()) {
      guessMap.fitBounds(bounds.pad(0.25), { maxZoom: 8 });
    }
  }

  setTimeout(() => guessMap?.invalidateSize(), 80);
}

function cleanupInteractiveViews() {
  viewerLoadGeneration += 1;

  if (googleStreetView) {
    try {
      window.google?.maps?.event?.clearInstanceListeners(googleStreetView);
      googleStreetView.setVisible(false);
    } catch (error) {
      // The Google viewer may already have been detached with the DOM.
    }
    googleStreetView = null;
  }

  if (pannellumViewer) {
    try {
      pannellumViewer.destroy();
    } catch (error) {
      // Pannellum may already have been removed with the DOM.
    }
    pannellumViewer = null;
  }

  if (guessMap) {
    try {
      guessMap.remove();
    } catch (error) {
      // Leaflet may already have been removed with the DOM.
    }
    guessMap = null;
  }
}

function mapStatus(round, isRevealed) {
  if (round.myGuess) {
    return `${formatDistance(round.myGuess.distanceKm)} · ${formatNumber(round.myGuess.score)} pts`;
  }

  if (round.isComplete) {
    return "Round closed";
  }

  if (draftGuess) {
    return `${draftGuess.latitude.toFixed(3)}, ${draftGuess.longitude.toFixed(3)}`;
  }

  return "Click the map";
}

function mapAction(round, isRevealed) {
  if (round.myGuess || isRevealed) {
    return "";
  }

  return `
    <button class="button" id="submit-guess" type="button" ${draftGuess ? "" : "disabled"}>
      <i data-lucide="map-pin-check"></i>Lock guess
    </button>
  `;
}

function roundResultMarkup(round, isRevealed) {
  if (!isRevealed) {
    return "";
  }

  const place = [round.view.title, round.view.city, round.view.country].filter(Boolean).join(", ");
  const guess = round.myGuess;

  return `
    <div class="result-banner">
      <p class="result-place">${escapeHtml(place)}</p>
      <span class="muted small">${guess ? `${formatDistance(guess.distanceKm)} away · ${formatNumber(guess.score)} pts` : "No guess locked"}</span>
    </div>
    ${round.guesses?.length ? `
      <div class="guess-table">
        ${round.guesses.map((guess) => `
          <div class="score-row">
            <span class="truncate">${escapeHtml(guess.playerName)}</span>
            <strong>${formatDistance(guess.distanceKm)}</strong>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function nextRoundMarkup() {
  if (!state.you?.isHost) {
    return `<div class="empty">Waiting for host.</div>`;
  }

  const label = state.roundIndex >= state.roundCount - 1 ? "Show results" : "Next round";

  return `
    <button class="button warn" id="next-round" type="button">
      <i data-lucide="arrow-right"></i>${label}
    </button>
  `;
}

function guessProgressMarkup() {
  return `
    <div class="player-list">
      ${state.players.map((player) => `
        <div class="player-row">
          <div class="player-name">
            <span class="status-dot ${player.hasGuessed ? "on" : ""}"></span>
            <span class="truncate">${escapeHtml(player.name)}</span>
          </div>
          <span class="muted small">${player.hasGuessed ? "Locked" : "Guessing"}</span>
        </div>
      `).join("")}
    </div>
  `;
}

async function createRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const playerName = form.get("playerName");

  try {
    const response = await api("/api/rooms", {
      method: "POST",
      body: { playerName }
    });
    useSession(response);
  } catch (error) {
    showToast(error.message);
  }
}

async function joinRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const playerName = form.get("playerName");
  const roomCode = String(form.get("roomCode") || "").trim().toUpperCase();

  try {
    const response = await api(`/api/rooms/${roomCode}/join`, {
      method: "POST",
      body: { playerName }
    });
    useSession(response);
  } catch (error) {
    showToast(error.message);
  }
}

async function startGame(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    state = await api(`/api/rooms/${session.roomCode}/start`, {
      method: "POST",
      body: {
        playerId: session.playerId,
        roundCount: Number(form.get("roundCount")),
        roundTimeSec: Number(form.get("roundTimeSec"))
      }
    });
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function submitGuess() {
  if (!draftGuess) {
    return;
  }

  try {
    state = await api(`/api/rooms/${session.roomCode}/guess`, {
      method: "POST",
      body: {
        playerId: session.playerId,
        latitude: draftGuess.latitude,
        longitude: draftGuess.longitude
      }
    });
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function nextRound() {
  try {
    state = await api(`/api/rooms/${session.roomCode}/next`, {
      method: "POST",
      body: { playerId: session.playerId }
    });
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function leaveRoom() {
  if (session?.roomCode && session?.playerId) {
    await api(`/api/rooms/${session.roomCode}/leave`, {
      method: "POST",
      body: { playerId: session.playerId }
    }).catch(() => null);
  }

  if (events) {
    events.close();
    events = null;
  }

  session = null;
  state = null;
  saveSession();
  resetCrazyGamesRoom();
  render();
}

function useSession(response) {
  session = {
    roomCode: response.roomCode,
    playerId: response.playerId
  };
  state = response.room;
  saveSession();
  connectEvents();
  render();
}

function connectEvents() {
  if (!session?.roomCode || !session?.playerId) {
    return;
  }

  if (events) {
    events.close();
  }

  events = new EventSource(apiUrl(`/events/${session.roomCode}?playerId=${session.playerId}`));
  events.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
    render();
  });
  events.onerror = () => {
    showToast("Connection paused. Reconnecting...");
  };
}

async function api(url, options = {}) {
  const response = await fetch(apiUrl(url), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function apiUrl(pathname) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(String(pathname))) {
    return pathname;
  }

  const path = String(pathname || "/");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${API_BASE_URL}${normalizedPath}`;
}

function toApiAssetUrl(url) {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(String(url))) {
    return url;
  }

  if (String(url).startsWith("/api/")) {
    return apiUrl(url);
  }

  return url;
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch (error) {
    return null;
  }
}

function saveSession() {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function copyRoomCode() {
  const inviteParams = getCrazyInviteParams();
  const inviteUrl = state?.code
    ? await callCrazyGames("inviteLink", inviteParams) || getInviteUrl()
    : getInviteUrl();

  if (!navigator.clipboard) {
    showToast(state.code);
    return;
  }

  navigator.clipboard.writeText(inviteUrl).then(() => showToast("Invite link copied."));
}

function getInviteUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.code);
  return url.toString();
}

function getInviteRoomCode() {
  try {
    const roomCode = getCrazyGamesInviteParam("room") || new URLSearchParams(window.location.search).get("room");
    return String(roomCode || "").trim().toUpperCase().slice(0, 8);
  } catch (error) {
    return "";
  }
}

function registerCrazyGamesJoinListener() {
  if (crazyJoinListenerRegistered) {
    return;
  }

  crazyJoinListenerRegistered = true;
  callCrazyGames("addJoinRoomListener", (params = {}) => {
    const roomCode = String(params.room || params.roomCode || "").trim().toUpperCase().slice(0, 8);

    if (!roomCode) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    window.history.replaceState(null, "", url.toString());

    if (!session) {
      render();
      showToast(`Invite ready for room ${roomCode}.`);
    }
  });
}

function syncCrazyGamesState() {
  const currentRound = state?.currentRound;
  const activelyPlaying = Boolean(state?.status === "playing" && currentRound && !currentRound.isComplete && !currentRound.myGuess);

  if (activelyPlaying && !crazyGameplayActive) {
    callCrazyGames("gameplayStart");
    crazyGameplayActive = true;
  } else if (!activelyPlaying && crazyGameplayActive) {
    callCrazyGames("gameplayStop");
    crazyGameplayActive = false;
  }

  const happyRoundKey = currentRound?.myGuess ? `${state.code}:${currentRound.index}` : "";

  if (happyRoundKey && happyRoundKey !== lastHappyRoundKey && currentRound.myGuess.score >= 4500) {
    lastHappyRoundKey = happyRoundKey;
    callCrazyGames("happytime");
  }
}

function syncCrazyGamesRoom() {
  if (!state?.code || !session?.roomCode) {
    if (crazyRoomKey) {
      resetCrazyGamesRoom();
    }
    return;
  }

  const roomKey = state.code;

  if (crazyRoomKey === roomKey) {
    return;
  }

  crazyRoomKey = roomKey;

  const inviteParams = getCrazyInviteParams();

  callCrazyGames("updateRoom", {
    roomId: state.code,
    isJoinable: true,
    inviteParams
  });
  callCrazyGames("inviteLink", inviteParams);
  callCrazyGames("showInviteButton", inviteParams);
}

function resetCrazyGamesRoom() {
  if (!crazyRoomKey) {
    return;
  }

  crazyRoomKey = "";
  callCrazyGames("hideInviteButton");
  callCrazyGames("leftRoom");
}

function getCrazyInviteParams() {
  return { room: state?.code || session?.roomCode || getInviteRoomCode() };
}

function getCrazyGamesInviteParam(name) {
  const sdk = window.LocGusserCrazyGames;

  if (!sdk || typeof sdk.getInviteParam !== "function") {
    return "";
  }

  try {
    const value = sdk.getInviteParam(name);

    if (typeof value === "string") {
      return value;
    }
  } catch (error) {
    return "";
  }

  return "";
}

function callCrazyGames(method, ...args) {
  const sdk = window.LocGusserCrazyGames;

  if (!sdk || typeof sdk[method] !== "function") {
    return Promise.resolve(false);
  }

  try {
    return Promise.resolve(sdk[method](...args)).catch(() => false);
  } catch (error) {
    return Promise.resolve(false);
  }
}

function hostName() {
  return state.players.find((player) => player.isHost)?.name || "host";
}

function timeLeft(round) {
  if (round.isComplete || !round.endsAt) {
    return "0:00";
  }

  const remaining = Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000));
  return formatSeconds(remaining);
}

function tickClock() {
  const timer = document.querySelector("#timer-value");

  if (!timer || state?.status !== "playing" || !state.currentRound) {
    return;
  }

  timer.textContent = timeLeft(state.currentRound);
}

function formatSeconds(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN").format(Math.round(value || 0));
}

function formatDistance(value) {
  if (value < 1) {
    return `${Math.round(value * 1000)} m`;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} km`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

document.addEventListener("click", (event) => {
  const leaveButton = event.target.closest("#leave-room");

  if (leaveButton) {
    leaveRoom();
  }
});
