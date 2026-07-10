import {
  api,
  connectSocket,
  escapeHtml,
  formatDuration,
  getPhase,
  renderLobbyGames,
  renderMembers,
  renderSettingsSummary,
} from "/assets/common.js";

const stage = document.querySelector("[data-page='lobby-player']");
const lobbyId = Number(stage.dataset.lobbyId);
const myUserId = Number(stage.dataset.userId);

const phasePill = document.getElementById("phasePill");
const leaveLobbyButton = document.getElementById("leaveLobbyButton");
const viewWaiting = document.getElementById("viewWaiting");
const viewGame = document.getElementById("viewGame");
const viewFinished = document.getElementById("viewFinished");
const memberList = document.getElementById("memberList");
const settingsSummary = document.getElementById("settingsSummary");
const gameTimer = document.getElementById("gameTimer");
const foundCount = document.getElementById("foundCount");
const mistakesLabel = document.getElementById("mistakesLabel");
const mistakesValue = document.getElementById("mistakesValue");
const guessForm = document.getElementById("guessForm");
const guessInput = document.getElementById("guessInput");
const guessList = document.getElementById("guessList");
const message = document.getElementById("message");
const leaderboardHighlights = document.getElementById("leaderboardHighlights");
const leaderboardList = document.getElementById("leaderboardList");

let state = null;

document.getElementById("logoutButton")?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

leaveLobbyButton.addEventListener("click", async () => {
  if (!window.confirm("Quitter la partie ?")) {
    return;
  }
  await api(`/api/lobby/${lobbyId}/leave`);
  window.location.href = "/";
});

function showView(view) {
  viewWaiting.hidden = view !== "waiting";
  viewGame.hidden = view !== "game";
  viewFinished.hidden = view !== "finished";
}

function guessRowHtml(guess) {
  return `
    <div class="guess-item">
      <span class="guess-word">
        ${guess.user_image ? `<img class="avatar avatar-sm" src="${escapeHtml(guess.user_image)}" alt="" />` : ""}
        <span class="guess-word-main">
          <strong>${escapeHtml(guess.raw_word)}</strong>
          ${guess.user_login ? `<span class="guess-login">${escapeHtml(guess.user_login)}</span>` : ""}
        </span>
      </span>
      <span class="${guess.is_correct ? "guess-ok" : ""}">${guess.is_correct ? "Trouvé" : "Raté"}</span>
    </div>
  `;
}

function renderGuessList(game) {
  guessList.innerHTML = (game.guesses ?? []).map(guessRowHtml).join("")
    || `<div class="guess-item"><span>Aucune réponse pour le moment.</span><span></span></div>`;
}

function mistakesDisplay(game, you) {
  const limit = game.settings.mistakeLimit;
  if (limit === null) {
    return { label: "Erreurs", value: game.settings.mistakeMode === "global" ? String(game.globalMistakes) : String(you.mistakes) };
  }
  if (limit === 0) {
    return { label: "Erreurs", value: "Interdites" };
  }
  if (game.settings.mistakeMode === "global") {
    return { label: "Erreurs restantes (équipe)", value: String(Math.max(0, limit - game.globalMistakes)) };
  }
  return { label: "Erreurs restantes", value: String(Math.max(0, limit - you.mistakes)) };
}

function renderResults(game) {
  if (!game.players?.length) {
    leaderboardHighlights.innerHTML = "";
    leaderboardList.innerHTML = `<div class="empty-copy">Aucune réponse enregistrée.</div>`;
    return;
  }
  const best = game.players[0];
  const clumsy = [...game.players].sort((a, b) => b.mistake_count - a.mistake_count)[0];
  const versus = game.settings.mode === "versus";
  const versusLine = versus
    ? `<div class="leaderboard-highlight">
        <span class="status-label">Score</span>
        <strong>Horde ${game.coalitionScores.HORDE} - ${game.coalitionScores.ALLIANCE} Alliance</strong>
      </div>`
    : "";
  leaderboardHighlights.innerHTML = `
    ${versusLine}
    <div class="leaderboard-highlight">
      <span class="status-label">Meilleur score</span>
      <strong>${escapeHtml(best.login)} · ${best.found_count} mots</strong>
    </div>
    <div class="leaderboard-highlight">
      <span class="status-label">Plus de ratés</span>
      <strong>${escapeHtml(clumsy.login)} · ${clumsy.mistake_count} erreurs</strong>
    </div>
  `;
  leaderboardList.innerHTML = game.players
    .map((player, index) => `
      <div class="leaderboard-row">
        <span class="leaderboard-rank">#${index + 1}</span>
        ${player.image_url ? `<img class="avatar" src="${escapeHtml(player.image_url)}" alt="" />` : ""}
        <strong class="leaderboard-login">${escapeHtml(player.login)}</strong>
        <span class="leaderboard-stats">${player.found_count} trouvés · ${player.mistake_count} erreurs</span>
      </div>
    `)
    .join("");
}

function applyState(newState) {
  state = newState;
  const { lobby, game, you } = state;
  document.getElementById("lobbyTitle").textContent = lobby.name;
  renderMembers(memberList, lobby.members, lobby.settings);
  renderSettingsSummary(settingsSummary, lobby.settings);
  renderLobbyGames(document.getElementById("lobbyGamesList"), lobby.games);

  const phase = getPhase(game);
  if (!game) {
    showView("waiting");
  } else if (phase.finished) {
    showView("finished");
    renderResults(game);
  } else {
    showView("game");
    renderGuessList(game);
    foundCount.textContent = `${game.foundCount} / ${game.wordCount}`;
    const mistakes = mistakesDisplay(game, you);
    mistakesLabel.textContent = mistakes.label;
    mistakesValue.textContent = mistakes.value;
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
  if (phase.finished) {
    // Flip locally as soon as the clock hits zero; the server broadcast with
    // the final standings follows within a second.
    if (!viewGame.hidden) {
      showView("finished");
      renderResults(game);
    }
    return;
  }
  gameTimer.textContent = formatDuration(phase.remainingMs);

  const locked = state.you.locked;
  const canPlay = phase.key === "play" && !locked;
  guessInput.disabled = !canPlay;
  guessForm.querySelector("button").disabled = !canPlay;
  if (locked) {
    message.textContent = "Vous avez épuisé vos erreurs pour cette partie.";
    message.className = "message error";
  } else if (phase.key === "reveal") {
    message.textContent = "Mémorisez les mots affichés sur l'écran de l'hôte…";
    message.className = "message";
  }
}

guessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const word = guessInput.value.trim();
  if (!word) {
    return;
  }
  const result = await api(`/api/lobby/${lobbyId}/guess`, { word });
  if (!result.ok) {
    message.textContent = result.error || "Impossible d'envoyer la réponse.";
    message.className = "message error";
    return;
  }
  const label =
    result.correct ? "Trouvé !" :
    result.alreadyFound ? `Déjà trouvé${result.firstLogin ? ` par ${result.firstLogin}` : ""}` :
    result.alreadyTried ? "Déjà tenté" :
    result.rejected ? result.error :
    "Raté";
  message.textContent = `${word} : ${label}`;
  message.className = result.correct ? "message ok" : "message";
  guessInput.value = "";
  guessInput.focus();
});

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
