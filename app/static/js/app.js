const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

const starterTracks = [
  { title: "The Less I Know The Better", artist: "Tame Impala", youtube_video_id: "sBzrzS1Ag_g", thumbnail: "https://i.ytimg.com/vi/sBzrzS1Ag_g/hqdefault.jpg", duration_seconds: 216 },
  { title: "Redbone", artist: "Childish Gambino", youtube_video_id: "Kp7eSUU9oy8", thumbnail: "https://i.ytimg.com/vi/Kp7eSUU9oy8/hqdefault.jpg", duration_seconds: 327 },
  { title: "Do I Wanna Know?", artist: "Arctic Monkeys", youtube_video_id: "bpOSxM0rNPM", thumbnail: "https://i.ytimg.com/vi/bpOSxM0rNPM/hqdefault.jpg", duration_seconds: 272 },
  { title: "Borderline", artist: "Tame Impala", youtube_video_id: "2g5xkLqIElU", thumbnail: "https://i.ytimg.com/vi/2g5xkLqIElU/hqdefault.jpg", duration_seconds: 238 },
  { title: "Feels Like We Only Go Backwards", artist: "Tame Impala", youtube_video_id: "wycjnCCgUes", thumbnail: "https://i.ytimg.com/vi/wycjnCCgUes/hqdefault.jpg", duration_seconds: 193 },
];

const state = {
  view: "home", library: [], playlists: [], folders: [], history: [], search: [],
  queue: [], currentIndex: -1, shuffle: false, shuffleOrder: [], shuffleCursor: -1,
  repeat: "off", current: null, playing: false, volume: .75, mutedVolume: null,
  audio: null, resumePosition: 0, activeDownload: null, filter: "all",
};

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Algo não saiu como esperado.");
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

async function bootstrap() {
  try {
    const [library, playlists, folders, history, playback] = await Promise.all([
      api("/api/library"), api("/api/playlists"), api("/api/folders"), api("/api/library/history/recent"), api("/api/player/state")
    ]);
    state.library = library.map(normalized);
    state.playlists = playlists.map(p => ({ ...p, tracks: p.tracks.map(normalized) }));
    state.folders = folders;
    state.history = history.map(normalized);
    state.volume = playback.volume;
    state.shuffle = playback.shuffle;
    state.repeat = playback.repeat_mode;
    state.resumePosition = playback.position || 0;
    state.current = state.library.find(track => track.id === playback.music_id) || null;
    state.queue = state.current ? [...state.library] : [];
    state.currentIndex = state.current ? state.queue.findIndex(t => t.id === state.current.id) : -1;
    $("#volumeBar").value = state.volume;
    setRangeFill($("#volumeBar"), state.volume * 100);
    updateModeButtons();
    renderAll();
    if (state.current) updatePlayerMeta();
    if (state.current?.playable_locally) prepareLocalAudio(state.current, false);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderAll() {
  renderSidebar(); renderHome(); renderLibrary(); renderFavorites(); renderHistory(); renderQueue();
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
  return `<article class="music-card ${playing ? "playing" : ""}" data-track-key="${key}"><div class="card-image">${track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy">` : ""}<button class="card-play" data-action="play" data-track-key="${key}" aria-label="Reproduzir ${escapeHtml(track.title)}">${icon(playing ? "pause" : "play")}</button></div><h3 title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h3><p>${escapeHtml(track.artist)}</p></article>`;
}

function playlistCard(p) {
  return `<article class="music-card" data-playlist="${p.id}"><div class="card-image">${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="">` : `<div class="collection-icon" style="width:100%;height:100%;border-radius:0">${icon("library")}</div>`}<button class="card-play" data-action="play-playlist" data-playlist="${p.id}">${icon("play")}</button></div><h3>${escapeHtml(p.name)}</h3><p>${p.track_count} ${p.track_count === 1 ? "faixa" : "faixas"}</p></article>`;
}

function renderLibrary() {
  let tracks = state.filter === "favorites" ? state.library.filter(t => t.favorite) : state.library;
  const query = $("#libraryFilter")?.value.trim().toLowerCase();
  if (query) tracks = tracks.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(query));
  $("#libraryCount").textContent = `${state.library.length} ${state.library.length === 1 ? "faixa guardada" : "faixas guardadas"}.`;
  $("#libraryContent").innerHTML = tracks.length ? trackTable(tracks) : emptyHtml(
    state.filter === "favorites" ? "Nada favoritado ainda" : "Sua biblioteca ainda está vazia",
    state.filter === "favorites" ? "Toque no coração de uma faixa para encontrá-la aqui." : "Pesquise uma música e adicione sua primeira faixa.",
    "Pesquisar músicas", "search"
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
  return `<div class="track-row ${playing ? "playing" : ""}" data-track-key="${key}" draggable="${playlistId ? "true" : "false"}" data-music-id="${track.id || ""}" data-playlist-id="${playlistId || ""}"><div class="row-thumb">${track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy">` : ""}<button class="row-play" data-action="play" data-track-key="${key}">${icon(playing ? "pause" : "play")}</button></div><div class="row-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span>${track.playable_locally ? `<small class="download-badge">${icon("check")} Disponível offline</small>` : ""}</div><span class="row-channel">${track.playable_locally ? "Arquivo local" : track.id ? "Importação pendente" : "YouTube"}</span><span class="duration-label">${fmt(track.duration_seconds)}</span><div class="row-actions">${!track.playable_locally ? `<button class="icon-btn" data-action="download" data-track-key="${key}" title="Baixar para a biblioteca">${icon("plus")}</button>` : `<button class="icon-btn favorite-btn ${track.favorite ? "active" : ""}" data-action="favorite" data-id="${track.id}" title="Favoritar">${icon("heart")}</button>`}<button class="icon-btn" data-action="more" data-track-key="${key}" data-playlist-id="${playlistId || ""}">${icon("more")}</button></div></div>`;
}

function emptyHtml(title, message, action, view) {
  return `<div class="empty-state"><div class="empty-icon">${icon("library")}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><button class="primary-btn" data-view="${view}">${escapeHtml(action)}</button></div>`;
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
  if (!track.id || !track.playable_locally) return downloadModal(track);
  if (sameTrack(track, state.current)) return togglePlay();
  state.current = track;
  if (queue?.length) state.queue = queue.map(normalized);
  else if (!state.queue.some(t => sameTrack(t, track))) state.queue = [track, ...state.queue];
  state.currentIndex = state.queue.findIndex(t => sameTrack(t, track));
  if (state.shuffle) buildShuffleOrder();
  updatePlayerMeta();
  prepareLocalAudio(track, true);
  if (track.id) recordHistory(track);
  persistState(); renderQueue();
}

function prepareLocalAudio(track, autoplay = true) {
  const audio = state.audio || $("#localAudio");
  state.audio = audio;
  const wanted = `${location.origin}/api/media/music/${track.id}`;
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

function togglePlay() {
  if (!state.current) return playTrack(state.library[0] || starterTracks[0], state.library.length ? state.library : starterTracks);
  if (!state.current.playable_locally) return downloadModal(state.current);
  const audio = state.audio || $("#localAudio");
  state.audio = audio;
  if (!audio.src) prepareLocalAudio(state.current, false);
  state.playing ? audio.pause() : audio.play().catch(() => toast("Não foi possível abrir o arquivo local.", "error"));
}

function updateTimeline() {
  const audio = state.audio || $("#localAudio");
  const current = audio.currentTime || 0;
  const duration = audio.duration || state.current?.duration_seconds || 0;
  $("#currentTime").textContent = fmt(current); $("#duration").textContent = fmt(duration);
  const percent = duration ? current / duration * 100 : 0;
  $("#seekBar").value = percent; setRangeFill($("#seekBar"), percent);
}

function updatePlayerMeta() {
  const track = state.current; if (!track) return;
  $("#playerTitle").textContent = track.title; $("#playerArtist").textContent = track.artist;
  $("#duration").textContent = fmt(track.duration_seconds);
  $("#playerCover").classList.remove("placeholder");
  $("#playerCover").innerHTML = track.thumbnail ? `<img src="${escapeHtml(track.thumbnail)}" alt="Capa de ${escapeHtml(track.title)}">` : icon("library");
  $("#favoriteCurrent").classList.toggle("active", Boolean(track.favorite));
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
  if (state.repeat === "one") { state.audio.currentTime = 0; return state.audio.play(); }
  moveTrack(1);
}

function stopPlayback() { state.playing = false; state.audio?.pause(); if (state.audio) state.audio.currentTime = 0; refreshPlayingUI(); }

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
  try { await api("/api/player/state", { method: "PUT", body: JSON.stringify({ music_id: state.current?.id || null, position: state.audio?.currentTime || 0, volume: state.volume, shuffle: state.shuffle, repeat_mode: state.repeat }) }); } catch (_) {}
}

async function recordHistory(track) {
  try {
    await api("/api/library/history", { method: "POST", body: JSON.stringify({ music_id: track.id }) });
    state.history = [track, ...state.history.filter(item => item.id !== track.id)].slice(0, 30);
    renderHistory();
  } catch (_) {}
}

function downloadModal(raw) {
  const track = normalized(raw);
  if (!track.youtube_video_id) return toast("Esta faixa não possui uma fonte de importação.", "error");
  const key = track.id ? `lib:${track.id}` : `yt:${track.youtube_video_id}`;
  modal(`<form class="modal" id="downloadForm" data-track-key="${key}"><div class="modal-head"><div><span class="eyebrow">IMPORTAR ÁUDIO</span><h2>Baixar para ouvir</h2></div><button type="button" class="icon-btn" data-close="modal">${icon("close")}</button></div><div style="display:flex;gap:12px;align-items:center;margin-bottom:18px"><img src="${escapeHtml(track.thumbnail || "")}" alt="" style="width:62px;height:62px;object-fit:cover;border-radius:9px"><div style="min-width:0"><strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(track.title)}</strong><span style="color:var(--muted);font-size:12px">${escapeHtml(track.artist)}</span></div></div><label class="rights-box"><input type="checkbox" name="rights" required><span>Confirmo que este conteúdo é meu, licenciado, está em domínio público ou que possuo autorização expressa para baixá-lo. A importação não deve violar direitos autorais nem os termos da fonte.</span></label><div id="downloadProgress"></div><div class="modal-actions"><button type="button" class="soft-btn" data-close="modal">Cancelar</button><button class="primary-btn" id="downloadSubmit">Confirmar e baixar</button></div></form>`);
}

async function startDownload(form) {
  const track = findTrack(form.dataset.trackKey);
  if (!track || !form.elements.rights.checked) return;
  const submit = $("#downloadSubmit");
  submit.disabled = true; submit.textContent = "Preparando...";
  $("#downloadProgress").innerHTML = `<div class="download-progress"><div class="download-progress-track"><div class="download-progress-bar" id="downloadBar"></div></div><div class="download-progress-meta"><span id="downloadMessage">Criando importação...</span><strong id="downloadPercent">0%</strong></div></div>`;
  try {
    const job = await api("/api/downloads", { method: "POST", body: JSON.stringify({ rights_confirmed: true, track: { title: track.title, artist: track.artist, youtube_video_id: track.youtube_video_id, thumbnail: track.thumbnail || null, duration_seconds: track.duration_seconds || null } }) });
    state.activeDownload = job.id;
    await followDownload(job, track);
  } catch (error) {
    submit.disabled = false; submit.textContent = "Tentar novamente";
    $("#downloadMessage").textContent = error.message; $("#downloadPercent").textContent = "Falhou";
    toast(error.message, "error");
  }
}

async function followDownload(initialJob, originalTrack) {
  let job = initialJob;
  while (job.status !== "complete" && job.status !== "failed") {
    updateDownloadProgress(job);
    await new Promise(resolve => setTimeout(resolve, 700));
    job = await api(`/api/downloads/${job.id}`);
  }
  updateDownloadProgress(job);
  if (job.status === "failed") throw new Error(job.message || "Não foi possível importar este conteúdo.");
  state.library = (await api("/api/library")).map(normalized);
  await reloadPlaylists();
  const saved = state.library.find(item => item.id === job.music_id || item.youtube_video_id === originalTrack.youtube_video_id);
  renderAll();
  toast("Download concluído. Reproduzindo arquivo local.");
  setTimeout(() => { closeModal(); if (saved) { state.current = null; playTrack(saved, state.library); } }, 350);
}

function updateDownloadProgress(job) {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const bar = $("#downloadBar"), message = $("#downloadMessage"), percent = $("#downloadPercent");
  if (bar) bar.style.width = `${progress}%`;
  if (message) message.textContent = job.message || "Baixando...";
  if (percent) percent.textContent = `${progress}%`;
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

function modal(content) {
  $("#modalLayer").innerHTML = content; $("#modalLayer").classList.add("open"); $("#modalLayer").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#modalLayer input")?.focus(), 50);
}
function closeModal() { $("#modalLayer").classList.remove("open"); $("#modalLayer").setAttribute("aria-hidden", "true"); }

function playlistModal() {
  modal(`<form class="modal" id="playlistForm"><div class="modal-head"><h2>Nova playlist</h2><button type="button" class="icon-btn" data-close="modal">${icon("close")}</button></div><label class="field"><span>Nome</span><input name="name" maxlength="100" required placeholder="Minha playlist"></label><label class="field"><span>Descrição <small>(opcional)</small></span><textarea name="description" maxlength="500" rows="3" placeholder="Qual é a vibe desta playlist?"></textarea></label>${state.folders.length ? `<label class="field"><span>Pasta</span><select name="folder_id"><option value="">Nenhuma</option>${state.folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select></label>` : ""}<div class="modal-actions"><button type="button" class="soft-btn" data-close="modal">Cancelar</button><button class="primary-btn">Criar playlist</button></div></form>`);
}

function folderModal() {
  modal(`<form class="modal" id="folderForm"><div class="modal-head"><h2>Nova pasta</h2><button type="button" class="icon-btn" data-close="modal">${icon("close")}</button></div><label class="field"><span>Nome</span><input name="name" maxlength="100" required placeholder="Ex.: Para trabalhar"></label><div class="modal-actions"><button type="button" class="soft-btn" data-close="modal">Cancelar</button><button class="primary-btn">Criar pasta</button></div></form>`);
}

function addToPlaylistModal(track) {
  modal(`<div class="modal"><div class="modal-head"><h2>Adicionar à playlist</h2><button class="icon-btn" data-close="modal">${icon("close")}</button></div><div class="playlist-options">${state.playlists.length ? state.playlists.map(p => `<button class="playlist-option" data-add-to-playlist="${p.id}" data-track-id="${track.id}"><strong>${escapeHtml(p.name)}</strong><br><small>${p.track_count} faixas</small></button>`).join("") : `<p style="color:var(--muted)">Crie uma playlist primeiro.</p>`}</div><button class="soft-btn" id="createFromAdd" style="margin-top:12px">${icon("plus")} Nova playlist</button></div>`);
}

async function createPlaylist(form) {
  const data = Object.fromEntries(new FormData(form)); if (!data.folder_id) delete data.folder_id; else data.folder_id = Number(data.folder_id);
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
  $("#playlistDetail").innerHTML = `<div class="playlist-banner"><div class="playlist-cover">${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="">` : icon("library")}</div><div class="playlist-info"><span class="eyebrow">PLAYLIST</span><h1>${escapeHtml(p.name)}</h1><p>${escapeHtml(p.description || "Sua seleção, do seu jeito.")}</p><small>${p.track_count} faixas · ${fmt(p.duration_seconds)}</small></div></div><div data-current-playlist="${p.id}"><div class="playlist-controls"><button class="large-play" data-action="play-playlist" data-playlist="${p.id}">${icon("play")}</button><button class="icon-btn" data-action="delete-playlist" data-playlist="${p.id}" title="Excluir playlist">${icon("more")}</button></div>${p.tracks.length ? trackTable(p.tracks, p.id) : emptyHtml("Esta playlist pede música", "Adicione faixas da sua biblioteca para começar.", "Abrir biblioteca", "library")}</div>`;
}

function playPlaylist(id) {
  const playlist = state.playlists.find(p => p.id === id);
  if (!playlist?.tracks.length) return toast("Esta playlist ainda está vazia.", "error");
  state.queue = [...playlist.tracks]; state.current = null; playTrack(state.queue[0], state.queue);
}

function renderQueue() {
  $("#queueList").innerHTML = state.queue.length ? state.queue.map((t, index) => `<button class="queue-item ${index === state.currentIndex ? "active" : ""}" data-queue-index="${index}" style="border:0;width:100%;background:${index === state.currentIndex ? "rgba(184,255,87,.08)" : "none"};text-align:left"><img src="${escapeHtml(t.thumbnail || "")}" alt=""><div><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.artist)}</span></div></button>`).join("") : `<p style="color:var(--muted)">A fila está vazia.</p>`;
}

function openContext(button, track, playlistId) {
  const menu = $("#contextMenu");
  menu.innerHTML = track.playable_locally
    ? `<button data-context="queue">Adicionar à fila</button><button data-context="playlist">Adicionar à playlist</button><button data-context="favorite">${track.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}</button>${playlistId ? `<button class="danger" data-context="remove-playlist">Remover da playlist</button>` : ""}<button class="danger" data-context="remove-library">Remover da biblioteca</button>`
    : `<button data-context="download">Baixar para ouvir</button>`;
  menu._track = track; menu._playlistId = Number(playlistId) || null;
  const rect = button.getBoundingClientRect(); menu.style.left = `${Math.min(rect.left - 170, innerWidth - 225)}px`; menu.style.top = `${Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 10)}px`; menu.classList.add("open");
}

async function contextAction(action) {
  const menu = $("#contextMenu"), track = menu._track, playlistId = menu._playlistId; menu.classList.remove("open");
  if (action === "queue") { state.queue.push(track); renderQueue(); return toast("Adicionada à fila"); }
  if (action === "download") return downloadModal(track);
  if (action === "favorite") return toggleFavorite(track.id);
  if (action === "playlist") return addToPlaylistModal(track);
  if (action === "remove-library") {
    try { await api(`/api/library/${track.id}`, { method: "DELETE" }); state.library = state.library.filter(t => t.id !== track.id); state.queue = state.queue.filter(t => t.id !== track.id); await reloadPlaylists(); renderAll(); toast("Removida da biblioteca"); } catch (e) { toast(e.message, "error"); }
  }
  if (action === "remove-playlist") {
    try { const updated = await api(`/api/playlists/${playlistId}/tracks/${track.id}`, { method: "DELETE" }); state.playlists[state.playlists.findIndex(p => p.id === playlistId)] = { ...updated, tracks: updated.tracks.map(normalized) }; renderPlaylistDetail(playlistId); renderSidebar(); toast("Removida da playlist"); } catch (e) { toast(e.message, "error"); }
  }
}

async function reloadPlaylists() { const data = await api("/api/playlists"); state.playlists = data.map(p => ({ ...p, tracks: p.tracks.map(normalized) })); }

function expandedPlayer() {
  if (!state.current) return toast("Escolha uma música primeiro.", "error");
  const t = state.current;
  modal(`<div class="expanded"><div class="expanded-bg" style="background-image:url('${escapeHtml(t.thumbnail)}')"></div><button class="icon-btn expanded-close" data-close="modal">${icon("close")}</button><div class="expanded-content"><img class="expanded-cover" src="${escapeHtml(t.thumbnail)}" alt="Capa de ${escapeHtml(t.title)}"><h2>${escapeHtml(t.title)}</h2><p>${escapeHtml(t.artist)}</p><div class="expanded-controls"><button class="icon-btn" data-expanded="shuffle">${icon("shuffle")}</button><button class="icon-btn" data-expanded="prev">${icon("prev")}</button><button class="main-play" data-expanded="play">${icon(state.playing ? "pause" : "play")}</button><button class="icon-btn" data-expanded="next">${icon("next")}</button><button class="icon-btn" data-expanded="repeat">${icon("repeat")}</button></div><div class="expanded-progress timeline"><span>${$("#currentTime").textContent}</span><input type="range" value="${$("#seekBar").value}"><span>${$("#duration").textContent}</span></div></div></div>`);
}

document.addEventListener("click", async event => {
  const viewButton = event.target.closest("[data-view]"); if (viewButton) navigate(viewButton.dataset.view);
  const playlistButton = event.target.closest("[data-playlist]");
  if (playlistButton && !playlistButton.matches('[data-action="play-playlist"]')) navigate("playlist", { id: playlistButton.dataset.playlist });
  const action = event.target.closest("[data-action]");
  if (action) {
    const track = findTrack(action.dataset.trackKey);
    if (action.dataset.action === "play" && track) playTrack(track, track.id ? state.library : state.search.length ? state.search : starterTracks);
    if (action.dataset.action === "download" && track) downloadModal(track);
    if (action.dataset.action === "favorite") toggleFavorite(Number(action.dataset.id));
    if (action.dataset.action === "more" && track) openContext(action, track, action.dataset.playlistId);
    if (action.dataset.action === "play-playlist") playPlaylist(Number(action.dataset.playlist));
    if (action.dataset.action === "delete-playlist") {
      const id = Number(action.dataset.playlist); if (confirm("Excluir esta playlist? As músicas continuarão na biblioteca.")) { await api(`/api/playlists/${id}`, { method: "DELETE" }); state.playlists = state.playlists.filter(p => p.id !== id); renderAll(); navigate("library"); toast("Playlist excluída"); }
    }
  }
  if (event.target.closest("#newPlaylistBtn,#newPlaylistSide")) playlistModal();
  if (event.target.closest("#newFolderBtn")) folderModal();
  if (event.target.closest("[data-close='modal']") || (event.target.id === "modalLayer")) closeModal();
  if (event.target.closest("[data-close='queue']")) $("#queuePanel").classList.remove("open");
  if (event.target.closest("#topSearch")) navigate("search");
  const hint = event.target.closest("[data-query]"); if (hint) { $("#searchInput").value = hint.dataset.query; $("#searchForm").requestSubmit(); }
  const addOption = event.target.closest("[data-add-to-playlist]"); if (addOption) addToPlaylist(Number(addOption.dataset.addToPlaylist), Number(addOption.dataset.trackId));
  if (event.target.closest("#createFromAdd")) playlistModal();
  const context = event.target.closest("[data-context]"); if (context) contextAction(context.dataset.context);
  else if (!event.target.closest("#contextMenu") && !event.target.closest('[data-action="more"]')) $("#contextMenu").classList.remove("open");
  const queueItem = event.target.closest("[data-queue-index]"); if (queueItem) { const i = Number(queueItem.dataset.queueIndex); state.current = null; playTrack(state.queue[i], state.queue); }
  const expanded = event.target.closest("[data-expanded]"); if (expanded) ({ play: togglePlay, prev: () => moveTrack(-1), next: () => moveTrack(1), shuffle: toggleShuffle, repeat: cycleRepeat }[expanded.dataset.expanded])();
});

document.addEventListener("submit", event => {
  if (event.target.id === "searchForm") search(event);
  if (event.target.id === "downloadForm") { event.preventDefault(); startDownload(event.target); }
  if (event.target.id === "playlistForm") { event.preventDefault(); createPlaylist(event.target); }
  if (event.target.id === "folderForm") { event.preventDefault(); createFolder(event.target); }
});

$("#playBtn").addEventListener("click", togglePlay); $("#prevBtn").addEventListener("click", () => moveTrack(-1)); $("#nextBtn").addEventListener("click", () => moveTrack(1));
$("#shuffleBtn").addEventListener("click", toggleShuffle); $("#repeatBtn").addEventListener("click", cycleRepeat);
$("#queueBtn").addEventListener("click", () => $("#queuePanel").classList.toggle("open"));
$("#expandBtn").addEventListener("click", expandedPlayer); $("#expandCover").addEventListener("click", expandedPlayer);
$("#favoriteCurrent").addEventListener("click", () => state.current?.id ? toggleFavorite(state.current.id) : toast("Adicione esta música à biblioteca primeiro.", "error"));
$("#clearQueue").addEventListener("click", () => { state.queue = state.current ? [state.current] : []; state.currentIndex = state.current ? 0 : -1; renderQueue(); });
$("#seekBar").addEventListener("input", event => { const duration = state.audio?.duration || 0; if (state.audio) state.audio.currentTime = duration * event.target.value / 100; setRangeFill(event.target, event.target.value); });
$("#volumeBar").addEventListener("input", event => { state.volume = Number(event.target.value); if (state.audio) state.audio.volume = state.volume; setRangeFill(event.target, state.volume * 100); persistState(); });
$("#muteBtn").addEventListener("click", () => { if (state.volume) { state.mutedVolume = state.volume; state.volume = 0; } else state.volume = state.mutedVolume || .75; $("#volumeBar").value = state.volume; setRangeFill($("#volumeBar"), state.volume * 100); if (state.audio) state.audio.volume = state.volume; });
$("#libraryFilter").addEventListener("input", renderLibrary);
$$('.filter-chip').forEach(button => button.addEventListener("click", () => { $$('.filter-chip').forEach(b => b.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; renderLibrary(); }));

document.addEventListener("keydown", event => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { if (event.key === "Escape") document.activeElement.blur(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); navigate("search"); }
  if (event.code === "Space") { event.preventDefault(); togglePlay(); }
  if (event.key === "ArrowRight" && state.audio) state.audio.currentTime = Math.min(state.audio.duration || Infinity, state.audio.currentTime + 10);
  if (event.key === "ArrowLeft" && state.audio) state.audio.currentTime = Math.max(0, state.audio.currentTime - 10);
  if (event.key === "Escape") { closeModal(); $("#queuePanel").classList.remove("open"); }
});

let draggedRow = null;
document.addEventListener("dragstart", event => { draggedRow = event.target.closest(".track-row[draggable='true']"); });
document.addEventListener("dragover", event => { const row = event.target.closest(".track-row[draggable='true']"); if (row && draggedRow && row !== draggedRow) { event.preventDefault(); const box = row.getBoundingClientRect(); row.parentNode.insertBefore(draggedRow, event.clientY < box.top + box.height / 2 ? row : row.nextSibling); } });
document.addEventListener("dragend", async () => {
  if (!draggedRow) return; const parent = draggedRow.parentNode; const playlistId = Number(draggedRow.dataset.playlistId); const ids = $$(".track-row", parent).map(row => Number(row.dataset.musicId)); draggedRow = null;
  try { const updated = await api(`/api/playlists/${playlistId}/reorder`, { method: "PUT", body: JSON.stringify(ids) }); state.playlists[state.playlists.findIndex(p => p.id === playlistId)] = { ...updated, tracks: updated.tracks.map(normalized) }; } catch (e) { toast(e.message, "error"); renderPlaylistDetail(playlistId); }
});

state.audio = $("#localAudio");
state.audio.addEventListener("play", () => { state.playing = true; refreshPlayingUI(); });
state.audio.addEventListener("pause", () => { state.playing = false; refreshPlayingUI(); });
state.audio.addEventListener("timeupdate", updateTimeline);
state.audio.addEventListener("durationchange", updateTimeline);
state.audio.addEventListener("ended", handleEnded);
state.audio.addEventListener("error", () => { if (state.current) toast("O arquivo local não pôde ser reproduzido.", "error"); });
window.addEventListener("beforeunload", persistState);
bootstrap();
