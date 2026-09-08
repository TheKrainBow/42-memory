export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDuration(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getPhase(game) {
  if (!game) {
    return { label: "En attente", key: "waiting", remainingMs: 0, finished: false };
  }
  const now = Date.now();
  const revealMs = new Date(game.revealAt).getTime() - now;
  const submitMs = new Date(game.submitUntil).getTime() - now;
  if (game.status !== "active" || submitMs <= 0) {
    return { label: "Terminé", key: "finished", remainingMs: 0, finished: true };
  }
  if (revealMs > 0) {
    return { label: "Mémorisation", key: "reveal", remainingMs: revealMs, finished: false };
  }
  return { label: "Partie", key: "play", remainingMs: submitMs, finished: false };
}

export async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, ...payload };
}

// Auto-reconnecting state socket. The server pushes the full state on connect
// and after every change, so a reconnection is always self-healing.
export function connectSocket({ lobbyId = null, onMessage }) {
  let ws = null;
  let closed = false;

  function open() {
    if (closed) {
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const query = lobbyId ? `?lobby=${lobbyId}` : "";
    ws = new WebSocket(`${proto}://${window.location.host}/ws${query}`);
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {}
    };
    ws.onclose = () => {
      if (!closed) {
        setTimeout(open, 1500);
      }
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  open();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

export function coalitionEmblem(coalition) {
  return coalition === "HORDE" ? "/assets/horde.svg" : coalition === "ALLIANCE" ? "/assets/alliance.svg" : null;
}

export function coalitionName(coalition) {
  return coalition === "HORDE" ? "Horde" : coalition === "ALLIANCE" ? "Alliance" : "?";
}

export function mistakeRuleText(settings) {
  const scope = settings.mistakeMode === "global" ? "globales" : "par joueur";
  if (settings.mistakeLimit === null) {
    return `Erreurs illimitées (${scope})`;
  }
  if (settings.mistakeLimit === 0) {
    return "Erreurs interdites";
  }
  return `${settings.mistakeLimit} erreurs ${scope}`;
}

export function modeName(mode) {
  if (mode === "versus") {
    return "Horde vs Alliance";
  }
  if (mode === "bomb") {
    return "Bombe";
  }
  return "Coopératif";
}

export function allowedCoalitionsText(settings) {
  if (settings.allowedCoalitions === "HORDE") {
    return "Horde uniquement";
  }
  if (settings.allowedCoalitions === "ALLIANCE") {
    return "Alliance uniquement";
  }
  return "Horde et Alliance";
}

export function difficultyName(difficulty) {
  return difficulty === "hard" ? "Difficile" : "Facile";
}

export function renderSettingsSummary(el, settings) {
  if (!el) {
    return;
  }
  el.innerHTML = `
    <div class="settings-row"><span>Mode</span><strong>${modeName(settings.mode)}</strong></div>
    <div class="settings-row"><span>Difficulté</span><strong>${escapeHtml(difficultyName(settings.difficulty))}</strong></div>
    <div class="settings-row"><span>Mots affichés</span><strong>${settings.wordCount}</strong></div>
    <div class="settings-row"><span>Mémorisation</span><strong>${settings.revealSeconds}s</strong></div>
    <div class="settings-row"><span>Écriture</span><strong>${formatDuration(settings.writeSeconds * 1000)}</strong></div>
    <div class="settings-row"><span>Erreurs</span><strong>${escapeHtml(mistakeRuleText(settings))}</strong></div>
    <div class="settings-row"><span>Coalitions</span><strong>${escapeHtml(allowedCoalitionsText(settings))}</strong></div>
  `;
}

export function formatDate(iso) {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

// Row for a game played in a lobby (host & player waiting views). Finished
// games link to their archive page.
export function lobbyGameRowHtml(game) {
  const inner = `
    <div class="history-main">
      <strong>Partie #${game.id}</strong>
      <span>${formatDate(game.startedAt)} · Seed ${game.seed}</span>
    </div>
    <div class="history-stats">
      <span>${modeName(game.settings.mode)}</span>
      <span>${game.foundCount}/${game.wordCount} trouvés · ${escapeHtml(mistakeRuleText(game.settings))}</span>
    </div>
    <span class="history-status ${game.status === "active" ? "active" : "finished"}">${
      game.status === "active" ? "En cours" : game.status === "stopped" ? "Arrêtée" : "Terminée"
    }</span>
  `;
  if (game.status === "active") {
    return `<article class="history-row">${inner}</article>`;
  }
  return `<a class="history-row history-row-link" href="/game/${game.id}">${inner}</a>`;
}

export function renderLobbyGames(el, games) {
  if (!el) {
    return;
  }
  el.innerHTML = (games ?? []).map(lobbyGameRowHtml).join("")
    || `<div class="empty-copy">Aucune partie jouée dans ce salon.</div>`;
}

export function renderMembers(el, members) {
  if (!el) {
    return;
  }
  el.innerHTML = members
    .map((member) => `
      <div class="member-row ${member.coalition === "HORDE" ? "member-horde" : "member-alliance"}">
        ${member.imageUrl ? `<img class="avatar" src="${escapeHtml(member.imageUrl)}" alt="" />` : `<span class="avatar avatar-placeholder"></span>`}
        <strong class="member-login">${escapeHtml(member.login)}</strong>
        ${member.isHost ? `<span class="badge badge-host">Hôte</span>` : ""}
        <img class="member-emblem" src="${coalitionEmblem(member.coalition)}" alt="${coalitionName(member.coalition)}" />
      </div>
    `)
    .join("") || `<div class="empty-copy">Personne pour le moment.</div>`;
}
