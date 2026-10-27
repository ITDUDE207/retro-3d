/**
 * GeoWorld 3D Network - database seeder.
 *
 * Creates the `geoworld.db` file, applies the `worlds` schema and (unless
 * already populated) claims a few demo homestead parcels by running the same
 * procedural .glb assembler the API uses.
 *
 * Usage:  npm run seed        # add demo parcels if the catalog is empty
 *         npm run seed -- --reset   # wipe the catalog first
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { buildStarterWorldBuffer } from './lib/glb-builder.js';
import {
  DB_PATH,
  UPLOAD_DIR,
  openDatabase,
  getDatabase,
  insertWorld,
  listWorlds,
  closeDatabase,
} from './lib/db.js';

const DEMO_WORLDS = [
  { name: 'Neon Grid Plaza', creator: 'system_op', hint: 'public commons' },
  { name: 'Silicon Alley 1996', creator: 'webmaster_x', hint: 'retro district' },
  { name: 'Terminal Garden', creator: 'mainframe_mary', hint: 'quiet sector' },
];

async function main() {
  const reset = process.argv.includes('--reset');

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  openDatabase();
  console.log(`[seed] database ready at ${DB_PATH}`);

  if (reset) {
    getDatabase().exec('DELETE FROM worlds;');
    getDatabase().exec("DELETE FROM sqlite_sequence WHERE name = 'worlds';");
    console.log('[seed] catalog reset (--reset)');
  }

  const existing = listWorlds();
  if (existing.length > 0 && !reset) {
    console.log(`[seed] catalog already holds ${existing.length} world(s); nothing to do.`);
    console.log('[seed] run `npm run seed -- --reset` to rebuild from scratch.');
    closeDatabase();
    return;
  }

  for (const demo of DEMO_WORLDS) {
    const glb = await buildStarterWorldBuffer(demo);
    const unique = crypto.randomBytes(6).toString('hex');
    const slug = demo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const filename = `${slug}-${unique}.glb`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(glb));
    const world = insertWorld({
      name: demo.name,
      creator: demo.creator,
      filePath: `/uploads/${filename}`,
    });
    console.log(`[seed] parcel #${world.id} "${world.name}" -> ${world.file_path} (${glb.byteLength} bytes)`);
  }

  console.log(`[seed] complete. ${listWorlds().length} world(s) in the catalog.`);
  closeDatabase();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
