/**
 * GeoWorld 3D Network - database seeder.
 *
 * Applies the `worlds` schema to whichever backend is configured (Neon
 * Postgres when `DATABASE_URL` is set, SQLite otherwise) and - unless the
 * catalog is already populated - claims a few demo homestead parcels by
 * running the same procedural .glb assembler the API uses.
 *
 * Usage:  npm run seed             # add demo parcels if the catalog is empty
 *         npm run seed -- --reset  # wipe the catalog first
 */

import crypto from 'node:crypto';

import { buildStarterWorldBuffer } from './lib/glb-builder.js';
import { saveWorldAsset } from './lib/glb-store.js';
import { backendLabel } from './lib/config.js';
import {
  initDatabase,
  insertWorld,
  listWorlds,
  resetWorlds,
  closeDatabase,
} from './lib/db.js';

const DEMO_WORLDS = [
  { name: 'Neon Grid Plaza', creator: 'system_op', hint: 'public commons' },
  { name: 'Silicon Alley 1996', creator: 'webmaster_x', hint: 'retro district' },
  { name: 'Terminal Garden', creator: 'mainframe_mary', hint: 'quiet sector' },
];

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'world'
  );
}

async function main() {
  const reset = process.argv.includes('--reset');

  await initDatabase();
  const { database, storage } = backendLabel();
  console.log(`[seed] database ready (${database}), assets -> ${storage}`);

  if (reset) {
    await resetWorlds();
    console.log('[seed] catalog reset (--reset)');
  }

  const existing = await listWorlds();
  if (existing.length > 0 && !reset) {
    console.log(`[seed] catalog already holds ${existing.length} world(s); nothing to do.`);
    console.log('[seed] run `npm run seed -- --reset` to rebuild from scratch.');
    closeDatabase();
    return;
  }

  for (const demo of DEMO_WORLDS) {
    const glb = await buildStarterWorldBuffer(demo);
    const unique = crypto.randomBytes(6).toString('hex');
    const filename = `${slugify(demo.name)}-${unique}.glb`;
    const filePath = await saveWorldAsset(filename, glb);
    const world = await insertWorld({
      name: demo.name,
      creator: demo.creator,
      filePath,
    });
    console.log(
      `[seed] parcel #${world.id} "${world.name}" -> ${world.file_path} (${glb.byteLength} bytes)`
    );
  }

  console.log(`[seed] complete. ${(await listWorlds()).length} world(s) in the catalog.`);
  closeDatabase();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
