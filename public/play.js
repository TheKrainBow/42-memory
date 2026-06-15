const screen = document.querySelector("[data-page='host']");
const groupKey = screen.dataset.group;
const gameId = Number(screen.dataset.gameId);
const revealTimer = document.getElementById("revealTimer");
const submitTimer = document.getElementById("submitTimer");
const foundCount = document.getElementById("foundCount");
const tryCount = document.getElementById("tryCount");
const statusPill = document.getElementById("statusPill");
const wordBoard = document.getElementById("wordBoard");
const historyList = document.getElementById("historyList");
const newGameButton = document.getElementById("newGameButton");

function formatDuration(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

async function fetchCurrentGame() {
  const response = await fetch(`/api/group/${groupKey}/current`);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchHistory() {
  const response = await fetch(`/api/group/${groupKey}/history`);
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data.games ?? [];
}

async function startNewGame() {
  const response = await fetch(`/api/group/${groupKey}/new`, { method: "POST" });
  if (!response.ok) {
    return;
  }
  const data = await response.json();
  window.location.reload();
  return data;
}

function renderHistory(games) {
  historyList.innerHTML = games
    .map((game) => {
      const finished = game.finished_at ? new Date(game.finished_at).toLocaleTimeString() : "en cours";
      return `
        <div class="history-item">
          <span><strong>#${game.id}</strong> ${game.status === "active" ? "en cours" : "terminée"}</span>
          <span>${game.guessed_count}/${game.word_count} trouvés, ${game.try_count} essais, ${finished}</span>
        </div>
      `;
    })
    .join("") || `<div class="history-item"><span>Aucune partie pour le moment.</span><span></span></div>`;
}

function updateTimers(game) {
  const now = Date.now();
  const revealRemaining = new Date(game.revealAt).getTime() - now;
  const submitRemaining = new Date(game.submitUntil).getTime() - now;
  revealTimer.textContent = formatDuration(revealRemaining);
  submitTimer.textContent = formatDuration(submitRemaining);
  foundCount.textContent = `${game.guessed_count} / ${game.word_count}`;
  tryCount.textContent = `${game.try_count} / 250`;

  if (revealRemaining <= 0 || game.status !== "active") {
    wordBoard.classList.add("blurred");
  }

  if (submitRemaining <= 0 || game.status !== "active") {
    statusPill.textContent = "Terminé";
  } else if (revealRemaining > 0) {
    statusPill.textContent = "Révélation";
  } else {
    statusPill.textContent = "Partie";
  }
}

async function refresh() {
  const payload = await fetchCurrentGame();
  if (!payload) {
    statusPill.textContent = "En attente";
    return;
  }
  const { game } = payload;
  updateTimers(game);
  renderHistory(await fetchHistory());
}

newGameButton.addEventListener("click", async () => {
  newGameButton.disabled = true;
  try {
    await startNewGame();
  } finally {
    newGameButton.disabled = false;
  }
});

await refresh();
setInterval(refresh, 5000);
setInterval(async () => {
  try {
    const payload = await fetchCurrentGame();
    if (payload) {
      updateTimers(payload.game);
    }
  } catch {
    statusPill.textContent = "Hors ligne";
  }
}, 1000);
