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

  CREATE INDEX IF NOT EXISTS idx_games_group_status_started
    ON games(group_key, status, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_guesses_game_normalized
    ON guesses(game_id, normalized_word);
`);

const gameColumns = db.prepare(`PRAGMA table_info(games)`).all().map((row) => row.name);
if (!gameColumns.includes("seed")) {
  db.prepare(`ALTER TABLE games ADD COLUMN seed INTEGER NOT NULL DEFAULT 0`).run();
}

export default db;
