import crypto from "crypto";
import express from "express";
import db from "./db.js";
import { normalizeGuess, sampleWords } from "./words.js";

const app = express();
const port = process.env.PORT || 3000;
const GAME_KEY = "main";
const THEME = String(process.env.THEME || "ALLIANCE").toUpperCase() === "HORDE" ? "HORDE" : "ALLIANCE";
const THEME_CONFIG = THEME === "HORDE"
  ? {
      bodyClass: "theme-horde",
      factionName: "Horde",
      factionTag: "Pour la Horde",
      emblem: "/assets/horde.svg",
    }
  : {
      bodyClass: "theme-alliance",
      factionName: "Alliance",
      factionTag: "Pour l'Alliance",
      emblem: "/assets/alliance.svg",
    };
const DISPLAY_DURATION_MS = 60 * 1000;
const SUBMIT_DURATION_MS = 5 * 60 * 1000;
const MAX_TRIES = 250;
const WORD_COUNT = 200;
const liveClients = new Set();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/assets", express.static("public"));
app.use("/font", express.static("font"));

function nowIso() {
  return new Date().toISOString();
}

function getActiveGame() {
  return db.prepare(`
    SELECT * FROM games
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

function getLatestGame() {
  return db.prepare(`
    SELECT * FROM games
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

function hydrateGame(game) {
  if (!game) {
    return null;
  }
  return {
    ...game,
    words: JSON.parse(game.words_json),
    startedAt: game.started_at,
    revealAt: game.reveal_at,
    submitUntil: game.submit_until,
  };
}

function getGameById(id) {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id);
  return hydrateGame(game);
}

function withDistinctCounts(game) {
  if (!game) {
    return null;
  }
  const guessed_count = guessedCountForGame(game.id, game.guessed_count);
  const try_count = tryCountForGame(game.id, game.try_count);
  return {
    ...game,
    guessed_count,
    try_count,
    remainingTries: Math.max(0, MAX_TRIES - try_count),
    remainingWords: Math.max(0, game.word_count - guessed_count),
  };
}

function finishExpiredGames() {
  const now = nowIso();
  db.prepare(`
    UPDATE games
    SET status = 'finished', finished_at = COALESCE(finished_at, ?)
    WHERE status = 'active' AND submit_until <= ?
  `).run(now, now);
}

function completeGameIfNeeded(gameId) {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId);
  if (!game || game.status !== "active") {
    return;
  }

  const guessedCount = db.prepare(`
    SELECT COUNT(DISTINCT normalized_word) AS count
    FROM guesses
    WHERE game_id = ? AND is_correct = 1
  `).get(gameId).count;
  const tryCount = db.prepare(`
    SELECT COUNT(DISTINCT normalized_word) AS count
    FROM guesses
    WHERE game_id = ?
  `).get(gameId).count;
  const shouldFinish =
    guessedCount >= game.word_count ||
    tryCount >= MAX_TRIES ||
    new Date(game.submit_until).getTime() <= Date.now();

  if (shouldFinish) {
    db.prepare(`
      UPDATE games
      SET guessed_count = ?, try_count = ?, status = 'finished', finished_at = COALESCE(finished_at, ?)
      WHERE id = ?
    `).run(guessedCount, tryCount, nowIso(), gameId);
  } else {
    db.prepare(`
      UPDATE games
      SET guessed_count = ?, try_count = ?
      WHERE id = ?
    `).run(guessedCount, tryCount, gameId);
  }
}

function getGamePhase(game) {
  if (!game) {
    return {
      label: "Terminé",
      remainingMs: 0,
      finished: true,
    };
  }

  const now = Date.now();
  const revealAt = new Date(game.reveal_at).getTime();
  const submitUntil = new Date(game.submit_until).getTime();
  if (game.status !== "active" || now >= submitUntil) {
    return {
      label: "Terminé",
      remainingMs: 0,
      finished: true,
    };
  }
  if (now < revealAt) {
    return {
      label: "Révélation",
      remainingMs: revealAt - now,
      finished: false,
    };
  }
  return {
    label: "Partie",
    remainingMs: submitUntil - now,
    finished: false,
  };
}

function createGame(seedOverride) {
  const seed =
    Number.isInteger(seedOverride) && seedOverride > 0
      ? seedOverride
      : crypto.randomInt(1, 2147483647);
  const words = sampleWords(WORD_COUNT, seed);
  const startedAt = new Date();
  const revealAt = new Date(startedAt.getTime() + DISPLAY_DURATION_MS);
  const submitUntil = new Date(startedAt.getTime() + SUBMIT_DURATION_MS);

  const result = db.prepare(`
    INSERT INTO games (
      group_key, seed, words_json, word_count, guessed_count, try_count,
      started_at, reveal_at, submit_until, status
    ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 'active')
  `).run(
    GAME_KEY,
    seed,
    JSON.stringify(words),
    words.length,
    startedAt.toISOString(),
    revealAt.toISOString(),
    submitUntil.toISOString()
  );

  return getGameById(result.lastInsertRowid);
}

function ensureCurrentGame() {
  const active = getActiveGame();
  if (active) {
    return hydrateGame(active);
  }
  const latest = getLatestGame();
  return latest ? hydrateGame(latest) : null;
}

function getGameSnapshot(gameId) {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId);
  if (!game) {
    return null;
  }

  const correctWords = db.prepare(`
    SELECT DISTINCT normalized_word
    FROM guesses
    WHERE game_id = ? AND is_correct = 1
    ORDER BY normalized_word ASC
  `).all(gameId).map((row) => row.normalized_word);

  const guesses = db.prepare(`
    SELECT raw_word, normalized_word, is_correct, created_at
    FROM guesses
    WHERE game_id = ?
    ORDER BY id DESC
    LIMIT 250
  `).all(gameId);

  return {
    ...hydrateGame(game),
    correctWords,
    guesses,
    ...withDistinctCounts(hydrateGame(game)),
  };
}

function guessedCountForGame(gameId, fallback = 0) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT normalized_word) AS count
    FROM guesses
    WHERE game_id = ? AND is_correct = 1
  `).get(gameId);
  return Number.isFinite(row?.count) ? row.count : fallback;
}

function tryCountForGame(gameId, fallback = 0) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT normalized_word) AS count
    FROM guesses
    WHERE game_id = ?
  `).get(gameId);
  return Number.isFinite(row?.count) ? row.count : fallback;
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

function formatClock(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function translateGameStatus(status) {
  return status === "active" ? "en cours" : "terminée";
}

function broadcastGame(gameId) {
  if (!liveClients.size) {
    return;
  }
  const payload = `data: ${JSON.stringify({ game: gameId ? getGameSnapshot(gameId) : null })}\n\n`;
  for (const client of liveClients) {
    client.write(payload);
  }
}

function registerLiveStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const active = ensureCurrentGame();
  res.write(`data: ${JSON.stringify({ game: active ? getGameSnapshot(active.id) : null })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  liveClients.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    liveClients.delete(res);
  });
}

function renderFactionMark(size = "large") {
  return `
    <div class="faction-mark faction-mark-${size}" aria-hidden="true">
      <img src="${THEME_CONFIG.emblem}" alt="" />
    </div>
  `;
}

function renderStatusCard(label, value, modifier = "", extraAttrs = "", valueId = "") {
  return `
    <article class="status-card ${modifier}" ${extraAttrs}>
      <span class="status-label">${label}</span>
      <strong class="status-value" ${valueId ? `id="${valueId}"` : ""}>${value}</strong>
    </article>
  `;
}

function formatGameRow(game) {
  const guessed_count = guessedCountForGame(game.id, game.guessed_count);
  const try_count = tryCountForGame(game.id, game.try_count);
  return {
    ...game,
    guessed_count,
    try_count,
    guessedPercent: game.word_count ? Math.round((guessed_count / game.word_count) * 100) : 0,
  };
}

function renderWelcomePage() {
  const activeGame = getActiveGame();
  const currentGame = activeGame ? withDistinctCounts(hydrateGame(activeGame)) : withDistinctCounts(ensureCurrentGame());
  const initialSeed = crypto.randomInt(1, 2147483647);
  const games = db.prepare(`
    SELECT id, seed, group_key, word_count, guessed_count, try_count, started_at, reveal_at, submit_until, finished_at, status
    FROM games
    ORDER BY id DESC
  `).all().map(formatGameRow);

  return pageShell({
    title: `Mémoire - ${THEME_CONFIG.factionName}`,
    bodyClass: THEME_CONFIG.bodyClass,
    body: `
      <main class="screen home-screen" data-page="home" data-current-game-id="${currentGame?.id ?? ""}">
        <section class="home-hero">
          <div class="home-copy">
            <div class="faction-badge">
              ${renderFactionMark("small")}
              <div>
                <span class="eyebrow">${THEME_CONFIG.factionTag}</span>
                <strong>${THEME_CONFIG.factionName}</strong>
              </div>
            </div>
            <p class="eyebrow">Jeu de memory</p>
            <h1>Memory</h1>
            <p class="lede">Lancez 200 mots pendant une minute, cachez-les, puis laissez l'équipe en retrouver un maximum en cinq minutes.</p>
          </div>

          <form class="launch-card" id="startGameForm">
            <div class="launch-card-head">
              <div>
                <strong>Lancer une partie</strong>
              </div>
              <button class="ghost-button" type="button" id="randomizeSeedButton">Générer le seed</button>
            </div>
            <label class="seed-field">
              <span>Seed</span>
              <input id="seedInput" name="seed" inputmode="numeric" value="${initialSeed}" />
            </label>
            <div class="launch-actions">
              <button class="primary" type="submit" data-start-game>Démarrer la partie</button>
              <a class="secondary" href="/tv">Mode TV</a>
              <a class="secondary" href="/tablet">Mode tablette</a>
            </div>
          </form>
        </section>

        <section class="home-grid">
          <article class="content-card">
            <div class="content-card-head">
              <div>
                <span class="panel-kicker">Partie en cours</span>
                <strong>Partie en cours</strong>
              </div>
              <span class="badge">${currentGame ? translateGameStatus(currentGame.status) : "en attente"}</span>
            </div>
            ${currentGame ? `
              <div class="stat-grid">
                ${renderStatusCard("Seed", currentGame.seed)}
                ${renderStatusCard("Trouvés", `${currentGame.guessed_count}/${currentGame.word_count}`)}
                ${renderStatusCard("Essais", `${currentGame.try_count}/250`)}
                ${renderStatusCard("Résolution", `${currentGame.word_count ? Math.round((currentGame.guessed_count / currentGame.word_count) * 100) : 0}%`)}
              </div>
            ` : `<div class="empty-copy">Aucune partie en cours. Lancez-en une depuis le panneau du dessus.</div>`}
          </article>

          <article class="content-card">
            <div class="content-card-head">
              <div>
                <span class="panel-kicker">Historique</span>
                <strong>Anciens jeux</strong>
              </div>
              <span class="badge">${games.length} parties</span>
            </div>
            <div class="history-list">
              ${games.map((game) => `
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
                  <span class="history-status ${escapeHtml(game.status)}">${translateGameStatus(game.status)}</span>
                </article>
              `).join("") || `<div class="empty-copy">Aucune partie pour le moment.</div>`}
            </div>
          </article>
        </section>
      </main>
    `,
    script: `/assets/home.js`
  });
}

function renderTvPage() {
  const game = withDistinctCounts(ensureCurrentGame());
  if (!game) {
    return pageShell({
      title: `Mémoire - TV - ${THEME_CONFIG.factionName}`,
      bodyClass: THEME_CONFIG.bodyClass,
      body: `
        <main class="tv-stage empty-state" data-page="host">
          <div class="empty-card">
            <p class="eyebrow">Mode TV</p>
            <h1>Aucune partie</h1>
            <p class="lede">Retournez à l'accueil pour lancer une nouvelle partie seedée.</p>
            <a class="primary" href="/">Retour à l'accueil</a>
          </div>
        </main>
      `,
    });
  }

  const wordsMarkup = game.words
    .map((word, index) => `<span class="floating-word" data-word="${escapeHtml(word)}" data-index="${index}">${escapeHtml(word)}</span>`)
    .join("");
  const phase = getGamePhase(game);
  const now = Date.now();
  const isBlurred = game.status === "active" && now >= new Date(game.revealAt).getTime() && now < new Date(game.submitUntil).getTime();
  const isFinished = phase.finished;

  return pageShell({
    title: `Mémoire - TV - ${THEME_CONFIG.factionName}`,
    bodyClass: THEME_CONFIG.bodyClass,
    body: `
      <main class="tv-stage ${isBlurred ? "is-blurred" : ""} ${isFinished ? "is-finished" : ""}" data-page="host" data-game-id="${game.id}" data-seed="${game.seed}" data-status="${game.status}" data-reveal-at="${escapeHtml(game.revealAt)}" data-submit-until="${escapeHtml(game.submitUntil)}" data-word-count="${game.word_count}" data-guessed-count="${game.guessed_count}" data-try-count="${game.try_count}">
        <header class="tv-topbar">
          <div class="tv-stats">
            ${renderStatusCard("Temps", phase.remainingMs ? formatClock(phase.remainingMs) : "0:00", "stat-card", "", "tvTimer")}
            ${renderStatusCard("Trouvés", `${game.guessed_count} / ${game.word_count}`, "stat-card", "", "tvGuessed")}
            ${renderStatusCard("Essais restants", `${MAX_TRIES - game.try_count}`, "stat-card", "", "tvRemaining")}
          </div>
          <div class="faction-panel">
            ${renderFactionMark("small")}
            <div>
              <span class="panel-kicker">${THEME_CONFIG.factionTag}</span>
              <strong>${THEME_CONFIG.factionName}</strong>
            </div>
            <div class="status-pill" id="tvPhaseLabel">${phase.label}</div>
          </div>
        </header>

        <section class="tv-board-shell">
          <div class="tv-board-frame">
            <div class="tv-watermark" aria-hidden="true">
              ${renderFactionMark("large")}
            </div>
            <div class="board board-live ${game.status === "active" && Date.now() >= new Date(game.revealAt).getTime() ? "blurred" : ""} ${game.status !== "active" ? "finished" : ""}" id="wordBoard">
              ${wordsMarkup}
            </div>
            <div class="tv-footer-pill">PHASE DE JEU - À VOUS DE JOUER</div>
          </div>
        </section>
      </main>
    `,
    script: `/assets/board.js`
  });
}

function renderTabletPage() {
  const game = getGameSnapshot(ensureCurrentGame()?.id);
  const phase = getGamePhase(game);
  const guessRows = (game?.guesses ?? [])
    .map((guess) => `
      <div class="guess-item">
        <strong>${escapeHtml(guess.raw_word)}</strong>
        <span>${guess.is_correct ? "Trouvé" : "Raté"}</span>
      </div>
    `)
    .join("") || `<div class="guess-item"><span>Aucune réponse pour le moment.</span><span></span></div>`;
  return pageShell({
    title: `Mémoire - Tablette - ${THEME_CONFIG.factionName}`,
    bodyClass: THEME_CONFIG.bodyClass,
    body: `
      <main class="screen tablet-screen" data-page="submit" data-game-id="${game?.id ?? ""}" data-status="${game?.status ?? ""}" data-reveal-at="${game ? escapeHtml(game.revealAt) : ""}" data-submit-until="${game ? escapeHtml(game.submitUntil) : ""}">
        <header class="tablet-topbar">
          <div class="tablet-title">
            <div class="faction-badge">
              ${renderFactionMark("small")}
              <div>
                <span class="eyebrow">Mode tablette</span>
                <strong>Soumettre vos réponses</strong>
              </div>
            </div>
          </div>
          <div class="status-pill" id="statusPill">Chargement</div>
        </header>

        <section class="tablet-stats">
          ${renderStatusCard("Temps", phase.remainingMs ? formatClock(phase.remainingMs) : "0:00", "stat-card", "", "submitTimer")}
          ${renderStatusCard("Trouvés", `${game?.guessed_count ?? 0} / ${WORD_COUNT}`, "stat-card", "", "foundCount")}
          ${renderStatusCard("Essais restants", `${MAX_TRIES - (game?.try_count ?? 0)}`, "stat-card", "", "tryCount")}
        </section>

        <section class="tablet-layout">
          <form class="submit-card" id="guessForm">
            <div class="panel-kicker">Saisir les réponses</div>
            <div class="submit-form">
              <input id="guessInput" name="guess" autocomplete="off" placeholder="Tapez un mot puis validez" />
              <button type="submit" ${phase.finished || phase.label !== "Partie" || (game?.try_count ?? 0) >= MAX_TRIES ? "disabled" : ""}>Valider</button>
            </div>
            <div class="submit-helper">Les doublons seront marqués comme déjà trouvé ou déjà tenté sans consommer d'essai.</div>
            <div class="message" id="message"></div>
          </form>

          <section class="submit-card">
            <div class="panel-kicker">Dernières réponses</div>
            <div id="guessList" class="guess-list">${guessRows}</div>
          </section>
        </section>
      </main>
    `,
    script: `/assets/submit.js`
  });
}

function handleCurrentGame(req, res) {
  finishExpiredGames();
  const game = ensureCurrentGame();
  if (!game) {
    return res.status(404).json({ error: "Aucune partie" });
  }
  completeGameIfNeeded(game.id);
  return res.json({ game: getGameSnapshot(game.id) });
}

function handleNewGame(req, res) {
  finishExpiredGames();
  db.prepare(`
    UPDATE games
    SET status = 'finished', finished_at = COALESCE(finished_at, ?)
    WHERE status = 'active'
  `).run(nowIso());

  const requestedSeed = Number.parseInt(req.body?.seed ?? req.query?.seed ?? "", 10);
  const game = createGame(Number.isFinite(requestedSeed) ? requestedSeed : undefined);
  broadcastGame(game.id);
  return res.json({ game: getGameSnapshot(game.id) });
}

function handleHistory(req, res) {
  const limit = Number.parseInt(req.query?.limit ?? "0", 10);
  const query = `
    SELECT id, seed, group_key, word_count, guessed_count, try_count, started_at, reveal_at, submit_until, finished_at, status
    FROM games
    ORDER BY id DESC
    ${Number.isFinite(limit) && limit > 0 ? "LIMIT ?" : ""}
  `;
  const stmt = db.prepare(query);
  const rows = Number.isFinite(limit) && limit > 0 ? stmt.all(limit) : stmt.all();
  res.json({ games: rows.map(formatGameRow) });
}

function handleGuess(req, res) {
  const rawWord = String(req.body.word ?? "").trim();
  if (!rawWord) {
    return res.status(400).json({ error: "Mot manquant" });
  }

  finishExpiredGames();
  const game = getActiveGame();
  if (!game) {
    return res.status(409).json({ error: "Aucune partie active" });
  }

  const normalizedWord = normalizeGuess(rawWord);
  if (!normalizedWord) {
    return res.status(400).json({ error: "Mot invalide" });
  }

  if (game.try_count >= MAX_TRIES) {
    completeGameIfNeeded(game.id);
    return res.status(403).json({ error: "Plus d'essais disponibles" });
  }
  if (new Date(game.submit_until).getTime() <= Date.now()) {
    completeGameIfNeeded(game.id);
    return res.status(403).json({ error: "Partie terminée" });
  }

  const hydratedGame = hydrateGame(game);
  const words = new Set(hydratedGame.words.map((word) => normalizeGuess(word)));
  const previousGuess = db.prepare(`
    SELECT is_correct
    FROM guesses
    WHERE game_id = ? AND normalized_word = ?
    LIMIT 1
  `).get(hydratedGame.id, normalizedWord);

  if (previousGuess) {
    db.prepare(`
      INSERT INTO guesses (game_id, raw_word, normalized_word, is_correct, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hydratedGame.id, rawWord, normalizedWord, previousGuess.is_correct ? 1 : 0, nowIso());

    completeGameIfNeeded(hydratedGame.id);
    const payload = {
      ok: true,
      correct: false,
      alreadyFound: Boolean(previousGuess.is_correct),
      alreadyTried: !previousGuess.is_correct,
      game: getGameSnapshot(hydratedGame.id),
      guess: {
        rawWord,
        normalizedWord,
        isCorrect: Boolean(previousGuess.is_correct),
      },
    };
    broadcastGame(hydratedGame.id);
    return res.json(payload);
  }

  const isCorrect = words.has(normalizedWord);

  db.prepare(`
    INSERT INTO guesses (game_id, raw_word, normalized_word, is_correct, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hydratedGame.id, rawWord, normalizedWord, isCorrect ? 1 : 0, nowIso());

  completeGameIfNeeded(hydratedGame.id);
  const payload = {
    ok: true,
    correct: isCorrect,
    alreadyFound: false,
    alreadyTried: false,
    game: getGameSnapshot(hydratedGame.id),
    guess: {
      rawWord,
      normalizedWord,
      isCorrect,
    },
  };
  broadcastGame(hydratedGame.id);
  return res.json(payload);
}

app.get("/", (_req, res) => {
  res.send(renderWelcomePage());
});

app.get("/tv", (_req, res) => {
  finishExpiredGames();
  res.send(renderTvPage());
});

app.get("/tablet", (_req, res) => {
  finishExpiredGames();
  res.send(renderTabletPage());
});

app.get("/group/:groupKey", (_req, res) => res.redirect("/tv"));
app.get("/group/:groupKey/submit", (_req, res) => res.redirect("/tablet"));

app.get("/api/game/current", handleCurrentGame);
app.post("/api/game/new", handleNewGame);
app.get("/api/game/history", handleHistory);
app.post("/api/game/guess", handleGuess);
app.get("/api/game/stream", registerLiveStream);

app.get("/api/group/:groupKey/current", handleCurrentGame);
app.post("/api/group/:groupKey/new", handleNewGame);
app.post("/api/group/:groupKey/guess", handleGuess);
app.get("/api/group/:groupKey/history", handleHistory);
app.get("/api/group/:groupKey/stream", registerLiveStream);

app.listen(port, () => {
  console.log(`Memory running on http://localhost:${port}`);
});
