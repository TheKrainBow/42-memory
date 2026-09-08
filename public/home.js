import { api, connectSocket, escapeHtml, modeName } from "/assets/common.js";

const createForm = document.getElementById("createLobbyForm");
const createMessage = document.getElementById("createMessage");
const lobbyList = document.getElementById("lobbyList");
const lobbyCountBadge = document.getElementById("lobbyCountBadge");

document.getElementById("logoutButton")?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

// A lobby only needs a name: the host tunes the rules from inside the lobby.
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/lobby", { name: document.getElementById("lobbyName").value });
  if (result.lobbyId) {
    window.location.href = `/lobby/${result.lobbyId}`;
    return;
  }
  createMessage.textContent = result.error || "Création impossible.";
  createMessage.className = "message error";
});

function renderLobbies(lobbies) {
  lobbyCountBadge.textContent = `${lobbies.length} salon${lobbies.length > 1 ? "s" : ""}`;
  lobbyList.innerHTML = lobbies
    .map((lobby) => `
      <article class="history-row lobby-row" data-lobby-id="${lobby.id}">
        <div class="history-main">
          <strong>${escapeHtml(lobby.name)}</strong>
          <span>Hôte : ${escapeHtml(lobby.hostLogin)}</span>
        </div>
        <div class="history-stats">
          <span>${modeName(lobby.mode)}</span>
          <span>${lobby.memberCount} joueur${lobby.memberCount > 1 ? "s" : ""} · ${lobby.wordCount} mots</span>
        </div>
        <span class="history-status ${lobby.playing ? "active" : ""}">${lobby.playing ? "En jeu" : "En attente"}</span>
        <button type="button" class="secondary join-button">Rejoindre</button>
      </article>
    `)
    .join("") || `<div class="empty-copy">Aucun salon ouvert pour le moment.</div>`;

  for (const row of lobbyList.querySelectorAll(".lobby-row")) {
    row.querySelector(".join-button").addEventListener("click", async () => {
      const lobbyId = row.dataset.lobbyId;
      const result = await api(`/api/lobby/${lobbyId}/join`);
      if (result.ok || result.lobbyId) {
        window.location.href = `/lobby/${result.lobbyId ?? lobbyId}`;
      } else {
        window.alert(result.error || "Impossible de rejoindre ce salon.");
      }
    });
  }
}

connectSocket({
  onMessage: (payload) => {
    if (payload.type === "lobbies") {
      renderLobbies(payload.lobbies ?? []);
    }
  },
});
