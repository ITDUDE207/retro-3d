/**
 * GeoWorld 3D Network - Vercel serverless entrypoint.
 *
 * Vercel builds this file as a single Node function and (per vercel.json)
 * rewrites every non-static request here. The Express app is reused as the
 * request listener; the persistence schema is ensured once per cold start.
 */

import app from '../server.js';
import { initDatabase } from '../lib/db.js';

let ready = null;

function ensureDatabase() {
  if (!ready) ready = initDatabase();
  return ready;
}

export default async function handler(req, res) {
  await ensureDatabase();
  return app(req, res);
}
