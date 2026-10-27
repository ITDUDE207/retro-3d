/**
 * GeoWorld 3D Network - .glb asset storage.
 *
 * Vercel's serverless filesystem is read-only apart from `/tmp`, so generated
 * parcels cannot live on disk in production. When `BLOB_READ_WRITE_TOKEN` is
 * present the buffer is uploaded to Vercel Blob and the public CDN URL is
 * returned; otherwise it is written to `public/uploads/` for local use.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { BLOB_READ_WRITE_TOKEN, UPLOAD_DIR, USE_BLOB } from './config.js';

/**
 * Persists a generated parcel and returns its public URL.
 *
 * @param {string} filename  Slugified, random-suffixed `.glb` filename.
 * @param {Uint8Array} buffer Binary glTF payload.
 * @returns {Promise<string>} URL stored in `worlds.file_path`.
 */
export async function saveWorldAsset(filename, buffer) {
  if (USE_BLOB) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`uploads/${filename}`, Buffer.from(buffer), {
      access: 'public',
      contentType: 'model/gltf-binary',
      token: BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });
    return blob.url;
  }

  const absolutePath = path.join(UPLOAD_DIR, filename);
  // Defence in depth: assert the resolved path is still inside uploads/.
  if (path.dirname(path.resolve(absolutePath)) !== path.resolve(UPLOAD_DIR)) {
    throw new Error('Invalid world name.');
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(buffer));
  return `/uploads/${filename}`;
}
