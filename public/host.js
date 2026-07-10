import {
  api,
  connectSocket,
  escapeHtml,
  formatDuration,
  getPhase,
  renderLobbyGames,
  renderMembers,
} from "/assets/common.js";
import { hashSeed, normalizeWord, resolveVirtualLayout, VIRTUAL_CANVAS, MIN_FONT_SIZE } from "/assets/board-layout.js";
import { renderFoundChart, renderLeaderboards, verdictText } from "/assets/stats-render.js";

const stage = document.querySelector("[data-page='lobby-host']");
const lobbyId = Number(stage.dataset.lobbyId);

const phasePill = document.getElementById("phasePill");
const seedInput = document.getElementById("seedInput");
const randomSeedButton = document.getElementById("randomSeedButton");
const startGameButton = document.getElementById("startGameButton");
const closeLobbyButton = document.getElementById("closeLobbyButton");
const viewWaiting = document.getElementById("viewWaiting");
const viewBoard = document.getElementById("viewBoard");
const viewStats = document.getElementById("viewStats");
const memberList = document.getElementById("memberList");
const playerCountBadge = document.getElementById("playerCountBadge");
const lobbyGamesList = document.getElementById("lobbyGamesList");
const lobbyGamesBadge = document.getElementById("lobbyGamesBadge");
const board = document.getElementById("wordBoard");
const boardFooter = document.getElementById("boardFooter");
const versusScores = document.getElementById("versusScores");
const scoreHorde = document.getElementById("scoreHorde");
const scoreAlliance = document.getElementById("scoreAlliance");
const tvTimer = document.getElementById("tvTimer");
const tvFound = document.getElementById("tvFound");
const tvMistakes = document.getElementById("tvMistakes");
const statsVerdict = document.getElementById("statsVerdict");
const statsByFound = document.getElementById("statsByFound");
const statsByFails = document.getElementById("statsByFails");
const foundChart = document.getElementById("foundChart");
const chartLegend = document.getElementById("chartLegend");
const settingsForm = document.getElementById("settingsForm");
const settingsMessage = document.getElementById("settingsMessage");
const mistakePolicy = document.getElementById("setMistakePolicy");
const mistakeLimitField = document.getElementById("mistakeLimitField");
const mistakeLimitInput = document.getElementById("setMistakeLimit");

let state = null;
let cachedLayout = null;
let layoutRaf = null;
let renderedChartFor = null;
let appliedSettingsJson = null;

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}
seedInput.value = String(randomSeed());
randomSeedButton.addEventListener("click", () => {
  seedInput.value = String(randomSeed());
});

startGameButton.addEventListener("click", async () => {
  startGameButton.disabled = true;
  try {
    const seed = Number.parseInt(seedInput.value, 10);
    await api(`/api/lobby/${lobbyId}/start`, Number.isFinite(seed) && seed > 0 ? { seed } : {});
  } finally {
    startGameButton.disabled = false;
  }
});

closeLobbyButton.addEventListener("click", async () => {
  if (!window.confirm("Fermer le salon pour tout le monde ?")) {
    return;
  }
  await api(`/api/lobby/${lobbyId}/leave`);
  window.location.href = "/";
});

// ---------------------------------------------------------------------------
// Settings form (editable between games only)
// ---------------------------------------------------------------------------

function syncMistakeControls() {
  mistakeLimitField.hidden = mistakePolicy.value !== "limited";
}
mistakePolicy.addEventListener("change", syncMistakeControls);

function fillSettingsForm(settings) {
  document.getElementById("setWordCount").value = settings.wordCount;
  document.getElementById("setRevealSeconds").value = settings.revealSeconds;
  document.getElementById("setWriteSeconds").value = settings.writeSeconds;
  document.getElementById("setMode").value = settings.mode;
  document.getElementById("setMistakeMode").value = settings.mistakeMode;
  mistakePolicy.value = settings.mistakeLimit === null ? "endless" : settings.mistakeLimit === 0 ? "disabled" : "limited";
  if (Number.isInteger(settings.mistakeLimit) && settings.mistakeLimit > 0) {
    mistakeLimitInput.value = settings.mistakeLimit;
  }
  syncMistakeControls();
}

// Repopulate only when the server settings actually changed and the host
// isn't in the middle of editing a field.
function maybeFillSettingsForm(settings) {
  const json = JSON.stringify(settings);
  if (json === appliedSettingsJson || settingsForm.contains(document.activeElement)) {
    return;
  }
  appliedSettingsJson = json;
  fillSettingsForm(settings);
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mistakeLimit =
    mistakePolicy.value === "endless" ? null :
    mistakePolicy.value === "disabled" ? 0 :
    Number.parseInt(mistakeLimitInput.value, 10);
  const result = await api(`/api/lobby/${lobbyId}/settings`, {
    settings: {
      wordCount: Number.parseInt(document.getElementById("setWordCount").value, 10),
      revealSeconds: Number.parseInt(document.getElementById("setRevealSeconds").value, 10),
      writeSeconds: Number.parseInt(document.getElementById("setWriteSeconds").value, 10),
      mode: document.getElementById("setMode").value,
      mistakeMode: document.getElementById("setMistakeMode").value,
      mistakeLimit,
    },
  });
  if (!result.ok) {
    settingsMessage.textContent = result.error || "Enregistrement impossible.";
    settingsMessage.className = "message error";
    return;
  }
  appliedSettingsJson = JSON.stringify(result.settings);
  fillSettingsForm(result.settings);
  settingsMessage.textContent = "Règles enregistrées.";
  settingsMessage.className = "message ok";
});

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function renderBoardWords(words) {
  board.innerHTML = words
    .map((word) => `<span class="floating-word" data-normalized="${escapeHtml(normalizeWord(word))}">${escapeHtml(word)}</span>`)
    .join("");
}

function layoutBoard() {
  const words = [...board.querySelectorAll(".floating-word")];
  if (!words.length || !state?.game) {
    return;
  }
  const rect = board.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(320, rect.height);
  const labels = words.map((el) => el.textContent || "");
  const cacheKey = hashSeed(state.game.seed, labels.join("|"));
  if (!cachedLayout || cachedLayout.key !== cacheKey) {
    cachedLayout = { key: cacheKey, ...resolveVirtualLayout(state.game.seed, labels) };
  }
  const scale = Math.min(width / VIRTUAL_CANVAS.width, height / VIRTUAL_CANVAS.height);
  board.style.setProperty("--word-font-size", `${Math.max(MIN_FONT_SIZE, cachedLayout.fontSize * scale)}px`);
  words.forEach((el, index) => {
    const { leftFrac, topFrac } = cachedLayout.positions[index];
    el.style.position = "absolute";
    el.style.left = `${leftFrac * width}px`;
    el.style.top = `${topFrac * height}px`;
  });
}

function scheduleLayout() {
  if (layoutRaf) {
    cancelAnimationFrame(layoutRaf);
  }
  layoutRaf = requestAnimationFrame(layoutBoard);
}
window.addEventListener("resize", scheduleLayout, { passive: true });

function applyFoundWords(game) {
  const versus = game.settings.mode === "versus";
  for (const el of board.querySelectorAll(".floating-word")) {
    const hit = game.correctWords[el.dataset.normalized];
    el.classList.toggle("found", Boolean(hit));
    el.classList.toggle("found-horde", versus && hit?.coalition === "HORDE");
    el.classList.toggle("found-alliance", versus && hit?.coalition === "ALLIANCE");
  }
}

// ---------------------------------------------------------------------------
// Stats view (rendered once per finished game)
// ---------------------------------------------------------------------------

function renderStats(game) {
  // Wait for the server-confirmed finish: the timeline only ships then.
  if (!game.timeline || renderedChartFor === game.id) {
    return;
  }
  renderedChartFor = game.id;
  renderLeaderboards({ byFoundEl: statsByFound, byFailsEl: statsByFails, players: game.players ?? [] });
  renderFoundChart({ container: foundChart, legend: chartLegend, game });
  statsVerdict.textContent = verdictText(game);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function showView(view) {
  viewWaiting.hidden = view !== "waiting";
  viewBoard.hidden = view !== "board";
  viewStats.hidden = view !== "stats";
}

function applyState(newState) {
  state = newState;
  const { lobby, game } = state;
  document.getElementById("lobbyTitle").textContent = lobby.name;
  playerCountBadge.textContent = String(lobby.members.length);
  renderMembers(memberList, lobby.members, lobby.settings);
  renderLobbyGames(lobbyGamesList, lobby.games);
  lobbyGamesBadge.textContent = `${lobby.games.length} partie${lobby.games.length > 1 ? "s" : ""}`;
  maybeFillSettingsForm(lobby.settings);

  const phase = getPhase(game);
  const versus = game?.settings.mode === "versus";
  const gameRunning = Boolean(game) && !phase.finished;
  for (const field of settingsForm.querySelectorAll("input, select, button")) {
    field.disabled = gameRunning;
  }

  if (!game) {
    showView("waiting");
    startGameButton.textContent = "Lancer une partie";
  } else if (phase.finished) {
    showView("stats");
    startGameButton.textContent = "Relancer une partie";
    renderStats(game);
  } else {
    showView("board");
    startGameButton.textContent = "Relancer une partie";
    if (board.dataset.gameId !== String(game.id)) {
      board.dataset.gameId = String(game.id);
      renderBoardWords(game.words ?? []);
      scheduleLayout();
    }
    applyFoundWords(game);
    versusScores.hidden = !versus;
    if (versus) {
      scoreHorde.textContent = String(game.coalitionScores.HORDE);
      scoreAlliance.textContent = String(game.coalitionScores.ALLIANCE);
    }
  }
  updateClock();
}

function updateClock() {
  const game = state?.game;
  const phase = getPhase(game);
  phasePill.textContent = phase.label;
  if (!game) {
    return;
  }
  tvTimer.textContent = formatDuration(phase.remainingMs);
  tvFound.textContent = `${game.foundCount} / ${game.wordCount}`;
  const limit = game.settings.mistakeLimit;
  if (game.settings.mistakeMode === "global" && Number.isInteger(limit) && limit > 0) {
    tvMistakes.textContent = `${game.globalMistakes} / ${limit}`;
  } else {
    tvMistakes.textContent = String(game.globalMistakes);
  }
  board.classList.toggle("blurred", phase.key === "play");
  board.classList.toggle("finished", phase.finished);
  boardFooter.textContent =
    phase.key === "reveal" ? "MÉMORISEZ LES MOTS" :
    phase.key === "play" ? "PHASE DE JEU - À VOUS DE JOUER" : "PARTIE TERMINÉE";

  // The server's ticker also broadcasts the finish, but flip the local view
  // immediately when the clock hits zero.
  if (phase.finished && !viewBoard.hidden) {
    showView("stats");
    renderStats(game);
  }
}

setInterval(updateClock, 500);

connectSocket({
  lobbyId,
  onMessage: (payload) => {
    if (payload.type === "closed") {
      window.location.href = "/";
      return;
    }
    if (payload.type === "state" && payload.state) {
      applyState(payload.state);
    }
  },
});
