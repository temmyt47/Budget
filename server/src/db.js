import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

const SCHEMA_VERSION = 2;
const version = db.prepare("PRAGMA user_version").get().user_version;
const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if(hasUsers && version < SCHEMA_VERSION){
  console.error(`Database ${config.dbPath} was made by an early test build (device-only sign-in). Delete it and start the server again.`);
  process.exit(1);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  is_owner       INTEGER NOT NULL DEFAULT 0,
  disabled       INTEGER NOT NULL DEFAULT 0,
  must_change    INTEGER NOT NULL DEFAULT 0,
  trial_ends     TEXT,
  comp_until     TEXT,
  seq            INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT UNIQUE NOT NULL,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id  TEXT UNIQUE NOT NULL,
  access_token   TEXT NOT NULL,
  institution    TEXT,
  cursor         TEXT,
  status         TEXT NOT NULL DEFAULT 'ok',
  error          TEXT,
  last_synced    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- accounts and transactions keep tombstones (removed = 1) so devices learn about deletions
CREATE TABLE IF NOT EXISTS accounts (
  plaid_account_id  TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL,
  institution       TEXT,
  name              TEXT,
  official_name     TEXT,
  mask              TEXT,
  type              TEXT,
  subtype           TEXT,
  current           REAL,
  available         REAL,
  currency          TEXT,
  seq               INTEGER NOT NULL,
  removed           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS accounts_user_seq ON accounts(user_id, seq);

CREATE TABLE IF NOT EXISTS txns (
  plaid_txn_id      TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL,
  plaid_account_id  TEXT,
  date              TEXT,
  name              TEXT,
  merchant          TEXT,
  amount            REAL,
  currency          TEXT,
  pending           INTEGER NOT NULL DEFAULT 0,
  category          TEXT,
  category_detail   TEXT,
  seq               INTEGER NOT NULL,
  removed           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS txns_user_seq ON txns(user_id, seq);

-- Lemon Squeezy mirrors: one row per subscription and per payment, upserted from webhooks
CREATE TABLE IF NOT EXISTS subscriptions (
  ls_id           TEXT PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email           TEXT,
  status          TEXT NOT NULL,
  variant_id      TEXT,
  product_name    TEXT,
  variant_name    TEXT,
  renews_at       TEXT,
  ends_at         TEXT,
  trial_ends_at   TEXT,
  card_brand      TEXT,
  card_last_four  TEXT,
  portal_url      TEXT,
  test_mode       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS payments (
  ls_id               TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subscription_ls_id  TEXT,
  email               TEXT,
  total_cents         INTEGER NOT NULL DEFAULT 0,
  currency            TEXT,
  status              TEXT,
  refunded            INTEGER NOT NULL DEFAULT 0,
  test_mode           INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_events (
  id          INTEGER PRIMARY KEY,
  event_name  TEXT NOT NULL,
  ls_id       TEXT,
  user_id     INTEGER,
  email       TEXT,
  summary     TEXT,
  test_mode   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
`);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

export const now = () => new Date().toISOString();

export function transaction(fn){
  db.exec("BEGIN");
  try{ const r = fn(); db.exec("COMMIT"); return r; }
  catch(e){ db.exec("ROLLBACK"); throw e; }
}

// every change a user can see gets a fresh sequence number; devices ask for "everything after N"
export function nextSeq(userId){
  db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").run(userId);
  return db.prepare("SELECT seq FROM users WHERE id = ?").get(userId).seq;
}

export const q = {
  userById:     db.prepare("SELECT * FROM users WHERE id = ?"),
  userByEmail:  db.prepare("SELECT * FROM users WHERE email = ?"),
  addUser:      db.prepare("INSERT INTO users (email, password_hash, is_owner, trial_ends, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"),
  setOwner:     db.prepare("UPDATE users SET is_owner = ? WHERE id = ?"),
  setPassword:  db.prepare("UPDATE users SET password_hash = ?, must_change = ? WHERE id = ?"),
  setDisabled:  db.prepare("UPDATE users SET disabled = ? WHERE id = ?"),
  setComp:      db.prepare("UPDATE users SET comp_until = ? WHERE id = ?"),
  touchUser:    db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?"),
  deleteUser:   db.prepare("DELETE FROM users WHERE id = ?"),
  userSeq:      db.prepare("SELECT seq FROM users WHERE id = ?"),
  allUsers:     db.prepare("SELECT * FROM users ORDER BY created_at DESC"),

  addSession:     db.prepare("INSERT INTO sessions (user_id, token_hash, user_agent, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)"),
  sessionByToken: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
  touchSession:   db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?"),
  deleteSession:  db.prepare("DELETE FROM sessions WHERE id = ?"),
  deleteSessionsExcept: db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?"),
  deleteSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),

  items:        db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY id"),
  allItems:     db.prepare("SELECT id, user_id, institution, status, error, last_synced FROM items"),
  item:         db.prepare("SELECT * FROM items WHERE id = ? AND user_id = ?"),
  itemByPlaid:  db.prepare("SELECT * FROM items WHERE plaid_item_id = ?"),
  addItem:      db.prepare(`INSERT INTO items (user_id, plaid_item_id, access_token, institution) VALUES (?, ?, ?, ?)
                            ON CONFLICT(plaid_item_id) DO UPDATE SET access_token = excluded.access_token,
                            institution = excluded.institution, status = 'ok', error = NULL
                            RETURNING id`),
  itemSynced:   db.prepare("UPDATE items SET cursor = ?, status = 'ok', error = NULL, last_synced = datetime('now') WHERE id = ?"),
  itemStatus:   db.prepare("UPDATE items SET status = ?, error = ? WHERE id = ?"),
  deleteItem:   db.prepare("DELETE FROM items WHERE id = ?"),

  upsertAccount: db.prepare(`INSERT INTO accounts (plaid_account_id, user_id, item_id, institution, name, official_name, mask, type, subtype, current, available, currency, seq, removed)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                             ON CONFLICT(plaid_account_id) DO UPDATE SET institution = excluded.institution, name = excluded.name,
                             official_name = excluded.official_name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
                             current = excluded.current, available = excluded.available, currency = excluded.currency, seq = excluded.seq, removed = 0`),
  upsertTxn:    db.prepare(`INSERT INTO txns (plaid_txn_id, user_id, item_id, plaid_account_id, date, name, merchant, amount, currency, pending, category, category_detail, seq, removed)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                            ON CONFLICT(plaid_txn_id) DO UPDATE SET plaid_account_id = excluded.plaid_account_id, date = excluded.date,
                            name = excluded.name, merchant = excluded.merchant, amount = excluded.amount, currency = excluded.currency,
                            pending = excluded.pending, category = excluded.category, category_detail = excluded.category_detail,
                            seq = excluded.seq, removed = 0`),
  removeTxn:    db.prepare("UPDATE txns SET removed = 1, seq = ? WHERE plaid_txn_id = ? AND user_id = ?"),
  tombItemTxns: db.prepare("UPDATE txns SET removed = 1, seq = ? WHERE item_id = ? AND removed = 0"),
  tombItemAccts: db.prepare("UPDATE accounts SET removed = 1, seq = ? WHERE item_id = ? AND removed = 0"),
  changedAccounts: db.prepare("SELECT * FROM accounts WHERE user_id = ? AND seq > ? ORDER BY seq"),
  changedTxns:     db.prepare("SELECT * FROM txns WHERE user_id = ? AND seq > ? ORDER BY seq"),

  latestSub:    db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"),
  allSubs:      db.prepare("SELECT * FROM subscriptions"),
  upsertSub:    db.prepare(`INSERT INTO subscriptions (ls_id, user_id, email, status, variant_id, product_name, variant_name, renews_at, ends_at,
                              trial_ends_at, card_brand, card_last_four, portal_url, test_mode, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(ls_id) DO UPDATE SET user_id = COALESCE(excluded.user_id, subscriptions.user_id), email = excluded.email,
                              status = excluded.status, variant_id = excluded.variant_id, product_name = excluded.product_name,
                              variant_name = excluded.variant_name, renews_at = excluded.renews_at, ends_at = excluded.ends_at,
                              trial_ends_at = excluded.trial_ends_at, card_brand = excluded.card_brand, card_last_four = excluded.card_last_four,
                              portal_url = excluded.portal_url, test_mode = excluded.test_mode, updated_at = excluded.updated_at`),
  claimSubsByEmail: db.prepare("UPDATE subscriptions SET user_id = ? WHERE user_id IS NULL AND email = ? COLLATE NOCASE"),
  upsertPayment: db.prepare(`INSERT INTO payments (ls_id, kind, user_id, subscription_ls_id, email, total_cents, currency, status, refunded, test_mode, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(ls_id) DO UPDATE SET user_id = COALESCE(excluded.user_id, payments.user_id), status = excluded.status,
                               refunded = excluded.refunded, total_cents = excluded.total_cents`),
  allPayments:  db.prepare("SELECT * FROM payments"),
  addEvent:     db.prepare("INSERT INTO billing_events (event_name, ls_id, user_id, email, summary, test_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  recentEvents: db.prepare("SELECT * FROM billing_events WHERE test_mode = 0 OR ? = 1 ORDER BY id DESC LIMIT 60"),
  lastEvent:    db.prepare("SELECT created_at FROM billing_events ORDER BY id DESC LIMIT 1")
};
