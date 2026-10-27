# GeoWorld 3D Network

A modern reimagining of the 1996 GeoCities VRML homesteads, rebuilt for the
browser. Users claim a parcel of digital real estate, get a procedurally
generated `.glb` base homestead, walk through it in 3D with WASD + mouse, and
(if they own the parcel) sculpt it with a live node editor and export the
result as a `.glb` file.

Stack: **Express + Neon Postgres (or SQLite) + Vercel Blob + A-Frame +
vanilla JS**. No bundler, no React, no build step.

---

## Quick start (local)

```bash
npm install
npm run seed     # creates geoworld.db and 3 sample homesteads
npm start        # http://localhost:3000
```

Then open <http://localhost:3000>, enter a homesteader name, and claim a world.

With no environment variables set the app runs entirely offline: the catalog
lives in a local SQLite file (`geoworld.db`) and generated parcels are written
to `public/uploads/`.

| Script | Purpose |
| --- | --- |
| `npm start` | Boot the mainframe on `:3000` (`PORT` / `HOST` env overrides). |
| `npm run seed` | Rebuild the catalog and regenerate the sample `.glb` parcels. |
| `npm run verify` | Validate that the procedural GLB builder emits a well-formed binary. |
| `npm run dev` | Same as start, with `node --watch`. |

---

## Deploy to Vercel

The app deploys as a single Node serverless function. Vercel serves `public/`
from its CDN and rewrites every other request to `api/index.js`, which wraps
the same Express app used locally.

1. **Create a Neon database.** In the [Neon console](https://console.neon.tech)
   create a project, then copy the **pooled** connection string
   (`...-pooler...`, ends in `?sslmode=require`).

2. **Create a Vercel Blob store.** In your Vercel project go to
   **Storage → Create Database → Blob**, then copy its **Read/Write Token**.
   (Blob storage is required because the serverless filesystem is read-only
   outside `/tmp`, so generated `.glb` files cannot live on disk.)

3. **Set the environment variables** for Production, Preview and Development
   under **Project → Settings → Environment Variables** (or via the CLI):

   | Variable | Purpose |
   | --- | --- |
   | `DATABASE_URL` | Neon pooled Postgres connection string. |
   | `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token for `.glb` parcels. |

   ```bash
   vercel env add DATABASE_URL
   vercel env add BLOB_READ_WRITE_TOKEN
   ```

   The table is created automatically on the first request; no migration step
   is required. To pre-populate demo parcels instead, run
   `DATABASE_URL=... npm run seed` locally against the same database.

4. **Deploy.**

   ```bash
   vercel          # preview deployment
   vercel --prod   # production deployment
   ```

`.env.example` documents every variable the app understands.

### How the backend is selected

| Condition | Catalog | `.glb` parcels |
| --- | --- | --- |
| `DATABASE_URL` set | Neon Postgres | Vercel Blob (if token set) |
| `DATABASE_URL` unset | local SQLite | `public/uploads/` |

Both database drivers are imported lazily, so the unused one is never loaded
(the SQLite native binding is not required on Vercel). `GET /api/health`
reports the active backends:

```json
{ "status": "ONLINE", "database": "neon-postgres", "storage": "vercel-blob", "worlds": 3 }
```

---

## Layout

```
server.js                 Express app: API, static hosting, GLB assembler endpoint
api/index.js              Vercel serverless entrypoint (wraps server.js)
vercel.json               Vercel build + rewrite configuration
seed.js                   Rebuilds the catalog and sample parcels
lib/config.js             Environment variables + backend selection
lib/db.js                 Postgres / SQLite schema + async queries
lib/glb-builder.js        Procedural .glb base homestead generator (@gltf-transform/core)
lib/glb-store.js          Vercel Blob / local-disk asset storage
scripts/verify-glb.js     GLB validation harness
public/index.html         Central Hub dashboard
public/explore.html       A-Frame sandbox canvas
public/404.html           Dead-link page
public/css/terminal.css   Neon-on-black terminal theme
public/js/app.js          Dashboard logic (login, create, catalog polling)
public/js/explore.js      Sandbox engine (assembly, editor, exporter)
public/uploads/           Generated .glb parcels (local mode)
```

---

## API

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, active backends + row count. |
| `GET` | `/api/worlds` | Full catalog, newest first. |
| `GET` | `/api/worlds/:id` | One parcel; `400` on a non-numeric id, `404` if absent. |
| `POST` | `/api/create-world` | Body `{ worldName, homesteaderName }`. Builds a `.glb` from scratch, stores it (Blob or disk), inserts the row. |

Example:

```bash
curl -X POST http://localhost:3000/api/create-world \
  -H 'Content-Type: application/json' \
  -d '{"worldName":"Neon Suburb","homesteaderName":"dude_207"}'
```

---

## How the pieces work

### Procedural base homestead

`lib/glb-builder.js` assembles a scene graph in memory with
`@gltf-transform/core` and serialises it to a real binary `.glb` buffer:
a green neon checker floor, a dark void grid beneath it, a platform slab, four
neon border rails, a spawn pad, and three low-poly structural columns (box,
cylinder, pyramid). Every node and material is named, so the file stays
readable when reopened in any glTF tool. Nothing is templated on disk - the
bytes are generated per request.

### Asset storage

`lib/glb-store.js` returns a public URL for each generated parcel. With
`BLOB_READ_WRITE_TOKEN` set the buffer is uploaded to Vercel Blob and the CDN
URL is stored in `worlds.file_path`; otherwise it is written to
`public/uploads/` and served by Express.

### Identity evaluation lock

`public/explore.html` compares `localStorage.geoworld_username` against the
parcel's stored `creator` handle:

- **Owner** - the editor dock is revealed: spawner buttons for cubes,
  spheres, cylinders, cones, planes and tori; sliders for X/Y/Z position,
  rotation, uniform scale and colour; duplicate and delete.
- **Visitor / anonymous** - the editor container is removed from the DOM
  entirely (not merely hidden), along with the download and reset controls.
  The scene stays read-only and guests can still walk the space.

> **Scope note.** This is an *authoring* lock, not an authorisation boundary.
> It is sufficient here because the sandbox never writes back to the server:
> edits live in browser memory and can only leave the machine as a file the
> user downloads. Before any edit-persisting endpoint is added, this needs to
> become real server-side authentication.

### Mesh compiler and exporter

The **Download World (.glb)** button (owner only) hands the live A-Frame scene
graph - the loaded base homestead plus every spawned node - to
`THREE.GLTFExporter`, serialises it to binary, rewrites the container scene
name to something self-describing, and streams it to the browser as
`<world>_backup.glb`. The selection highlight (`BoxHelper`) is deliberately
excluded from the export.

### Movement

The camera uses A-Frame's bundled `wasd-controls` (with `fly: false`, so you
stay on the ground) and `look-controls` for mouse-drag look. Click a spawned
object to select it; sliders then transform the selection live.

---

## Security posture

- All input is validated and length-capped before use; ids must match
  `^\d+$`, so no SQL or path material ever derives from raw user text.
- Upload filenames are slugified and suffixed with a random hex token, so a
  hostile world name cannot escape the upload namespace.
- All SQL goes through bound parameters on both Postgres and SQLite.
- Credentials (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`) are read only from the
  environment and are never logged or committed; `.env` files are gitignored.
- Responses carry `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options` and a restrictive CSP.
- The CSP allows `'unsafe-eval'` because A-Frame 1.4.2 builds msdf font
  accessors with `new Function` at bundle load and will not initialise without
  it. Nothing server- or user-supplied is ever evaluated as script: dynamic
  HTML is escaped before insertion and the API consumes JSON only.
- Error responses are generic; stack traces stay in the server console.

---

## Notes

- Locally, generated artifacts (`geoworld.db`, `public/uploads/*.glb`) are
  gitignored. Run `npm run seed` after cloning.
- On Vercel, the catalog lives in Neon Postgres and parcels in Vercel Blob;
  nothing is written to the deployment filesystem.
- A-Frame 1.4.2 and the three.js `GLTFExporter` are pinned and loaded from
  CDN. A-Frame 1.4.2 bundles three r147, so the exporter build must match that
  revision.
