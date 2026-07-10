import { escapeHtml, formatDate, mistakeRuleText, modeName } from "/assets/common.js";

const historyList = document.getElementById("historyList");
const historyCountBadge = document.getElementById("historyCountBadge");

document.getElementById("logoutButton")?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

function gameRowHtml(game) {
  return `
    <a class="history-row history-row-link history-personal" href="/game/${game.id}">
      <div class="history-main">
        <strong>${escapeHtml(game.lobbyName ?? "Salon supprimé")}</strong>
        <span>${formatDate(game.startedAt)} · Partie #${game.id} · Seed ${game.seed}</span>
      </div>
      <div class="history-stats">
        <span>${modeName(game.settings.mode)} · ${escapeHtml(mistakeRuleText(game.settings))}</span>
        <span>Score global : ${game.foundCount}/${game.wordCount}</span>
      </div>
      <div class="history-me">
        <span class="me-found">${game.myFound} trouvés</span>
        <span class="me-mistakes">${game.myMistakes} erreurs</span>
      </div>
      <span class="history-status ${game.status === "active" ? "active" : "finished"}">${game.status === "active" ? "En cours" : "Terminée"}</span>
    </a>
  `;
}

const response = await fetch(`/api/me/history?ts=${Date.now()}`, { cache: "no-store" });
const payload = response.ok ? await response.json() : { summary: null, games: [] };
const { summary, games } = payload;

if (summary) {
  document.getElementById("sumGames").textContent = String(summary.games);
  document.getElementById("sumFound").textContent = String(summary.wordsFound);
  document.getElementById("sumMistakes").textContent = String(summary.mistakes);
  const tries = summary.wordsFound + summary.mistakes;
  document.getElementById("sumAccuracy").textContent = tries ? `${Math.round((summary.wordsFound / tries) * 100)}%` : "-";
}

historyCountBadge.textContent = `${games.length} partie${games.length > 1 ? "s" : ""}`;
historyList.innerHTML = games.map(gameRowHtml).join("")
  || `<div class="empty-copy">Aucune partie jouée pour le moment. Rejoignez un salon !</div>`;
