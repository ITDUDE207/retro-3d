/**
 * GeoWorld 3D Network - runtime configuration.
 *
 * Centralises every environment variable the app understands and decides
 * which persistence backend is active. Nothing here touches the network, so
 * it is safe to import from any entrypoint (Express, Vercel, seed script).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');

/**
 * Neon Postgres connection string. When present the app stores the catalog in
 * Postgres; otherwise it falls back to the local SQLite file so `npm start`
 * and `npm run seed` keep working offline.
 */
export const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

export const USE_POSTGRES = DATABASE_URL.length > 0;

/** SQLite fallback location (only used when DATABASE_URL is unset). */
export const DB_PATH = process.env.GEOWORLD_DB || path.join(ROOT_DIR, 'geoworld.db');

/**
 * Vercel Blob token. Generated `.glb` parcels are written to Blob storage when
 * this is set; otherwise they land in `public/uploads/` (local development).
 */
export const BLOB_READ_WRITE_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN || process.env.GEOWORLD_BLOB_TOKEN || '';

export const USE_BLOB = BLOB_READ_WRITE_TOKEN.length > 0;

/** Human-readable backend label, surfaced by /api/health. */
export function backendLabel() {
  const database = USE_POSTGRES ? 'neon-postgres' : path.basename(DB_PATH);
  const storage = USE_BLOB ? 'vercel-blob' : 'local-disk';
  return { database, storage };
}
