import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("DB_PATH", "/srv/data/einb.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    age             INTEGER,
    nationality     TEXT,
    sex             TEXT CHECK (sex IN ('M','F') OR sex IS NULL),
    land            TEXT,                 -- chosen Bundesland code (e.g. 'BY')
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','expired')),
    coupon_code     TEXT,
    trial_questions_seen INTEGER NOT NULL DEFAULT 0,
    activated_at    TIMESTAMP,
    expires_at      TIMESTAMP,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Migration for existing DBs: add `sex` column if not present (idempotent).
-- SQLite has no IF NOT EXISTS for ALTER TABLE, so we use a small trick:
-- the SELECT will fail silently if the column exists, but we wrap in BEGIN to be safe.

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    user_agent  TEXT,
    ip          TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS coupons (
    code            TEXT PRIMARY KEY COLLATE NOCASE,
    partner         TEXT,
    discount_pct    INTEGER,
    discount_cents  INTEGER,
    valid_until     TIMESTAMP,
    max_uses        INTEGER,
    used_count      INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    stripe_session_id   TEXT UNIQUE,
    amount_cents        INTEGER NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'EUR',
    status              TEXT NOT NULL,
    paid_at             TIMESTAMP,
    raw_event           TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS progress (
    user_id         INTEGER NOT NULL,
    question_id     INTEGER NOT NULL,
    correct_count   INTEGER NOT NULL DEFAULT 0,
    wrong_count     INTEGER NOT NULL DEFAULT 0,
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    last_seen       TIMESTAMP,
    PRIMARY KEY (user_id, question_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Anti-abuse: track anonymous trial views by (anon_token, ip_hash, question_id).
-- UNIQUE(anon_token, question_id) means re-viewing the same question doesn't count twice.
-- ip_hash is SHA256(secret+ip) truncated — privacy-preserving, not reversible.
CREATE TABLE IF NOT EXISTS anon_trial_views (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    anon_token      TEXT NOT NULL,
    ip_hash         TEXT NOT NULL,
    ua_hash         TEXT,
    question_id     INTEGER NOT NULL,
    seen_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(anon_token, question_id)
);
CREATE INDEX IF NOT EXISTS idx_anon_views_token    ON anon_trial_views(anon_token);
CREATE INDEX IF NOT EXISTS idx_anon_views_ip_time  ON anon_trial_views(ip_hash, seen_at);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def db():
    conn = get_conn()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        # Idempotent column-add migrations for existing DBs.
        _ensure_column(conn, "users", "sex", "TEXT CHECK (sex IN ('M','F') OR sex IS NULL)")
        _ensure_column(conn, "users", "land", "TEXT")


def _ensure_column(conn, table: str, column: str, ddl: str) -> None:
    """Add `column` to `table` if missing. Safe to call on every startup."""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
