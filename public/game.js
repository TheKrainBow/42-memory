import { escapeHtml, formatDate, renderSettingsSummary } from "/assets/common.js";
import { normalizeWord } from "/assets/board-layout.js";
import { renderFoundChart, renderLeaderboards, verdictText } from "/assets/stats-render.js";

const stage = document.querySelector("[data-page='game-detail']");
const gameId = Number(stage.dataset.gameId);

const response = await fetch(`/api/game/${gameId}?ts=${Date.now()}`, { cache: "no-store" });
if (!response.ok) {
  window.location.href = "/history";
} else {
  const { game } = await response.json();
  const versus = game.settings.mode === "versus";

  document.getElementById("gameTitle").textContent = game.lobbyName ?? "Salon supprimé";
  document.getElementById("gameSubtitle").textContent =
    `Partie #${game.id} · ${formatDate(game.startedAt)} · Seed ${game.seed}`;
  document.getElementById("gameVerdict").textContent = verdictText(game);

  renderFoundChart({
    container: document.getElementById("foundChart"),
    legend: document.getElementById("chartLegend"),
    game,
  });
  renderLeaderboards({
    byFoundEl: document.getElementById("statsByFound"),
    byFailsEl: document.getElementById("statsByFails"),
    players: game.players ?? [],
  });
  renderSettingsSummary(document.getElementById("settingsSummary"), game.settings);

  document.getElementById("wordChips").innerHTML = (game.words ?? [])
    .map((word) => {
      const hit = game.correctWords[normalizeWord(word)];
      const classes = [
        "word-chip",
        hit ? "word-chip-found" : "",
        versus && hit?.coalition === "HORDE" ? "word-chip-horde" : "",
        versus && hit?.coalition === "ALLIANCE" ? "word-chip-alliance" : "",
      ].join(" ");
      const title = hit ? `Trouvé par ${hit.login}` : "Non trouvé";
      return `<span class="${classes}" title="${escapeHtml(title)}">${escapeHtml(word)}${hit ? `<small>${escapeHtml(hit.login)}</small>` : ""}</span>`;
    })
    .join("");
}
