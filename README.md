# GeoWorld 3D Network

A modern reimagining of the 1996 GeoCities VRML homesteads, rebuilt for the
browser. Users claim a parcel of digital real estate, get a procedurally
generated `.glb` base homestead, walk through it in 3D with WASD + mouse, and
(if they own the parcel) sculpt it with a live node editor and export the
result as a `.glb` file.

Stack: **Express + better-sqlite3 + A-Frame + vanilla JS**. No bundler, no
React, no build step.

---

## Quick start

```bash
npm install
npm run seed     # creates geoworld.db and 3 sample homesteads
npm start        # http://localhost:3000
```

Then open <http://localhost:3000>, enter a homesteader name, and claim a world.

| Script | Purpose |
| --- | --- |
| `npm start` | Boot the mainframe on `:3000` (`PORT` / `HOST` env overrides). |
| `npm run seed` | Rebuild `geoworld.db` and regenerate the sample `.glb` uploads. |
| `npm run verify` | Validate that the procedural GLB builder emits a well-formed binary. |
| `npm run dev` | Same as start, with `node --watch`. |

---

## Layout

```
server.js                 Express app: API, static hosting, GLB assembler endpoint
seed.js                   Rebuilds the database and sample parcels
lib/db.js                 SQLite schema + queries
lib/glb-builder.js        Procedural .glb base homestead generator (@gltf-transform/core)
scripts/verify-glb.js     GLB validation harness
public/index.html         Central Hub dashboard
public/explore.html       A-Frame sandbox canvas
public/404.html           Dead-link page
public/css/terminal.css   Neon-on-black terminal theme
public/js/app.js          Dashboard logic (login, create, catalog polling)
public/js/explore.js      Sandbox engine (assembly, editor, exporter)
public/uploads/           Generated .glb parcels
```

---

## API

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + row count. |
| `GET` | `/api/worlds` | Full catalog, newest first. |
| `GET` | `/api/worlds/:id` | One parcel; `400` on a non-numeric id, `404` if absent. |
| `POST` | `/api/create-world` | Body `{ worldName, homesteaderName }`. Builds a `.glb` from scratch, writes it to `public/uploads/`, inserts the row. |

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
  hostile world name cannot escape `public/uploads/`.
- All SQL goes through prepared statements.
- Responses carry `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options` and a restrictive CSP.
- The CSP allows `'unsafe-eval'` because A-Frame 1.4.2 builds msdf font
  accessors with `new Function` at bundle load and will not initialise without
  it. Nothing server- or user-supplied is ever evaluated as script: dynamic
  HTML is escaped before insertion and the API consumes JSON only.
- Error responses are generic; stack traces stay in the server console.

---

## Notes

- Generated artifacts (`geoworld.db`, `public/uploads/*.glb`) are gitignored.
  Run `npm run seed` after cloning.
- A-Frame 1.4.2 and the three.js `GLTFExporter` are pinned and loaded from
  CDN. A-Frame 1.4.2 bundles three r147, so the exporter build must match that
  revision.
