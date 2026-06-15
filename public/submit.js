const screen = document.querySelector("[data-page='submit']");
const submitTimer = document.getElementById("submitTimer");
const foundCount = document.getElementById("foundCount");
const tryCount = document.getElementById("tryCount");
const statusPill = document.getElementById("statusPill");
const submitPhaseLabel = document.getElementById("submitPhaseLabel");
const guessForm = document.getElementById("guessForm");
const guessInput = document.getElementById("guessInput");
const guessList = document.getElementById("guessList");
const message = document.getElementById("message");

let currentGame = null;
let liveSource = null;

function formatDuration(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getPhase(game) {
  const now = Date.now();
  const revealMs = new Date(game.revealAt).getTime() - now;
  const submitMs = new Date(game.submitUntil).getTime() - now;
  const finished = game.status !== "active" || submitMs <= 0;
  const label = finished ? "Terminé" : revealMs > 0 ? "Révélation" : "Partie";
  const remainingMs = finished ? 0 : revealMs > 0 ? revealMs : submitMs;
  return { label, remainingMs, finished };
}

async function fetchCurrentGame() {
  const response = await fetch(`/api/game/current?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function renderGuessList(game) {
  const guesses = game.guesses ?? [];
  guessList.innerHTML = guesses
    .map((guess) => `
      <div class="guess-item">
        <strong>${escapeHtml(guess.raw_word)}</strong>
        <span>${guess.is_correct ? "Trouvé" : "Raté"}</span>
      </div>
    `)
    .join("") || `<div class="guess-item"><span>Aucune réponse pour le moment.</span><span></span></div>`;
}

function prependGuessToList(guess) {
  if (!guessList || !guess) {
    return;
  }

  const item = document.createElement("div");
  item.className = "guess-item";
  item.innerHTML = `
    <strong>${escapeHtml(guess.rawWord ?? guess.raw_word ?? "")}</strong>
    <span>${guess.isCorrect ?? guess.is_correct ? "Trouvé" : "Raté"}</span>
  `;

  const emptyState = guessList.querySelector(".guess-item");
  if (emptyState && emptyState.textContent?.includes("Aucune réponse")) {
    guessList.innerHTML = "";
  }

  guessList.prepend(item);

  while (guessList.children.length > 20) {
    guessList.removeChild(guessList.lastElementChild);
  }
}

function updateGame(game) {
  currentGame = game;
  const phase = getPhase(game);
  submitTimer.textContent = formatDuration(phase.remainingMs);
  if (submitPhaseLabel) {
    submitPhaseLabel.textContent = phase.label;
  }
  foundCount.textContent = `${game.guessed_count} / ${game.word_count}`;
  tryCount.textContent = `${Math.max(0, 250 - game.try_count)}`;
  statusPill.textContent = phase.finished ? "Terminé" : phase.label;
  renderGuessList(game);

  const locked = phase.finished || phase.label !== "Partie" || game.try_count >= 250;
  guessInput.disabled = locked;
  guessForm.querySelector("button").disabled = locked;
  if (locked) {
    message.textContent = phase.finished ? "Partie terminée." : "En attente de la phase de jeu.";
    message.className = phase.finished ? "message error" : "message";
  }
}

async function refresh() {
  const payload = await fetchCurrentGame();
  if (!payload) {
    statusPill.textContent = "En attente";
    if (submitPhaseLabel) {
      submitPhaseLabel.textContent = "En attente";
    }
    submitTimer.textContent = "0:00";
    foundCount.textContent = "0 / 200";
    tryCount.textContent = "250";
    guessInput.disabled = true;
    guessForm.querySelector("button").disabled = true;
    message.textContent = "En attente du lancement d'une partie.";
    message.className = "message";
    guessList.innerHTML = `<div class="guess-item"><span>Aucune partie pour le moment.</span><span></span></div>`;
    return;
  }
  updateGame(payload.game);
}

guessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const word = guessInput.value.trim();
  if (!word) {
    return;
  }

  const response = await fetch("/api/game/guess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    message.textContent = payload.error || "Impossible d'envoyer la réponse.";
    message.className = "message error";
    await refresh();
    return;
  }

  const correct = payload.correct ? "Trouvé" : payload.alreadyFound ? "Déjà trouvé" : payload.alreadyTried ? "Déjà tenté" : "Raté";
  message.textContent = `${word}: ${correct}`;
  message.className = payload.correct ? "message ok" : "message";
  guessInput.value = "";
  if (payload.guess) {
    prependGuessToList(payload.guess);
  }
  if (payload.game) {
    updateGame(payload.game);
  } else {
    await refresh();
  }
});

function startLiveStream() {
  if (liveSource) {
    liveSource.close();
  }
  liveSource = new EventSource("/api/game/stream");
  liveSource.onmessage = (event) => {
    const payload = JSON.parse(event.data || "{}");
    if (payload?.game) {
      updateGame(payload.game);
    }
  };
liveSource.onerror = () => {
  liveSource?.close();
  setTimeout(() => {
    if (!liveSource || liveSource.readyState === EventSource.CLOSED) {
      startLiveStream();
    }
  }, 1500);
};
}

await refresh();
startLiveStream();
setInterval(refresh, 1000);
setInterval(() => {
  if (currentGame) {
    updateGame(currentGame);
  }
}, 1000);
