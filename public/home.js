const form = document.getElementById("startGameForm");
const seedInput = document.getElementById("seedInput");
const randomizeSeedButton = document.getElementById("randomizeSeedButton");
const currentGameCard = document.querySelector("[data-current-game-id]");
const currentGameStatus = document.querySelector(".content-card .badge");
const currentGameStatGrid = document.querySelector(".stat-grid");
const historyList = document.querySelectorAll(".history-list");

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

if (seedInput && !seedInput.value) {
  seedInput.value = String(randomSeed());
}

if (randomizeSeedButton) {
  randomizeSeedButton.addEventListener("click", () => {
    if (seedInput) {
      seedInput.value = String(randomSeed());
      seedInput.focus();
      seedInput.select();
    }
  });
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector("[data-start-game]");
    const seed = Number.parseInt(seedInput?.value || "", 10);
    const payload = Number.isFinite(seed) && seed > 0 ? { seed } : {};

    submitButton.setAttribute("aria-busy", "true");
    submitButton.disabled = true;
    try {
      const response = await fetch("/api/game/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Unable to create a new game");
      }
      window.location.href = "/tv";
    } finally {
      submitButton.removeAttribute("aria-busy");
      submitButton.disabled = false;
    }
  });
}

function formatGameStatus(status) {
  return status === "active" ? "en cours" : "terminée";
}

async function fetchJson(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function renderCurrentGame(game) {
  if (!currentGameCard || !currentGameStatus || !currentGameStatGrid) {
    return;
  }
  currentGameStatus.textContent = formatGameStatus(game?.status || "finished");
  currentGameStatGrid.innerHTML = game
    ? `
      <article class="status-card">
        <span class="status-label">Seed</span>
        <strong class="status-value">${game.seed}</strong>
      </article>
      <article class="status-card">
        <span class="status-label">Trouvés</span>
        <strong class="status-value">${game.guessed_count}/${game.word_count}</strong>
      </article>
      <article class="status-card">
        <span class="status-label">Essais</span>
        <strong class="status-value">${game.try_count}/250</strong>
      </article>
      <article class="status-card">
        <span class="status-label">Résolution</span>
        <strong class="status-value">${game.word_count ? Math.round((game.guessed_count / game.word_count) * 100) : 0}%</strong>
      </article>
    `
    : `<div class="empty-copy">Aucune partie en cours. Lancez-en une depuis le panneau du dessus.</div>`;
}

function renderHistory(games) {
  for (const list of historyList) {
    list.innerHTML = games
      .map((game) => `
        <article class="history-row">
          <div class="history-main">
            <strong>Game #${game.id}</strong>
            <span>Seed ${game.seed}</span>
          </div>
          <div class="history-stats">
            <span>${game.guessed_count}/${game.word_count} trouvés</span>
            <span>${game.try_count}/250 essais</span>
            <span>${game.guessedPercent}%</span>
          </div>
          <span class="history-status ${game.status}">${formatGameStatus(game.status)}</span>
        </article>
      `)
      .join("") || `<div class="empty-copy">Aucune partie pour le moment.</div>`;
  }
}

async function refreshHome() {
  const [currentPayload, historyPayload] = await Promise.all([
    fetchJson("/api/game/current"),
    fetchJson("/api/game/history?limit=10"),
  ]);
  renderCurrentGame(currentPayload?.game || null);
  renderHistory(historyPayload?.games || []);
}

if (currentGameCard) {
  refreshHome();
  setInterval(refreshHome, 1000);
}
