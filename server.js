import crypto from "crypto";
import express from "express";
import { WebSocketServer } from "ws";
import db from "./db.js";
import { normalizeGuess, sampleWords, wordPoolSize } from "./words.js";
import {
  COALITIONS,
  FT_CLIENT_ID,
  buildAuthorizeUrl,
  createSession,
  destroySession,
  exchangeCode,
  fetchIntraProfile,
  getSessionUser,
  parseCookies,
  publicUser,
  setCookie,
  setUserCoalition,
  upsertUser,
} from "./auth.js";

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 3000;

const THEMES = {
  HORDE: {
    bodyClass: "theme-horde",
    factionName: "Horde",
    factionTag: "Pour la Horde",
    emblem: "/assets/horde.svg",
  },
  ALLIANCE: {
    bodyClass: "theme-alliance",
    factionName: "Alliance",
    factionTag: "Pour l'Alliance",
    emblem: "/assets/alliance.svg",
  },
};

// The theme follows the connected user's coalition.
function themeFor(user) {
  return THEMES[user?.coalition] || THEMES.ALLIANCE;
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/assets", express.static("public"));
app.use("/font", express.static("font"));

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageShell({ title, body, script, extraHead = "", bodyClass = "" }) {
  return `<!doctype html>
  <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <link rel="stylesheet" href="/assets/styles.css" />
      ${extraHead}
    </head>
    <body class="${escapeHtml(bodyClass)}">
      ${body}
      ${script ? `<script type="module" src="${script}"></script>` : ""}
    </body>
  </html>`;
}

// ---------------------------------------------------------------------------
// Lobby settings
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

// mistakeLimit: null = endless, 0 = mistakes rejected outright, N = allowance.
function normalizeSettings(input) {
  const raw = input ?? {};
  const mode = raw.mode === "versus" ? "versus" : raw.mode === "bomb" ? "bomb" : "coop";
  const mistakeMode = raw.mistakeMode === "global" ? "global" : "per_user";
  let mistakeLimit;
  if (raw.mistakeLimit === null || raw.mistakeLimit === "endless" || raw.mistakeLimit === "") {
    mistakeLimit = null;
  } else {
    mistakeLimit = clampInt(raw.mistakeLimit, 0, 100000, mistakeMode === "global" ? 50 : 30);
  }
  const allowedCoalitions = COALITIONS.includes(String(raw.allowedCoalitions || "").toUpperCase())
    ? String(raw.allowedCoalitions).toUpperCase()
    : "BOTH";
  const difficulty = raw.difficulty === "hard" ? "hard" : "easy";
  const bombMinSeconds = clampInt(raw.bombMinSeconds, 3, 300, 15);
  // Max can never end up below min: a lobby host dragging min past the
  // current max just pulls max up with it instead of erroring out.
  const bombMaxSeconds = Math.max(bombMinSeconds, clampInt(raw.bombMaxSeconds, 3, 300, 30));
  return {
    mode,
    wordCount: clampInt(raw.wordCount, 10, wordPoolSize(), 200),
    revealSeconds: clampInt(raw.revealSeconds, 5, 600, 60),
    writeSeconds: clampInt(raw.writeSeconds, 30, 7200, 300),
    mistakeMode,
    mistakeLimit,
    allowedCoalitions,
    difficulty,
    bombMinSeconds,
    bombMaxSeconds,
  };
}

function coalitionAllowed(settings, coalition) {
  return settings.allowedCoalitions === "BOTH" || settings.allowedCoalitions === coalition;
}

function parseSettings(json) {
  try {
    return normalizeSettings(JSON.parse(json));
  } catch {
    return normalizeSettings({});
  }
}

// ---------------------------------------------------------------------------
// Lobby data access
// ---------------------------------------------------------------------------

function getLobby(id) {
  const row = db.prepare(`SELECT * FROM lobbies WHERE id = ?`).get(id);
  if (!row) {
    return null;
  }
  return { ...row, settings: parseSettings(row.settings_json) };
}

function memberLobbyId(userId) {
  return db.prepare(`SELECT lobby_id FROM lobby_members WHERE user_id = ?`).get(userId)?.lobby_id ?? null;
}

function lobbyMembers(lobbyId) {
  return db.prepare(`
    SELECT u.*, lm.joined_at
    FROM lobby_members lm
    JOIN users u ON u.id = lm.user_id
    WHERE lm.lobby_id = ?
    ORDER BY lm.joined_at ASC
  `).all(lobbyId);
}

function listOpenLobbies() {
  return db.prepare(`
    SELECT l.id, l.name, l.settings_json, l.created_at,
           h.login AS host_login, h.image_url AS host_image,
           (SELECT COUNT(*) FROM lobby_members lm WHERE lm.lobby_id = l.id) AS member_count,
           (SELECT COUNT(*) FROM games g WHERE g.lobby_id = l.id AND g.status = 'active') AS active_games
    FROM lobbies l
    JOIN users h ON h.id = l.host_user_id
    WHERE l.status = 'open'
    ORDER BY l.id DESC
  `).all().map((row) => {
    const settings = parseSettings(row.settings_json);
    return {
      id: row.id,
      name: row.name,
      hostLogin: row.host_login,
      hostImage: row.host_image,
      memberCount: row.member_count,
      mode: settings.mode,
      wordCount: settings.wordCount,
      playing: row.active_games > 0,
      createdAt: row.created_at,
    };
  });
}

function closeLobby(lobbyId) {
  db.prepare(`UPDATE lobbies SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`).run(nowIso(), lobbyId);
  db.prepare(`
    UPDATE games SET status = 'finished', finished_at = COALESCE(finished_at, ?)
    WHERE lobby_id = ? AND status = 'active'
  `).run(nowIso(), lobbyId);
  db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).run(lobbyId);
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

function getActiveGameForLobby(lobbyId) {
  return db.prepare(`
    SELECT * FROM games WHERE lobby_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1
  `).get(lobbyId);
}

// A host-stopped game is excluded here (but stays in the lobby's history via
// lobbyGames()) so the live view falls straight back to "waiting" — settings
// editable again — the moment a game is stopped, with no game-over screen.
function getLatestGameForLobby(lobbyId) {
  return db.prepare(`
    SELECT * FROM games WHERE lobby_id = ? AND status != 'stopped' AND dismissed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(lobbyId);
}

// ---------------------------------------------------------------------------
// Bomb mode: players sit in a circle (host-only view); a bomb with a random
// fuse passes from player to player as they type words from the memorized
// list; whoever holds it when it goes off is eliminated. The fuse deadline
// lives only in the DB/server memory and is never sent to clients.
// ---------------------------------------------------------------------------

const BOMB_MIN_TURN_MS = 2000;

function randomBombFuseMs(settings) {
  const minMs = settings.bombMinSeconds * 1000;
  const maxMs = settings.bombMaxSeconds * 1000;
  return crypto.randomInt(minMs, maxMs + 1);
}

// Walks the fixed circle order starting just after `fromUserId`, returning
// the first id still in `alive`. Used both for a normal turn pass (correct
// guess) and after an elimination.
function nextAlivePlayer(order, alive, fromUserId) {
  const aliveSet = new Set(alive);
  const idx = order.indexOf(fromUserId);
  if (idx === -1) {
    return alive[0] ?? null;
  }
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(idx + step) % order.length];
    if (aliveSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function startLobbyGame(lobby, seedOverride) {
  db.prepare(`
    UPDATE games SET status = 'finished', finished_at = COALESCE(finished_at, ?)
    WHERE lobby_id = ? AND status = 'active'
  `).run(nowIso(), lobby.id);

  const settings = lobby.settings;
  const seed =
    Number.isInteger(seedOverride) && seedOverride > 0
      ? seedOverride
      : crypto.randomInt(1, 2147483647);
  const words = sampleWords(settings.wordCount, seed);
  const startedAt = new Date();
  const revealAt = new Date(startedAt.getTime() + settings.revealSeconds * 1000);
  const submitUntil = new Date(revealAt.getTime() + settings.writeSeconds * 1000);

  let bombOrder = null;
  let bombAlive = null;
  let bombHolder = null;
  let bombDeadline = null;
  if (settings.mode === "bomb") {
    const eligible = lobbyMembers(lobby.id).filter((member) => member.id !== lobby.host_user_id);
    bombOrder = eligible.map((member) => member.id);
    bombAlive = [...bombOrder];
    bombHolder = bombOrder[Math.floor(Math.random() * bombOrder.length)];
    bombDeadline = new Date(revealAt.getTime() + randomBombFuseMs(settings));
  }

  const result = db.prepare(`
    INSERT INTO games (
      group_key, seed, words_json, word_count, guessed_count, try_count,
      started_at, reveal_at, submit_until, status, lobby_id, settings_json,
      bomb_order_json, bomb_alive_json, bomb_eliminated_json, bomb_holder_id, bomb_deadline_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `lobby-${lobby.id}`,
    seed,
    JSON.stringify(words),
    words.length,
    startedAt.toISOString(),
    revealAt.toISOString(),
    submitUntil.toISOString(),
    lobby.id,
    JSON.stringify(settings),
    bombOrder && JSON.stringify(bombOrder),
    bombAlive && JSON.stringify(bombAlive),
    bombOrder && JSON.stringify([]),
    bombHolder,
    bombDeadline && bombDeadline.toISOString()
  );
  return db.prepare(`SELECT * FROM games WHERE id = ?`).get(result.lastInsertRowid);
}

function finishGame(gameId) {
  db.prepare(`
    UPDATE games SET status = 'finished', finished_at = COALESCE(finished_at, ?)
    WHERE id = ? AND status = 'active'
  `).run(nowIso(), gameId);
}

function foundCountForGame(gameId) {
  return db.prepare(`
    SELECT COUNT(DISTINCT normalized_word) AS count
    FROM guesses WHERE game_id = ? AND is_correct = 1
  `).get(gameId).count;
}

// Duplicates never consume anything: a mistake belongs to the first player
// who tried that wrong word, a found word to the first who guessed it.
function mistakesByUser(gameId) {
  const rows = db.prepare(`
    SELECT f.user_id AS user_id, COUNT(*) AS mistakes
    FROM (
      SELECT user_id, is_correct, MIN(id) AS first_id
      FROM guesses WHERE game_id = ? GROUP BY normalized_word
    ) f
    WHERE f.is_correct = 0
    GROUP BY f.user_id
  `).all(gameId);
  const map = new Map();
  for (const row of rows) {
    map.set(row.user_id, row.mistakes);
  }
  return map;
}

function globalMistakes(gameId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT MIN(id), is_correct FROM guesses WHERE game_id = ? GROUP BY normalized_word
    )
    WHERE is_correct = 0
  `).get(gameId).count;
}

function correctWordsForGame(gameId) {
  return db.prepare(`
    SELECT g.normalized_word, u.coalition, u.login, MIN(g.id) AS first_id
    FROM guesses g
    JOIN users u ON u.id = g.user_id
    WHERE g.game_id = ? AND g.is_correct = 1
    GROUP BY g.normalized_word
  `).all(gameId);
}

function recentGuesses(gameId, limit = 30) {
  return db.prepare(`
    SELECT g.raw_word, g.is_correct, g.created_at,
           u.login AS user_login, u.image_url AS user_image, u.coalition AS user_coalition
    FROM guesses g
    LEFT JOIN users u ON u.id = g.user_id
    WHERE g.game_id = ?
    ORDER BY g.id DESC
    LIMIT ?
  `).all(gameId, limit);
}

function playerStatsForGame(gameId) {
  return db.prepare(`
    SELECT u.id, u.login, u.image_url, u.coalition,
           SUM(f.is_correct) AS found_count,
           SUM(CASE WHEN f.is_correct = 0 THEN 1 ELSE 0 END) AS mistake_count,
           COUNT(*) AS try_count
    FROM (
      SELECT user_id, is_correct, MIN(id) AS first_id
      FROM guesses
      WHERE game_id = ?
      GROUP BY normalized_word
    ) f
    JOIN users u ON u.id = f.user_id
    GROUP BY u.id
    ORDER BY found_count DESC, mistake_count ASC, u.login ASC
  `).all(gameId);
}

// Cumulative "found words over time" source: one point per found word, with
// the finder's coalition so the versus chart can split into two series.
function timelineForGame(game) {
  const startedMs = new Date(game.started_at).getTime();
  return db.prepare(`
    SELECT g.created_at, u.coalition, MIN(g.id) AS first_id
    FROM guesses g
    JOIN users u ON u.id = g.user_id
    WHERE g.game_id = ? AND g.is_correct = 1
    GROUP BY g.normalized_word
    ORDER BY first_id ASC
  `).all(game.id).map((row) => ({
    t: Math.max(0, Math.round((new Date(row.created_at).getTime() - startedMs) / 1000)),
    coalition: row.coalition,
  }));
}

function lobbyGames(lobbyId) {
  return db.prepare(`
    SELECT id, seed, started_at, finished_at, status, word_count, settings_json
    FROM games WHERE lobby_id = ? ORDER BY id DESC
  `).all(lobbyId).map((game) => ({
    id: game.id,
    seed: game.seed,
    startedAt: game.started_at,
    finishedAt: game.finished_at,
    status: game.status,
    wordCount: game.word_count,
    foundCount: foundCountForGame(game.id),
    settings: parseSettings(game.settings_json),
  }));
}

// Every game a user took part in (any guess counts as playing), with the
// user's personal first-attempt-credited stats.
function userHistory(userId) {
  const games = db.prepare(`
    SELECT g.id, g.seed, g.started_at, g.finished_at, g.status, g.word_count, g.settings_json,
           g.lobby_id, l.name AS lobby_name
    FROM games g
    LEFT JOIN lobbies l ON l.id = g.lobby_id
    WHERE g.id IN (SELECT DISTINCT game_id FROM guesses WHERE user_id = ?)
    ORDER BY g.id DESC
  `).all(userId);

  return games.map((game) => {
    const mine = playerStatsForGame(game.id).find((player) => player.id === userId);
    return {
      id: game.id,
      seed: game.seed,
      startedAt: game.started_at,
      finishedAt: game.finished_at,
      status: game.status,
      wordCount: game.word_count,
      settings: parseSettings(game.settings_json),
      lobbyId: game.lobby_id,
      lobbyName: game.lobby_name,
      foundCount: foundCountForGame(game.id),
      myFound: mine?.found_count ?? 0,
      myMistakes: mine?.mistake_count ?? 0,
    };
  });
}

function gameDetail(gameId) {
  const game = db.prepare(`
    SELECT g.*, l.name AS lobby_name
    FROM games g
    LEFT JOIN lobbies l ON l.id = g.lobby_id
    WHERE g.id = ?
  `).get(gameId);
  if (!game) {
    return null;
  }
  return {
    ...gameStatePayload(game, { includeWords: true }),
    timeline: timelineForGame(game),
    lobbyId: game.lobby_id,
    lobbyName: game.lobby_name,
  };
}

function completeGameIfNeeded(game) {
  if (!game || game.status !== "active") {
    return false;
  }
  const settings = parseSettings(game.settings_json);
  if (settings.mode === "bomb") {
    return false; // bomb games end only through tickBombGame.
  }
  const timeUp = new Date(game.submit_until).getTime() <= Date.now();
  const allFound = foundCountForGame(game.id) >= game.word_count;
  const globalBlown =
    settings.mistakeMode === "global" &&
    Number.isInteger(settings.mistakeLimit) &&
    settings.mistakeLimit > 0 &&
    globalMistakes(game.id) >= settings.mistakeLimit;

  if (timeUp || allFound || globalBlown) {
    finishGame(game.id);
    return true;
  }
  return false;
}

// Eliminates the current bomb holder once their fuse has expired, then either
// finishes the game (nobody left, or every word already found) or arms a
// fresh fuse for the next player in the circle. Returns true if it changed
// anything (so callers know to broadcast). Safe to call opportunistically
// (e.g. right before validating a guess) as well as from the 1s ticker.
function tickBombGame(game) {
  if (!game || game.status !== "active" || !game.bomb_holder_id) {
    return false;
  }
  const now = Date.now();
  if (now < new Date(game.reveal_at).getTime()) {
    return false; // still memorizing, fuse not armed yet
  }
  if (!game.bomb_deadline_at || now < new Date(game.bomb_deadline_at).getTime()) {
    return false;
  }

  const order = JSON.parse(game.bomb_order_json || "[]");
  const alive = JSON.parse(game.bomb_alive_json || "[]").filter((id) => id !== game.bomb_holder_id);
  const eliminated = JSON.parse(game.bomb_eliminated_json || "[]");
  eliminated.push({ userId: game.bomb_holder_id, place: eliminated.length + 1, eliminatedAt: nowIso() });

  if (alive.length === 0 || foundCountForGame(game.id) >= game.word_count) {
    db.prepare(`
      UPDATE games
      SET status = 'finished', finished_at = ?, bomb_alive_json = ?, bomb_eliminated_json = ?, bomb_holder_id = NULL
      WHERE id = ?
    `).run(nowIso(), JSON.stringify(alive), JSON.stringify(eliminated), game.id);
    return true;
  }

  const nextHolder = nextAlivePlayer(order, alive, game.bomb_holder_id);
  const deadline = new Date(now + randomBombFuseMs(parseSettings(game.settings_json)));
  db.prepare(`
    UPDATE games
    SET bomb_alive_json = ?, bomb_eliminated_json = ?, bomb_holder_id = ?, bomb_deadline_at = ?
    WHERE id = ?
  `).run(JSON.stringify(alive), JSON.stringify(eliminated), nextHolder, deadline.toISOString(), game.id);
  return true;
}

// ---------------------------------------------------------------------------
// Lobby state for clients (pushed over WebSocket)
// ---------------------------------------------------------------------------

function gameStatePayload(game, { includeWords }) {
  if (!game) {
    return null;
  }
  const settings = parseSettings(game.settings_json);
  const correct = correctWordsForGame(game.id);
  const coalitionScores = { HORDE: 0, ALLIANCE: 0 };
  const correctWords = {};
  for (const row of correct) {
    correctWords[row.normalized_word] = { coalition: row.coalition, login: row.login };
    if (coalitionScores[row.coalition] !== undefined) {
      coalitionScores[row.coalition] += 1;
    }
  }
  const perUser = mistakesByUser(game.id);
  const mistakes = {};
  for (const [userId, count] of perUser) {
    mistakes[userId] = count;
  }
  const finished = game.status !== "active";

  return {
    id: game.id,
    seed: game.seed,
    status: game.status,
    startedAt: game.started_at,
    revealAt: game.reveal_at,
    submitUntil: game.submit_until,
    finishedAt: game.finished_at,
    wordCount: game.word_count,
    settings,
    foundCount: correct.length,
    globalMistakes: globalMistakes(game.id),
    coalitionScores,
    correctWords,
    mistakes,
    guesses: recentGuesses(game.id),
    players: playerStatsForGame(game.id),
    timeline: finished ? timelineForGame(game) : undefined,
    words: includeWords ? JSON.parse(game.words_json) : undefined,
  };
}

// Bomb mode's payload deliberately omits everything the standard payload
// exposes about found words (correctWords/guesses) and any timing info:
// players only ever learn a count, never the deadline or the word list.
function bombStatePayload(game, viewerUserId, includeWords) {
  if (!game) {
    return null;
  }
  const settings = parseSettings(game.settings_json);
  const order = JSON.parse(game.bomb_order_json || "[]");
  const alive = JSON.parse(game.bomb_alive_json || "[]");
  const eliminated = JSON.parse(game.bomb_eliminated_json || "[]");
  const finished = game.status !== "active";

  return {
    id: game.id,
    seed: game.seed,
    status: game.status,
    startedAt: game.started_at,
    revealAt: game.reveal_at,
    finishedAt: game.finished_at,
    wordCount: game.word_count,
    settings,
    foundCount: foundCountForGame(game.id),
    bomb: {
      order,
      alive,
      eliminated,
      holderId: finished ? null : game.bomb_holder_id,
      isYourTurn: !finished && game.bomb_holder_id === viewerUserId,
      youEliminated: eliminated.some((entry) => entry.userId === viewerUserId),
    },
    words: includeWords ? JSON.parse(game.words_json) : undefined,
  };
}

function buildLobbyState(lobbyId, user) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return null;
  }
  const members = lobbyMembers(lobbyId);
  const isHost = lobby.host_user_id === user.id;
  const game = getLatestGameForLobby(lobbyId);
  const gameSettings = game ? parseSettings(game.settings_json) : null;
  const isBomb = gameSettings?.mode === "bomb";
  const gamePayload = isBomb
    ? bombStatePayload(game, user.id, isHost)
    : gameStatePayload(game, { includeWords: isHost });

  let locked = false;
  if (
    !isBomb &&
    gamePayload &&
    gamePayload.status === "active" &&
    gamePayload.settings.mistakeMode === "per_user" &&
    Number.isInteger(gamePayload.settings.mistakeLimit) &&
    gamePayload.settings.mistakeLimit > 0
  ) {
    locked = (gamePayload.mistakes[user.id] ?? 0) >= gamePayload.settings.mistakeLimit;
  }

  return {
    lobby: {
      id: lobby.id,
      name: lobby.name,
      status: lobby.status,
      settings: lobby.settings,
      hostId: lobby.host_user_id,
      games: lobbyGames(lobbyId),
      members: members.map((member) => ({
        ...publicUser(member),
        isHost: member.id === lobby.host_user_id,
        mistakes: !isBomb && gamePayload ? gamePayload.mistakes[member.id] ?? 0 : 0,
      })),
    },
    game: gamePayload,
    you: {
      ...publicUser(user),
      role: isHost ? "host" : "player",
      mistakes: !isBomb && gamePayload ? gamePayload.mistakes[user.id] ?? 0 : 0,
      locked,
      eliminated: isBomb ? Boolean(gamePayload?.bomb.youEliminated) : false,
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket infrastructure: REST performs actions, sockets receive state.
// ---------------------------------------------------------------------------

const lobbySockets = new Map(); // lobbyId -> Set<ws>
const homeSockets = new Set();

function wsSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastLobby(lobbyId) {
  const sockets = lobbySockets.get(lobbyId);
  if (!sockets?.size) {
    return;
  }
  for (const ws of sockets) {
    const state = buildLobbyState(lobbyId, ws.user);
    wsSend(ws, state ? { type: "state", state } : { type: "closed" });
  }
}

function broadcastLobbyClosed(lobbyId) {
  const sockets = lobbySockets.get(lobbyId);
  if (!sockets?.size) {
    return;
  }
  for (const ws of sockets) {
    wsSend(ws, { type: "closed" });
  }
}

function kickMember(lobbyId, userId) {
  db.prepare(`DELETE FROM lobby_members WHERE user_id = ? AND lobby_id = ?`).run(userId, lobbyId);
  const sockets = lobbySockets.get(lobbyId);
  if (!sockets) {
    return;
  }
  for (const ws of sockets) {
    if (ws.user?.id === userId) {
      wsSend(ws, { type: "closed" });
    }
  }
}

function broadcastHome() {
  if (!homeSockets.size) {
    return;
  }
  const payload = { type: "lobbies", lobbies: listOpenLobbies() };
  for (const ws of homeSockets) {
    wsSend(ws, payload);
  }
}

function notifyLobbyChange(lobbyId) {
  broadcastLobby(lobbyId);
  broadcastHome();
}

// ---------------------------------------------------------------------------
// Auth pages & OAuth (unchanged flow)
// ---------------------------------------------------------------------------

function safeNextPath(value) {
  const next = String(value || "");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// Pages need a connected user with a coalition: the coalition drives the
// theme, so the login page handles both steps before letting anyone through.
function requirePageAuth(req, res, next) {
  const user = getSessionUser(req);
  if (user?.coalition) {
    req.user = user;
    return next();
  }
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
}

function requireApiAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: "Connexion requise" });
  }
  if (!user.coalition) {
    return res.status(403).json({ error: "Choisissez d'abord une coalition" });
  }
  req.user = user;
  return next();
}

function renderLoginProfile(user) {
  if (!user) {
    return "";
  }
  return `
    ${user.image_url ? `<img class="avatar avatar-lg" src="${escapeHtml(user.image_url)}" alt="" />` : ""}
    <strong>${escapeHtml(user.login)}</strong>
  `;
}

function renderLoginPage(nextPath, user) {
  return pageShell({
    title: "Connexion - Piscine Games",
    body: `
      <main class="tv-stage empty-state login-screen" data-page="login" data-next="${escapeHtml(nextPath)}">
        <div class="empty-card login-card" id="loginStep" ${user ? "hidden" : ""}>
          <p class="eyebrow">Piscine Games</p>
          <h1>Connexion</h1>
          <p class="lede">Connectez-vous avec votre compte 42 pour accéder aux jeux de la piscine.</p>
          <button type="button" class="primary" id="loginButton">Se connecter avec 42</button>
          <div class="message" id="loginMessage"></div>
        </div>
        <div class="empty-card login-card" id="coalitionStep" ${user ? "" : "hidden"}>
          <p class="eyebrow">Choisissez votre camp</p>
          <h1>Coalition</h1>
          <div class="login-profile" id="loginProfile">${renderLoginProfile(user)}</div>
          <p class="lede">Votre profil intra n'appartient ni à la Horde, ni à l'Alliance. Choisissez une coalition pour les jeux.</p>
          <div class="coalition-choices">
            <button type="button" data-coalition="HORDE">
              <img src="/assets/horde.svg" alt="" />
              <span>Horde</span>
            </button>
            <button type="button" data-coalition="ALLIANCE">
              <img src="/assets/alliance.svg" alt="" />
              <span>Alliance</span>
            </button>
          </div>
          <div class="message" id="coalitionMessage"></div>
        </div>
      </main>
    `,
    script: `/assets/login.js`,
  });
}

// Rendered inside the OAuth popup: hand the result back to the page that
// opened it (which may itself live inside an iframe), then close.
function renderAuthPopupResult({ ok, error = null }) {
  const payload = JSON.stringify({ type: "42-auth", ok, error });
  return pageShell({
    title: "Connexion 42",
    body: `
      <main class="screen auth-popup-screen">
        <p class="lede">${ok ? "Connexion réussie, vous pouvez fermer cette fenêtre." : escapeHtml(error || "Connexion impossible.")}</p>
      </main>
      <script>
        const payload = ${payload};
        if (window.opener) {
          try {
            window.opener.postMessage(payload, window.location.origin);
          } catch {}
        }
        window.close();
      </script>
    `,
  });
}

app.get("/auth/42", (req, res) => {
  if (!FT_CLIENT_ID) {
    return res.status(500).send(renderAuthPopupResult({ ok: false, error: "OAuth 42 non configuré (FT_CLIENT_ID manquant)." }));
  }
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, req, "oauth_state", state, 600);
  return res.redirect(buildAuthorizeUrl(req, state));
});

app.get("/auth/42/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = parseCookies(req).oauth_state;
  setCookie(res, req, "oauth_state", "", 0);

  if (error) {
    return res.send(renderAuthPopupResult({ ok: false, error: "Connexion refusée sur l'intra." }));
  }
  if (!code || !state || state !== expectedState) {
    return res.send(renderAuthPopupResult({ ok: false, error: "État OAuth invalide, réessayez." }));
  }

  try {
    const token = await exchangeCode(req, String(code));
    const profile = await fetchIntraProfile(token.access_token);
    const user = upsertUser(profile);
    createSession(res, req, user.id);
    return res.send(renderAuthPopupResult({ ok: true }));
  } catch (err) {
    console.error("42 OAuth callback failed:", err);
    return res.send(renderAuthPopupResult({ ok: false, error: "Connexion 42 impossible, réessayez." }));
  }
});

app.post("/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ user: publicUser(getSessionUser(req)) });
});

app.post("/api/me/coalition", (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: "Connexion requise" });
  }
  const coalition = String(req.body?.coalition || "").toUpperCase();
  if (!COALITIONS.includes(coalition)) {
    return res.status(400).json({ error: "Coalition invalide" });
  }
  if (user.coalition_source === "intra") {
    return res.status(403).json({ error: "Coalition déjà fixée par l'intra" });
  }
  setUserCoalition(user.id, coalition);
  return res.json({ user: publicUser(getSessionUser(req)) });
});

app.get("/login", (req, res) => {
  const nextPath = safeNextPath(req.query?.next);
  const user = getSessionUser(req);
  if (user?.coalition) {
    return res.redirect(nextPath);
  }
  return res.send(renderLoginPage(nextPath, user));
});

// ---------------------------------------------------------------------------
// Lobby API
// ---------------------------------------------------------------------------

app.post("/api/lobby", requireApiAuth, (req, res) => {
  const existing = memberLobbyId(req.user.id);
  if (existing) {
    return res.status(409).json({ error: "Vous êtes déjà dans un salon", lobbyId: existing });
  }
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!name) {
    return res.status(400).json({ error: "Nom du salon manquant" });
  }
  const settings = normalizeSettings(req.body?.settings);
  const result = db.prepare(`
    INSERT INTO lobbies (name, host_user_id, settings_json, status, created_at)
    VALUES (?, ?, ?, 'open', ?)
  `).run(name, req.user.id, JSON.stringify(settings), nowIso());
  const lobbyId = result.lastInsertRowid;
  db.prepare(`INSERT INTO lobby_members (user_id, lobby_id, joined_at) VALUES (?, ?, ?)`)
    .run(req.user.id, lobbyId, nowIso());
  broadcastHome();
  return res.json({ lobbyId });
});

app.get("/api/lobbies", requireApiAuth, (_req, res) => {
  res.json({ lobbies: listOpenLobbies() });
});

function withLobby(req, res, next) {
  const lobby = getLobby(Number.parseInt(req.params.id, 10));
  if (!lobby || lobby.status !== "open") {
    return res.status(404).json({ error: "Salon introuvable ou fermé" });
  }
  req.lobby = lobby;
  return next();
}

function joinLobby(user, lobby) {
  db.prepare(`INSERT INTO lobby_members (user_id, lobby_id, joined_at) VALUES (?, ?, ?)`)
    .run(user.id, lobby.id, nowIso());
}

app.post("/api/lobby/:id/join", requireApiAuth, withLobby, (req, res) => {
  const current = memberLobbyId(req.user.id);
  if (current === req.lobby.id) {
    return res.json({ ok: true, lobbyId: req.lobby.id });
  }
  if (current) {
    return res.status(409).json({ error: "Vous êtes déjà dans un autre salon", lobbyId: current });
  }
  if (!coalitionAllowed(req.lobby.settings, req.user.coalition)) {
    return res.status(403).json({ error: "Votre coalition n'est pas autorisée dans ce salon" });
  }
  joinLobby(req.user, req.lobby);
  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true, lobbyId: req.lobby.id });
});

app.post("/api/lobby/:id/leave", requireApiAuth, withLobby, (req, res) => {
  if (memberLobbyId(req.user.id) !== req.lobby.id) {
    return res.status(403).json({ error: "Vous n'êtes pas dans ce salon" });
  }
  if (req.lobby.host_user_id === req.user.id) {
    // The host owns the lobby: leaving closes it for everyone.
    closeLobby(req.lobby.id);
    broadcastLobbyClosed(req.lobby.id);
    broadcastHome();
    return res.json({ ok: true, closed: true });
  }
  db.prepare(`DELETE FROM lobby_members WHERE user_id = ?`).run(req.user.id);
  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true });
});

// Settings stay editable between games (each game snapshots them at start),
// but never while one is running.
app.post("/api/lobby/:id/settings", requireApiAuth, withLobby, (req, res) => {
  if (req.lobby.host_user_id !== req.user.id) {
    return res.status(403).json({ error: "Seul l'hôte peut modifier les règles" });
  }
  if (getActiveGameForLobby(req.lobby.id)) {
    return res.status(409).json({ error: "Impossible de modifier les règles pendant une partie" });
  }
  const settings = normalizeSettings(req.body?.settings ?? req.body);
  const confirm = Boolean(req.body?.confirm);
  const toKick = lobbyMembers(req.lobby.id).filter(
    (member) => member.id !== req.lobby.host_user_id && !coalitionAllowed(settings, member.coalition)
  );
  if (toKick.length && !confirm) {
    return res.status(409).json({ error: "faction_conflict", kicked: toKick.length });
  }
  for (const member of toKick) {
    kickMember(req.lobby.id, member.id);
  }
  db.prepare(`UPDATE lobbies SET settings_json = ? WHERE id = ?`).run(JSON.stringify(settings), req.lobby.id);
  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true, settings, kicked: toKick.length });
});

app.get("/api/me/history", requireApiAuth, (req, res) => {
  const games = userHistory(req.user.id);
  const summary = {
    games: games.length,
    wordsFound: games.reduce((sum, game) => sum + game.myFound, 0),
    mistakes: games.reduce((sum, game) => sum + game.myMistakes, 0),
  };
  res.json({ summary, games });
});

app.get("/api/game/:id", requireApiAuth, (req, res) => {
  const detail = gameDetail(Number.parseInt(req.params.id, 10));
  if (!detail) {
    return res.status(404).json({ error: "Partie introuvable" });
  }
  return res.json({ game: detail });
});

app.post("/api/lobby/:id/start", requireApiAuth, withLobby, (req, res) => {
  if (req.lobby.host_user_id !== req.user.id) {
    return res.status(403).json({ error: "Seul l'hôte peut lancer une partie" });
  }
  if (req.lobby.settings.mode === "bomb") {
    const eligible = lobbyMembers(req.lobby.id).filter((member) => member.id !== req.lobby.host_user_id);
    if (eligible.length < 2) {
      return res.status(400).json({ error: "Il faut au moins 2 joueurs (hors hôte) pour le mode Bombe" });
    }
  }
  const requestedSeed = Number.parseInt(req.body?.seed ?? "", 10);
  const game = startLobbyGame(req.lobby, Number.isFinite(requestedSeed) ? requestedSeed : undefined);
  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true, gameId: game.id, seed: game.seed });
});

// Ends the current game early without starting a new one: the lobby falls
// back to the waiting/settings view (getLatestGameForLobby skips 'stopped'
// games), so the host can tweak settings without losing the game from the
// lobby's history.
app.post("/api/lobby/:id/stop", requireApiAuth, withLobby, (req, res) => {
  if (req.lobby.host_user_id !== req.user.id) {
    return res.status(403).json({ error: "Seul l'hôte peut arrêter la partie" });
  }
  const game = getActiveGameForLobby(req.lobby.id);
  if (!game) {
    return res.status(409).json({ error: "Aucune partie en cours" });
  }
  db.prepare(`
    UPDATE games SET status = 'stopped', finished_at = COALESCE(finished_at, ?), bomb_holder_id = NULL
    WHERE id = ?
  `).run(nowIso(), game.id);
  notifyLobbyChange(req.lobby.id);
  broadcastHome();
  return res.json({ ok: true });
});

// Acknowledges a finished game's results and returns everyone to the
// waiting/settings view, without starting a new game (unlike /start, which
// would also work but immediately launches a fresh round).
app.post("/api/lobby/:id/dismiss", requireApiAuth, withLobby, (req, res) => {
  if (req.lobby.host_user_id !== req.user.id) {
    return res.status(403).json({ error: "Seul l'hôte peut revenir aux réglages" });
  }
  const game = getLatestGameForLobby(req.lobby.id);
  if (!game || game.status === "active") {
    return res.status(409).json({ error: "Aucune partie terminée à fermer" });
  }
  db.prepare(`UPDATE games SET dismissed_at = ? WHERE id = ?`).run(nowIso(), game.id);
  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true });
});

// Bomb mode: only the current holder may guess; a correct new word passes
// the bomb to the next alive player (extending the fuse to a 2s minimum if
// it was about to expire); an already-found word is a no-op message; a wrong
// word just fails silently, no elimination, no turn change.
function handleBombGuess(req, res, game, user) {
  if (tickBombGame(game)) {
    notifyLobbyChange(req.lobby.id);
    game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(game.id);
  }
  if (game.status !== "active") {
    return res.status(403).json({ error: "Partie terminée" });
  }

  const now = Date.now();
  if (now < new Date(game.reveal_at).getTime()) {
    return res.status(403).json({ error: "Phase de mémorisation en cours" });
  }
  if (game.bomb_holder_id !== user.id) {
    return res.status(403).json({ error: "Ce n'est pas votre tour" });
  }

  const rawWord = String(req.body?.word ?? "").trim();
  const normalizedWord = normalizeGuess(rawWord);
  if (!normalizedWord) {
    return res.status(400).json({ error: "Mot invalide" });
  }

  const alreadyFound = db.prepare(`
    SELECT 1 FROM guesses WHERE game_id = ? AND normalized_word = ? AND is_correct = 1 LIMIT 1
  `).get(game.id, normalizedWord);
  if (alreadyFound) {
    return res.json({ ok: true, correct: false, alreadyFound: true });
  }

  const words = new Set(JSON.parse(game.words_json).map((word) => normalizeGuess(word)));
  if (!words.has(normalizedWord)) {
    return res.json({ ok: true, correct: false });
  }

  db.prepare(`
    INSERT INTO guesses (game_id, raw_word, normalized_word, is_correct, created_at, user_id)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(game.id, rawWord, normalizedWord, nowIso(), user.id);

  if (foundCountForGame(game.id) >= game.word_count) {
    db.prepare(`UPDATE games SET status = 'finished', finished_at = ?, bomb_holder_id = NULL WHERE id = ?`)
      .run(nowIso(), game.id);
    notifyLobbyChange(req.lobby.id);
    broadcastHome();
    return res.json({ ok: true, correct: true, gameOver: true });
  }

  const order = JSON.parse(game.bomb_order_json || "[]");
  const alive = JSON.parse(game.bomb_alive_json || "[]");
  const nextHolder = nextAlivePlayer(order, alive, user.id);
  let deadlineMs = new Date(game.bomb_deadline_at).getTime();
  if (deadlineMs - now < BOMB_MIN_TURN_MS) {
    deadlineMs = now + BOMB_MIN_TURN_MS;
  }
  db.prepare(`UPDATE games SET bomb_holder_id = ?, bomb_deadline_at = ? WHERE id = ?`)
    .run(nextHolder, new Date(deadlineMs).toISOString(), game.id);

  notifyLobbyChange(req.lobby.id);
  return res.json({ ok: true, correct: true });
}

app.post("/api/lobby/:id/guess", requireApiAuth, withLobby, (req, res) => {
  const user = req.user;
  if (memberLobbyId(user.id) !== req.lobby.id) {
    return res.status(403).json({ error: "Vous n'êtes pas dans ce salon" });
  }

  const game = getActiveGameForLobby(req.lobby.id);
  if (!game) {
    return res.status(409).json({ error: "Aucune partie en cours" });
  }

  const settings = parseSettings(game.settings_json);
  if (settings.mode === "bomb") {
    return handleBombGuess(req, res, game, user);
  }

  if (completeGameIfNeeded(game)) {
    broadcastLobby(req.lobby.id);
    return res.status(403).json({ error: "Partie terminée" });
  }

  const now = Date.now();
  if (now < new Date(game.reveal_at).getTime()) {
    return res.status(403).json({ error: "Phase de mémorisation en cours" });
  }

  const rawWord = String(req.body?.word ?? "").trim();
  const normalizedWord = normalizeGuess(rawWord);
  if (!normalizedWord) {
    return res.status(400).json({ error: "Mot invalide" });
  }

  // Per-user allowance exhausted: the player is locked for the whole game.
  if (settings.mistakeMode === "per_user" && Number.isInteger(settings.mistakeLimit) && settings.mistakeLimit > 0) {
    const mine = mistakesByUser(game.id).get(user.id) ?? 0;
    if (mine >= settings.mistakeLimit) {
      return res.status(403).json({ error: "Plus d'essais : vous avez épuisé vos erreurs", locked: true });
    }
  }

  const previous = db.prepare(`
    SELECT g.is_correct, u.login AS first_login
    FROM guesses g
    LEFT JOIN users u ON u.id = g.user_id
    WHERE g.game_id = ? AND g.normalized_word = ?
    ORDER BY g.id ASC
    LIMIT 1
  `).get(game.id, normalizedWord);

  if (previous) {
    db.prepare(`
      INSERT INTO guesses (game_id, raw_word, normalized_word, is_correct, created_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(game.id, rawWord, normalizedWord, previous.is_correct ? 1 : 0, nowIso(), user.id);
    broadcastLobby(req.lobby.id);
    return res.json({
      ok: true,
      correct: false,
      alreadyFound: Boolean(previous.is_correct),
      alreadyTried: !previous.is_correct,
      firstLogin: previous.first_login,
    });
  }

  const words = new Set(JSON.parse(game.words_json).map((word) => normalizeGuess(word)));
  const isCorrect = words.has(normalizedWord);

  // mistakeLimit 0 means mistakes are disabled: wrong words are rejected
  // outright and never recorded.
  if (!isCorrect && settings.mistakeLimit === 0) {
    return res.json({ ok: true, correct: false, rejected: true, error: "Mot incorrect — les erreurs sont désactivées" });
  }

  db.prepare(`
    INSERT INTO guesses (game_id, raw_word, normalized_word, is_correct, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game.id, rawWord, normalizedWord, isCorrect ? 1 : 0, nowIso(), user.id);

  const finishedNow = completeGameIfNeeded(db.prepare(`SELECT * FROM games WHERE id = ?`).get(game.id));
  broadcastLobby(req.lobby.id);
  if (finishedNow) {
    broadcastHome();
  }
  return res.json({ ok: true, correct: isCorrect });
});

app.get("/api/lobby/:id/state", requireApiAuth, (req, res) => {
  const state = buildLobbyState(Number.parseInt(req.params.id, 10), req.user);
  if (!state) {
    return res.status(404).json({ error: "Salon introuvable" });
  }
  return res.json({ state });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function renderUserChip(user) {
  const theme = themeFor(user);
  return `
    <div class="user-chip">
      ${user.image_url ? `<img class="avatar" src="${escapeHtml(user.image_url)}" alt="" />` : ""}
      <div class="user-chip-main">
        <strong>${escapeHtml(user.login)}</strong>
        <span>${theme.factionName}</span>
      </div>
      <img class="user-chip-emblem" src="${theme.emblem}" alt="" />
      <button type="button" class="ghost-button user-chip-logout" id="logoutButton">Quitter</button>
    </div>
  `;
}

function renderHomePage(user) {
  const theme = themeFor(user);
  return pageShell({
    title: "Piscine Games - Salons",
    bodyClass: theme.bodyClass,
    body: `
      <main class="screen home-screen" data-page="home">
        <header class="tablet-topbar">
          <div class="faction-badge">
            <div class="faction-mark faction-mark-small" aria-hidden="true"><img src="${theme.emblem}" alt="" /></div>
            <div>
              <span class="eyebrow">${theme.factionTag}</span>
              <strong>Piscine Games</strong>
            </div>
          </div>
          <div class="tablet-topbar-side">
            <div class="auth-area">${renderUserChip(user)}</div>
            <a class="secondary" href="/history">Mon historique</a>
          </div>
        </header>

        <section class="home-hero home-hero-single">
          <div class="home-copy">
            <p class="eyebrow">Memory multijoueur</p>
            <h1>Salons</h1>
            <p class="lede">Créez un salon en un clic — vous réglerez les règles depuis le salon, avant de lancer la partie.</p>
            <form class="home-cta create-inline" id="createLobbyForm">
              <input id="lobbyName" name="name" maxlength="40" placeholder="Nom du salon (ex : Piscine C1)" required />
              <button type="submit" class="primary">Créer un salon</button>
            </form>
            <div class="message" id="createMessage"></div>
          </div>
        </section>

        <section class="home-grid">
          <article class="content-card">
            <div class="content-card-head">
              <div>
                <span class="panel-kicker">En direct</span>
                <strong>Salons ouverts</strong>
              </div>
              <span class="badge" id="lobbyCountBadge">0 salon</span>
            </div>
            <div class="history-list" id="lobbyList">
              <div class="empty-copy">Aucun salon ouvert pour le moment.</div>
            </div>
          </article>
        </section>
      </main>
    `,
    script: `/assets/home.js`,
  });
}

function renderHostPage(user, lobby) {
  const theme = themeFor(user);
  return pageShell({
    title: `${lobby.name} - Hôte`,
    bodyClass: theme.bodyClass,
    body: `
      <main class="tv-stage host-stage" data-page="lobby-host" data-lobby-id="${lobby.id}" data-user-id="${user.id}">
        <header class="tv-topbar">
          <div class="lobby-heading">
            <div class="faction-mark faction-mark-small" aria-hidden="true"><img src="${theme.emblem}" alt="" /></div>
            <div>
              <span class="eyebrow">Salon</span>
              <strong id="lobbyTitle">${escapeHtml(lobby.name)}</strong>
            </div>
            <div class="status-pill" id="phasePill">En attente</div>
          </div>
          <div class="versus-scores" id="versusScores" hidden>
            <span class="score-horde"><img src="/assets/horde.svg" alt="Horde" /><strong id="scoreHorde">0</strong></span>
            <span class="score-vs">VS</span>
            <span class="score-alliance"><strong id="scoreAlliance">0</strong><img src="/assets/alliance.svg" alt="Alliance" /></span>
          </div>
          <div class="host-controls">
            <label class="seed-field seed-inline">
              <span>Seed</span>
              <input id="seedInput" inputmode="numeric" />
            </label>
            <button type="button" class="ghost-button" id="randomSeedButton">Aléatoire</button>
            <button type="button" class="ghost-button" id="dismissGameButton" hidden>Modifier les réglages</button>
            <button type="button" class="primary" id="startGameButton">Lancer une partie</button>
            <button type="button" class="ghost-button danger-button" id="closeLobbyButton">Fermer le salon</button>
          </div>
        </header>

        <section class="host-body">
          <div class="host-view" id="viewWaiting">
            <div class="host-waiting-grid">
              <article class="content-card">
                <div class="content-card-head">
                  <div>
                    <span class="panel-kicker">Joueurs</span>
                    <strong>Dans le salon</strong>
                  </div>
                  <span class="badge" id="playerCountBadge">0</span>
                </div>
                <div class="member-list" id="memberList"></div>
              </article>
              <article class="content-card">
                <div class="content-card-head">
                  <div>
                    <span class="panel-kicker">Règles</span>
                    <strong>Paramètres</strong>
                  </div>
                </div>
                <form id="settingsForm">
                  <div class="settings-grid">
                    <label class="seed-field">
                      <span>Mots affichés</span>
                      <input id="setWordCount" type="number" min="10" max="400" />
                    </label>
                    <label class="seed-field">
                      <span>Mémorisation (s)</span>
                      <input id="setRevealSeconds" type="number" min="5" max="600" />
                    </label>
                    <label class="seed-field" id="writeSecondsField">
                      <span>Écriture (s)</span>
                      <input id="setWriteSeconds" type="number" min="30" max="7200" />
                    </label>
                    <label class="seed-field">
                      <span>Mode de jeu</span>
                      <select id="setMode">
                        <option value="coop">Coopératif</option>
                        <option value="versus">Horde vs Alliance</option>
                        <option value="bomb">Bombe</option>
                      </select>
                    </label>
                    <label class="seed-field" id="mistakeModeField">
                      <span>Erreurs</span>
                      <select id="setMistakeMode">
                        <option value="per_user">Par joueur</option>
                        <option value="global">Globales</option>
                      </select>
                    </label>
                    <label class="seed-field" id="mistakePolicyField">
                      <span>Limite d'erreurs</span>
                      <select id="setMistakePolicy">
                        <option value="limited">Limitées</option>
                        <option value="endless">Illimitées</option>
                        <option value="disabled">Interdites</option>
                      </select>
                    </label>
                    <label class="seed-field" id="mistakeLimitField">
                      <span>Nombre d'erreurs</span>
                      <input id="setMistakeLimit" type="number" min="1" max="100000" />
                    </label>
                    <label class="seed-field">
                      <span>Coalitions autorisées</span>
                      <select id="setAllowedCoalitions">
                        <option value="BOTH">Horde et Alliance</option>
                        <option value="HORDE">Horde uniquement</option>
                        <option value="ALLIANCE">Alliance uniquement</option>
                      </select>
                    </label>
                    <label class="seed-field">
                      <span>Difficulté</span>
                      <select id="setDifficulty">
                        <option value="easy">Facile</option>
                        <option value="hard">Difficile</option>
                      </select>
                    </label>
                    <label class="seed-field" id="bombMinSecondsField">
                      <span>Bombe min (s)</span>
                      <input id="setBombMinSeconds" type="number" min="3" max="300" />
                    </label>
                    <label class="seed-field" id="bombMaxSecondsField">
                      <span>Bombe max (s)</span>
                      <input id="setBombMaxSeconds" type="number" min="3" max="300" />
                    </label>
                  </div>
                  <div class="launch-actions">
                    <button class="primary" type="submit">Enregistrer les règles</button>
                  </div>
                  <div class="message" id="settingsMessage"></div>
                </form>
              </article>
            </div>
            <article class="content-card">
              <div class="content-card-head">
                <div>
                  <span class="panel-kicker">Historique</span>
                  <strong>Parties de ce salon</strong>
                </div>
                <span class="badge" id="lobbyGamesBadge">0 partie</span>
              </div>
              <div class="history-list" id="lobbyGamesList"></div>
            </article>
          </div>

          <div class="host-view" id="viewBoard" hidden>
            <div class="tv-board-shell">
              <div class="tv-board-frame">
                <div class="board board-live" id="wordBoard"></div>
                <div class="tv-footer-pill" id="boardFooter">PHASE DE JEU</div>
              </div>
            </div>
            <div class="tv-stats host-game-stats">
              <article class="status-card stat-card"><span class="status-label">Temps</span><strong class="status-value" id="tvTimer">0:00</strong></article>
              <article class="status-card stat-card"><span class="status-label">Trouvés</span><strong class="status-value" id="tvFound">0 / 0</strong></article>
              <article class="status-card stat-card"><span class="status-label">Erreurs</span><strong class="status-value" id="tvMistakes">0</strong></article>
            </div>
          </div>

          <div class="host-view" id="viewBomb" hidden>
            <div class="bomb-shell">
              <div class="bomb-circle" id="bombCircle">
                <div class="bomb-core" id="bombCore">
                  <span class="bomb-icon">💣</span>
                </div>
                <div class="bomb-arrow" id="bombArrow" hidden></div>
              </div>
            </div>
            <div class="tv-stats host-game-stats bomb-stats">
              <article class="status-card stat-card"><span class="status-label">Trouvés</span><strong class="status-value" id="bombFound">0 / 0</strong></article>
              <article class="status-card stat-card"><span class="status-label">Survivants</span><strong class="status-value" id="bombAliveCount">0</strong></article>
            </div>
            <div class="bomb-result" id="bombResult" hidden></div>
          </div>

          <div class="host-view" id="viewStats" hidden>
            <div class="stats-grid">
              <article class="content-card">
                <div class="content-card-head">
                  <div>
                    <span class="panel-kicker">Statistiques</span>
                    <strong id="statsTitle">Fin de partie</strong>
                  </div>
                  <span class="badge" id="statsVerdict"></span>
                </div>
                <div class="chart-card">
                  <div class="chart-legend" id="chartLegend"></div>
                  <div class="chart-holder" id="foundChart"></div>
                </div>
              </article>
              <article class="content-card">
                <div class="content-card-head">
                  <div><span class="panel-kicker">Classement</span><strong>Mots trouvés</strong></div>
                </div>
                <div class="leaderboard-list" id="statsByFound"></div>
              </article>
              <article class="content-card">
                <div class="content-card-head">
                  <div><span class="panel-kicker">Classement</span><strong>Erreurs</strong></div>
                </div>
                <div class="leaderboard-list" id="statsByFails"></div>
              </article>
            </div>
          </div>
        </section>
      </main>
    `,
    script: `/assets/host.js`,
  });
}

function renderPlayerPage(user, lobby) {
  const theme = themeFor(user);
  return pageShell({
    title: `${lobby.name}`,
    bodyClass: theme.bodyClass,
    body: `
      <main class="screen tablet-screen" data-page="lobby-player" data-lobby-id="${lobby.id}" data-user-id="${user.id}">
        <header class="tablet-topbar">
          <div class="tablet-title">
            <div class="faction-badge">
              <div class="faction-mark faction-mark-small" aria-hidden="true"><img src="${theme.emblem}" alt="" /></div>
              <div>
                <span class="eyebrow">Salon</span>
                <strong id="lobbyTitle">${escapeHtml(lobby.name)}</strong>
              </div>
            </div>
          </div>
          <div class="tablet-topbar-side">
            <div class="auth-area">${renderUserChip(user)}</div>
            <div class="status-pill" id="phasePill">En attente</div>
            <button type="button" class="ghost-button danger-button" id="leaveLobbyButton">Quitter la partie</button>
          </div>
        </header>

        <div class="player-view" id="viewWaiting">
          <section class="tablet-layout">
            <article class="submit-card">
              <div class="panel-kicker">Joueurs</div>
              <div class="member-list" id="memberList"></div>
            </article>
            <article class="submit-card">
              <div class="panel-kicker">Règles du salon</div>
              <div class="settings-summary" id="settingsSummary"></div>
              <div class="submit-helper">En attente du lancement par l'hôte…</div>
            </article>
          </section>
          <section class="submit-card">
            <div class="panel-kicker">Parties de ce salon</div>
            <div class="history-list" id="lobbyGamesList"></div>
          </section>
        </div>

        <div class="player-view" id="viewGame" hidden>
          <section class="tablet-stats" id="gameStats">
            <article class="status-card stat-card" id="gameTimerCard"><span class="status-label">Temps</span><strong class="status-value" id="gameTimer">0:00</strong></article>
            <article class="status-card stat-card"><span class="status-label">Trouvés</span><strong class="status-value" id="foundCount">0 / 0</strong></article>
            <article class="status-card stat-card" id="mistakesCard"><span class="status-label" id="mistakesLabel">Erreurs restantes</span><strong class="status-value" id="mistakesValue">-</strong></article>
          </section>
          <div class="bomb-turn-banner" id="bombTurnBanner" hidden></div>
          <section class="tablet-layout">
            <form class="submit-card" id="guessForm">
              <div class="panel-kicker">Saisir les réponses</div>
              <div class="submit-form">
                <input id="guessInput" name="guess" autocomplete="off" placeholder="Tapez un mot puis validez" />
                <button type="submit">Valider</button>
              </div>
              <div class="message" id="message"></div>
            </form>
            <section class="submit-card" id="guessHistoryCard">
              <div class="panel-kicker">Dernières réponses</div>
              <div id="guessList" class="guess-list"></div>
            </section>
          </section>
        </div>

        <div class="player-view" id="viewFinished" hidden>
          <section class="submit-card leaderboard-card">
            <div class="panel-kicker">Résultats de la partie</div>
            <div class="leaderboard-highlights" id="leaderboardHighlights"></div>
            <div class="leaderboard-list" id="leaderboardList"></div>
            <div class="submit-helper">L'hôte peut relancer une partie à tout moment, restez dans le salon.</div>
          </section>
        </div>
      </main>
    `,
    script: `/assets/player.js`,
  });
}

function renderHistoryPage(user) {
  const theme = themeFor(user);
  return pageShell({
    title: "Mon historique - Piscine Games",
    bodyClass: theme.bodyClass,
    body: `
      <main class="screen tablet-screen" data-page="history">
        <header class="tablet-topbar">
          <div class="tablet-title">
            <div class="faction-badge">
              <div class="faction-mark faction-mark-small" aria-hidden="true"><img src="${theme.emblem}" alt="" /></div>
              <div>
                <span class="eyebrow">Statistiques personnelles</span>
                <strong>Mon historique</strong>
              </div>
            </div>
          </div>
          <div class="tablet-topbar-side">
            <div class="auth-area">${renderUserChip(user)}</div>
            <a class="secondary" href="/">Accueil</a>
          </div>
        </header>

        <section class="tablet-stats history-summary">
          <article class="status-card stat-card"><span class="status-label">Parties jouées</span><strong class="status-value" id="sumGames">-</strong></article>
          <article class="status-card stat-card"><span class="status-label">Mots trouvés</span><strong class="status-value" id="sumFound">-</strong></article>
          <article class="status-card stat-card"><span class="status-label">Erreurs</span><strong class="status-value" id="sumMistakes">-</strong></article>
          <article class="status-card stat-card"><span class="status-label">Précision</span><strong class="status-value" id="sumAccuracy">-</strong></article>
        </section>

        <section class="content-card">
          <div class="content-card-head">
            <div>
              <span class="panel-kicker">Parties</span>
              <strong>Toutes mes parties</strong>
            </div>
            <span class="badge" id="historyCountBadge">0 partie</span>
          </div>
          <div class="history-list" id="historyList">
            <div class="empty-copy">Chargement…</div>
          </div>
        </section>
      </main>
    `,
    script: `/assets/history.js`,
  });
}

function renderGamePage(user, gameId) {
  const theme = themeFor(user);
  return pageShell({
    title: `Partie #${gameId} - Piscine Games`,
    bodyClass: theme.bodyClass,
    body: `
      <main class="screen tablet-screen" data-page="game-detail" data-game-id="${gameId}">
        <header class="tablet-topbar">
          <div class="tablet-title">
            <div class="faction-badge">
              <div class="faction-mark faction-mark-small" aria-hidden="true"><img src="${theme.emblem}" alt="" /></div>
              <div>
                <span class="eyebrow" id="gameSubtitle">Partie #${gameId}</span>
                <strong id="gameTitle">Chargement…</strong>
              </div>
            </div>
          </div>
          <div class="tablet-topbar-side">
            <span class="badge" id="gameVerdict"></span>
            <a class="secondary" href="/history">Mon historique</a>
            <a class="secondary" href="/">Accueil</a>
          </div>
        </header>

        <section class="stats-grid game-detail-grid">
          <article class="content-card">
            <div class="content-card-head">
              <div><span class="panel-kicker">Progression</span><strong>Mots trouvés dans le temps</strong></div>
            </div>
            <div class="chart-card">
              <div class="chart-legend" id="chartLegend"></div>
              <div class="chart-holder" id="foundChart"></div>
            </div>
          </article>
          <article class="content-card">
            <div class="content-card-head">
              <div><span class="panel-kicker">Classement</span><strong>Mots trouvés</strong></div>
            </div>
            <div class="leaderboard-list" id="statsByFound"></div>
          </article>
          <article class="content-card">
            <div class="content-card-head">
              <div><span class="panel-kicker">Classement</span><strong>Erreurs</strong></div>
            </div>
            <div class="leaderboard-list" id="statsByFails"></div>
          </article>
        </section>

        <section class="tablet-layout">
          <article class="content-card">
            <div class="content-card-head">
              <div><span class="panel-kicker">Règles</span><strong>Paramètres de la partie</strong></div>
            </div>
            <div class="settings-summary" id="settingsSummary"></div>
          </article>
          <article class="content-card">
            <div class="content-card-head">
              <div><span class="panel-kicker">Tableau</span><strong>Les mots</strong></div>
            </div>
            <div class="word-chips" id="wordChips"></div>
          </article>
        </section>
      </main>
    `,
    script: `/assets/game.js`,
  });
}

app.get("/", requirePageAuth, (req, res) => {
  const current = memberLobbyId(req.user.id);
  if (current) {
    return res.redirect(`/lobby/${current}`);
  }
  return res.send(renderHomePage(req.user));
});

app.get("/history", requirePageAuth, (req, res) => {
  res.send(renderHistoryPage(req.user));
});

app.get("/game/:id", requirePageAuth, (req, res) => {
  const gameId = Number.parseInt(req.params.id, 10);
  const game = db.prepare(`SELECT id, status, lobby_id FROM games WHERE id = ?`).get(gameId);
  if (!game) {
    return res.redirect("/history");
  }
  // A game still running is watched from its lobby, not the archive.
  if (game.status === "active") {
    return res.redirect(`/lobby/${game.lobby_id}`);
  }
  return res.send(renderGamePage(req.user, gameId));
});

app.get("/lobby/:id", requirePageAuth, (req, res) => {
  const lobbyId = Number.parseInt(req.params.id, 10);
  const lobby = getLobby(lobbyId);
  const current = memberLobbyId(req.user.id);

  // A player belongs to a single lobby: always route them to it.
  if (current && current !== lobbyId) {
    return res.redirect(`/lobby/${current}`);
  }
  if (!lobby || lobby.status !== "open") {
    return res.redirect("/");
  }
  if (!current) {
    joinLobby(req.user, lobby);
    notifyLobbyChange(lobby.id);
  }

  if (lobby.host_user_id === req.user.id) {
    return res.send(renderHostPage(req.user, lobby));
  }
  return res.send(renderPlayerPage(req.user, lobby));
});

// Legacy single-game routes.
app.get("/tv", (_req, res) => res.redirect("/"));
app.get("/tablet", (_req, res) => res.redirect("/"));
app.get("/group/:groupKey", (_req, res) => res.redirect("/"));
app.get("/group/:groupKey/submit", (_req, res) => res.redirect("/"));

// ---------------------------------------------------------------------------
// Server + WebSocket upgrade
// ---------------------------------------------------------------------------

const server = app.listen(port, () => {
  console.log(`Piscine Games running on http://localhost:${port}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const user = getSessionUser(req);
  if (!user?.coalition) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const lobbyId = Number.parseInt(url.searchParams.get("lobby") ?? "", 10);
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (Number.isFinite(lobbyId) && lobbyId > 0) {
    ws.lobbyId = lobbyId;
    if (!lobbySockets.has(lobbyId)) {
      lobbySockets.set(lobbyId, new Set());
    }
    lobbySockets.get(lobbyId).add(ws);
    const state = buildLobbyState(lobbyId, ws.user);
    wsSend(ws, state && state.lobby.status === "open" ? { type: "state", state } : { type: "closed" });
    ws.on("close", () => {
      lobbySockets.get(lobbyId)?.delete(ws);
    });
  } else {
    homeSockets.add(ws);
    wsSend(ws, { type: "lobbies", lobbies: listOpenLobbies() });
    ws.on("close", () => {
      homeSockets.delete(ws);
    });
  }
});

// Keepalive + authoritative game clock: finish expired games even when nobody
// is submitting, and push the transition to every connected client.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

setInterval(() => {
  const activeGames = db.prepare(`
    SELECT g.* FROM games g
    JOIN lobbies l ON l.id = g.lobby_id
    WHERE g.status = 'active' AND l.status = 'open'
  `).all();
  for (const game of activeGames) {
    const changed = game.bomb_holder_id ? tickBombGame(game) : completeGameIfNeeded(game);
    if (changed) {
      notifyLobbyChange(game.lobby_id);
    }
  }
}, 1000);
