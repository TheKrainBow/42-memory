const stage = document.querySelector("[data-page='host']");
const board = document.getElementById("wordBoard");
const tvPhaseLabel = document.getElementById("tvPhaseLabel");
const tvTimer = document.getElementById("tvTimer");
const tvGuessed = document.getElementById("tvGuessed");
const tvRemaining = document.getElementById("tvRemaining");
const gameId = Number(stage?.dataset.gameId || 0);
let seed = Number(stage?.dataset.seed || 0);
let status = String(stage?.dataset.status || "active");
let revealAt = new Date(stage?.dataset.revealAt || Date.now()).getTime();
let submitUntil = new Date(stage?.dataset.submitUntil || Date.now()).getTime();
let activeGameId = gameId;
let lastGame = null;
let layoutRaf = null;
let liveSource = null;

function normalizeWord(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createRng(initialSeed) {
  let t = initialSeed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts) {
  const source = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffle(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function renderWords(words) {
  board.innerHTML = words
    .map((word, index) => `<span class="floating-word" data-word="${escapeHtml(word)}" data-index="${index}">${escapeHtml(word)}</span>`)
    .join("");
}

function getFontSize() {
  const width = window.innerWidth;
  if (width < 700) return 14;
  if (width < 1100) return 18;
  return 20;
}

function rectsOverlap(a, b, padding = 10) {
  return !(
    a.right + padding < b.left ||
    a.left - padding > b.right ||
    a.bottom + padding < b.top ||
    a.top - padding > b.bottom
  );
}

function measureWord(wordEl) {
  const rect = wordEl.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function layoutWords() {
  if (!board) {
    return;
  }
  const words = [...board.querySelectorAll(".floating-word")];
  if (!words.length) {
    return;
  }

  const rect = board.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(320, rect.height);
  const fontSize = getFontSize();
  const layoutSeed = hashSeed(seed, width, height, words.length);
  const rng = createRng(layoutSeed);
  const shuffled = shuffle(words, rng);
  const placed = [];

  board.style.setProperty("--word-font-size", `${fontSize}px`);

  for (const wordEl of shuffled) {
    wordEl.style.position = "absolute";
    wordEl.style.left = "0px";
    wordEl.style.top = "0px";
    wordEl.style.setProperty("--word-font-size", `${fontSize}px`);

    const { width: wordWidth, height: wordHeight } = measureWord(wordEl);
    const maxLeft = Math.max(0, width - wordWidth);
    const maxTop = Math.max(0, height - wordHeight);
    let candidate = null;

    for (let attempt = 0; attempt < 400 && !candidate; attempt += 1) {
      const left = rng() * maxLeft;
      const top = rng() * maxTop;
      const rectCandidate = {
        left,
        top,
        right: left + wordWidth,
        bottom: top + wordHeight,
      };
      if (!placed.some((item) => rectsOverlap(rectCandidate, item))) {
        candidate = rectCandidate;
      }
    }

    if (!candidate) {
      const left = rng() * maxLeft;
      const top = rng() * maxTop;
      candidate = {
        left,
        top,
        right: left + wordWidth,
        bottom: top + wordHeight,
      };
    }

    placed.push(candidate);
    wordEl.style.left = `${Math.max(0, Math.min(maxLeft, candidate.left))}px`;
    wordEl.style.top = `${Math.max(0, Math.min(maxTop, candidate.top))}px`;
  }
}

function applyFoundWords(foundWords) {
  const found = new Set(foundWords.map(normalizeWord));
  for (const word of board.querySelectorAll(".floating-word")) {
    const normalized = word.dataset.normalized || normalizeWord(word.dataset.word || word.textContent || "");
    const isFound = found.has(normalized);
    word.dataset.normalized = normalized;
    word.dataset.found = String(isFound);
    word.classList.toggle("found", isFound);
  }
}

function updateRevealState() {
  const finished = status !== "active" || Date.now() >= submitUntil;
  const blurred = !finished && Date.now() >= revealAt;
  board.classList.toggle("blurred", blurred);
  board.classList.toggle("finished", finished);
  stage.classList.toggle("is-blurred", blurred);
  stage.classList.toggle("is-finished", finished);
}

function formatDuration(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateHeader(game) {
  const now = Date.now();
  const revealMs = new Date(game.revealAt).getTime() - now;
  const submitMs = new Date(game.submitUntil).getTime() - now;
  const finished = game.status !== "active" || submitMs <= 0;
  const phaseLabel = finished ? "Terminé" : revealMs > 0 ? "Révélation" : "Partie";
  const remainingMs = finished ? 0 : revealMs > 0 ? revealMs : submitMs;

  if (tvPhaseLabel) {
    tvPhaseLabel.textContent = phaseLabel;
  }
  if (tvTimer) {
    tvTimer.textContent = formatDuration(remainingMs);
  }
  if (tvGuessed) {
    tvGuessed.textContent = `${game.guessed_count} / ${game.word_count}`;
  }
  if (tvRemaining) {
    tvRemaining.textContent = `${Math.max(0, 250 - game.try_count)}`;
  }
}

function syncGame(game) {
  const gameChanged = activeGameId !== game.id;
  activeGameId = game.id;
  seed = game.seed;
  status = game.status;
  revealAt = new Date(game.revealAt).getTime();
  submitUntil = new Date(game.submitUntil).getTime();
  stage.dataset.seed = String(seed);
  stage.dataset.status = status;
  stage.dataset.revealAt = game.revealAt;
  stage.dataset.submitUntil = game.submitUntil;

  if (gameChanged) {
    renderWords(game.words || []);
    scheduleLayout();
  }

  lastGame = game;
  applyFoundWords(game.correctWords || []);
  updateHeader(game);
  updateRevealState();
}

async function fetchCurrentGame() {
  const response = await fetch("/api/game/current");
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function refresh() {
  const payload = await fetchCurrentGame();
  if (!payload?.game) {
    return;
  }
  syncGame(payload.game);
}

function startLiveStream() {
  if (liveSource) {
    liveSource.close();
  }
  liveSource = new EventSource("/api/game/stream");
  liveSource.onmessage = (event) => {
    const payload = JSON.parse(event.data || "{}");
    if (payload?.game) {
      syncGame(payload.game);
    }
  };
  liveSource.onerror = () => {
    liveSource?.close();
  };
}

function tick() {
  if (lastGame) {
    updateHeader(lastGame);
    updateRevealState();
  }
}

function scheduleLayout() {
  if (layoutRaf) {
    cancelAnimationFrame(layoutRaf);
  }
  layoutRaf = requestAnimationFrame(() => {
    layoutWords();
    updateRevealState();
  });
}

window.addEventListener("resize", scheduleLayout, { passive: true });

if (board && stage) {
  if (!board.querySelector(".floating-word") && stage.dataset.words) {
    renderWords(JSON.parse(stage.dataset.words));
  }
  scheduleLayout();
  await refresh();
  startLiveStream();
  setInterval(refresh, 15000);
  setInterval(tick, 1000);
}
