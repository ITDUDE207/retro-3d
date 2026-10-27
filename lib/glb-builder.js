/**
 * GeoWorld 3D Network - server side 3D assembly utility.
 *
 * Procedurally builds a valid binary glTF 2.0 (.glb) "starter homestead":
 * a neon checkerboard grid floor, a perimeter glow border, a platform slab
 * and three low-poly structural columns.
 *
 * The document is emitted with @gltf-transform/core so the resulting buffer
 * is spec compliant and can be loaded by three.js / A-Frame GLTFLoader.
 */

import { Document, NodeIO } from '@gltf-transform/core';

/* ------------------------------------------------------------------ *
 * Palette - 1990s cyberpunk terminal: pure black + neon green.
 * ------------------------------------------------------------------ */
const MATERIALS = {
  tileNeon: { base: [0.0, 0.9, 0.12, 1.0], emissive: [0.0, 0.55, 0.07], rough: 0.6 },
  tileDark: { base: [0.01, 0.04, 0.02, 1.0], emissive: [0.0, 0.01, 0.0], rough: 0.95 },
  slab: { base: [0.015, 0.02, 0.025, 1.0], emissive: [0.0, 0.0, 0.0], rough: 1.0 },
  neon: { base: [0.0, 1.0, 0.2, 1.0], emissive: [0.0, 0.7, 0.1], rough: 0.4 },
  neonSoft: { base: [0.0, 0.45, 0.12, 1.0], emissive: [0.0, 0.25, 0.05], rough: 0.5 },
};

/* ------------------------------------------------------------------ *
 * Raw geometry generators (positions / normals / indices).
 * All primitives are centred on their own origin.
 * ------------------------------------------------------------------ */
function quad(w, d) {
  const hw = w / 2;
  const hd = d / 2;
  return {
    positions: new Float32Array([-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
  };
}

function box(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  faces.forEach((face, fi) => {
    face.v.forEach((vert) => {
      positions.push(vert[0], vert[1], vert[2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
    });
    const o = fi * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

function cylinder(radiusTop, radiusBottom, height, segments) {
  const positions = [];
  const normals = [];
  const indices = [];
  const halfH = height / 2;
  const slope = height === 0 ? 0 : (radiusBottom - radiusTop) / height;
  const isApex = radiusTop < 1e-6;

  // Side wall.
  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    const cx = Math.cos(t);
    const cz = Math.sin(t);
    const len = Math.hypot(cx, slope, cz) || 1;
    const nx = cx / len;
    const ny = slope / len;
    const nz = cz / len;
    positions.push(radiusTop * cx, halfH, radiusTop * cz);
    positions.push(radiusBottom * cx, -halfH, radiusBottom * cz);
    normals.push(nx, ny, nz, nx, ny, nz);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, d, b, a, c, d);
  }

  // Bottom cap.
  const bottomCenter = positions.length / 3;
  positions.push(0, -halfH, 0);
  normals.push(0, -1, 0);
  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    positions.push(radiusBottom * Math.cos(t), -halfH, radiusBottom * Math.sin(t));
    normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i += 1) {
    indices.push(bottomCenter, bottomCenter + 1 + i, bottomCenter + 2 + i);
  }

  // Top cap (skipped for cones).
  if (!isApex) {
    const topCenter = positions.length / 3;
    positions.push(0, halfH, 0);
    normals.push(0, 1, 0);
    for (let i = 0; i <= segments; i += 1) {
      const t = (i / segments) * Math.PI * 2;
      positions.push(radiusTop * Math.cos(t), halfH, radiusTop * Math.sin(t));
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < segments; i += 1) {
      indices.push(topCenter, topCenter + 2 + i, topCenter + 1 + i);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

/* ------------------------------------------------------------------ *
 * glTF document assembly.
 * ------------------------------------------------------------------ */
function createMaterial(doc, name, spec) {
  return doc
    .createMaterial(name)
    .setBaseColorFactor(spec.base)
    .setMetallicFactor(0.05)
    .setRoughnessFactor(spec.rough)
    .setEmissiveFactor(spec.emissive)
    .setDoubleSided(true);
}

function createGeometry(doc, buffer, geo) {
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(geo.positions)
    .setBuffer(buffer);
  const normal = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(geo.normals)
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(geo.indices)
    .setBuffer(buffer);
  return { position, normal, indices };
}

function addMeshNode(doc, buffer, name, material, geometries, translation = [0, 0, 0]) {
  const mesh = doc.createMesh(name);
  geometries.forEach((geo) => {
    const attrs = createGeometry(doc, buffer, geo);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', attrs.position)
      .setAttribute('NORMAL', attrs.normal)
      .setIndices(attrs.indices)
      .setMaterial(material);
    mesh.addPrimitive(prim);
  });
  const node = doc.createNode(name).setMesh(mesh).setTranslation(translation);
  return node;
}

/**
 * Builds the checkerboard floor: a single mesh holding two primitives
 * (one per material) so the grid stays cheap to render.
 */
function buildCheckerboard(tileSize, tiles) {
  const dark = { positions: [], normals: [], indices: [] };
  const neon = { positions: [], normals: [], indices: [] };
  const half = (tiles * tileSize) / 2;

  for (let ix = 0; ix < tiles; ix += 1) {
    for (let iz = 0; iz < tiles; iz += 1) {
      const cx = -half + tileSize / 2 + ix * tileSize;
      const cz = -half + tileSize / 2 + iz * tileSize;
      const target = (ix + iz) % 2 === 0 ? neon : dark;
      const base = target.positions.length / 3;
      const h = tileSize / 2;
      target.positions.push(cx - h, 0, cz - h, cx + h, 0, cz - h, cx + h, 0, cz + h, cx - h, 0, cz + h);
      for (let i = 0; i < 4; i += 1) target.normals.push(0, 1, 0);
      target.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  const pack = (src) => ({
    positions: new Float32Array(src.positions),
    normals: new Float32Array(src.normals),
    indices: new Uint16Array(src.indices),
  });
  return { dark: pack(dark), neon: pack(neon) };
}

/**
 * @returns {Promise<Uint8Array>} binary glTF buffer for a starter world.
 */
export async function buildStarterWorldBuffer(options = {}) {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'GeoWorld 3D Network GLB Assembler';
  doc.getRoot().getAsset().copyright = 'GeoWorld 3D Network';
  const buffer = doc.createBuffer('geoworld-starter');

  const mats = {
    tileNeon: createMaterial(doc, 'neon_grid', MATERIALS.tileNeon),
    tileDark: createMaterial(doc, 'void_grid', MATERIALS.tileDark),
    slab: createMaterial(doc, 'platform_slab', MATERIALS.slab),
    neon: createMaterial(doc, 'neon_structure', MATERIALS.neon),
    neonSoft: createMaterial(doc, 'neon_accent', MATERIALS.neonSoft),
  };

  const scene = doc.createScene('GeoWorld Base Homestead');
  const worldSize = 40;
  const tileSize = 2;
  const tiles = worldSize / tileSize;

  // 1. Platform slab beneath the grid.
  scene.addChild(
    addMeshNode(doc, buffer, 'base_slab', mats.slab, [box(worldSize + 2, 1, worldSize + 2)], [0, -0.5, 0])
  );

  // 2. Neon checkerboard grid floor (two primitives, two materials).
  const checker = buildCheckerboard(tileSize, tiles);
  const floorMesh = doc.createMesh('base_floor');
  [
    [checker.neon, mats.tileNeon],
    [checker.dark, mats.tileDark],
  ].forEach(([geo, material]) => {
    const attrs = createGeometry(doc, buffer, geo);
    floorMesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', attrs.position)
        .setAttribute('NORMAL', attrs.normal)
        .setIndices(attrs.indices)
        .setMaterial(material)
    );
  });
  scene.addChild(doc.createNode('base_floor').setMesh(floorMesh).setTranslation([0, 0.02, 0]));

  // 3. Glowing perimeter border.
  const half = worldSize / 2 + 0.5;
  const borderSpecs = [
    [worldSize + 2, 0.5, 0.5, [0, 0.25, -half]],
    [worldSize + 2, 0.5, 0.5, [0, 0.25, half]],
    [0.5, 0.5, worldSize + 2, [-half, 0.25, 0]],
    [0.5, 0.5, worldSize + 2, [half, 0.25, 0]],
  ];
  const borderMesh = doc.createMesh('base_border');
  borderSpecs.forEach(([w, h, d]) => {
    const attrs = createGeometry(doc, buffer, box(w, h, d));
    borderMesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', attrs.position)
        .setAttribute('NORMAL', attrs.normal)
        .setIndices(attrs.indices)
        .setMaterial(mats.neon)
    );
  });
  scene.addChild(doc.createNode('base_border').setMesh(borderMesh));

  // 4. Three low-poly structural columns.
  scene.addChild(
    addMeshNode(doc, buffer, 'column_box', mats.neon, [box(1.6, 6, 1.6)], [-9, 3, -9])
  );
  scene.addChild(
    addMeshNode(
      doc,
      buffer,
      'column_cylinder',
      mats.neonSoft,
      [cylinder(1.0, 1.2, 7, 12)],
      [0, 3.5, -13]
    )
  );
  scene.addChild(
    addMeshNode(doc, buffer, 'column_pyramid', mats.neon, [cylinder(0, 1.6, 8, 4)], [9, 4, -9])
  );

  // 5. Central spawn pad marker.
  scene.addChild(
    addMeshNode(
      doc,
      buffer,
      'spawn_pad',
      mats.neonSoft,
      [cylinder(2.4, 2.4, 0.12, 24)],
      [0, 0.08, 6]
    )
  );

  doc.getRoot().setDefaultScene(scene);

  const glb = await new NodeIO().writeBinary(doc);
  return glb instanceof Uint8Array ? glb : new Uint8Array(glb);
}

/** Node names the client can expect inside the generated base layout. */
export const BASE_NODE_NAMES = [
  'base_slab',
  'base_floor',
  'base_border',
  'column_box',
  'column_cylinder',
  'column_pyramid',
  'spawn_pad',
];

export default buildStarterWorldBuffer;
