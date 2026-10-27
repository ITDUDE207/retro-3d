/**
 * GeoWorld 3D Network - Express application core.
 *
 * Responsibilities:
 *   - bootstrap the persistence backend (Neon Postgres on Vercel, SQLite
 *     locally) and the `worlds` table
 *   - serve the static dashboard / sandbox from `public/`
 *   - expose the world catalog API and the procedural .glb assembler
 *
 * Run with:  npm start        (defaults to http://localhost:3000)
 * Deploy:    Vercel routes every request to api/index.js, which wraps `app`.
 */

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';

import { buildStarterWorldBuffer } from './lib/glb-builder.js';
import { saveWorldAsset } from './lib/glb-store.js';
import { backendLabel, PUBLIC_DIR, USE_BLOB, USE_POSTGRES } from './lib/config.js';
import {
  initDatabase,
  listWorlds,
  getWorldById,
  insertWorld,
  countWorlds,
} from './lib/db.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const NAME_MAX = 60;
const CREATOR_MAX = 32;

const app = express();

/* ------------------------------------------------------------------ *
 * Hardening middleware.
 * ------------------------------------------------------------------ */
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// The dashboard and sandbox are fully self-contained: A-Frame and the glTF
// exporter come from pinned CDNs and everything else is same-origin. When
// parcels are stored in Vercel Blob they are fetched from that CDN, hence the
// extra img-src/connect-src allowance.
//
// `'unsafe-eval'` is required by A-Frame 1.4.2, which builds msdf font
// metric accessors with `new Function` (and uses the same trick to resolve
// the webpack global) at bundle load. Without it every A-Frame system fails
// to initialise. This is safe to allow here because no server or user
// supplied string is ever evaluated as script: the only dynamic HTML in the
// app is escaped before insertion, and the API accepts JSON data only.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://aframe.io https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
      "font-src 'self' data:",
      "media-src 'self' blob: data:",
      "connect-src 'self' https://*.public.blob.vercel-storage.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  next();
});

/* ------------------------------------------------------------------ *
 * Validation helpers.
 * ------------------------------------------------------------------ */

/** Strips control characters and collapses whitespace. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase, filesystem-safe slug. Never empty, never contains `..` or `/`. */
function slugify(value, fallback = 'world') {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/** Only ever accept a positive integer id - blocks SQL/param pollution. */
function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw ?? ''))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Public-facing shape of a world row (file_path -> url alias kept for clarity). */
function serializeWorld(row) {
  return {
    id: row.id,
    name: row.name,
    creator: row.creator,
    file_path: row.file_path,
    url: row.file_path,
    created_at: row.created_at,
  };
}

/** Wraps an async route handler so rejections reach the error middleware. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ------------------------------------------------------------------ *
 * Simple in-memory throttle so a single client cannot flood the
 * procedural assembler. Not a substitute for an edge rate limiter, but
 * keeps a warm instance responsive.
 * ------------------------------------------------------------------ */
const CREATE_WINDOW_MS = 60_000;
const CREATE_MAX_PER_WINDOW = 20;
const createHits = new Map();

function throttleCreate(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const hits = (createHits.get(key) || []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (hits.length >= CREATE_MAX_PER_WINDOW) {
    return res.status(429).json({
      error: 'Rate limit reached. The mainframe needs a moment to cool down.',
    });
  }
  hits.push(now);
  createHits.set(key, hits);
  return next();
}

/* ------------------------------------------------------------------ *
 * Static assets.
 *
 * On Vercel the CDN serves `public/` directly and these routes never run;
 * locally they are the only way the dashboard is reachable.
 * ------------------------------------------------------------------ */
app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.glb')) {
        res.setHeader('Content-Type', 'model/gltf-binary');
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  })
);

/* ------------------------------------------------------------------ *
 * API: catalog.
 * ------------------------------------------------------------------ */
app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    const { database, storage } = backendLabel();
    res.json({
      status: 'ONLINE',
      database,
      storage,
      worlds: await countWorlds(),
      time: new Date().toISOString(),
    });
  })
);

app.get(
  '/api/worlds',
  asyncRoute(async (req, res) => {
    const worlds = (await listWorlds()).map(serializeWorld);
    res.json({ count: worlds.length, worlds });
  })
);

app.get(
  '/api/worlds/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: 'World id must be a positive integer.' });
    }
    const world = await getWorldById(id);
    if (!world) {
      return res.status(404).json({ error: `World ${id} not found in the catalog.` });
    }
    return res.json({ world: serializeWorld(world) });
  })
);

/* ------------------------------------------------------------------ *
 * API: procedural world creation.
 * ------------------------------------------------------------------ */
app.post(
  '/api/create-world',
  throttleCreate,
  asyncRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    const worldName = cleanText(body.worldName);
    const homesteaderName = cleanText(body.homesteaderName ?? body.creator);

    if (!worldName || !homesteaderName) {
      return res.status(400).json({
        error: 'Both worldName and homesteaderName are required.',
      });
    }
    if (worldName.length > NAME_MAX) {
      return res.status(400).json({ error: `worldName must be ${NAME_MAX} characters or fewer.` });
    }
    if (homesteaderName.length > CREATOR_MAX) {
      return res
        .status(400)
        .json({ error: `homesteaderName must be ${CREATOR_MAX} characters or fewer.` });
    }

    // Build the binary glTF buffer from scratch.
    const glb = await buildStarterWorldBuffer({ worldName, homesteaderName });

    // Unique, non-guessable, traversal-proof filename.
    const unique = crypto.randomBytes(6).toString('hex');
    const filename = `${slugify(worldName)}-${unique}.glb`;

    // Vercel Blob in production, public/uploads/ locally.
    const filePath = await saveWorldAsset(filename, glb);

    const world = await insertWorld({
      name: worldName,
      creator: homesteaderName,
      filePath,
    });

    return res.status(201).json({
      message: 'Homestead parcel claimed.',
      bytes: glb.byteLength,
      world: serializeWorld(world),
    });
  })
);

/* ------------------------------------------------------------------ *
 * Page routes.
 * ------------------------------------------------------------------ */
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/explore', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'explore.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Unknown API endpoint.' });
  }
  return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// Central error handler - never leaks stack traces to the client.
app.use((err, req, res, next) => {
  console.error('[geoworld] unhandled error:', err);
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.parse.failed' ? 400 : 500;
  return res.status(status).json({
    error:
      status === 400
        ? 'Malformed JSON payload.'
        : 'Internal mainframe fault. Check the server console.',
  });
});

/* ------------------------------------------------------------------ *
 * Boot.
 * ------------------------------------------------------------------ */
export async function startServer(port = PORT, host = HOST) {
  await initDatabase();
  const { database, storage } = backendLabel();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log('==================================================');
      console.log('  GeoWorld 3D Network - HOMESTEAD MAINFRAME ONLINE');
      console.log('==================================================');
      console.log(`  dashboard : http://localhost:${port}/`);
      console.log(`  sandbox   : http://localhost:${port}/explore?id=<id>`);
      console.log(`  database  : ${database}`);
      console.log(`  storage   : ${storage}`);
      console.log(`  backends  : postgres=${USE_POSTGRES} blob=${USE_BLOB}`);
      console.log('==================================================');
      resolve(server);
    });
  });
}

export { app };

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('[geoworld] failed to start:', err);
    process.exit(1);
  });
}

export default app;
