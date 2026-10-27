/**
 * GeoWorld 3D Network - persistence layer.
 *
 * Two interchangeable backends behind one async API:
 *
 *   - Neon Postgres (serverless, production / Vercel) when `DATABASE_URL` is
 *     set. Queries go through `@neondatabase/serverless`'s HTTP driver, so a
 *     single connection string works from any number of short-lived lambdas.
 *   - SQLite (`better-sqlite3`) otherwise, keeping `npm start` / `npm run
 *     seed` fully functional offline with no cloud credentials.
 *
 * Both drivers are imported lazily so the unused one is never loaded (the
 * SQLite native binding in particular is not needed on Vercel).
 *
 * Every value is bound as a query parameter - never interpolated - so the
 * catalog cannot be used for SQL injection on either backend.
 */

import fs from 'node:fs';

import {
  DATABASE_URL,
  DB_PATH,
  PUBLIC_DIR,
  ROOT_DIR,
  UPLOAD_DIR,
  USE_POSTGRES,
} from './config.js';

export { DATABASE_URL, DB_PATH, PUBLIC_DIR, ROOT_DIR, UPLOAD_DIR, USE_POSTGRES };

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

const POSTGRES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS worlds (
    id         BIGSERIAL   PRIMARY KEY,
    name       TEXT        NOT NULL,
    creator    TEXT        NOT NULL,
    file_path  TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const POSTGRES_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_worlds_created_at ON worlds (created_at DESC)';

const COLUMNS = 'id, name, creator, file_path, created_at';

let sqliteDb = null;
let pgQuery = null;
let initPromise = null;

/* ------------------------------------------------------------------ *
 * Backend initialisation (idempotent, memoised).
 * ------------------------------------------------------------------ */

async function initSqlite() {
  if (sqliteDb) return sqliteDb;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  sqliteDb = db;
  return db;
}

async function initPostgres() {
  if (pgQuery) return pgQuery;
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(DATABASE_URL);
  await sql(POSTGRES_TABLE_SQL);
  await sql(POSTGRES_INDEX_SQL);
  pgQuery = sql;
  return sql;
}

/**
 * Ensures the active backend is connected and the `worlds` schema exists.
 * Safe to call on every request - the work happens once per process.
 */
export function initDatabase() {
  if (!initPromise) {
    initPromise = USE_POSTGRES ? initPostgres() : initSqlite();
  }
  return initPromise;
}

/** Closes the SQLite handle (no-op for Postgres). Used by the seeder. */
export function closeDatabase() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  initPromise = null;
}

/* ------------------------------------------------------------------ *
 * Row normalisation - both backends return the same JS shape.
 * ------------------------------------------------------------------ */

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  // SQLite CURRENT_TIMESTAMP is UTC but carries no timezone marker.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text.replace(' ', 'T') + 'Z';
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    creator: row.creator,
    file_path: row.file_path,
    created_at: toIso(row.created_at),
  };
}

/* ------------------------------------------------------------------ *
 * Queries.
 * ------------------------------------------------------------------ */

export async function listWorlds() {
  if (USE_POSTGRES) {
    const sql = await initDatabase();
    const rows = await sql`SELECT id, name, creator, file_path, created_at
      FROM worlds ORDER BY id DESC`;
    return rows.map(normalizeRow);
  }
  const db = await initDatabase();
  return db
    .prepare(`SELECT ${COLUMNS} FROM worlds ORDER BY id DESC`)
    .all()
    .map(normalizeRow);
}

export async function getWorldById(id) {
  if (USE_POSTGRES) {
    const sql = await initDatabase();
    const rows = await sql`SELECT id, name, creator, file_path, created_at
      FROM worlds WHERE id = ${id}`;
    return normalizeRow(rows[0]);
  }
  const db = await initDatabase();
  return normalizeRow(
    db.prepare(`SELECT ${COLUMNS} FROM worlds WHERE id = ?`).get(id)
  );
}

export async function insertWorld({ name, creator, filePath }) {
  if (USE_POSTGRES) {
    const sql = await initDatabase();
    const rows = await sql`INSERT INTO worlds (name, creator, file_path)
      VALUES (${name}, ${creator}, ${filePath})
      RETURNING id, name, creator, file_path, created_at`;
    return normalizeRow(rows[0]);
  }
  const db = await initDatabase();
  const info = db
    .prepare('INSERT INTO worlds (name, creator, file_path) VALUES (?, ?, ?)')
    .run(name, creator, filePath);
  return getWorldById(Number(info.lastInsertRowid));
}

export async function countWorlds() {
  if (USE_POSTGRES) {
    const sql = await initDatabase();
    const rows = await sql`SELECT COUNT(*)::int AS total FROM worlds`;
    return Number(rows[0].total);
  }
  const db = await initDatabase();
  return Number(db.prepare('SELECT COUNT(*) AS total FROM worlds').get().total);
}

/** Empties the catalog and resets the id sequence. Used by the seeder. */
export async function resetWorlds() {
  if (USE_POSTGRES) {
    const sql = await initDatabase();
    // TRUNCATE ... RESTART IDENTITY resets BIGSERIAL in one statement.
    await sql('TRUNCATE TABLE worlds RESTART IDENTITY');
    return;
  }
  const db = await initDatabase();
  db.exec('DELETE FROM worlds;');
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'worlds';");
}
