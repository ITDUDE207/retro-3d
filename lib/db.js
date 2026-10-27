/**
 * GeoWorld 3D Network - SQLite persistence layer.
 *
 * Opens (and if necessary creates) the local `geoworld.db` file and applies
 * the `worlds` schema. better-sqlite3 is used because it is synchronous,
 * transactional by default and has zero server-side setup.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
export const DB_PATH = process.env.GEOWORLD_DB || path.join(ROOT_DIR, 'geoworld.db');

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS worlds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    creator    TEXT    NOT NULL,
    file_path  TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_worlds_created_at ON worlds (created_at DESC);
`;

let db = null;

/**
 * Ensures the static asset directories exist, then opens the database and
 * applies the schema. Safe to call repeatedly (returns the same handle).
 */
export function openDatabase() {
  if (db) return db;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

export function getDatabase() {
  return db || openDatabase();
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/* ------------------------------------------------------------------ *
 * Prepared statements / queries.
 * Every value is bound as a parameter - never interpolated - so the
 * catalog cannot be used for SQL injection.
 * ------------------------------------------------------------------ */
export function listWorlds() {
  return getDatabase()
    .prepare(
      'SELECT id, name, creator, file_path, created_at FROM worlds ORDER BY id DESC'
    )
    .all();
}

export function getWorldById(id) {
  return getDatabase()
    .prepare(
      'SELECT id, name, creator, file_path, created_at FROM worlds WHERE id = ?'
    )
    .get(id);
}

export function insertWorld({ name, creator, filePath }) {
  const info = getDatabase()
    .prepare('INSERT INTO worlds (name, creator, file_path) VALUES (?, ?, ?)')
    .run(name, creator, filePath);
  return getWorldById(info.lastInsertRowid);
}

export function countWorlds() {
  return getDatabase().prepare('SELECT COUNT(*) AS total FROM worlds').get().total;
}
