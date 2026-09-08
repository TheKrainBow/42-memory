import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH || "piscine-games.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key TEXT NOT NULL DEFAULT 'main',
    seed INTEGER NOT NULL DEFAULT 0,
    words_json TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    guessed_count INTEGER NOT NULL DEFAULT 0,
    try_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    reveal_at TEXT NOT NULL,
    submit_until TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    raw_word TEXT NOT NULL,
    normalized_word TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    display_name TEXT,
    image_url TEXT,
    coalition TEXT,
    coalition_source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS lobbies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host_user_id INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    closed_at TEXT,
    FOREIGN KEY (host_user_id) REFERENCES users(id)
  );

  -- user_id is the primary key: a user belongs to at most one lobby at a time.
  CREATE TABLE IF NOT EXISTS lobby_members (
    user_id INTEGER PRIMARY KEY,
    lobby_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (lobby_id) REFERENCES lobbies(id)
  );

  CREATE INDEX IF NOT EXISTS idx_lobby_members_lobby
    ON lobby_members(lobby_id);

  CREATE INDEX IF NOT EXISTS idx_games_group_status_started
    ON games(group_key, status, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_guesses_game_normalized
    ON guesses(game_id, normalized_word);
`);

const gameColumns = db.prepare(`PRAGMA table_info(games)`).all().map((row) => row.name);
if (!gameColumns.includes("seed")) {
  db.prepare(`ALTER TABLE games ADD COLUMN seed INTEGER NOT NULL DEFAULT 0`).run();
}

const guessColumns = db.prepare(`PRAGMA table_info(guesses)`).all().map((row) => row.name);
if (!guessColumns.includes("user_id")) {
  db.prepare(`ALTER TABLE guesses ADD COLUMN user_id INTEGER`).run();
}

if (!gameColumns.includes("lobby_id")) {
  db.prepare(`ALTER TABLE games ADD COLUMN lobby_id INTEGER`).run();
}
if (!gameColumns.includes("settings_json")) {
  db.prepare(`ALTER TABLE games ADD COLUMN settings_json TEXT`).run();
}

// Bomb mode: circle of eligible players, who currently holds the bomb, and
// the server-only fuse deadline (never serialized to clients).
// dismissed_at: the host acknowledged a finished game's results and went
// back to the lobby settings, without that starting a new game.
for (const [column, ddl] of [
  ["bomb_order_json", `ALTER TABLE games ADD COLUMN bomb_order_json TEXT`],
  ["bomb_alive_json", `ALTER TABLE games ADD COLUMN bomb_alive_json TEXT`],
  ["bomb_eliminated_json", `ALTER TABLE games ADD COLUMN bomb_eliminated_json TEXT`],
  ["bomb_holder_id", `ALTER TABLE games ADD COLUMN bomb_holder_id INTEGER`],
  ["bomb_deadline_at", `ALTER TABLE games ADD COLUMN bomb_deadline_at TEXT`],
  ["dismissed_at", `ALTER TABLE games ADD COLUMN dismissed_at TEXT`],
]) {
  if (!gameColumns.includes(column)) {
    db.prepare(ddl).run();
  }
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_games_lobby ON games(lobby_id, id DESC)`);

export default db;
