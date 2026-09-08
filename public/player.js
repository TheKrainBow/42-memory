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
const gameTimerCard = document.getElementById("gameTimerCard");
const gameTimer = document.getElementById("gameTimer");
const foundCount = document.getElementById("foundCount");
const mistakesCard = document.getElementById("mistakesCard");
const mistakesLabel = document.getElementById("mistakesLabel");
const mistakesValue = document.getElementById("mistakesValue");
const bombTurnBanner = document.getElementById("bombTurnBanner");
const guessHistoryCard = document.getElementById("guessHistoryCard");
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

// Bomb mode: who currently holds the bomb, or your own eliminated/turn
// status. No fuse countdown is ever shown — the server never sends one.
function renderBombTurnBanner(game, members, you) {
  if (you.eliminated) {
    bombTurnBanner.textContent = "Vous êtes éliminé — la partie continue sans vous.";
    bombTurnBanner.className = "bomb-turn-banner eliminated";
    return;
  }
  if (game.bomb.isYourTurn) {
    bombTurnBanner.textContent = "À vous de jouer !";
    bombTurnBanner.className = "bomb-turn-banner your-turn";
    return;
  }
  const holder = members.find((member) => member.id === game.bomb.holderId);
  bombTurnBanner.textContent = holder ? `Tour de ${holder.login}` : "En attente…";
  bombTurnBanner.className = "bomb-turn-banner";
}

function renderBombResults(game, members) {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const eliminatedDesc = [...game.bomb.eliminated].sort((a, b) => b.place - a.place);
  const rows = [
    ...game.bomb.alive.map((id) => ({ id, label: "Survivant" })),
    ...eliminatedDesc.map((entry) => ({ id: entry.userId, label: `Éliminé (place ${entry.place})` })),
  ];
  leaderboardHighlights.innerHTML = `
    <div class="leaderboard-highlight">
      <span class="status-label">Mots trouvés</span>
      <strong>${game.foundCount} / ${game.wordCount}</strong>
    </div>
  `;
  leaderboardList.innerHTML = rows
    .map((row, index) => {
      const member = memberById.get(row.id);
      if (!member) {
        return "";
      }
      return `
        <div class="leaderboard-row">
          <span class="leaderboard-rank">#${index + 1}</span>
          ${member.imageUrl ? `<img class="avatar" src="${escapeHtml(member.imageUrl)}" alt="" />` : ""}
          <strong class="leaderboard-login">${escapeHtml(member.login)}</strong>
          <span class="leaderboard-stats">${row.label}</span>
        </div>
      `;
    })
    .join("") || `<div class="empty-copy">Aucune donnée.</div>`;
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
  renderMembers(memberList, lobby.members);
  renderSettingsSummary(settingsSummary, lobby.settings);
  renderLobbyGames(document.getElementById("lobbyGamesList"), lobby.games);

  const phase = getPhase(game);
  const isBomb = game?.settings.mode === "bomb";
  if (!game) {
    showView("waiting");
  } else if (phase.finished) {
    showView("finished");
    if (isBomb) {
      renderBombResults(game, lobby.members);
    } else {
      renderResults(game);
    }
  } else {
    showView("game");
    mistakesCard.hidden = isBomb;
    guessHistoryCard.hidden = isBomb;
    foundCount.textContent = `${game.foundCount} / ${game.wordCount}`;
    if (isBomb) {
      renderBombTurnBanner(game, lobby.members, you);
    } else {
      gameTimerCard.hidden = false;
      bombTurnBanner.hidden = true;
      renderGuessList(game);
      const mistakes = mistakesDisplay(game, you);
      mistakesLabel.textContent = mistakes.label;
      mistakesValue.textContent = mistakes.value;
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
  const isBomb = game.settings.mode === "bomb";
  if (phase.finished) {
    // Flip locally as soon as the clock hits zero; the server broadcast with
    // the final standings follows within a second.
    if (!viewGame.hidden) {
      showView("finished");
      if (isBomb) {
        renderBombResults(game, state.lobby.members);
      } else {
        renderResults(game);
      }
    }
    return;
  }

  if (isBomb) {
    const inReveal = phase.key === "reveal";
    gameTimerCard.hidden = !inReveal;
    bombTurnBanner.hidden = inReveal;
    if (inReveal) {
      gameTimer.textContent = formatDuration(phase.remainingMs);
    }

    const eliminated = state.you.eliminated;
    const canPlay = phase.key === "play" && !eliminated && game.bomb.isYourTurn;
    guessInput.disabled = !canPlay;
    guessForm.querySelector("button").disabled = !canPlay;
    if (eliminated) {
      message.textContent = "Vous êtes éliminé.";
      message.className = "message error";
    } else if (inReveal) {
      message.textContent = "Mémorisez les mots affichés sur l'écran de l'hôte…";
      message.className = "message";
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
