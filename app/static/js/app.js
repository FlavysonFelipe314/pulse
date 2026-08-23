const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const DEVICE_MEDIA_CACHE_PREFIX = "pulse-media-v3-user-";
const CLIENT_DATA_VERSION = "pulse-data-v4";

const starterTracks = [
  { title: "The Less I Know The Better", artist: "Tame Impala", youtube_video_id: "sBzrzS1Ag_g", thumbnail: "https://i.ytimg.com/vi/sBzrzS1Ag_g/hqdefault.jpg", duration_seconds: 216 },
  { title: "Redbone", artist: "Childish Gambino", youtube_video_id: "Kp7eSUU9oy8", thumbnail: "https://i.ytimg.com/vi/Kp7eSUU9oy8/hqdefault.jpg", duration_seconds: 327 },
  { title: "Do I Wanna Know?", artist: "Arctic Monkeys", youtube_video_id: "bpOSxM0rNPM", thumbnail: "https://i.ytimg.com/vi/bpOSxM0rNPM/hqdefault.jpg", duration_seconds: 272 },
  { title: "Borderline", artist: "Tame Impala", youtube_video_id: "2g5xkLqIElU", thumbnail: "https://i.ytimg.com/vi/2g5xkLqIElU/hqdefault.jpg", duration_seconds: 238 },
  { title: "Feels Like We Only Go Backwards", artist: "Tame Impala", youtube_video_id: "wycjnCCgUes", thumbnail: "https://i.ytimg.com/vi/wycjnCCgUes/hqdefault.jpg", duration_seconds: 193 },
];

const state = {
  user: null,
  view: "home", library: [], playlists: [], folders: [], history: [], search: [],
  queue: [], currentIndex: -1, shuffle: false, shuffleOrder: [], shuffleCursor: -1,
  repeat: "off", current: null, playing: false, volume: .75, mutedVolume: null,
  audio: null, source: null,
  resumePosition: 0, activeDownloads: new Map(), filter: "all",
  deviceOfflineIds: new Set(), deviceSavingIds: new Set(),
  syncingDevice: false,
  room: null, roomSocket: null, roomSyncTimer: null, roomReconnectTimer: null, roomAudioBlocked: false, roomSearch: [],
  lyrics: null, activeLyricIndex: -1, lyricsLoadingId: null,
  notifications: [], dismissedNotifications: new Set(), knownFriendRequestIds: null, notificationTimer: null,
  floatingWindow: null, floatingSearch: [],
};
let deferredInstallPrompt = null;
let installInProgress = false;
let installWatchdog = null;
let installCompletedThisSession = false;

function migrateClientData() {
  if (localStorage.getItem("pulse:data-version") === CLIENT_DATA_VERSION) return;
  Object.keys(localStorage)
    .filter(key => key.startsWith("pulse:snapshot:"))
    .forEach(key => localStorage.removeItem(key));
  localStorage.setItem("pulse:data-version", CLIENT_DATA_VERSION);
}

function deviceVolumeKey() {
  return `pulse:volume:${state.user?.id || "anonymous"}`;
}

function loadDeviceVolume() {
  const stored = localStorage.getItem(deviceVolumeKey());
  if (stored === null) return .75;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .75;
}

function saveDeviceVolume() {
  localStorage.setItem(deviceVolumeKey(), String(state.volume));
}

function setDeviceVolume(value, persist = true) {
  state.volume = Math.max(0, Math.min(1, Number(value)));
  if (state.audio) state.audio.volume = state.volume;
  $("#volumeBar").value = state.volume;
  $("#mobileVolumeBar").value = state.volume;
  $("#mobileVolumeValue").textContent = `${Math.round(state.volume * 100)}%`;
  setRangeFill($("#volumeBar"), state.volume * 100);
  setRangeFill($("#mobileVolumeBar"), state.volume * 100);
  saveDeviceVolume();
  if (persist) persistState();
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch (error) {
    throw new Error(navigator.onLine ? "Não foi possível conectar ao servidor." : "Sem conexão. Alguns recursos estão indisponíveis.");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || "Algo não saiu como esperado.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function fmt(seconds) {
  if (!Number.isFinite(Number(seconds))) return "—";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function normalized(raw) {
  return {
    ...raw,
    title: decodeEntities(raw.title || "Sem título"),
    artist: decodeEntities(raw.artist || raw.channel || "Artista desconhecido"),
    youtube_video_id: raw.youtube_video_id || raw.videoId,
    thumbnail: raw.thumbnail || "",
    duration_seconds: raw.duration_seconds ?? raw.durationSeconds ?? 0,
  };
}

function decodeEntities(value) {
  const element = document.createElement("textarea");
  element.innerHTML = value;
  return element.value;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toasts").append(item);
  setTimeout(() => item.remove(), 3200);
}

function resetAccountState() {
  state.library = []; state.playlists = []; state.folders = []; state.history = []; state.search = [];
  state.queue = []; state.current = null; state.currentIndex = -1; state.deviceOfflineIds = new Set();
  state.audio?.pause(); if (state.audio) state.audio.removeAttribute("src");
  clearInterval(state.notificationTimer); state.notificationTimer = null;
  state.notifications = []; state.dismissedNotifications = new Set(); state.knownFriendRequestIds = null;
  if (state.floatingWindow && !state.floatingWindow.closed) state.floatingWindow.close(); state.floatingWindow = null;
}

function applyUser(user) {
  state.user = user;
  localStorage.setItem("pulse:last-user", JSON.stringify(user));
  const initial = (user.display_name || "P").trim().charAt(0).toUpperCase();
  $$('[data-profile-name]').forEach(element => { element.textContent = user.display_name; });
  $$('[data-profile-avatar]').forEach(element => { element.textContent = initial; });
}

function showAuthenticatedApp() {
  document.body.classList.remove("auth-pending", "auth-required");
  document.body.classList.add("auth-ready");
  $("#authError").textContent = "";
}

function showAuthScreen(message = "") {
  document.body.classList.remove("auth-pending", "auth-ready");
  document.body.classList.add("auth-required");
  $("#authError").textContent = message;
  setTimeout(() => $("#loginForm input")?.focus(), 80);
}

async function initializeApp() {
  try {
    const user = await api("/api/auth/me");
    applyUser(user);
    showAuthenticatedApp();
    await bootstrap();
  } catch (error) {
    if (!navigator.onLine) {
      try {
        const cachedUser = JSON.parse(localStorage.getItem("pulse:last-user") || "null");
        if (cachedUser) {
          applyUser(cachedUser); showAuthenticatedApp(); await bootstrap(); return;
        }
      } catch (_) {}
    }
    showAuthScreen(error.status === 401 ? "" : error.message);
  }
}

async function submitAuth(form, mode) {
  const button = $("button[type='submit'],button:not([type])", form);
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  button.textContent = mode === "register" ? "Criando conta..." : "Entrando...";
  $("#authError").textContent = "";
  try {
    const user = await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(data) });
    resetAccountState(); applyUser(user); showAuthenticatedApp(); await bootstrap(); form.reset();
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = mode === "register" ? "Criar minha conta" : "Entrar";
  }
}

function switchAuthMode(mode) {
  const registering = mode === "register";
  $("#loginForm").classList.toggle("hidden", registering);
  $("#registerForm").classList.toggle("hidden", !registering);
  $("#authTitle").textContent = registering ? "Crie sua conta" : "Entre na sua conta";
  $("#authMessage").textContent = registering ? "Sua biblioteca será privada e acompanhará você em todos os aparelhos." : "Acesse sua biblioteca e mantenha suas músicas sincronizadas em todos os seus aparelhos.";
  $("#authSwitch").textContent = registering ? "Já tenho uma conta" : "Ainda não tenho conta";
  $("#authSwitch").dataset.mode = registering ? "login" : "register";
  $("#authError").textContent = "";
}

async function bootstrap() {
  try {
    const [library, playlists, folders, history, playback] = await Promise.all([
      api("/api/library"), api("/api/playlists"), api("/api/folders"), api("/api/library/history/recent"), api("/api/player/state")
    ]);
    state.library = library.map(normalized);
    state.playlists = playlists.map(p => ({ ...p, tracks: p.tracks.map(normalized) }));
    state.folders = folders;
    state.history = history.map(normalized);
    state.volume = loadDeviceVolume();
    state.shuffle = playback.shuffle;
    state.repeat = playback.repeat_mode;
    state.resumePosition = playback.position || 0;
    state.current = state.library.find(track => track.id === playback.music_id) || null;
    const savedQueue = loadSavedQueue();
    state.queue = savedQueue.length ? savedQueue : state.current ? [...state.library] : [];
    if (state.current && !state.queue.some(track => sameTrack(track, state.current))) state.queue.unshift(state.current);
    state.currentIndex = state.current ? state.queue.findIndex(t => t.id === state.current.id) : -1;
    await loadDeviceOfflineIndex();
    $("#volumeBar").value = state.volume;
    $("#mobileVolumeBar").value = state.volume;
    $("#mobileVolumeValue").textContent = `${Math.round(state.volume * 100)}%`;
    setRangeFill($("#volumeBar"), state.volume * 100);
    setRangeFill($("#mobileVolumeBar"), state.volume * 100);
    updateModeButtons();
    setupMediaSession();
    renderAll();
    if (state.current) updatePlayerMeta();
    if (state.current?.playable_locally) prepareLocalAudio(state.current, false);
  } catch (error) {
    restoreClientSnapshot();
    await loadDeviceOfflineIndex();
    renderAll();
    toast(error.message, "error");
  }
  const requestedView = new URLSearchParams(location.search).get("view");
  if (["home", "search", "library", "favorites", "history"].includes(requestedView)) navigate(requestedView);
  await restoreListeningRoom();
  await refreshImportantNotifications(false);
  clearInterval(state.notificationTimer);
  state.notificationTimer = setInterval(() => refreshImportantNotifications(true), 30000);
  if (state.user?.auto_download_devices && navigator.onLine) syncOfflineLibrary();
}

function renderAll() {
  closeContextMenu();
  renderSidebar(); renderHome(); renderLibrary(); renderFavorites(); renderHistory(); renderQueue();
  saveClientSnapshot();
}

function saveClientSnapshot() {
  if (!state.user) return;
  try { localStorage.setItem(`pulse:snapshot:${state.user.id}`, JSON.stringify({ library: state.library, playlists: state.playlists, folders: state.folders, history: state.history, queue: state.queue, currentIndex: state.currentIndex })); } catch (_) {}
}

function loadSavedQueue() {
  try {
    const cached = JSON.parse(localStorage.getItem(`pulse:snapshot:${state.user?.id}`) || "null");
    if (!cached?.queue) return [];
    const allowedIds = new Set(state.library.map(track => track.id));
    return cached.queue.map(normalized).filter(track => !track.id || allowedIds.has(track.id));
  } catch (_) { return []; }
}

function restoreClientSnapshot() {
  try {
    const cached = JSON.parse(localStorage.getItem(`pulse:snapshot:${state.user?.id}`) || "null");
    if (!cached) return;
    state.library = (cached.library || []).map(normalized);
    state.playlists = (cached.playlists || []).map(p => ({ ...p, tracks: (p.tracks || []).map(normalized) }));
    state.folders = cached.folders || [];
    state.history = (cached.history || []).map(normalized);
    state.queue = (cached.queue || []).map(normalized);
    state.currentIndex = Number.isInteger(cached.currentIndex) ? cached.currentIndex : -1;
  } catch (_) {}
}

function deviceMediaUrl(musicId) {
  return `/api/media/music/${musicId}?account=${state.user?.id || 0}`;
}

function deviceMediaCacheName() {
  return `${DEVICE_MEDIA_CACHE_PREFIX}${state.user?.id || "anonymous"}`;
}

function isTrackOnDevice(track) {
  return Boolean(track?.id && state.deviceOfflineIds.has(Number(track.id)));
}

async function loadDeviceOfflineIndex() {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(deviceMediaCacheName());
    const requests = await cache.keys();
    state.deviceOfflineIds = new Set(requests.map(request => {
      const match = new URL(request.url).pathname.match(/^\/api\/media\/music\/(\d+)$/);
      return match ? Number(match[1]) : null;
    }).filter(Boolean));
  } catch (_) {
    state.deviceOfflineIds = new Set();
  }
}

async function saveTrackOnDevice(raw, options = {}) {
  const track = normalized(raw);
  if (!track.id || !track.playable_locally) {
    if (!options.silent) toast("A música precisa terminar de baixar antes de ser salva neste aparelho.", "error");
    return false;
  }
  if (isTrackOnDevice(track)) {
    if (!options.silent) toast("Esta música já está disponível neste aparelho.");
    return true;
  }
  if (!("caches" in window)) {
    if (!options.silent) toast("Este navegador não permite salvar músicas para uso offline.", "error");
    return false;
  }
  state.deviceSavingIds.add(Number(track.id));
  renderAll();
  showDownloadDock(track, { progress: 94, message: "Salvando uma cópia neste aparelho..." });
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
    const url = deviceMediaUrl(track.id);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("O arquivo não está disponível no servidor.");
    const cache = await caches.open(deviceMediaCacheName());
    await cache.put(url, response);
    state.deviceOfflineIds.add(Number(track.id));
    showDownloadDock(track, { progress: 100, message: "Salva neste aparelho", status: "complete" });
    if (!options.silent) toast("Música salva neste aparelho para ouvir offline.");
    return true;
  } catch (error) {
    if (!options.silent) toast(`Não foi possível salvar no aparelho: ${error.message}`, "error");
    return false;
  } finally {
    state.deviceSavingIds.delete(Number(track.id));
    renderAll();
    if (!state.syncingDevice) setTimeout(hideDownloadDock, 1800);
  }
}

async function removeTrackFromDevice(raw, options = {}) {
  const track = normalized(raw);
  if (!track.id || !("caches" in window)) return;
  try {
    const cache = await caches.open(deviceMediaCacheName());
    await cache.delete(deviceMediaUrl(track.id));
    state.deviceOfflineIds.delete(Number(track.id));
    renderAll();
    if (!options.silent) toast("Cópia removida deste aparelho. A música continua na biblioteca.");
  } catch (_) {
    if (!options.silent) toast("Não foi possível remover a cópia deste aparelho.", "error");
  }
}

async function syncOfflineLibrary() {
  if (state.syncingDevice || !state.user?.auto_download_devices || !navigator.onLine) return;
  const pending = state.library.filter(track => track.playable_locally && !isTrackOnDevice(track));
  if (!pending.length) return;
  state.syncingDevice = true;
  toast(`Sincronizando ${pending.length} ${pending.length === 1 ? "música" : "músicas"} neste aparelho...`);
  let saved = 0;
  for (const track of pending) {
    if (!navigator.onLine || !state.user?.auto_download_devices) break;
    if (await saveTrackOnDevice(track, { silent: true })) saved += 1;
  }
  state.syncingDevice = false;
  hideDownloadDock();
  if (saved) toast(`${saved} ${saved === 1 ? "música sincronizada" : "músicas sincronizadas"} neste aparelho.`);
}

function profileModal() {
  if (!state.user) return;
  modal(`<div class="modal profile-modal"><div class="modal-head"><div><span class="eyebrow">CONTA PRIVADA</span><h2>${escapeHtml(state.user.display_name)}</h2></div><button class="icon-btn" data-close="modal">${icon("close")}</button></div><p class="profile-email">${escapeHtml(state.user.email)}</p><button class="soft-btn" data-view="social" data-close="modal" style="width:100%;margin-bottom:12px">${icon("users")} Pessoas, amigos e salas</button><label class="preference-row"><span><strong>Baixar automaticamente nos aparelhos</strong><small>Ao entrar em um aparelho novo, o Pulse salva localmente todas as músicas disponíveis na sua biblioteca.</small></span><input type="checkbox" id="autoDownloadPreference" ${state.user.auto_download_devices ? "checked" : ""}></label><div class="privacy-note">Cada conta enxerga somente sua biblioteca, playlists, favoritos e histórico. Ao sair, as cópias offline desta conta são removidas deste aparelho.</div><div class="modal-actions"><button class="soft-btn danger" id="logoutBtn">Sair da conta</button><button class="primary-btn" data-close="modal">Continuar ouvindo</button></div></div>`);
}

async function updateAutoDownloadPreference(checked) {
  try {
    state.user = await api("/api/auth/preferences", { method: "PATCH", body: JSON.stringify({ auto_download_devices: checked }) });
    applyUser(state.user);
    toast(checked ? "Sincronização automática ativada." : "Sincronização automática desativada.");
    if (checked) syncOfflineLibrary();
  } catch (error) {
    $("#autoDownloadPreference").checked = !checked;
    toast(error.message, "error");
  }
}

async function logoutAccount() {
  const userId = state.user?.id;
  if (state.room) leaveListeningRoom();
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
  if ("caches" in window && userId) {
    try { await caches.delete(`${DEVICE_MEDIA_CACHE_PREFIX}${userId}`); } catch (_) {}
  }
  if (userId) localStorage.removeItem(`pulse:snapshot:${userId}`);
  localStorage.removeItem("pulse:last-user");
  closeModal(); resetAccountState(); state.user = null; showAuthScreen("Você saiu com segurança.");
}

function renderSidebar() {
  $("#sidePlaylists").innerHTML = state.playlists.length
    ? state.playlists.map(p => `<button class="side-playlist" data-playlist="${p.id}">${escapeHtml(p.name)}</button>`).join("")
    : `<span class="side-playlist" style="cursor:default">Nenhuma playlist ainda</span>`;
}

function section(title, subtitle, tracks) {
  if (!tracks.length) return "";
  return `<section class="section-block"><div class="section-title"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="text-btn" data-view="library">Ver tudo</button></div><div class="card-grid">${tracks.slice(0, 5).map(cardHtml).join("")}</div></section>`;
}

function renderHome() {
  const recent = state.history.length ? state.history : starterTracks;
  let html = section(state.history.length ? "Ouvidas recentemente" : "Comece por aqui", state.history.length ? "Retome de onde parou" : "Uma seleção para dar o primeiro play", recent);
  if (state.playlists.length) {
    html += `<section class="section-block"><div class="section-title"><div><h2>Suas playlists</h2><p>Coleções feitas por você</p></div></div><div class="card-grid">${state.playlists.slice(0, 5).map(playlistCard).join("")}</div></section>`;
  }
  if (state.library.length) html += section("Adicionadas recentemente", "Novidades na sua biblioteca", state.library);
  $("#homeSections").innerHTML = html;
}

function cardHtml(raw) {
  const track = normalized(raw);
  const key = track.id ? `lib:${track.id}` : `yt:${track.youtube_video_id}`;
  const playing = sameTrack(track, state.current) && state.playing;
  const deviceState = track.id && track.playable_locally ? `<span class="device-state-dot ${isTrackOnDevice(track) ? "offline" : "online-only"}" title="${isTrackOnDevice(track) ? "Salva neste aparelho" : "Somente online"}"></span>` : "";
  return `<article class="music-card ${playing ? "playing" : ""}" data-track-key="${key}"><div class="card-image">${track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy">` : ""}${deviceState}<button class="card-play" data-action="play" data-track-key="${key}" aria-label="Reproduzir ${escapeHtml(track.title)}">${icon(playing ? "pause" : "play")}</button></div><h3 title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h3><p>${escapeHtml(track.artist)}</p></article>`;
}

function playlistCard(p) {
  return `<article class="music-card" data-playlist="${p.id}"><div class="card-image">${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="">` : `<div class="collection-icon" style="width:100%;height:100%;border-radius:0">${icon("library")}</div>`}<button class="card-play" data-action="play-playlist" data-playlist="${p.id}">${icon("play")}</button></div><h3>${escapeHtml(p.name)}</h3><p>${p.track_count} ${p.track_count === 1 ? "faixa" : "faixas"}${p.is_public ? " · Pública" : " · Privada"}</p></article>`;
}

function renderLibrary() {
  let tracks = state.filter === "favorites" ? state.library.filter(t => t.favorite) : state.library;
  if (state.filter === "device") tracks = state.library.filter(isTrackOnDevice);
  const query = $("#libraryFilter")?.value.trim().toLowerCase();
  if (query) tracks = tracks.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(query));
  const deviceCount = state.library.filter(isTrackOnDevice).length;
  $("#libraryCount").textContent = `${state.library.length} ${state.library.length === 1 ? "faixa guardada" : "faixas guardadas"} · ${deviceCount} neste aparelho.`;
  $("#libraryContent").innerHTML = tracks.length ? trackTable(tracks) : emptyHtml(
    state.filter === "favorites" ? "Nada favoritado ainda" : state.filter === "device" ? "Nenhuma música salva neste aparelho" : "Sua biblioteca ainda está vazia",
    state.filter === "favorites" ? "Toque no coração de uma faixa para encontrá-la aqui." : state.filter === "device" ? "Na biblioteca, toque no ícone de download das faixas marcadas como Somente online." : "Pesquise uma música e adicione sua primeira faixa.",
    state.filter === "device" ? "Ver toda a biblioteca" : "Pesquisar músicas", state.filter === "device" ? "library" : "search", state.filter === "device" ? "all" : null
  );
}

function renderFavorites() {
  const favorites = state.library.filter(t => t.favorite);
  $("#favoritesContent").innerHTML = favorites.length ? trackTable(favorites) : emptyHtml("Seu coração está tranquilo", "Favorite suas músicas preferidas e elas aparecem aqui.", "Explorar biblioteca", "library");
}

function renderHistory() {
  $("#historyContent").innerHTML = state.history.length ? trackTable(state.history) : emptyHtml("Nenhuma faixa tocada ainda", "Quando você ouvir uma música da sua biblioteca, ela aparecerá aqui.", "Encontrar uma música", "search");
}

function trackTable(tracks, playlistId = null) {
  return `<div class="track-table">${tracks.map((track, index) => rowHtml(track, index, playlistId)).join("")}</div>`;
}

function rowHtml(raw, index, playlistId = null) {
  const track = normalized(raw), key = track.id ? `lib:${track.id}` : `yt:${track.youtube_video_id}`;
  const playing = sameTrack(track, state.current) && state.playing;
  const onDevice = isTrackOnDevice(track), saving = state.deviceSavingIds.has(Number(track.id));
  const availability = !track.playable_locally ? "" : onDevice
    ? `<small class="download-badge device-offline">${icon("check")} Neste aparelho</small>`
    : `<small class="download-badge online-only">${icon("install")} Somente online</small>`;
  const deviceAction = track.playable_locally && !onDevice ? `<button class="icon-btn device-save-btn ${saving ? "saving" : ""}" data-action="device-download" data-track-key="${key}" title="Salvar neste aparelho" ${saving ? "disabled" : ""}>${icon("install")}</button>` : "";
  return `<div class="track-row ${playing ? "playing" : ""}" data-track-key="${key}" draggable="${playlistId ? "true" : "false"}" data-music-id="${track.id || ""}" data-playlist-id="${playlistId || ""}"><div class="row-thumb">${track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy">` : ""}<button class="row-play" data-action="play" data-track-key="${key}">${icon(playing ? "pause" : "play")}</button></div><div class="row-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span>${availability}</div><span class="row-channel">${onDevice ? "Neste aparelho" : track.playable_locally ? "Biblioteca online" : track.id ? "Importação pendente" : "YouTube"}</span><span class="duration-label">${fmt(track.duration_seconds)}</span><div class="row-actions">${!track.playable_locally ? `<button class="icon-btn" data-action="download" data-track-key="${key}" title="Baixar para a biblioteca">${icon("plus")}</button>` : `${deviceAction}<button class="icon-btn favorite-btn ${track.favorite ? "active" : ""}" data-action="favorite" data-id="${track.id}" title="Favoritar">${icon("heart")}</button>`}<button class="icon-btn computer-save-btn" data-action="save-file" data-track-key="${key}" title="Salvar arquivo no computador">${icon("install")}</button><button class="icon-btn" data-action="more" data-track-key="${key}" data-playlist-id="${playlistId || ""}">${icon("more")}</button></div></div>`;
}

function emptyHtml(title, message, action, view, filterReset = null) {
  return `<div class="empty-state"><div class="empty-icon">${icon("library")}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><button class="primary-btn" data-view="${view}"${filterReset ? ` data-filter-reset="${filterReset}"` : ""}>${escapeHtml(action)}</button></div>`;
}

function findTrack(key) {
  if (!key) return null;
  const [type, value] = key.split(":");
  if (type === "lib") return state.library.find(t => t.id === Number(value)) || state.history.find(t => t.id === Number(value));
  return [...state.search, ...starterTracks].map(normalized).find(t => t.youtube_video_id === value);
}

function sameTrack(a, b) {
  if (!a || !b) return false;
  return (a.id && b.id && a.id === b.id) || (a.youtube_video_id && a.youtube_video_id === b.youtube_video_id);
}

function navigate(view, data = {}) {
  state.view = view;
  $$(".view").forEach(item => item.classList.toggle("active", item.id === `view-${view}`));
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view || (view === "playlist" && item.dataset.view === "library")));
  if (view === "search") setTimeout(() => $("#searchInput").focus(), 60);
  if (view === "playlist" && data.id) renderPlaylistDetail(Number(data.id));
  if (view === "social") loadSocial();
  if (state.room && matchMedia("(max-width: 760px)").matches) setRoomCollapsed(true);
  $("#mainContent").scrollTo({ top: 0, behavior: "smooth" });
}

async function search(event) {
  event.preventDefault();
  const query = $("#searchInput").value.trim();
  if (query.length < 2) return;
  $("#searchStatus").textContent = `Buscando “${query}”...`;
  $("#searchResults").innerHTML = Array.from({ length: 7 }, () => `<div class="skeleton"></div>`).join("");
  try {
    const result = await api(`/api/youtube/search?q=${encodeURIComponent(query)}`);
    state.search = result.items.map(normalized);
    $("#searchStatus").textContent = `${state.search.length} resultados para “${query}”`;
    $("#searchResults").innerHTML = state.search.length ? state.search.map((t, i) => rowHtml(t, i)).join("") : emptyHtml("Nenhum resultado", "Tente pesquisar com outros termos.", "Limpar busca", "search");
  } catch (error) {
    $("#searchStatus").textContent = "Pesquisa indisponível";
    $("#searchResults").innerHTML = `<div class="empty-state"><div class="empty-icon">${icon("search")}</div><h2>Não foi possível pesquisar</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function playTrack(raw, queue = null) {
  const track = normalized(raw);
  if (!navigator.onLine && track.playable_locally && !isTrackOnDevice(track)) return toast("Esta música está somente online. Conecte-se para salvá-la neste aparelho.", "error");
  if (sameTrack(track, state.current)) return togglePlay();
  state.current = track;
  if (queue?.length) state.queue = queue.map(normalized);
  else if (!state.queue.some(t => sameTrack(t, track))) state.queue = [track, ...state.queue];
  state.currentIndex = state.queue.findIndex(t => sameTrack(t, track));
  if (state.shuffle) buildShuffleOrder();
  updatePlayerMeta();
  if (track.id && track.playable_locally) {
    prepareLocalAudio(track, true);
    recordHistory(track);
  } else {
    startAutoDownload(track, true);
  }
  persistState(); renderQueue(); saveClientSnapshot();
}

function prepareLocalAudio(track, autoplay = true) {
  const audio = state.audio || $("#localAudio");
  state.audio = audio;
  state.source = "local";
  const wanted = `${location.origin}${deviceMediaUrl(track.id)}`;
  if (audio.src !== wanted) audio.src = wanted;
  audio.volume = state.volume;
  audio.onloadedmetadata = () => {
    if (!autoplay && state.resumePosition > 0 && state.resumePosition < audio.duration) {
      audio.currentTime = state.resumePosition;
      state.resumePosition = 0;
    }
    updateTimeline();
  };
  if (autoplay) audio.play().catch(() => toast("O navegador bloqueou a reprodução automática. Clique em play.", "error"));
}

function setupMediaSession() {
  const button = $("#floatingPlayerBtn");
  if (button) button.hidden = false;
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => { if (!state.playing) togglePlay(); },
    pause: () => { if (state.playing) togglePlay(); },
    previoustrack: () => state.room ? toast("A sala não permite voltar pela notificação.", "error") : moveTrack(-1),
    nexttrack: () => state.room ? (state.room.room.owner_id === state.user?.id ? roomSend({ type: "skip" }) : toast("Somente o host pode pular.", "error")) : moveTrack(1),
    seekbackward: details => { if (!state.room && state.audio) state.audio.currentTime = Math.max(0, state.audio.currentTime - (details.seekOffset || 10)); },
    seekforward: details => { if (!state.room && state.audio) state.audio.currentTime = Math.min(state.audio.duration || Infinity, state.audio.currentTime + (details.seekOffset || 10)); },
    seekto: details => {
      if (state.room) {
        if (state.room.room.owner_id === state.user?.id) roomSend({ type: "seek", position: details.seekTime || 0 });
      } else if (state.audio && Number.isFinite(details.seekTime)) state.audio.currentTime = details.seekTime;
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  }
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.current) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.current.title,
      artist: state.current.artist,
      album: state.room ? state.room.room.name : "Pulse",
      artwork: state.current.thumbnail ? [{ src: state.current.thumbnail }] : [],
    });
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  } catch (_) {}
}

function floatingQueueItems() {
  if (state.room) return (state.room.queue || []).map(entry => ({ ...entry.music, roomEntryId: entry.id }));
  return state.queue;
}

function renderFloatingPlayer(force = false) {
  const popup = state.floatingWindow;
  if (!popup || popup.closed) return;
  const track = state.current;
  const queue = floatingQueueItems();
  const document = popup.document;
  if (!force && document.activeElement?.closest?.("#floatSearch")) return;
  document.title = "Pulse · Player";
  document.body.innerHTML = `<main><section class="now"><img src="${escapeHtml(track?.thumbnail || "")}" alt=""><div><small>${state.room ? "SALA AO VIVO" : "TOCANDO AGORA"}</small><strong>${escapeHtml(track?.title || "Escolha uma música")}</strong><span>${escapeHtml(track?.artist || "Pulse")}</span></div></section><nav><button data-float-action="prev" aria-label="Anterior">◀</button><button class="play" data-float-action="play" aria-label="Play ou pause">${state.playing ? "Ⅱ" : "▶"}</button><button data-float-action="next" aria-label="Próxima">▶</button></nav><form id="floatSearch"><input name="query" minlength="2" required placeholder="Buscar para adicionar à fila"><button>Buscar</button></form><div id="floatResults"></div><header><strong>Fila</strong><small>${queue.length} músicas</small></header><div class="queue">${queue.length ? queue.slice(0, 12).map((item, index) => `<article><img src="${escapeHtml(item.thumbnail || "")}" alt=""><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.artist)}</small></span><button data-float-remove="${item.roomEntryId || index}" aria-label="Remover">×</button></article>`).join("") : `<p>A fila está vazia.</p>`}</div></main>`;
  document.querySelectorAll("[data-float-action]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.floatAction;
    if (action === "play") togglePlay();
    if (action === "prev") state.room ? toast("Em sala não é possível voltar.", "error") : moveTrack(-1);
    if (action === "next") state.room ? (state.room.room.owner_id === state.user?.id ? roomSend({ type: "skip" }) : toast("Somente o host pode pular.", "error")) : moveTrack(1);
  }));
  document.querySelectorAll("[data-float-remove]").forEach(button => button.addEventListener("click", () => {
    if (state.room) roomSend({ type: "queue_remove", entry_id: button.dataset.floatRemove });
    else removeQueueItem(Number(button.dataset.floatRemove));
  }));
  document.querySelector("#floatSearch").addEventListener("submit", async event => {
    event.preventDefault(); const query = new FormData(event.target).get("query");
    const results = document.querySelector("#floatResults"); results.innerHTML = `<p>Buscando...</p>`;
    try {
      const response = await api(`/api/youtube/search?q=${encodeURIComponent(String(query))}`);
      state.floatingSearch = response.items.map(normalized).slice(0, 5);
      results.innerHTML = state.floatingSearch.map((item, index) => `<button class="result" data-float-add="${index}"><img src="${escapeHtml(item.thumbnail || "")}" alt=""><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.artist)}</small></span><b>+</b></button>`).join("") || `<p>Nenhum resultado.</p>`;
      results.querySelectorAll("[data-float-add]").forEach(button => button.addEventListener("click", () => addFromFloatingPlayer(state.floatingSearch[Number(button.dataset.floatAdd)])));
    } catch (error) { results.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
  });
}

function addFromFloatingPlayer(track) {
  if (!track) return;
  if (state.room) roomSend({ type: "queue_add_track", track: { title: track.title, artist: track.artist, youtube_video_id: track.youtube_video_id, thumbnail: track.thumbnail || null, duration_seconds: track.duration_seconds || null } });
  else {
    state.queue.push(track); renderQueue(); saveClientSnapshot();
  }
  toast(state.room?.room.queue_policy === "approval" && state.room.room.owner_id !== state.user?.id ? "Pedido enviado ao host." : "Música adicionada à fila.");
  renderFloatingPlayer(true);
}

async function openFloatingPlayer() {
  try {
    if (state.floatingWindow && !state.floatingWindow.closed) { state.floatingWindow.focus(); return; }
    const popup = "documentPictureInPicture" in window
      ? await window.documentPictureInPicture.requestWindow({ width: 390, height: 620 })
      : window.open("", "pulse-floating-player", "popup,width=390,height=620");
    if (!popup) throw new Error("popup blocked");
    state.floatingWindow = popup;
    const style = popup.document.createElement("style");
    style.textContent = `*{box-sizing:border-box}body{margin:0;background:#0d0d12;color:#f7f7fb;font:13px system-ui;overflow:auto}main{padding:14px}.now{display:grid;grid-template-columns:58px 1fr;gap:11px;align-items:center}.now img,.queue img,.result img{width:58px;height:58px;border-radius:10px;object-fit:cover;background:#25252e}.now div,.queue span,.result span{min-width:0}.now small,.now strong,.now span,.queue strong,.queue small,.result strong,.result small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.now small{color:#b8ff57;font-size:9px;font-weight:800;letter-spacing:1px}.now strong{font-size:14px;margin:4px 0}.now span,.queue small,.result small,header small,p{color:#92929f}nav{display:flex;justify-content:center;gap:10px;margin:14px 0}button{border:0;color:#fff;background:#25252f;cursor:pointer}nav button{width:42px;height:42px;border-radius:50%}nav .play{background:#b8ff57;color:#111;font-size:17px}form{display:flex;height:42px;border:1px solid #34343e;border-radius:12px;overflow:hidden}form input{min-width:0;flex:1;border:0;outline:0;padding:0 11px;background:#16161e;color:#fff}form button{padding:0 12px;background:#b8ff57;color:#111;font-weight:800}header{display:flex;justify-content:space-between;margin:16px 2px 7px}.queue,.result{display:flex;flex-direction:column}.queue article,.result{width:100%;display:grid;grid-template-columns:42px minmax(0,1fr) 30px;align-items:center;gap:8px;padding:7px;border-radius:9px;text-align:left}.queue article:hover,.result:hover{background:#191920}.queue img,.result img{width:42px;height:42px}.queue article>button{width:30px;height:30px;border-radius:8px}.result b{color:#b8ff57;font-size:20px}#floatResults{margin-top:7px}`;
    popup.document.head.append(style);
    popup.addEventListener("pagehide", () => { if (state.floatingWindow === popup) state.floatingWindow = null; });
    renderFloatingPlayer();
  } catch (_) { toast("O navegador não conseguiu abrir o player flutuante.", "error"); }
}

function togglePlay() {
  if (state.room) {
    if (state.room.room.owner_id !== state.user?.id) {
      if (state.room.playing && state.audio?.paused) return state.audio.play().catch(() => toast("O navegador bloqueou o áudio. Toque novamente para ouvir a sala.", "error"));
      return toast("O anfitrião controla a reprodução da sala.", "error");
    }
    return roomSend({ type: state.room.playing ? "pause" : "play", position: state.audio?.currentTime || 0 });
  }
  if (!state.current) return playTrack(state.library[0] || starterTracks[0], state.library.length ? state.library : starterTracks);
  if (!navigator.onLine && state.current.playable_locally && !isTrackOnDevice(state.current)) return toast("Esta música não está salva neste aparelho.", "error");
  if (state.source === "stream") return state.playing ? state.audio.pause() : state.audio.play();
  if (!state.current.playable_locally) {
    return startAutoDownload(state.current, true);
  }
  const audio = state.audio || $("#localAudio");
  state.audio = audio;
  if (!audio.src) prepareLocalAudio(state.current, false);
  state.playing ? audio.pause() : audio.play().catch(() => toast("Não foi possível abrir o arquivo local.", "error"));
}

function updateTimeline() {
  const audio = state.audio || $("#localAudio");
  const current = audio.currentTime || 0;
  const duration = Number.isFinite(audio.duration) ? audio.duration : state.current?.duration_seconds || 0;
  $("#currentTime").textContent = fmt(current); $("#duration").textContent = fmt(duration);
  const percent = duration ? current / duration * 100 : 0;
  $("#seekBar").value = percent; setRangeFill($("#seekBar"), percent);
  updateLyricsPosition();
  if ("mediaSession" in navigator && duration > 0 && Number.isFinite(duration) && current <= duration) {
    try { navigator.mediaSession.setPositionState({ duration, playbackRate: state.audio?.playbackRate || 1, position: Math.max(0, current) }); } catch (_) {}
  }
}

function updatePlayerMeta() {
  const track = state.current;
  if (!track) {
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    renderFloatingPlayer(); return;
  }
  $("#playerTitle").textContent = track.title; $("#playerArtist").textContent = track.artist;
  $("#duration").textContent = fmt(track.duration_seconds);
  $("#playerCover").classList.remove("placeholder");
  $("#playerCover").innerHTML = track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="Capa de ${escapeHtml(track.title)}">` : icon("library");
  $("#favoriteCurrent").classList.toggle("active", Boolean(track.favorite));
  updateMediaSession(); renderFloatingPlayer();
  if ($("#lyricsPanel").classList.contains("open") && state.lyrics?.musicId !== track.id && state.lyricsLoadingId !== track.id) {
    queueMicrotask(openLyrics);
  }
}

function refreshPlayingUI() {
  $("#playBtn").innerHTML = icon(state.playing ? "pause" : "play");
  $("#playBtn").title = state.playing ? "Pausar" : "Reproduzir";
  renderHome(); renderLibrary(); renderFavorites(); renderHistory();
  if (state.search.length) $("#searchResults").innerHTML = state.search.map((t, i) => rowHtml(t, i)).join("");
  if (state.view === "playlist") {
    const active = $("#playlistDetail [data-current-playlist]");
    if (active) renderPlaylistDetail(Number(active.dataset.currentPlaylist));
  }
  updateMediaSession(); renderFloatingPlayer();
}

function moveTrack(direction) {
  if (!state.queue.length) return;
  if (state.shuffle) {
    state.shuffleCursor += direction;
    if (state.shuffleCursor >= state.shuffleOrder.length) {
      if (state.repeat !== "all") return stopPlayback();
      buildShuffleOrder(); state.shuffleCursor = 0;
    }
    if (state.shuffleCursor < 0) state.shuffleCursor = state.repeat === "all" ? state.shuffleOrder.length - 1 : 0;
    state.currentIndex = state.shuffleOrder[state.shuffleCursor];
  } else {
    let next = state.currentIndex + direction;
    if (next >= state.queue.length) next = state.repeat === "all" ? 0 : -1;
    if (next < 0) next = state.repeat === "all" ? state.queue.length - 1 : 0;
    if (next === -1) return stopPlayback();
    state.currentIndex = next;
  }
  const nextTrack = state.queue[state.currentIndex];
  state.current = null; playTrack(nextTrack, state.queue);
}

function handleEnded() {
  if (state.repeat === "one") {
    state.audio.currentTime = 0; return state.audio.play();
  }
  moveTrack(1);
}

function stopPlayback() {
  state.playing = false;
  state.audio?.pause(); if (state.audio) state.audio.currentTime = 0;
  refreshPlayingUI();
}

function buildShuffleOrder() {
  const current = state.currentIndex;
  const rest = state.queue.map((_, i) => i).filter(i => i !== current);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  state.shuffleOrder = current >= 0 ? [current, ...rest] : rest;
  state.shuffleCursor = 0;
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.shuffle) buildShuffleOrder();
  updateModeButtons(); persistState();
  toast(state.shuffle ? "Modo aleatório ativado" : "Modo aleatório desativado");
}

function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  updateModeButtons(); persistState();
}

function updateModeButtons() {
  $("#shuffleBtn").classList.toggle("active", state.shuffle);
  $("#repeatBtn").classList.toggle("active", state.repeat !== "off");
  $("#repeatBtn").classList.toggle("one", state.repeat === "one");
  $("#repeatBtn").title = { off: "Repetição desligada", all: "Repetir fila", one: "Repetir faixa" }[state.repeat];
}

function setRangeFill(input, percent) { input.style.setProperty("--range", `${Math.max(0, Math.min(100, percent))}%`); }

async function persistState() {
  const position = state.audio?.currentTime || 0;
  try { await api("/api/player/state", { method: "PUT", body: JSON.stringify({ music_id: state.current?.id || null, position, volume: state.volume, shuffle: state.shuffle, repeat_mode: state.repeat }) }); } catch (_) {}
}

async function recordHistory(track) {
  try {
    await api("/api/library/history", { method: "POST", body: JSON.stringify({ music_id: track.id }) });
    state.history = [track, ...state.history.filter(item => item.id !== track.id)].slice(0, 30);
    renderHistory();
  } catch (_) {}
}

async function startAutoDownload(raw, autoplay = false) {
  const track = normalized(raw);
  if (!track.youtube_video_id || track.playable_locally) return track;
  const existing = state.activeDownloads.get(track.youtube_video_id);
  if (existing) {
    existing.autoplay = existing.autoplay || autoplay;
    if (existing.autoplay && existing.jobId) prepareProgressiveAudio(existing.jobId);
    return existing.task;
  }
  showDownloadDock(track, { progress: 0, message: "Preparando download..." });
  const entry = { autoplay, jobId: null, task: null };
  entry.task = (async () => {
    try {
      const job = await api("/api/downloads", { method: "POST", body: JSON.stringify({ track: { title: track.title, artist: track.artist, youtube_video_id: track.youtube_video_id, thumbnail: track.thumbnail || null, duration_seconds: track.duration_seconds || null } }) });
      entry.jobId = job.id;
      if (job.music_id && !state.library.some(item => item.id === job.music_id)) {
        state.library.unshift(normalized({ ...track, id: job.music_id, playable_locally: false }));
        renderAll();
      }
      return await followDownload(job, track, entry);
    } catch (error) {
      showDownloadDock(track, { progress: 0, message: error.message, status: "failed" });
      toast(`Download não concluído: ${error.message}`, "error");
      setTimeout(hideDownloadDock, 5000);
      return null;
    } finally {
      state.activeDownloads.delete(track.youtube_video_id);
    }
  })();
  state.activeDownloads.set(track.youtube_video_id, entry);
  return entry.task;
}

function prepareProgressiveAudio(jobId) {
  const audio = state.audio || $("#localAudio");
  state.audio = audio;
  state.source = "stream";
  audio.autoplay = true;
  audio.src = `/api/downloads/${jobId}/stream`;
  audio.volume = state.volume;
  audio.play().catch(() => toast("O áudio está sendo preparado. Clique em play para começar.", "error"));
}

async function followDownload(initialJob, originalTrack, entry = null) {
  let job = initialJob;
  while (job.status !== "complete" && job.status !== "failed") {
    updateDownloadProgress(job, originalTrack);
    if (entry?.autoplay && !entry.streamStarted && job.status === "streaming") {
      entry.streamStarted = true;
      prepareProgressiveAudio(job.id);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    job = await api(`/api/downloads/${job.id}`);
  }
  updateDownloadProgress(job, originalTrack);
  if (job.status === "failed") throw new Error(job.message || "Não foi possível importar este conteúdo.");
  state.library = (await api("/api/library")).map(normalized);
  await reloadPlaylists();
  const saved = state.library.find(item => item.id === job.music_id || item.youtube_video_id === originalTrack.youtube_video_id);
  if (saved && sameTrack(state.current, originalTrack)) {
    state.current = saved;
    if (!entry?.streamStarted && entry?.autoplay) prepareLocalAudio(saved, true);
    else if (!initialJob.id) prepareLocalAudio(saved, true);
  }
  renderAll();
  const savedOnDevice = saved ? await saveTrackOnDevice(saved, { silent: true }) : false;
  showDownloadDock(originalTrack, { progress: 100, message: savedOnDevice ? "Salva neste aparelho" : "Na biblioteca; toque no ícone para salvar no aparelho", status: "complete" });
  toast(savedOnDevice ? "Download concluído — salva neste aparelho." : "Download concluído e adicionado à biblioteca.");
  setTimeout(hideDownloadDock, 2400);
  return saved || null;
}

function audioFilename(raw) {
  const track = normalized(raw);
  const base = `${track.artist} - ${track.title}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return `${base || "musica"}.mp3`;
}

async function playableLibraryTrack(raw) {
  const track = normalized(raw);
  if (track.id && track.playable_locally) return track;
  const downloaded = await startAutoDownload(track, false);
  return downloaded || state.library.find(item => item.youtube_video_id === track.youtube_video_id && item.playable_locally) || null;
}

async function saveTrackToComputer(raw) {
  const original = normalized(raw);
  const filename = audioFilename(original);
  let fileHandle = null;
  if (typeof window.showSaveFilePicker === "function") {
    try {
      fileHandle = await window.showSaveFilePicker({
        id: "pulse-music-export",
        suggestedName: filename,
        startIn: "music",
        types: [{ description: "Áudio MP3", accept: { "audio/mpeg": [".mp3"] } }],
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      fileHandle = null;
    }
  }

  const track = await playableLibraryTrack(original);
  if (!track) return toast("Não foi possível preparar o arquivo desta música.", "error");
  showDownloadDock(track, { progress: 0, message: fileHandle ? "Salvando no local escolhido..." : "Preparando o arquivo para salvar..." });

  let writable = null;
  try {
    const response = await fetch(deviceMediaUrl(track.id), { cache: "no-store" });
    if (!response.ok) throw new Error("O arquivo não está disponível no servidor.");
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body?.getReader();
    const chunks = [];
    let received = 0;
    if (fileHandle) writable = await fileHandle.createWritable();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (writable) await writable.write(value); else chunks.push(value);
        const progress = total ? Math.round(received / total * 100) : 50;
        showDownloadDock(track, { progress, message: `Salvando ${Math.round(received / 1024 / 1024 * 10) / 10} MB...` });
      }
    } else {
      const blob = await response.blob();
      received = blob.size;
      if (writable) await writable.write(blob); else chunks.push(blob);
    }

    if (writable) {
      await writable.close();
      writable = null;
    } else {
      const blob = chunks.length === 1 && chunks[0] instanceof Blob ? chunks[0] : new Blob(chunks, { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    showDownloadDock(track, { progress: 100, message: fileHandle ? "Arquivo salvo no local escolhido" : "Arquivo enviado ao navegador", status: "complete" });
    toast(fileHandle ? "Arquivo salvo no local escolhido." : "Arquivo pronto. Confira os downloads do navegador.");
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    showDownloadDock(track, { progress: 0, message: error.message, status: "failed" });
    toast(`Não foi possível salvar o arquivo: ${error.message}`, "error");
  } finally {
    setTimeout(hideDownloadDock, 2600);
  }
}

function updateDownloadProgress(job, track) {
  showDownloadDock(track, job);
}

function showDownloadDock(track, job) {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  if (matchMedia("(max-width: 760px)").matches) {
    $("#player").classList.toggle("downloading", job.status !== "complete" && job.status !== "failed");
    $("#player").style.setProperty("--download-progress", `${progress}%`);
    if (sameTrack(track, state.current)) {
      $("#playerArtist").textContent = job.status === "complete" ? "Disponível offline" : job.status === "failed" ? "Falha no download" : `Baixando • ${progress}%`;
    }
    return;
  }
  $("#downloadDock").classList.add("open");
  $("#downloadDockArt").style.backgroundImage = track.thumbnail ? `url("${track.thumbnail.replace(/["\\]/g, "")}")` : "none";
  $("#downloadDockTitle").textContent = job.status === "complete" ? "Download concluído" : job.status === "failed" ? "Falha no download" : track.title || "Baixando";
  $("#downloadDockMessage").textContent = job.message || "Baixando em segundo plano...";
  $("#downloadDockBar").style.width = `${progress}%`;
  $("#downloadDockPercent").textContent = `${progress}%`;
}

function hideDownloadDock() {
  $("#downloadDock").classList.remove("open");
  $("#player").classList.remove("downloading");
  if (state.current) updatePlayerMeta();
}

async function toggleFavorite(id) {
  try {
    const updated = normalized(await api(`/api/library/${id}/favorite`, { method: "PATCH" }));
    const index = state.library.findIndex(t => t.id === id); if (index >= 0) state.library[index] = updated;
    if (state.current?.id === id) state.current = updated;
    state.history = state.history.map(t => t.id === id ? updated : t);
    renderAll(); updatePlayerMeta();
  } catch (error) { toast(error.message, "error"); }
}

function personRow(person, context = "search") {
  const initial = (person.display_name || "P").charAt(0).toUpperCase();
  let actions = `<button class="soft-btn" data-public-profile="${person.id}">Playlists</button>`;
  if (context === "request" || person.friendship_status === "incoming") actions += `<button class="primary-btn" data-friend-accept="${person.id}">Aceitar</button>`;
  else if (person.friendship_status === "friends") actions += `<button class="soft-btn danger" data-friend-remove="${person.id}">Remover</button>`;
  else if (person.friendship_status === "outgoing") actions += `<button class="soft-btn" disabled>Enviado</button>`;
  else actions += `<button class="primary-btn" data-friend-add="${person.id}">Adicionar</button>`;
  return `<div class="person-row"><div class="profile-avatar">${escapeHtml(initial)}</div><div class="person-row-copy"><strong>${escapeHtml(person.display_name)}</strong><small>${person.friendship_status === "friends" ? "Amigo" : person.friendship_status === "incoming" ? "Enviou um convite" : person.friendship_status === "outgoing" ? "Convite enviado" : "Perfil Pulse"}</small></div><div class="person-actions">${actions}</div></div>`;
}

function renderNotifications() {
  const items = state.notifications.filter(item => !state.dismissedNotifications.has(item.id));
  const badge = $("#notificationBadge");
  badge.hidden = !items.length; badge.textContent = items.length > 9 ? "9+" : String(items.length);
  $("#notificationList").innerHTML = items.length ? items.map(item => `<button class="notification-item" data-notification-id="${escapeHtml(item.id)}" data-notification-kind="${escapeHtml(item.kind)}"><span class="notification-icon">${icon(item.kind === "friend" ? "users" : "chat")}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></span></button>`).join("") : `<p class="notification-empty">Nenhuma novidade.</p>`;
}

function addImportantNotification(notification, announce = true) {
  if (state.dismissedNotifications.has(notification.id) || state.notifications.some(item => item.id === notification.id)) return;
  state.notifications.unshift(notification); state.notifications = state.notifications.slice(0, 30);
  renderNotifications();
  if (announce) toast(notification.message);
}

function syncFriendRequestNotifications(requests, announce) {
  const ids = new Set(requests.map(person => Number(person.id)));
  for (const person of requests) addImportantNotification({ id: `friend-${person.id}`, kind: "friend", title: "Novo convite de amizade", message: `${person.display_name} quer adicionar você.` }, announce && state.knownFriendRequestIds !== null && !state.knownFriendRequestIds.has(Number(person.id)));
  state.notifications = state.notifications.filter(item => item.kind !== "friend" || ids.has(Number(item.id.replace("friend-", ""))));
  state.knownFriendRequestIds = ids; renderNotifications();
}

async function refreshImportantNotifications(announce = true) {
  if (!state.user || !navigator.onLine) return;
  try { syncFriendRequestNotifications(await api("/api/social/friends/requests"), announce); }
  catch (_) {}
}

async function loadSocial() {
  if (!state.user || !navigator.onLine) return;
  try {
    const [friends, requests] = await Promise.all([api("/api/social/friends"), api("/api/social/friends/requests")]);
    $("#friendsList").innerHTML = friends.length ? friends.map(person => personRow(person, "friend")).join("") : `<p class="social-placeholder">Você ainda não adicionou amigos.</p>`;
    $("#friendRequests").innerHTML = requests.length ? requests.map(person => personRow(person, "request")).join("") : `<p class="social-placeholder">Nenhum convite pendente.</p>`;
    syncFriendRequestNotifications(requests, false);
  } catch (error) { toast(error.message, "error"); }
}

async function searchPeople(form) {
  const query = new FormData(form).get("q") || $("#socialSearchInput").value;
  try {
    const people = await api(`/api/social/users?q=${encodeURIComponent(String(query))}`);
    $("#peopleResults").innerHTML = people.length ? people.map(person => personRow(person)).join("") : `<p class="social-placeholder">Nenhuma pessoa encontrada.</p>`;
  } catch (error) { toast(error.message, "error"); }
}

async function showPublicPlaylists(userId) {
  try {
    const data = await api(`/api/social/users/${userId}/playlists`);
    const playlists = data.playlists.map(playlist => `<article class="public-playlist"><span class="visibility-badge">Pública</span><h3>${escapeHtml(playlist.name)}</h3><p>${escapeHtml(playlist.description || `${playlist.track_count} faixas`)}</p><div class="public-track-list">${playlist.tracks.length ? playlist.tracks.map(track => `<div class="room-queue-item"><img src="${escapeHtml(track.thumbnail || "")}" alt=""><div><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small></div></div>`).join("") : `<small style="color:var(--muted)">Playlist vazia</small>`}</div></article>`).join("");
    modal(`<div class="modal"><div class="modal-head"><div><span class="eyebrow">PLAYLISTS PÚBLICAS</span><h2>${escapeHtml(data.user.display_name)}</h2></div><button class="icon-btn" data-close="modal">${icon("close")}</button></div><div class="public-playlists">${playlists || `<p style="color:var(--muted)">Este perfil não publicou playlists.</p>`}</div></div>`);
  } catch (error) { toast(error.message, "error"); }
}

async function friendAction(action, userId) {
  try {
    if (action === "add") await api(`/api/social/friends/${userId}`, { method: "POST" });
    if (action === "accept") await api(`/api/social/friends/${userId}/accept`, { method: "POST" });
    if (action === "remove") await api(`/api/social/friends/${userId}`, { method: "DELETE" });
    toast(action === "accept" ? "Agora vocês são amigos." : action === "remove" ? "Amizade removida." : "Convite enviado.");
    await loadSocial();
    if ($("#socialSearchInput").value.trim().length >= 2) searchPeople($("#socialSearchForm"));
  } catch (error) { toast(error.message, "error"); }
}

function roomSend(payload) {
  if (state.roomSocket?.readyState === WebSocket.OPEN) state.roomSocket.send(JSON.stringify(payload));
}

async function copyRoomCode() {
  const code = state.room?.room.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = code; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.append(input); input.select(); document.execCommand("copy"); input.remove();
  }
  toast(`Código ${code} copiado.`);
}

async function pasteAndJoinRoom() {
  const input = $("#joinRoomCodeInput");
  try {
    const value = await navigator.clipboard.readText();
    input.value = value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
    syncRoomCodeSlots();
    if (input.value.length >= 4) input.form.requestSubmit();
    else throw new Error();
  } catch (_) {
    input.focus();
    toast("Cole o código no campo e toque em Entrar.", "error");
  }
}

function syncRoomCodeSlots() {
  const input = $("#joinRoomCodeInput"); if (!input) return;
  const value = input.value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
  input.value = value;
  $$("#roomCodeSlots i").forEach((slot, index) => {
    slot.textContent = value[index] || "";
    slot.classList.toggle("filled", Boolean(value[index]));
    slot.classList.toggle("active", document.activeElement === input && index === Math.min(value.length, 5));
  });
}

async function createListeningRoom(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "Sala de música");
  const queue_policy = String(data.get("queue_policy") || "everyone");
  try { openListeningRoom(await api("/api/rooms", { method: "POST", body: JSON.stringify({ name, queue_policy }) })); }
  catch (error) { toast(error.message, "error"); }
}

async function joinListeningRoom(formOrCode) {
  const rawCode = typeof formOrCode === "string" ? formOrCode : String(new FormData(formOrCode).get("code") || "");
  const code = rawCode.replace(/[^a-z0-9]/gi, "").toUpperCase();
  try { openListeningRoom(await api(`/api/rooms/${encodeURIComponent(code.toUpperCase())}/join`, { method: "POST" })); }
  catch (error) { toast(error.message, "error"); }
}

async function restoreListeningRoom() {
  if (state.room || !navigator.onLine) return;
  const code = sessionStorage.getItem("pulse:active-room");
  if (!code) return;
  try {
    openListeningRoom(await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST" }));
  } catch (error) {
    if ([403, 404].includes(error.status)) sessionStorage.removeItem("pulse:active-room");
  }
}

function openListeningRoom(snapshot) {
  clearTimeout(state.roomReconnectTimer); state.roomReconnectTimer = null;
  if (state.roomSocket) state.roomSocket.close();
  state.audio?.pause(); state.source = "room"; state.current = null; updatePlayerMeta();
  state.room = snapshot; state.roomAudioBlocked = false;
  sessionStorage.setItem("pulse:active-room", snapshot.room.code);
  document.body.classList.add("room-active");
  $("#roomPanel").classList.add("open"); $("#roomPanel").setAttribute("aria-hidden", "false");
  setRoomCollapsed(matchMedia("(max-width: 760px)").matches);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/rooms/${snapshot.room.code}`);
  state.roomSocket = socket;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "chat") {
      state.room.messages = [...(state.room.messages || []), message].slice(-50); renderRoom();
      if (message.user.id !== state.user?.id) addImportantNotification({ id: `chat-${message.id}`, kind: "chat", title: `Mensagem em ${state.room.room.name}`, message: `${message.user.display_name}: ${message.text}` }, true);
    } else if (message.type === "room_error") {
      toast(message.message || "A sala não conseguiu concluir esta ação.", "error");
    } else if (message.type === "room_notice") {
      toast(message.message || "A sala foi atualizada.");
    } else if (message.type === "room_state") {
      state.room = message; renderRoom(); applyRoomPlayback(message);
    }
  });
  socket.addEventListener("close", () => {
    if (state.roomSocket === socket && state.room) {
      state.roomSocket = null;
      toast("Reconectando à sala...", "error");
      state.roomReconnectTimer = setTimeout(async () => {
        const code = state.room?.room.code;
        if (!code || !navigator.onLine) return;
        try { openListeningRoom(await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST" })); }
        catch (_) { sessionStorage.removeItem("pulse:active-room"); }
      }, 1500);
    }
  });
  clearInterval(state.roomSyncTimer);
  state.roomSyncTimer = setInterval(() => {
    if (state.room?.room.owner_id === state.user?.id && state.source === "room") roomSend({ type: "sync", position: state.audio.currentTime || 0, playing: !state.audio.paused });
  }, 5000);
  renderRoom();
}

function setRoomCollapsed(collapsed) {
  const panel = $("#roomPanel");
  panel.classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("room-collapsed", collapsed);
  $("#toggleRoomPanelBtn").textContent = collapsed ? "⌄" : "⌃";
  $("#toggleRoomPanelBtn").setAttribute("aria-expanded", collapsed ? "false" : "true");
  $("#toggleRoomPanelBtn").title = collapsed ? "Abrir sala" : "Recolher sala";
}

function renderRoom() {
  const snapshot = state.room; if (!snapshot) return;
  const owner = snapshot.room.owner_id === state.user?.id;
  const policy = snapshot.room.queue_policy || "everyone";
  const policyLabels = { everyone: "Todos podem adicionar", approval: "Músicas precisam da aprovação do host", host_only: "Somente o host adiciona" };
  const pending = snapshot.pending_requests || [];
  const ownPending = pending.filter(entry => entry.added_by.id === state.user?.id).length;
  $("#roomCode").textContent = snapshot.room.code; $("#roomName").textContent = snapshot.room.name;
  $("#roomPolicyLabel").textContent = `${policyLabels[policy]}${!owner && ownPending ? ` · ${ownPending} aguardando` : ""}`;
  $("#roomParticipants").innerHTML = snapshot.participants.map(person => `<span class="participant-chip ${person.online ? "online" : ""}">${escapeHtml(person.display_name)}${person.id === snapshot.room.owner_id ? " · host" : ""}</span>`).join("");
  $("#roomNow").innerHTML = snapshot.current ? `<span class="eyebrow">TOCANDO AGORA</span><strong>${escapeHtml(snapshot.current.music.title)}</strong><small>${escapeHtml(snapshot.current.music.artist)}</small>` : `<span class="eyebrow">TOCANDO AGORA</span><strong>Nenhuma música ainda</strong>`;
  $("#roomPlayBtn").innerHTML = icon(owner && snapshot.playing ? "pause" : "play");
  $("#roomPlayBtn").disabled = owner ? false : !snapshot.current || !snapshot.playing;
  $("#roomPlayBtn").title = owner ? (snapshot.playing ? "Pausar sala" : "Tocar na sala") : "Liberar áudio neste aparelho";
  $("#roomSkipBtn").disabled = !owner; $("#roomClearBtn").style.display = owner ? "inline" : "none";
  $("#roomAddBtn").disabled = !owner && policy === "host_only";
  $("#roomQuickAddBtn").disabled = !owner && policy === "host_only";
  $("#roomAddLabel").textContent = !owner && policy === "approval" ? "Pedir música" : !owner && policy === "host_only" ? "Só o host adiciona" : "Buscar música";
  $("#roomRequestsSection").hidden = !owner || policy !== "approval";
  $("#roomRequestCount").textContent = `${pending.length} ${pending.length === 1 ? "pedido" : "pedidos"}`;
  $("#roomRequests").innerHTML = pending.length ? pending.map(entry => `<div class="room-request-item"><img src="${escapeHtml(entry.music.thumbnail || "")}" alt=""><div><strong>${escapeHtml(entry.music.title)}</strong><small>pedido por ${escapeHtml(entry.added_by.display_name)}</small></div><div class="room-request-actions"><button class="soft-btn" data-room-request-reject="${entry.id}">Recusar</button><button class="primary-btn" data-room-request-accept="${entry.id}">Aceitar</button></div></div>`).join("") : `<p class="social-placeholder">Nenhum pedido aguardando.</p>`;
  $("#roomQueueCount").textContent = `${snapshot.queue.length} ${snapshot.queue.length === 1 ? "música" : "músicas"}`;
  $("#roomQueue").innerHTML = snapshot.queue.length ? snapshot.queue.map((entry, index) => `<div class="room-queue-item"><img src="${escapeHtml(entry.music.thumbnail || "")}" alt=""><div><strong>${escapeHtml(entry.music.title)}</strong><small>por ${escapeHtml(entry.added_by.display_name)}</small></div><div class="room-queue-actions">${owner ? `<button class="icon-btn" data-room-move="${entry.id}" data-direction="-1" title="Subir" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-btn" data-room-move="${entry.id}" data-direction="1" title="Descer" ${index === snapshot.queue.length - 1 ? "disabled" : ""}>↓</button>` : ""}${owner || entry.added_by.id === state.user?.id ? `<button class="icon-btn" data-room-remove="${entry.id}" title="Remover">${icon("close")}</button>` : ""}</div></div>`).join("") : `<p class="social-placeholder">Busque uma música sem sair da sala.</p>`;
  $("#roomMessages").innerHTML = (snapshot.messages || []).map(message => `<div class="chat-message"><strong>${escapeHtml(message.user.display_name)}</strong>${escapeHtml(message.text)}</div>`).join("");
  $("#roomMessages").scrollTop = $("#roomMessages").scrollHeight;
  renderFloatingPlayer();
}

function applyRoomPlayback(snapshot) {
  if (!snapshot.current) return;
  const track = normalized(snapshot.current.music), audio = state.audio || $("#localAudio");
  const wanted = `${location.origin}/api/rooms/${snapshot.room.code}/media/${track.id}`;
  state.current = track; state.source = "room"; updatePlayerMeta();
  if (audio.src !== wanted) { audio.src = wanted; audio.volume = state.volume; }
  const expected = Number(snapshot.position || 0);
  const applyState = () => {
    if (Number.isFinite(audio.duration) && Math.abs((audio.currentTime || 0) - expected) > 1.8) audio.currentTime = Math.min(expected, audio.duration || expected);
    if (snapshot.playing) {
      audio.play().then(() => { state.roomAudioBlocked = false; }).catch(() => {
        if (snapshot.room.owner_id !== state.user?.id && !state.roomAudioBlocked) {
          state.roomAudioBlocked = true;
          toast("A sala está tocando. Toque no botão de play para liberar o áudio neste celular.", "error");
        }
      });
    } else audio.pause();
  };
  if (audio.readyState >= 1) applyState(); else audio.addEventListener("loadedmetadata", applyState, { once: true });
}

function roomPickerRows(tracks, source) {
  return tracks.length ? tracks.map((track, index) => `<button class="room-picker-item" data-room-picker-source="${source}" data-room-picker-index="${index}"><img src="${escapeHtml(track.thumbnail || "")}" alt=""><span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small></span><b>+</b></button>`).join("") : `<p class="social-placeholder">Nenhuma música aqui ainda.</p>`;
}

function addRoomMusicModal() {
  state.roomSearch = [];
  modal(`<div class="modal room-music-picker"><div class="modal-head"><div><span class="eyebrow">SEM SAIR DA SALA</span><h2>Buscar e adicionar</h2></div><button class="icon-btn" data-close="modal">${icon("close")}</button></div><form class="room-picker-search" id="roomMusicSearchForm"><svg><use href="#i-search"/></svg><input name="query" minlength="2" maxlength="120" required autocomplete="off" placeholder="Música ou artista"><button class="primary-btn">Buscar</button></form><div class="room-picker-results" id="roomPickerResults"><span class="eyebrow">SUA BIBLIOTECA</span>${roomPickerRows(state.library, "library")}</div></div>`);
}

async function searchRoomMusic(form) {
  const query = String(new FormData(form).get("query") || "").trim();
  if (query.length < 2) return;
  $("#roomPickerResults").innerHTML = `<p class="social-placeholder">Buscando “${escapeHtml(query)}”...</p>`;
  try {
    const result = await api(`/api/youtube/search?q=${encodeURIComponent(query)}`);
    state.roomSearch = result.items.map(normalized);
    $("#roomPickerResults").innerHTML = `<span class="eyebrow">RESULTADOS</span>${roomPickerRows(state.roomSearch, "search")}`;
  } catch (error) {
    $("#roomPickerResults").innerHTML = `<p class="social-placeholder">${escapeHtml(error.message)}</p>`;
  }
}

function leaveListeningRoom() {
  clearInterval(state.roomSyncTimer); state.roomSyncTimer = null;
  clearTimeout(state.roomReconnectTimer); state.roomReconnectTimer = null;
  if (state.roomSocket) state.roomSocket.close(); state.roomSocket = null; state.room = null; state.roomAudioBlocked = false;
  if (state.source === "room") { state.audio.pause(); state.source = null; state.current = null; updatePlayerMeta(); }
  document.body.classList.remove("room-active", "room-collapsed");
  sessionStorage.removeItem("pulse:active-room");
  $("#roomPanel").classList.remove("open"); $("#roomPanel").setAttribute("aria-hidden", "true");
}

async function togglePlaylistVisibility(playlistId) {
  try {
    const updated = await api(`/api/playlists/${playlistId}/visibility`, { method: "PATCH" });
    const index = state.playlists.findIndex(playlist => playlist.id === playlistId);
    state.playlists[index] = { ...updated, tracks: updated.tracks.map(normalized) };
    renderPlaylistDetail(playlistId); renderSidebar(); toast(updated.is_public ? "Playlist publicada." : "Playlist agora é privada.");
  } catch (error) { toast(error.message, "error"); }
}

function modal(content) {
  $("#modalLayer").innerHTML = content; $("#modalLayer").classList.add("open"); $("#modalLayer").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#modalLayer input")?.focus(), 50);
}
function closeModal() { $("#modalLayer").classList.remove("open"); $("#modalLayer").setAttribute("aria-hidden", "true"); }

function playlistModal() {
  modal(`<form class="modal" id="playlistForm"><div class="modal-head"><h2>Nova playlist</h2><button type="button" class="icon-btn" data-close="modal">${icon("close")}</button></div><label class="field"><span>Nome</span><input name="name" maxlength="100" required placeholder="Minha playlist"></label><label class="field"><span>Descrição <small>(opcional)</small></span><textarea name="description" maxlength="500" rows="3" placeholder="Qual é a vibe desta playlist?"></textarea></label>${state.folders.length ? `<label class="field"><span>Pasta</span><select name="folder_id"><option value="">Nenhuma</option>${state.folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select></label>` : ""}<label class="preference-row"><span><strong>Playlist pública</strong><small>Outras pessoas poderão encontrar e visualizar esta playlist.</small></span><input type="checkbox" name="is_public"></label><div class="modal-actions"><button type="button" class="soft-btn" data-close="modal">Cancelar</button><button class="primary-btn">Criar playlist</button></div></form>`);
}

function folderModal() {
  modal(`<form class="modal" id="folderForm"><div class="modal-head"><h2>Nova pasta</h2><button type="button" class="icon-btn" data-close="modal">${icon("close")}</button></div><label class="field"><span>Nome</span><input name="name" maxlength="100" required placeholder="Ex.: Para trabalhar"></label><div class="modal-actions"><button type="button" class="soft-btn" data-close="modal">Cancelar</button><button class="primary-btn">Criar pasta</button></div></form>`);
}

function addToPlaylistModal(track) {
  modal(`<div class="modal"><div class="modal-head"><h2>Adicionar à playlist</h2><button class="icon-btn" data-close="modal">${icon("close")}</button></div><div class="playlist-options">${state.playlists.length ? state.playlists.map(p => `<button class="playlist-option" data-add-to-playlist="${p.id}" data-track-id="${track.id}"><strong>${escapeHtml(p.name)}</strong><br><small>${p.track_count} faixas</small></button>`).join("") : `<p style="color:var(--muted)">Crie uma playlist primeiro.</p>`}</div><button class="soft-btn" id="createFromAdd" style="margin-top:12px">${icon("plus")} Nova playlist</button></div>`);
}

async function createPlaylist(form) {
  const data = Object.fromEntries(new FormData(form)); if (!data.folder_id) delete data.folder_id; else data.folder_id = Number(data.folder_id);
  data.is_public = data.is_public === "on";
  try { state.playlists.unshift(await api("/api/playlists", { method: "POST", body: JSON.stringify(data) })); closeModal(); renderAll(); toast("Playlist criada"); }
  catch (error) { toast(error.message, "error"); }
}

async function createFolder(form) {
  const data = Object.fromEntries(new FormData(form));
  try { state.folders.push(await api("/api/folders", { method: "POST", body: JSON.stringify(data) })); closeModal(); toast("Pasta criada"); }
  catch (error) { toast(error.message, "error"); }
}

async function addToPlaylist(playlistId, trackId) {
  try {
    const updated = await api(`/api/playlists/${playlistId}/tracks/${trackId}`, { method: "POST" });
    state.playlists[state.playlists.findIndex(p => p.id === playlistId)] = { ...updated, tracks: updated.tracks.map(normalized) };
    closeModal(); renderAll(); toast("Adicionada à playlist");
  } catch (error) { toast(error.message, "error"); }
}

function renderPlaylistDetail(id) {
  const p = state.playlists.find(item => item.id === id); if (!p) return navigate("library");
  $("#playlistDetail").innerHTML = `<div class="playlist-banner"><div class="playlist-cover">${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="">` : icon("library")}</div><div class="playlist-info"><span class="eyebrow">PLAYLIST ${p.is_public ? "PÚBLICA" : "PRIVADA"}</span><h1>${escapeHtml(p.name)}</h1><p>${escapeHtml(p.description || "Sua seleção, do seu jeito.")}</p><small>${p.track_count} faixas · ${fmt(p.duration_seconds)}</small></div></div><div data-current-playlist="${p.id}"><div class="playlist-controls"><button class="large-play" data-action="play-playlist" data-playlist="${p.id}">${icon("play")}</button><button class="soft-btn" data-playlist-visibility="${p.id}">${p.is_public ? "Tornar privada" : "Publicar playlist"}</button><button class="icon-btn" data-action="delete-playlist" data-playlist="${p.id}" title="Excluir playlist">${icon("more")}</button></div>${p.tracks.length ? trackTable(p.tracks, p.id) : emptyHtml("Esta playlist pede música", "Adicione faixas da sua biblioteca para começar.", "Abrir biblioteca", "library")}</div>`;
}

function playPlaylist(id) {
  const playlist = state.playlists.find(p => p.id === id);
  if (!playlist?.tracks.length) return toast("Esta playlist ainda está vazia.", "error");
  state.queue = [...playlist.tracks]; state.current = null; playTrack(state.queue[0], state.queue);
}

function renderQueue() {
  $("#queueList").innerHTML = state.queue.length ? state.queue.map((t, index) => `<div class="queue-row ${index === state.currentIndex ? "active" : ""}"><img src="${escapeHtml(t.thumbnail || "")}" alt=""><button class="queue-row-copy" data-queue-index="${index}"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.artist)}</span></button><div class="queue-actions">${index !== state.currentIndex ? `<button class="icon-btn" data-queue-move="${index}" data-direction="-1" title="Subir" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-btn" data-queue-move="${index}" data-direction="1" title="Descer" ${index === state.queue.length - 1 ? "disabled" : ""}>↓</button><button class="icon-btn" data-queue-remove="${index}" title="Remover">${icon("close")}</button>` : `<span class="eyebrow">AGORA</span>`}</div></div>`).join("") : `<p style="color:var(--muted)">A fila está vazia.</p>`;
  renderFloatingPlayer();
}

function moveQueueItem(index, direction) {
  const target = index + direction;
  if (index === state.currentIndex || target < 0 || target >= state.queue.length) return;
  [state.queue[index], state.queue[target]] = [state.queue[target], state.queue[index]];
  if (state.currentIndex === target) state.currentIndex = index;
  renderQueue(); saveClientSnapshot(); persistState();
}

function removeQueueItem(index) {
  if (index === state.currentIndex) return toast("A música atual continua tocando. Pule antes de removê-la.", "error");
  state.queue.splice(index, 1);
  if (index < state.currentIndex) state.currentIndex -= 1;
  renderQueue(); saveClientSnapshot(); persistState();
}

function closeContextMenu() {
  const menu = $("#contextMenu");
  menu._anchor?.setAttribute("aria-expanded", "false");
  menu.classList.remove("open");
  menu._anchor = null;
}

function positionContextMenu() {
  const menu = $("#contextMenu"), button = menu._anchor;
  if (!menu.classList.contains("open") || !button?.isConnected) return closeContextMenu();
  const rect = button.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return closeContextMenu();
  const gap = 6, edge = 8;
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(edge, Math.min(rect.right - menuRect.width, innerWidth - menuRect.width - edge));
  const roomBelow = innerHeight - rect.bottom - edge;
  const top = roomBelow >= menuRect.height
    ? rect.bottom + gap
    : Math.max(edge, rect.top - menuRect.height - gap);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function scheduleContextMenuPosition() {
  if (!$("#contextMenu").classList.contains("open") || positionContextMenu._frame) return;
  positionContextMenu._frame = requestAnimationFrame(() => {
    positionContextMenu._frame = null;
    positionContextMenu();
  });
}

function openContext(button, track, playlistId) {
  const menu = $("#contextMenu");
  if (menu.classList.contains("open") && menu._anchor === button) return closeContextMenu();
  closeContextMenu();
  menu.innerHTML = track.playable_locally
    ? `<button data-context="queue">Adicionar à fila</button>${isTrackOnDevice(track) ? `<button data-context="device-remove">Remover deste aparelho</button>` : `<button data-context="device-download">Salvar neste aparelho</button>`}<button data-context="save-file">Salvar arquivo no computador…</button><button data-context="playlist">Adicionar à playlist</button><button data-context="favorite">${track.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}</button>${playlistId ? `<button class="danger" data-context="remove-playlist">Remover da playlist</button>` : ""}<button class="danger" data-context="remove-library">Remover da biblioteca</button>`
    : `<button data-context="download">Baixar para ouvir</button><button data-context="save-file">Baixar e escolher onde salvar…</button>`;
  menu._track = track; menu._playlistId = Number(playlistId) || null; menu._anchor = button;
  button.setAttribute("aria-expanded", "true");
  menu.classList.add("open");
  positionContextMenu();
}

async function contextAction(action) {
  const menu = $("#contextMenu"), track = menu._track, playlistId = menu._playlistId; closeContextMenu();
  if (action === "queue") { state.queue.push(track); renderQueue(); saveClientSnapshot(); return toast("Adicionada à fila"); }
  if (action === "download") return startAutoDownload(track);
  if (action === "save-file") return saveTrackToComputer(track);
  if (action === "device-download") return saveTrackOnDevice(track);
  if (action === "device-remove") return removeTrackFromDevice(track);
  if (action === "favorite") return toggleFavorite(track.id);
  if (action === "playlist") return addToPlaylistModal(track);
  if (action === "remove-library") {
    try { await api(`/api/library/${track.id}`, { method: "DELETE" }); await removeTrackFromDevice(track, { silent: true }); state.library = state.library.filter(t => t.id !== track.id); state.queue = state.queue.filter(t => t.id !== track.id); await reloadPlaylists(); renderAll(); toast("Removida da biblioteca"); } catch (e) { toast(e.message, "error"); }
  }
  if (action === "remove-playlist") {
    try { const updated = await api(`/api/playlists/${playlistId}/tracks/${track.id}`, { method: "DELETE" }); state.playlists[state.playlists.findIndex(p => p.id === playlistId)] = { ...updated, tracks: updated.tracks.map(normalized) }; renderPlaylistDetail(playlistId); renderSidebar(); toast("Removida da playlist"); } catch (e) { toast(e.message, "error"); }
  }
}

async function reloadPlaylists() { const data = await api("/api/playlists"); state.playlists = data.map(p => ({ ...p, tracks: p.tracks.map(normalized) })); }

function parseSyncedLyrics(value) {
  const lines = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const text = rawLine.replace(/(?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+/g, "").trim();
    for (const match of rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      const fraction = Number(`0.${match[3] || 0}`);
      lines.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text: text || "♪" });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function renderLyricsLines(lines, synchronized) {
  if (!lines.length) {
    $("#lyricsLines").innerHTML = `<p class="social-placeholder">A letra ainda não foi encontrada no LRCLIB.</p>`;
    return;
  }
  $("#lyricsLines").innerHTML = lines.map((line, index) => `<button class="lyric-line" data-lyric-index="${index}" ${synchronized ? `data-lyric-time="${line.time}"` : ""}>${escapeHtml(line.text)}</button>`).join("");
}

async function openLyrics() {
  if (!state.current?.id) return toast("Comece uma música para abrir a letra.", "error");
  $("#queuePanel").classList.remove("open");
  $("#lyricsPanel").classList.add("open"); $("#lyricsPanel").setAttribute("aria-hidden", "false");
  $("#lyricsTitle").textContent = state.current.title;
  $("#lyricsLines").innerHTML = `<p class="social-placeholder">Buscando letra sincronizada...</p>`;
  const musicId = state.current.id;
  if (state.lyricsLoadingId === musicId) return;
  state.lyricsLoadingId = musicId;
  const roomQuery = state.source === "room" && state.room ? `?room=${encodeURIComponent(state.room.room.code)}` : "";
  try {
    const result = await api(`/api/lyrics/${musicId}${roomQuery}`);
    if (state.current?.id !== musicId) return openLyrics();
    if (result.temporarily_unavailable) {
      state.lyrics = { musicId, synchronized: false, lines: [] };
      $("#lyricsLines").innerHTML = `<p class="social-placeholder">O LRCLIB está temporariamente indisponível. Tente novamente mais tarde.</p>`;
      return;
    }
    const synced = parseSyncedLyrics(result.synced_lyrics);
    const lines = synced.length ? synced : String(result.plain_lyrics || "").split(/\r?\n/).filter(Boolean).map(text => ({ time: null, text }));
    state.lyrics = { musicId, synchronized: Boolean(synced.length), lines };
    state.activeLyricIndex = -1;
    renderLyricsLines(lines, state.lyrics.synchronized);
    updateLyricsPosition();
  } catch (error) {
    $("#lyricsLines").innerHTML = `<p class="social-placeholder">${escapeHtml(error.message)}</p>`;
  } finally {
    if (state.lyricsLoadingId === musicId) state.lyricsLoadingId = null;
  }
}

function closeLyrics() {
  $("#lyricsPanel").classList.remove("open");
  $("#lyricsPanel").setAttribute("aria-hidden", "true");
}

function updateLyricsPosition() {
  if (!state.lyrics?.synchronized || state.lyrics.musicId !== state.current?.id) return;
  const position = state.audio?.currentTime || 0;
  let active = -1;
  for (let index = 0; index < state.lyrics.lines.length; index += 1) {
    if (state.lyrics.lines[index].time <= position + .08) active = index; else break;
  }
  if (active === state.activeLyricIndex) return;
  state.activeLyricIndex = active;
  $$(".lyric-line", $("#lyricsLines")).forEach((line, index) => {
    line.classList.toggle("active", index === active);
    line.classList.toggle("past", index < active);
  });
  const current = $(`.lyric-line[data-lyric-index="${active}"]`, $("#lyricsLines"));
  current?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function expandedPlayer() {
  if (!state.current) return toast("Escolha uma música primeiro.", "error");
  const t = state.current;
  modal(`<div class="expanded"><div class="expanded-bg" style="background-image:url('${escapeHtml(t.thumbnail)}')"></div><button class="icon-btn expanded-close" data-close="modal">${icon("close")}</button><div class="expanded-content"><img class="expanded-cover" src="${escapeHtml(t.thumbnail)}" alt="Capa de ${escapeHtml(t.title)}"><h2>${escapeHtml(t.title)}</h2><p>${escapeHtml(t.artist)}</p><div class="expanded-controls"><button class="icon-btn" data-expanded="shuffle">${icon("shuffle")}</button><button class="icon-btn" data-expanded="prev">${icon("prev")}</button><button class="main-play" data-expanded="play">${icon(state.playing ? "pause" : "play")}</button><button class="icon-btn" data-expanded="next">${icon("next")}</button><button class="icon-btn" data-expanded="repeat">${icon("repeat")}</button></div><div class="expanded-progress timeline"><span>${$("#currentTime").textContent}</span><input type="range" value="${$("#seekBar").value}"><span>${$("#duration").textContent}</span></div></div></div>`);
}

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function setInstallButton(status = "ready") {
  $$(".install-trigger").forEach(button => {
    const label = $(".install-label", button);
    const busy = status === "installing";
    button.classList.toggle("installing", busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
    button.disabled = busy;
    const baseLabel = button.dataset.installLabel || "Instalar app";
    label.textContent = status === "installing" ? "Instalando..." : status === "manual" ? "Como instalar" : baseLabel;
  });
}

function showInstallProgress(message = "O navegador está baixando o aplicativo...") {
  installInProgress = true;
  setInstallButton("installing");
  const progress = $("#installProgress");
  $("#installProgressTitle").textContent = "Instalando o Pulse";
  $("#installProgressMessage").textContent = message;
  progress.classList.add("open");
  progress.setAttribute("aria-hidden", "false");
  clearTimeout(installWatchdog);
  installWatchdog = setTimeout(() => {
    if (!installInProgress) return;
    $("#installProgressMessage").textContent = "Finalizando no navegador. Você pode continuar usando o Pulse.";
  }, 20000);
}

function hideInstallProgress() {
  installInProgress = false;
  clearTimeout(installWatchdog);
  installWatchdog = null;
  setInstallButton("ready");
  const progress = $("#installProgress");
  progress.classList.remove("open", "complete");
  progress.setAttribute("aria-hidden", "true");
}

async function installApp() {
  if (isStandalone()) return toast("O Pulse já está instalado.");
  if (installInProgress) return toast("A instalação do Pulse está em andamento.");
  if (deferredInstallPrompt) {
    closeModal();
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    setInstallButton("installing");
    try {
      await prompt.prompt();
    } catch (_) {
      setInstallButton("manual");
      toast("Não foi possível abrir a instalação. Recarregue a página e tente novamente.", "error");
      return;
    }
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      if (!installCompletedThisSession) showInstallProgress("Download iniciado. Aguarde enquanto o navegador instala o Pulse...");
    } else {
      setInstallButton("manual");
      localStorage.setItem("pulse:install-dismissed", String(Date.now()));
      toast("Instalação cancelada. Você pode tentar novamente pelo menu do navegador.", "error");
    }
    return;
  }
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isMobile = matchMedia("(max-width: 760px)").matches;
  const insecure = !window.isSecureContext;
  modal(`<div class="modal"><div class="modal-head"><div><span class="eyebrow">LEVE O PULSE COM VOCÊ</span><h2>${insecure ? "HTTPS necessário" : isiOS ? "Instalar no iPhone" : isMobile ? "Instalar no celular" : "Instalar no computador"}</h2></div><button class="icon-btn" data-close="modal">${icon("close")}</button></div>${insecure ? `<p style="color:var(--muted);line-height:1.6">O navegador só permite instalar aplicativos quando o Pulse é aberto por <strong style="color:#fff">HTTPS</strong>. Publique o app em um domínio HTTPS ou use um túnel HTTPS para acessar este computador pelo celular.</p>` : isiOS ? `<div style="color:var(--muted);line-height:1.7"><p>1. Toque no botão <strong style="color:#fff">Compartilhar</strong> do Safari.</p><p>2. Escolha <strong style="color:#fff">Adicionar à Tela de Início</strong>.</p><p>3. Confirme em <strong style="color:#fff">Adicionar</strong>.</p></div>` : `<p style="color:var(--muted);line-height:1.6">O navegador ainda não liberou a instalação automática. Abra o menu do navegador e escolha <strong style="color:#fff">Instalar Pulse</strong> ou <strong style="color:#fff">Instalar aplicativo</strong>.</p>`}<div class="modal-actions"><button class="primary-btn" data-close="modal">Entendi</button></div></div>`);
}

function showInstallCoach(kind = "android") {
  if (isStandalone() || $("#modalLayer").classList.contains("open")) return;
  const dismissedAt = Number(localStorage.getItem("pulse:install-dismissed") || 0);
  if (Date.now() - dismissedAt < 3 * 24 * 60 * 60 * 1000) return;
  const iosSteps = `<div style="color:var(--muted);line-height:1.65"><p><strong style="color:var(--accent)">1.</strong> Toque em Compartilhar no Safari.</p><p><strong style="color:var(--accent)">2.</strong> Toque em Adicionar à Tela de Início.</p><p><strong style="color:var(--accent)">3.</strong> Confirme em Adicionar.</p></div>`;
  modal(`<div class="modal install-coach"><div class="install-coach-art"><div class="install-coach-phone"><span class="brand-mark"><i></i><i></i><i></i></span></div></div><div class="modal-head"><div><span class="eyebrow">PULSE NO CELULAR</span><h2>${kind === "ios" ? "Adicione à tela inicial" : "Instale com um toque"}</h2></div><button class="icon-btn" id="dismissInstall">${icon("close")}</button></div><p style="color:var(--muted);line-height:1.55;margin-top:-7px">Player em tela cheia, acesso rápido e uma experiência feita para o seu celular.</p><div class="install-benefits"><span>✓ Tela cheia</span><span>✓ Acesso rápido</span><span>✓ Biblioteca offline</span></div>${kind === "ios" ? iosSteps : ""}<div class="modal-actions"><button class="soft-btn" id="dismissInstallText">Agora não</button>${kind === "android" ? `<button class="primary-btn" id="installNowBtn">${icon("install")} Instalar agora</button>` : `<button class="primary-btn" data-close="modal">Entendi</button>`}</div></div>`);
}

function showInstallSuccess() {
  navigate("home");
  history.replaceState({}, "", "/?installed=1");
  modal(`<div class="modal" style="text-align:center"><div class="install-coach-art"><div class="install-coach-phone"><span class="brand-mark"><i></i><i></i><i></i></span></div></div><span class="eyebrow">TUDO PRONTO</span><h2 style="font:700 24px Manrope;margin:0 0 8px">Pulse instalado</h2><p style="color:var(--muted);line-height:1.55">O ícone foi adicionado à sua tela inicial. Você já pode continuar ouvindo por aqui.</p><button class="primary-btn" data-close="modal" style="width:100%;margin-top:10px">Continuar no Pulse</button></div>`);
}

function updateConnectionStatus() {
  $("#offlinePill").classList.toggle("open", !navigator.onLine);
}

function setupPwa() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    let reloadingForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      location.reload();
    });
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
  if (isStandalone()) { $$(".install-trigger").forEach(button => button.classList.add("hidden")); document.body.classList.add("pwa-installed"); }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installInProgress = false;
    setInstallButton("ready");
    $$(".install-trigger").forEach(button => button.classList.remove("hidden"));
  });
  window.addEventListener("appinstalled", () => {
    installCompletedThisSession = true;
    deferredInstallPrompt = null;
    localStorage.setItem("pulse:installed", "true");
    $$(".install-trigger").forEach(button => button.classList.add("hidden"));
    clearTimeout(installWatchdog);
    installInProgress = false;
    const progress = $("#installProgress");
    progress.classList.add("open", "complete");
    progress.setAttribute("aria-hidden", "false");
    $("#installProgressTitle").textContent = "Pulse instalado";
    $("#installProgressMessage").textContent = "Download concluído. O aplicativo está pronto para abrir.";
    setTimeout(() => {
      hideInstallProgress();
      showInstallSuccess();
    }, 1300);
  });
  window.addEventListener("online", () => { updateConnectionStatus(); if (state.user?.auto_download_devices) syncOfflineLibrary(); });
  window.addEventListener("offline", updateConnectionStatus);
  updateConnectionStatus();
}

document.addEventListener("click", async event => {
  if (event.target.closest("#authSwitch")) switchAuthMode($("#authSwitch").dataset.mode);
  if (event.target.closest(".profile-open")) profileModal();
  if (event.target.closest("#logoutBtn")) logoutAccount();
  const publicProfile = event.target.closest("[data-public-profile]"); if (publicProfile) showPublicPlaylists(Number(publicProfile.dataset.publicProfile));
  const friendAdd = event.target.closest("[data-friend-add]"); if (friendAdd) friendAction("add", Number(friendAdd.dataset.friendAdd));
  const friendAccept = event.target.closest("[data-friend-accept]"); if (friendAccept) friendAction("accept", Number(friendAccept.dataset.friendAccept));
  const friendRemove = event.target.closest("[data-friend-remove]"); if (friendRemove && confirm("Remover esta amizade?")) friendAction("remove", Number(friendRemove.dataset.friendRemove));
  const visibility = event.target.closest("[data-playlist-visibility]"); if (visibility) togglePlaylistVisibility(Number(visibility.dataset.playlistVisibility));
  if (event.target.closest("#roomAddBtn, #roomQuickAddBtn")) addRoomMusicModal();
  if (event.target.closest("#copyRoomCodeBtn")) copyRoomCode();
  if (event.target.closest("#pasteRoomCodeBtn")) pasteAndJoinRoom();
  if (event.target.closest("#notificationBtn")) {
    const popover = $("#notificationPopover"), opening = popover.hidden;
    popover.hidden = !opening; $("#notificationBtn").setAttribute("aria-expanded", opening ? "true" : "false");
  }
  if (event.target.closest("#clearNotificationsBtn")) {
    state.notifications.forEach(item => state.dismissedNotifications.add(item.id)); renderNotifications();
  }
  const notification = event.target.closest("[data-notification-id]");
  if (notification) {
    state.dismissedNotifications.add(notification.dataset.notificationId); renderNotifications();
    $("#notificationPopover").hidden = true; $("#notificationBtn").setAttribute("aria-expanded", "false");
    if (notification.dataset.notificationKind === "friend") navigate("social");
    if (notification.dataset.notificationKind === "chat" && state.room) setRoomCollapsed(false);
  }
  if (!event.target.closest(".notification-shell")) { $("#notificationPopover").hidden = true; $("#notificationBtn").setAttribute("aria-expanded", "false"); }
  const roomAdd = event.target.closest("[data-room-add-music]"); if (roomAdd) { roomSend({ type: "queue_add", music_id: Number(roomAdd.dataset.roomAddMusic) }); closeModal(); }
  const roomPicker = event.target.closest("[data-room-picker-source]");
  if (roomPicker) {
    const source = roomPicker.dataset.roomPickerSource;
    const track = (source === "library" ? state.library : state.roomSearch)[Number(roomPicker.dataset.roomPickerIndex)];
    if (track) {
      if (source === "library" && track.id) roomSend({ type: "queue_add", music_id: track.id });
      else roomSend({ type: "queue_add_track", track: { title: track.title, artist: track.artist, youtube_video_id: track.youtube_video_id, thumbnail: track.thumbnail || null, duration_seconds: track.duration_seconds || null } });
      const needsApproval = state.room?.room.queue_policy === "approval" && state.room?.room.owner_id !== state.user?.id;
      toast(needsApproval ? "Pedido enviado ao host." : "Música enviada para a fila da sala.");
    }
  }
  const requestAccept = event.target.closest("[data-room-request-accept]");
  if (requestAccept) roomSend({ type: "queue_request_accept", request_id: requestAccept.dataset.roomRequestAccept });
  const requestReject = event.target.closest("[data-room-request-reject]");
  if (requestReject) roomSend({ type: "queue_request_reject", request_id: requestReject.dataset.roomRequestReject });
  const roomRemove = event.target.closest("[data-room-remove]"); if (roomRemove) roomSend({ type: "queue_remove", entry_id: roomRemove.dataset.roomRemove });
  const roomMove = event.target.closest("[data-room-move]"); if (roomMove) roomSend({ type: "queue_move", entry_id: roomMove.dataset.roomMove, direction: Number(roomMove.dataset.direction) });
  if (event.target.closest("#roomClearBtn")) roomSend({ type: "queue_clear" });
  if (event.target.closest("#toggleRoomPanelBtn")) setRoomCollapsed(!$("#roomPanel").classList.contains("collapsed"));
  if (event.target.closest("#roomPlayBtn")) {
    if (state.room?.room.owner_id === state.user?.id) {
      roomSend({ type: state.room?.playing ? "pause" : "play", position: state.audio?.currentTime || 0 });
    } else if (state.room?.playing && state.room?.current) {
      state.audio?.play().then(() => {
        state.roomAudioBlocked = false;
        toast("Áudio da sala liberado neste aparelho.");
      }).catch(() => toast("O celular ainda bloqueou o áudio. Aumente o volume e toque novamente.", "error"));
    }
  }
  if (event.target.closest("#roomSkipBtn")) roomSend({ type: "skip" });
  if (event.target.closest("#leaveRoomBtn")) leaveListeningRoom();
  const filterReset = event.target.closest("[data-filter-reset]");
  if (filterReset) {
    state.filter = filterReset.dataset.filterReset;
    $$(".filter-chip").forEach(button => button.classList.toggle("active", button.dataset.filter === state.filter));
    renderLibrary();
  }
  const viewButton = event.target.closest("[data-view]"); if (viewButton) navigate(viewButton.dataset.view);
  const playlistButton = event.target.closest("[data-playlist]");
  if (playlistButton && !playlistButton.matches('[data-action="play-playlist"]')) navigate("playlist", { id: playlistButton.dataset.playlist });
  const action = event.target.closest("[data-action]");
  if (action) {
    const track = findTrack(action.dataset.trackKey);
    if (action.dataset.action === "play" && track) playTrack(track, track.id ? state.library : state.search.length ? state.search : starterTracks);
    if (action.dataset.action === "download" && track) startAutoDownload(track);
    if (action.dataset.action === "save-file" && track) saveTrackToComputer(track);
    if (action.dataset.action === "device-download" && track) saveTrackOnDevice(track);
    if (action.dataset.action === "favorite") toggleFavorite(Number(action.dataset.id));
    if (action.dataset.action === "more" && track) openContext(action, track, action.dataset.playlistId);
    if (action.dataset.action === "play-playlist") playPlaylist(Number(action.dataset.playlist));
    if (action.dataset.action === "delete-playlist") {
      const id = Number(action.dataset.playlist); if (confirm("Excluir esta playlist? As músicas continuarão na biblioteca.")) { await api(`/api/playlists/${id}`, { method: "DELETE" }); state.playlists = state.playlists.filter(p => p.id !== id); renderAll(); navigate("library"); toast("Playlist excluída"); }
    }
  }
  if (event.target.closest("#newPlaylistBtn,#newPlaylistSide")) playlistModal();
  if (event.target.closest("#newFolderBtn")) folderModal();
  if (event.target.closest(".install-trigger,#installNowBtn")) installApp();
  if (event.target.closest("#dismissInstall,#dismissInstallText")) {
    localStorage.setItem("pulse:install-dismissed", String(Date.now()));
    closeModal();
  }
  if (event.target.closest("[data-close='modal']") || (event.target.id === "modalLayer")) closeModal();
  if (event.target.closest("[data-close='queue']")) $("#queuePanel").classList.remove("open");
  if (event.target.closest("[data-close='lyrics']")) closeLyrics();
  if (event.target.closest("#topSearch")) navigate("search");
  const hint = event.target.closest("[data-query]"); if (hint) { $("#searchInput").value = hint.dataset.query; $("#searchForm").requestSubmit(); }
  const addOption = event.target.closest("[data-add-to-playlist]"); if (addOption) addToPlaylist(Number(addOption.dataset.addToPlaylist), Number(addOption.dataset.trackId));
  if (event.target.closest("#createFromAdd")) playlistModal();
  const context = event.target.closest("[data-context]"); if (context) contextAction(context.dataset.context);
  else if (!event.target.closest("#contextMenu") && !event.target.closest('[data-action="more"]')) closeContextMenu();
  const queueItem = event.target.closest("[data-queue-index]"); if (queueItem) { const i = Number(queueItem.dataset.queueIndex); state.current = null; playTrack(state.queue[i], state.queue); }
  const queueMove = event.target.closest("[data-queue-move]"); if (queueMove) moveQueueItem(Number(queueMove.dataset.queueMove), Number(queueMove.dataset.direction));
  const queueRemove = event.target.closest("[data-queue-remove]"); if (queueRemove) removeQueueItem(Number(queueRemove.dataset.queueRemove));
  const lyricLine = event.target.closest("[data-lyric-time]");
  if (lyricLine) {
    const position = Number(lyricLine.dataset.lyricTime);
    if (state.source === "room") {
      if (state.room?.room.owner_id === state.user?.id) roomSend({ type: "seek", position });
      else toast("Somente o anfitrião pode mudar o tempo da sala.", "error");
    } else if (state.audio) state.audio.currentTime = position;
  }
  const expanded = event.target.closest("[data-expanded]"); if (expanded) ({ play: togglePlay, prev: () => moveTrack(-1), next: () => moveTrack(1), shuffle: toggleShuffle, repeat: cycleRepeat }[expanded.dataset.expanded])();
});

document.addEventListener("submit", event => {
  if (event.target.id === "loginForm") { event.preventDefault(); submitAuth(event.target, "login"); return; }
  if (event.target.id === "registerForm") { event.preventDefault(); submitAuth(event.target, "register"); return; }
  if (event.target.id === "socialSearchForm") { event.preventDefault(); searchPeople(event.target); return; }
  if (event.target.id === "createRoomForm") { event.preventDefault(); createListeningRoom(event.target); return; }
  if (event.target.id === "joinRoomForm") { event.preventDefault(); joinListeningRoom(event.target); return; }
  if (event.target.id === "roomChatForm") { event.preventDefault(); const input = event.target.elements.text; const text = input.value.trim(); if (text) roomSend({ type: "chat", text }); input.value = ""; return; }
  if (event.target.id === "roomMusicSearchForm") { event.preventDefault(); searchRoomMusic(event.target); return; }
  if (event.target.id === "searchForm") search(event);
  if (event.target.id === "playlistForm") { event.preventDefault(); createPlaylist(event.target); }
  if (event.target.id === "folderForm") { event.preventDefault(); createFolder(event.target); }
});

document.addEventListener("change", event => {
  if (event.target.id === "autoDownloadPreference") updateAutoDownloadPreference(event.target.checked);
});

document.addEventListener("scroll", scheduleContextMenuPosition, { capture: true, passive: true });
window.addEventListener("resize", scheduleContextMenuPosition, { passive: true });

$("#playBtn").addEventListener("click", togglePlay); $("#prevBtn").addEventListener("click", () => moveTrack(-1)); $("#nextBtn").addEventListener("click", () => moveTrack(1));
$("#shuffleBtn").addEventListener("click", toggleShuffle); $("#repeatBtn").addEventListener("click", cycleRepeat);
$("#queueBtn").addEventListener("click", () => { closeLyrics(); $("#queuePanel").classList.toggle("open"); });
$("#floatingPlayerBtn").addEventListener("click", openFloatingPlayer);
$("#lyricsBtn").addEventListener("click", openLyrics);
$("#expandBtn").addEventListener("click", expandedPlayer); $("#expandCover").addEventListener("click", expandedPlayer);
$("#favoriteCurrent").addEventListener("click", () => state.current?.id ? toggleFavorite(state.current.id) : toast("Adicione esta música à biblioteca primeiro.", "error"));
$("#clearQueue").addEventListener("click", () => { state.queue = state.current ? [state.current] : []; state.currentIndex = state.current ? 0 : -1; renderQueue(); saveClientSnapshot(); });
$("#seekBar").addEventListener("input", event => {
  const duration = Number.isFinite(state.audio?.duration) ? state.audio.duration : state.current?.duration_seconds || 0;
  const position = duration * event.target.value / 100;
  if (state.source === "room") {
    if (state.room?.room.owner_id === state.user?.id) roomSend({ type: "seek", position });
    else toast("Somente o anfitrião pode avançar a música.", "error");
    return;
  }
  if (state.audio) state.audio.currentTime = position;
  setRangeFill(event.target, event.target.value);
});
$("#volumeBar").addEventListener("input", event => setDeviceVolume(event.target.value));
$("#mobileVolumeBar").addEventListener("input", event => setDeviceVolume(event.target.value));
$("#muteBtn").addEventListener("click", () => {
  if (matchMedia("(max-width: 760px)").matches) {
    $("#mobileVolumePanel").classList.toggle("open");
    $("#mobileVolumePanel").setAttribute("aria-hidden", $("#mobileVolumePanel").classList.contains("open") ? "false" : "true");
    return;
  }
  if (state.volume) { state.mutedVolume = state.volume; setDeviceVolume(0); }
  else setDeviceVolume(state.mutedVolume || .75);
});
$("#libraryFilter").addEventListener("input", renderLibrary);
$("#joinRoomCodeInput").addEventListener("input", syncRoomCodeSlots);
$("#joinRoomCodeInput").addEventListener("focus", syncRoomCodeSlots);
$("#joinRoomCodeInput").addEventListener("blur", syncRoomCodeSlots);
$$('.filter-chip').forEach(button => button.addEventListener("click", () => { $$('.filter-chip').forEach(b => b.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; renderLibrary(); }));

document.addEventListener("keydown", event => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { if (event.key === "Escape") document.activeElement.blur(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); navigate("search"); }
  if (event.code === "Space") { event.preventDefault(); togglePlay(); }
  if (event.key === "ArrowRight" && state.audio) state.audio.currentTime = Math.min(Number.isFinite(state.audio.duration) ? state.audio.duration : Infinity, state.audio.currentTime + 10);
  if (event.key === "ArrowLeft" && state.audio) state.audio.currentTime = Math.max(0, state.audio.currentTime - 10);
  if (event.key === "Escape") { closeModal(); closeContextMenu(); $("#queuePanel").classList.remove("open"); closeLyrics(); }
});

let draggedRow = null;
document.addEventListener("dragstart", event => { draggedRow = event.target.closest(".track-row[draggable='true']"); });
document.addEventListener("dragover", event => { const row = event.target.closest(".track-row[draggable='true']"); if (row && draggedRow && row !== draggedRow) { event.preventDefault(); const box = row.getBoundingClientRect(); row.parentNode.insertBefore(draggedRow, event.clientY < box.top + box.height / 2 ? row : row.nextSibling); } });
document.addEventListener("dragend", async () => {
  if (!draggedRow) return; const parent = draggedRow.parentNode; const playlistId = Number(draggedRow.dataset.playlistId); const ids = $$(".track-row", parent).map(row => Number(row.dataset.musicId)); draggedRow = null;
  try { const updated = await api(`/api/playlists/${playlistId}/reorder`, { method: "PUT", body: JSON.stringify(ids) }); state.playlists[state.playlists.findIndex(p => p.id === playlistId)] = { ...updated, tracks: updated.tracks.map(normalized) }; } catch (e) { toast(e.message, "error"); renderPlaylistDetail(playlistId); }
});

state.audio = $("#localAudio");
state.audio.addEventListener("play", () => { if (!['local','stream','room'].includes(state.source)) return; state.playing = true; refreshPlayingUI(); });
state.audio.addEventListener("pause", () => { if (!['local','stream','room'].includes(state.source)) return; state.playing = false; refreshPlayingUI(); });
state.audio.addEventListener("timeupdate", updateTimeline);
state.audio.addEventListener("durationchange", updateTimeline);
state.audio.addEventListener("ended", () => { if (state.source === "room" && state.room?.room.owner_id === state.user?.id) roomSend({ type: "skip" }); else if (['local','stream'].includes(state.source)) handleEnded(); });
state.audio.addEventListener("error", () => { if (state.current && ['local','stream','room'].includes(state.source)) toast("O áudio não pôde ser reproduzido.", "error"); });
window.addEventListener("beforeunload", persistState);
setupPwa();
migrateClientData();
initializeApp();
