import {
  api,
  coalitionEmblem,
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
const dismissGameButton = document.getElementById("dismissGameButton");
const closeLobbyButton = document.getElementById("closeLobbyButton");
const viewWaiting = document.getElementById("viewWaiting");
const viewBoard = document.getElementById("viewBoard");
const viewBomb = document.getElementById("viewBomb");
const viewStats = document.getElementById("viewStats");
const bombCircle = document.getElementById("bombCircle");
const bombArrow = document.getElementById("bombArrow");
const bombFound = document.getElementById("bombFound");
const bombAliveCount = document.getElementById("bombAliveCount");
const bombResult = document.getElementById("bombResult");
const bombCore = document.getElementById("bombCore");
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
const allowedCoalitions = document.getElementById("setAllowedCoalitions");
const difficultySelect = document.getElementById("setDifficulty");
const modeSelect = document.getElementById("setMode");
const writeSecondsField = document.getElementById("writeSecondsField");
const mistakeModeField = document.getElementById("mistakeModeField");
const mistakePolicyField = document.getElementById("mistakePolicyField");
const bombMinSecondsField = document.getElementById("bombMinSecondsField");
const bombMaxSecondsField = document.getElementById("bombMaxSecondsField");
const bombMinSecondsInput = document.getElementById("setBombMinSeconds");
const bombMaxSecondsInput = document.getElementById("setBombMaxSeconds");

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
  const game = state?.game;
  const gameRunning = Boolean(game) && !getPhase(game).finished;
  if (gameRunning) {
    if (!window.confirm("Arrêter la partie en cours ? Vous pourrez modifier les règles puis relancer.")) {
      return;
    }
    startGameButton.disabled = true;
    try {
      await api(`/api/lobby/${lobbyId}/stop`);
    } finally {
      startGameButton.disabled = false;
    }
    return;
  }
  startGameButton.disabled = true;
  try {
    const seed = Number.parseInt(seedInput.value, 10);
    await api(`/api/lobby/${lobbyId}/start`, Number.isFinite(seed) && seed > 0 ? { seed } : {});
  } finally {
    startGameButton.disabled = false;
  }
});

dismissGameButton.addEventListener("click", async () => {
  dismissGameButton.disabled = true;
  try {
    await api(`/api/lobby/${lobbyId}/dismiss`);
  } finally {
    dismissGameButton.disabled = false;
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

// Bomb mode has its own configurable fuse range and no write-phase deadline
// or mistake budget, so those fields swap for these instead.
function syncSettingsVisibility() {
  const isBomb = modeSelect.value === "bomb";
  writeSecondsField.hidden = isBomb;
  mistakeModeField.hidden = isBomb;
  mistakePolicyField.hidden = isBomb;
  mistakeLimitField.hidden = isBomb || mistakePolicy.value !== "limited";
  bombMinSecondsField.hidden = !isBomb;
  bombMaxSecondsField.hidden = !isBomb;
}
mistakePolicy.addEventListener("change", syncSettingsVisibility);
modeSelect.addEventListener("change", syncSettingsVisibility);

function fillSettingsForm(settings) {
  document.getElementById("setWordCount").value = settings.wordCount;
  document.getElementById("setRevealSeconds").value = settings.revealSeconds;
  document.getElementById("setWriteSeconds").value = settings.writeSeconds;
  modeSelect.value = settings.mode;
  document.getElementById("setMistakeMode").value = settings.mistakeMode;
  allowedCoalitions.value = settings.allowedCoalitions;
  difficultySelect.value = settings.difficulty;
  bombMinSecondsInput.value = settings.bombMinSeconds;
  bombMaxSecondsInput.value = settings.bombMaxSeconds;
  mistakePolicy.value = settings.mistakeLimit === null ? "endless" : settings.mistakeLimit === 0 ? "disabled" : "limited";
  if (Number.isInteger(settings.mistakeLimit) && settings.mistakeLimit > 0) {
    mistakeLimitInput.value = settings.mistakeLimit;
  }
  syncSettingsVisibility();
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
  const settings = {
    wordCount: Number.parseInt(document.getElementById("setWordCount").value, 10),
    revealSeconds: Number.parseInt(document.getElementById("setRevealSeconds").value, 10),
    writeSeconds: Number.parseInt(document.getElementById("setWriteSeconds").value, 10),
    mode: modeSelect.value,
    mistakeMode: document.getElementById("setMistakeMode").value,
    mistakeLimit,
    allowedCoalitions: allowedCoalitions.value,
    difficulty: difficultySelect.value,
    bombMinSeconds: Number.parseInt(bombMinSecondsInput.value, 10),
    bombMaxSeconds: Number.parseInt(bombMaxSecondsInput.value, 10),
  };

  let result = await api(`/api/lobby/${lobbyId}/settings`, { settings });
  if (!result.ok && result.error === "faction_conflict") {
    const warning = `${result.kicked} joueur${result.kicked > 1 ? "s" : ""} ne ${result.kicked > 1 ? "font" : "fait"} plus partie d'une coalition autorisée et ${result.kicked > 1 ? "seront exclus" : "sera exclu"} du salon. Continuer ?`;
    if (!window.confirm(warning)) {
      settingsMessage.textContent = "Enregistrement annulé.";
      settingsMessage.className = "message error";
      return;
    }
    result = await api(`/api/lobby/${lobbyId}/settings`, { settings, confirm: true });
  }
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

// ---------------------------------------------------------------------------
// Hard difficulty: words drift in a random direction and bounce off the
// board edges. Positions live in cachedLayout (fractions of the virtual
// canvas), same as the static layout, so resizing just rescales them.
// ---------------------------------------------------------------------------

const HARD_MODE_MIN_SPEED = 40; // virtual canvas px/sec
const HARD_MODE_MAX_SPEED = 90;
const HARD_MODE_EDGE_MARGIN = 20; // virtual canvas px

let hardModeRaf = null;
let hardModeLastTs = null;
let hardModeVelocities = null;
let hardModeVelocitiesKey = null;

function ensureHardModeVelocities(key, count) {
  if (hardModeVelocitiesKey === key && hardModeVelocities?.length === count) {
    return;
  }
  hardModeVelocitiesKey = key;
  hardModeVelocities = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = HARD_MODE_MIN_SPEED + Math.random() * (HARD_MODE_MAX_SPEED - HARD_MODE_MIN_SPEED);
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  });
}

function stepHardMode(ts) {
  hardModeRaf = null;
  const words = [...board.querySelectorAll(".floating-word")];
  if (!words.length || !cachedLayout || state?.game?.settings.difficulty !== "hard") {
    hardModeLastTs = null;
    return;
  }
  const dt = hardModeLastTs ? Math.min(0.1, (ts - hardModeLastTs) / 1000) : 0;
  hardModeLastTs = ts;
  ensureHardModeVelocities(cachedLayout.key, words.length);

  const rect = board.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(320, rect.height);
  const marginXFrac = HARD_MODE_EDGE_MARGIN / VIRTUAL_CANVAS.width;
  const marginYFrac = HARD_MODE_EDGE_MARGIN / VIRTUAL_CANVAS.height;

  words.forEach((el, index) => {
    const pos = cachedLayout.positions[index];
    const vel = hardModeVelocities[index];
    let left = pos.leftFrac + (vel.vx / VIRTUAL_CANVAS.width) * dt;
    let top = pos.topFrac + (vel.vy / VIRTUAL_CANVAS.height) * dt;
    if (left < marginXFrac) {
      left = marginXFrac;
      vel.vx = Math.abs(vel.vx);
    } else if (left > 1 - marginXFrac) {
      left = 1 - marginXFrac;
      vel.vx = -Math.abs(vel.vx);
    }
    if (top < marginYFrac) {
      top = marginYFrac;
      vel.vy = Math.abs(vel.vy);
    } else if (top > 1 - marginYFrac) {
      top = 1 - marginYFrac;
      vel.vy = -Math.abs(vel.vy);
    }
    pos.leftFrac = left;
    pos.topFrac = top;
    el.style.left = `${left * width}px`;
    el.style.top = `${top * height}px`;
  });

  hardModeRaf = requestAnimationFrame(stepHardMode);
}

function startHardMode() {
  if (hardModeRaf) {
    return;
  }
  hardModeLastTs = null;
  hardModeRaf = requestAnimationFrame(stepHardMode);
}

function stopHardMode() {
  if (hardModeRaf) {
    cancelAnimationFrame(hardModeRaf);
    hardModeRaf = null;
  }
  hardModeLastTs = null;
}

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
// Bomb mode: circle of players, arrow pointing at whoever holds the bomb.
// Positions/rotation are driven by CSS custom properties (--angle-x/-y on
// each avatar, degrees on the arrow) so the layout stays responsive without
// re-measuring pixels here. No fuse time is ever rendered.
// ---------------------------------------------------------------------------

// One ring only fits so many avatars before they overlap. Past that, spill
// onto additional inner rings — outer rings (more circumference) hold more
// players, and past BOMB_COMPACT_THRESHOLD players total we also shrink to
// avatar-only dots since even multiple rings run out of room for labels.
const BOMB_RING_MAX_RADIUS = 0.46;
const BOMB_RING_MIN_RADIUS = 0.3;
const BOMB_RING_GAP = 0.09;
const BOMB_RING_MAX_COUNT = 6;
const BOMB_REFERENCE_DIAMETER = 640; // just a fixed unit for capacity math; radii stay fractional
const BOMB_ITEM_ARC = 66; // px of ring circumference an avatar+label needs
const BOMB_ITEM_ARC_COMPACT = 34; // px needed for an avatar-only dot
const BOMB_COMPACT_THRESHOLD = 40;

function bombRingLayout(count) {
  const compact = count > BOMB_COMPACT_THRESHOLD;
  const itemArc = compact ? BOMB_ITEM_ARC_COMPACT : BOMB_ITEM_ARC;
  const rings = [];
  let radius = BOMB_RING_MAX_RADIUS;
  let remaining = count;
  while (remaining > 0 && rings.length < BOMB_RING_MAX_COUNT - 1) {
    const circumference = 2 * Math.PI * radius * (BOMB_REFERENCE_DIAMETER / 2);
    const capacity = Math.max(1, Math.floor(circumference / itemArc));
    const take = Math.min(capacity, remaining);
    rings.push({ radius, count: take });
    remaining -= take;
    radius = Math.max(BOMB_RING_MIN_RADIUS - BOMB_RING_GAP, radius - BOMB_RING_GAP);
  }
  if (remaining > 0) {
    rings.push({ radius: Math.max(0.14, radius - BOMB_RING_GAP), count: remaining });
  }
  return { rings, compact };
}

// Maps every player to a { radius, angle } slot across however many rings
// bombRingLayout() decided on, walking `order` sequentially ring by ring.
function computeBombPlacements(order) {
  const { rings, compact } = bombRingLayout(order.length);
  const placements = new Map();
  let cursor = 0;
  rings.forEach((ring, ringIndex) => {
    const staggerOffset = ringIndex % 2 === 1 ? Math.PI / ring.count : 0;
    for (let i = 0; i < ring.count && cursor < order.length; i += 1, cursor += 1) {
      const angle = (i / ring.count) * Math.PI * 2 - Math.PI / 2 + staggerOffset;
      placements.set(order[cursor], { radius: ring.radius, angle });
    }
  });
  return { placements, compact };
}

function renderBombCircle(game, members) {
  const order = game.bomb.order;
  const aliveSet = new Set(game.bomb.alive);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const { placements, compact } = computeBombPlacements(order);

  for (const el of bombCircle.querySelectorAll(".bomb-player")) {
    el.remove();
  }
  bombCircle.classList.toggle("bomb-circle-compact", compact);

  order.forEach((userId) => {
    const member = memberById.get(userId);
    const placement = placements.get(userId);
    if (!member || !placement) {
      return;
    }
    const alive = aliveSet.has(userId);
    const el = document.createElement("div");
    el.className = "bomb-player" + (alive ? "" : " eliminated") + (game.bomb.holderId === userId ? " holding" : "");
    el.title = member.login;
    el.style.setProperty("--angle-x", String(Math.cos(placement.angle)));
    el.style.setProperty("--angle-y", String(Math.sin(placement.angle)));
    el.style.setProperty("--radius", `${placement.radius * 100}%`);
    el.innerHTML = `
      ${member.imageUrl ? `<img class="avatar" src="${escapeHtml(member.imageUrl)}" alt="" />` : `<span class="avatar avatar-placeholder"></span>`}
      <strong>${escapeHtml(member.login)}</strong>
      ${alive ? "" : `<span class="bomb-rip">RIP</span>`}
    `;
    bombCircle.appendChild(el);
  });

  const holderPlacement = game.bomb.holderId != null ? placements.get(game.bomb.holderId) : null;
  if (holderPlacement) {
    const angleDeg = holderPlacement.angle * (180 / Math.PI) + 90;
    bombArrow.style.setProperty("--arrow-length", `${holderPlacement.radius * 100}%`);
    bombArrow.style.transform = `translate(-50%, -100%) rotate(${angleDeg}deg)`;
    bombArrow.hidden = false;
  } else {
    bombArrow.hidden = true;
  }
}

// The "winner" is whoever ranks first: the sole survivor if there is one,
// a co-survivor if the game ended on all-words-found with several people
// still alive, or (nobody made it) the last player eliminated.
function bombWinner(game, members) {
  const memberById = new Map(members.map((member) => [member.id, member]));
  if (game.bomb.alive.length >= 1) {
    return memberById.get(game.bomb.alive[0]) ?? null;
  }
  const lastOut = [...game.bomb.eliminated].sort((a, b) => b.place - a.place)[0];
  return lastOut ? memberById.get(lastOut.userId) ?? null : null;
}

function renderBombCore(winner) {
  if (!winner) {
    bombCore.classList.remove("bomb-core-winner");
    bombCore.innerHTML = `<span class="bomb-icon">💣</span>`;
    return;
  }
  bombCore.classList.add("bomb-core-winner");
  bombCore.innerHTML = `
    ${winner.imageUrl ? `<img class="avatar bomb-winner-avatar" src="${escapeHtml(winner.imageUrl)}" alt="" />` : `<span class="avatar bomb-winner-avatar avatar-placeholder"></span>`}
    <strong class="bomb-winner-login">${escapeHtml(winner.login)}</strong>
    ${winner.coalition ? `<img class="bomb-winner-emblem" src="${coalitionEmblem(winner.coalition)}" alt="" />` : ""}
  `;
}

function renderBombResult(game, members) {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const eliminatedDesc = [...game.bomb.eliminated].sort((a, b) => b.place - a.place);
  const rows = [
    ...game.bomb.alive.map((id) => ({ id, label: "Survivant" })),
    ...eliminatedDesc.map((entry) => ({ id: entry.userId, label: `Éliminé (place ${entry.place})` })),
  ];
  bombResult.innerHTML = `
    <div class="panel-kicker">Classement</div>
    ${rows
      .map((row, index) => {
        const member = memberById.get(row.id);
        if (!member) {
          return "";
        }
        return `
          <div class="bomb-result-row">
            <span class="bomb-result-rank">#${index + 1}</span>
            ${member.imageUrl ? `<img class="avatar avatar-sm" src="${escapeHtml(member.imageUrl)}" alt="" />` : `<span class="avatar avatar-sm avatar-placeholder"></span>`}
            <strong>${escapeHtml(member.login)}</strong>
            <span>${row.label}</span>
          </div>
        `;
      })
      .join("")}
  `;
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
  viewBomb.hidden = view !== "bomb";
  viewStats.hidden = view !== "stats";
}

function applyState(newState) {
  state = newState;
  const { lobby, game } = state;
  document.getElementById("lobbyTitle").textContent = lobby.name;
  playerCountBadge.textContent = String(lobby.members.length);
  renderMembers(memberList, lobby.members);
  renderLobbyGames(lobbyGamesList, lobby.games);
  lobbyGamesBadge.textContent = `${lobby.games.length} partie${lobby.games.length > 1 ? "s" : ""}`;
  maybeFillSettingsForm(lobby.settings);

  const phase = getPhase(game);
  const isBomb = game?.settings.mode === "bomb";
  const versus = game?.settings.mode === "versus";
  const gameRunning = Boolean(game) && !phase.finished;
  for (const field of settingsForm.querySelectorAll("input, select, button")) {
    field.disabled = gameRunning;
  }
  startGameButton.textContent = !game ? "Lancer une partie" : gameRunning ? "Arrêter la partie" : "Relancer une partie";
  dismissGameButton.hidden = !game || gameRunning;

  if (!game) {
    showView("waiting");
    stopHardMode();
  } else if (isBomb) {
    versusScores.hidden = true;
    bombFound.textContent = `${game.foundCount} / ${game.wordCount}`;
    bombAliveCount.textContent = String(game.bomb.alive.length);
    renderBombCircle(game, lobby.members);
    bombResult.hidden = !phase.finished;
    renderBombCore(phase.finished ? bombWinner(game, lobby.members) : null);
    if (phase.finished) {
      showView("bomb");
      renderBombResult(game, lobby.members);
      stopHardMode();
    } else if (phase.key === "reveal") {
      // Memorization still uses the word board, same as the other modes;
      // the circle only takes over once the bomb starts moving.
      showView("board");
      boardFooter.textContent = "MÉMORISEZ LES MOTS";
      if (board.dataset.gameId !== String(game.id)) {
        board.dataset.gameId = String(game.id);
        renderBoardWords(game.words ?? []);
        scheduleLayout();
      }
      if (game.settings.difficulty === "hard") {
        startHardMode();
      } else {
        stopHardMode();
      }
    } else {
      showView("bomb");
      stopHardMode();
    }
  } else if (phase.finished) {
    showView("stats");
    renderStats(game);
    stopHardMode();
  } else {
    showView("board");
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
    if (game.settings.difficulty === "hard") {
      startHardMode();
    } else {
      stopHardMode();
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
  if (game.settings.mode === "bomb") {
    if (phase.key === "reveal") {
      // Memorization countdown is shown same as any other mode; the fuse
      // itself never gets a visible timer once the circle takes over.
      tvTimer.textContent = formatDuration(phase.remainingMs);
      tvFound.textContent = `${game.foundCount} / ${game.wordCount}`;
      tvMistakes.textContent = "-";
    } else if (!phase.finished && !viewBoard.hidden) {
      // Flip locally from the reveal board to the circle as soon as
      // memorization ends, without waiting for the next server push.
      showView("bomb");
      stopHardMode();
    }
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
    startGameButton.textContent = "Relancer une partie";
    dismissGameButton.hidden = false;
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
