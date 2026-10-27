/* ==================================================================
   GeoWorld 3D Network - Dynamic Sandbox Canvas Engine
   --------------------------------------------------------------
   Loads a server-generated .glb base homestead into an A-Frame scene,
   evaluates the visitor's identity against the world's creator handle
   and unlocks a full node editor (owner) or a read-only walk-through
   (visitor). Owners can compile the live scene graph back into a
   binary .glb using THREE.GLTFExporter.

   NOTE ON THE IDENTITY LOCK
   The owner/visitor decision is made from localStorage, so it is an
   authoring convenience, not an authorisation boundary. It is safe
   here because the sandbox never writes back to the server: edits
   live in browser memory and can only leave the machine as a file the
   user downloads. Nothing a "visitor" can do in this page mutates the
   stored world. Server-side authentication would be required before
   any edit-persisting endpoint is added.
   ================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'geoworld_username';

  /* ------------------------------------------------------------------ *
   * Primitive catalogue for the spawner.
   * `groundY` keeps each shape resting on the floor by default.
   * ------------------------------------------------------------------ */
  var PRIMITIVES = {
    box: { label: 'Cube', geometry: 'primitive: box; width: 1; height: 1; depth: 1', groundY: 0.5 },
    sphere: { label: 'Sphere', geometry: 'primitive: sphere; radius: 0.6; segmentsWidth: 18; segmentsHeight: 12', groundY: 0.6 },
    cylinder: { label: 'Cylinder', geometry: 'primitive: cylinder; radius: 0.5; height: 1.2; segmentsRadial: 16', groundY: 0.6 },
    cone: { label: 'Cone', geometry: 'primitive: cone; radiusBottom: 0.6; radiusTop: 0; height: 1.4; segmentsRadial: 8', groundY: 0.7 },
    plane: { label: 'Plane', geometry: 'primitive: plane; width: 2; height: 2', groundY: 0.03, rotation: { x: -90, y: 0, z: 0 } },
    torus: { label: 'Torus', geometry: 'primitive: torus; radius: 0.6; radiusTubular: 0.18; segmentsRadial: 12; segmentsTubular: 20', groundY: 0.8 },
  };

  var FALLBACK_NEON = '#00ff00';

  /* ------------------------------------------------------------------ *
   * DOM handles.
   * ------------------------------------------------------------------ */
  var el = {
    scene: document.getElementById('world-scene'),
    baseWorld: document.getElementById('base-world'),
    userObjects: document.getElementById('user-objects'),
    title: document.getElementById('world-title'),
    metaId: document.getElementById('meta-id'),
    metaCreator: document.getElementById('meta-creator'),
    metaCreated: document.getElementById('meta-created'),
    metaAsset: document.getElementById('meta-asset'),
    identityBadge: document.getElementById('identity-badge'),
    status: document.getElementById('hud-status'),
    btnDownload: document.getElementById('btn-download'),
    btnReset: document.getElementById('btn-reset'),
    btnExit: document.getElementById('btn-exit'),
    helpOwner: document.getElementById('help-owner'),
    editorPanel: document.getElementById('editor-panel'),
    selectionReadout: document.getElementById('selection-readout'),
    transformBlock: document.getElementById('transform-block'),
    btnDeselect: document.getElementById('btn-deselect'),
    btnDuplicate: document.getElementById('btn-duplicate'),
    btnDelete: document.getElementById('btn-delete'),
    bootSplash: document.getElementById('boot-splash'),
    bootText: document.getElementById('boot-text'),
    bootSub: document.getElementById('boot-sub'),
  };

  var state = {
    world: null,
    isOwner: false,
    username: null,
    selectedEl: null,
    helper: null,
    spawned: [],
    pointer: { x: 0.5, y: 0.5 },
    hasPointer: false,
    raycaster: new THREE.Raycaster(),
    spawnCount: 0,
  };

  /* ================================================================== *
   * Small helpers.
   * ================================================================== */

  function setStatus(text, kind) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.style.color = kind === 'err' ? '#ff2d2d' : kind === 'ok' ? '#00ff00' : '#ffb000';
  }

  function setBoot(text, sub) {
    if (el.bootText) el.bootText.textContent = text;
    if (sub && el.bootSub) el.bootSub.textContent = sub;
  }

  function hideBoot() {
    if (!el.bootSplash) return;
    el.bootSplash.classList.add('gone');
    window.setTimeout(function () {
      if (el.bootSplash && el.bootSplash.parentNode) {
        el.bootSplash.parentNode.removeChild(el.bootSplash);
      }
    }, 500);
  }

  function formatDate(raw) {
    if (!raw) return '--';
    var iso = String(raw).indexOf('T') === -1 ? String(raw).replace(' ', 'T') + 'Z' : raw;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(raw);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' UTC';
  }

  function readUsername() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function worldIdFromUrl() {
    var raw = new URLSearchParams(window.location.search).get('id');
    if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
    var id = Number(raw);
    return id > 0 ? id : null;
  }

  function threeObjectOf(entity) {
    return entity && entity.object3D ? entity.object3D : null;
  }

  function cameraObject() {
    var cameraEl = document.getElementById('camera');
    return cameraEl ? cameraEl.getObject3D('camera') : null;
  }

  /* ================================================================== *
   * Scene plumbing.
   * ================================================================== */

  function addEntity(attrs) {
    var entity = document.createElement('a-entity');
    Object.keys(attrs).forEach(function (key) {
      entity.setAttribute(key, attrs[key]);
    });
    return entity;
  }

  /** Highlight ring drawn around the current selection (never exported). */
  function ensureHelper() {
    if (state.helper) return state.helper;
    var helper = new THREE.BoxHelper(new THREE.Object3D(), 0x00ff00);
    helper.material.depthTest = false;
    helper.material.transparent = true;
    helper.material.opacity = 0.9;
    helper.visible = false;
    state.helper = helper;
    el.scene.object3D.add(helper);
    return helper;
  }

  function refreshHelper() {
    var helper = ensureHelper();
    var target = threeObjectOf(state.selectedEl);
    if (!target) {
      helper.visible = false;
      return;
    }
    helper.setFromObject(target);
    helper.visible = true;
  }

  /* ================================================================== *
   * Owner editor.
   * ================================================================== */

  function selectEntity(entity) {
    if (!state.isOwner || !entity) return;
    state.selectedEl = entity;
    el.transformBlock.classList.remove('hidden');
    el.selectionReadout.innerHTML =
      '<strong>' + entity.getAttribute('data-node-name') + '</strong><br />' +
      'id: ' + entity.getAttribute('id') + '<br />' +
      'type: ' + entity.getAttribute('data-primitive');
    syncSlidersFromSelection();
    refreshHelper();
  }

  function deselect() {
    state.selectedEl = null;
    if (state.helper) state.helper.visible = false;
    el.transformBlock.classList.add('hidden');
    el.selectionReadout.textContent = 'No object selected. Click a spawned object in the scene.';
  }

  function readTransform(entity) {
    var position = entity.getAttribute('position') || { x: 0, y: 0, z: 0 };
    var rotation = entity.getAttribute('rotation') || { x: 0, y: 0, z: 0 };
    var scale = entity.getAttribute('scale') || { x: 1, y: 1, z: 1 };
    var material = entity.getAttribute('material') || {};
    return {
      position: position,
      rotation: rotation,
      scale: scale,
      color: typeof material.color === 'string' ? material.color : FALLBACK_NEON,
    };
  }

  function sliders() {
    return el.editorPanel ? el.editorPanel.querySelectorAll('[data-slider]') : [];
  }

  function setOut(name, text) {
    var out = el.editorPanel.querySelector('[data-out="' + name + '"]');
    if (out) out.textContent = text;
  }

  function syncSlidersFromSelection() {
    if (!state.selectedEl || !el.editorPanel) return;
    var t = readTransform(state.selectedEl);
    var values = {
      px: t.position.x,
      py: t.position.y,
      pz: t.position.z,
      rx: t.rotation.x,
      ry: t.rotation.y,
      rz: t.rotation.z,
      scale: t.scale.x,
    };
    Object.keys(values).forEach(function (key) {
      var input = el.editorPanel.querySelector('[data-slider="' + key + '"]');
      if (input) input.value = String(values[key]);
      setOut(key, key.indexOf('r') === 0 ? Math.round(values[key]) + '\u00B0' : values[key].toFixed(2));
    });
    var colorInput = el.editorPanel.querySelector('[data-slider="color"]');
    if (colorInput) colorInput.value = t.color;
    setOut('color', t.color);
  }

  function applySlider(name, rawValue) {
    var entity = state.selectedEl;
    if (!entity) return;
    var value = parseFloat(rawValue);
    var current = readTransform(entity);

    if (name === 'scale') {
      var s = isNaN(value) ? 1 : Math.max(0.05, value);
      entity.setAttribute('scale', { x: s, y: s, z: s });
      setOut('scale', s.toFixed(2));
      refreshHelper();
      return;
    }
    if (name === 'color') {
      entity.setAttribute('material', 'color', rawValue);
      entity.setAttribute('data-base-color', rawValue);
      setOut('color', rawValue);
      return;
    }
    if (name.charAt(0) === 'p') {
      var axis = name.charAt(1);
      var position = { x: current.position.x, y: current.position.y, z: current.position.z };
      position[axis] = isNaN(value) ? 0 : value;
      entity.setAttribute('position', position);
      setOut(name, position[axis].toFixed(2));
      refreshHelper();
      return;
    }
    if (name.charAt(0) === 'r') {
      var raxis = name.charAt(1);
      var rotation = { x: current.rotation.x, y: current.rotation.y, z: current.rotation.z };
      rotation[raxis] = isNaN(value) ? 0 : value;
      entity.setAttribute('rotation', rotation);
      setOut(name, Math.round(rotation[raxis]) + '\u00B0');
      refreshHelper();
    }
  }

  function spawnPrimitive(kind) {
    if (!state.isOwner) return;
    var spec = PRIMITIVES[kind];
    if (!spec) return;

    state.spawnCount += 1;
    var id = 'node-' + kind + '-' + state.spawnCount;
    var nodeName = spec.label + ' ' + state.spawnCount;

    var target = cursorSpawnPoint(spec);
    var color = randomNeon();

    var entity = addEntity({
      id: id,
      'data-editable': 'true',
      'data-primitive': kind,
      'data-node-name': nodeName,
      geometry: spec.geometry,
      material: 'shader: standard; color: ' + color + '; emissive: ' + dim(color) + '; emissiveIntensity: 0.35; roughness: 0.55; metalness: 0.05; side: double',
      position: target.x.toFixed(3) + ' ' + target.y.toFixed(3) + ' ' + target.z.toFixed(3),
      scale: '1 1 1',
    });
    if (spec.rotation) {
      entity.setAttribute('rotation', spec.rotation);
    }

    // Give the scene-graph nodes real names so the exported .glb stays readable.
    entity.object3D.name = nodeName;
    entity.addEventListener('object3dset', function (event) {
      if (event.detail.object) event.detail.object.name = nodeName;
    });

    el.userObjects.appendChild(entity);
    state.spawned.push(entity);

    // Bind selection to the entity itself: A-Frame resolves raycast
    // intersections on child meshes back to the owning entity.
    entity.addEventListener('click', function (event) {
      if (event && event.stopPropagation) event.stopPropagation();
      selectEntity(entity);
    });

    selectEntity(entity);
    setStatus('SPAWNED ' + spec.label.toUpperCase() + ' -> ' + id, 'ok');
    return entity;
  }

  function deleteSelected() {
    var entity = state.selectedEl;
    if (!entity) return;
    var index = state.spawned.indexOf(entity);
    if (index >= 0) state.spawned.splice(index, 1);
    if (entity.parentNode) entity.parentNode.removeChild(entity);
    deselect();
    setStatus('NODE DELETED', 'ok');
  }

  function duplicateSelected() {
    var source = state.selectedEl;
    if (!source) return;
    var kind = source.getAttribute('data-primitive');
    if (!PRIMITIVES[kind]) return;
    var copy = spawnPrimitive(kind);
    var t = readTransform(source);
    var offset = 1.2;
    copy.setAttribute('position', {
      x: t.position.x + offset,
      y: t.position.y,
      z: t.position.z + offset,
    });
    copy.setAttribute('rotation', t.rotation);
    copy.setAttribute('scale', t.scale);
    copy.setAttribute('material', 'color', t.color);
    copy.setAttribute('data-base-color', t.color);
    selectEntity(copy);
    setStatus('NODE DUPLICATED', 'ok');
  }

  function resetSandbox() {
    if (!state.isOwner) return;
    state.spawned.slice().forEach(function (entity) {
      if (entity.parentNode) entity.parentNode.removeChild(entity);
    });
    state.spawned.length = 0;
    state.spawnCount = 0;
    deselect();
    setStatus('SANDBOX RESET - BASE LANDSCAPE RESTORED', 'ok');
  }

  /* ================================================================== *
   * Colour helpers (neon-on-black palette).
   * ================================================================== */

  function randomNeon() {
    var hues = [0.33, 0.30, 0.36, 0.47, 0.55, 0.13, 0.88];
    var hue = hues[Math.floor(Math.random() * hues.length)];
    var saturation = 0.85 + Math.random() * 0.15;
    var light = 0.45 + Math.random() * 0.15;
    return hslToHex(hue, saturation, light);
  }

  function hslToHex(h, s, l) {
    function channel(n) {
      var k = (n + h * 12) % 12;
      var a = s * Math.min(l, 1 - l);
      var v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * v);
    }
    return '#' + [channel(0), channel(8), channel(4)]
      .map(function (v) { return v.toString(16).padStart(2, '0'); })
      .join('');
  }

  /** Darkens a hex colour so the spawn gets a subtle self-lit glow. */
  function dim(hex) {
    var clean = String(hex).replace('#', '');
    if (clean.length !== 6) return '#000000';
    var parts = [0, 2, 4].map(function (i) {
      var value = Math.round(parseInt(clean.substr(i, 2), 16) * 0.45);
      return value.toString(16).padStart(2, '0');
    });
    return '#' + parts.join('');
  }

  /* ================================================================== *
   * Cursor raycasting: where does the next primitive land?
   * ================================================================== */

  function updatePointer(clientX, clientY) {
    state.pointer.x = clientX / window.innerWidth;
    state.pointer.y = clientY / window.innerHeight;
    state.hasPointer = true;
  }

  function pointerNdc() {
    return {
      x: state.pointer.x * 2 - 1,
      y: -(state.pointer.y * 2) + 1,
    };
  }

  function selectableObjects() {
    var objects = [];
    state.spawned.forEach(function (entity) {
      var obj = threeObjectOf(entity);
      if (obj) objects.push(obj);
    });
    return objects;
  }

  function collideTargets() {
    var targets = [];
    var base = threeObjectOf(el.baseWorld);
    if (base) targets.push(base);
    targets = targets.concat(selectableObjects());
    return targets;
  }

  /** Raycasts through the cursor and returns the world-space hit point. */
  function cursorHit() {
    var camera = cameraObject();
    if (!camera) return null;
    el.scene.object3D.updateMatrixWorld(true);
    state.raycaster.setFromCamera(pointerNdc(), camera);
    var targets = collideTargets();
    if (!targets.length) return null;
    var hits = state.raycaster.intersectObjects(targets, true);
    return hits.length ? hits[0] : null;
  }

  function cursorSpawnPoint(spec) {
    var hit = cursorHit();
    if (hit) {
      return {
        x: hit.point.x,
        y: Math.max(hit.point.y + spec.groundY * 0.5, spec.groundY),
        z: hit.point.z,
      };
    }
    // Fallback: 7 metres along the view vector, resting on the floor plane.
    var camera = cameraObject();
    if (!camera) return { x: 0, y: spec.groundY, z: 0 };
    var origin = camera.getWorldPosition(new THREE.Vector3());
    var direction = camera.getWorldDirection(new THREE.Vector3());
    var distance = 7;
    return {
      x: origin.x + direction.x * distance,
      y: spec.groundY,
      z: origin.z + direction.z * distance,
    };
  }

  /** Pick the topmost spawned node under the cursor. */
  function pickSpawned() {
    var camera = cameraObject();
    if (!camera) return null;
    var targets = selectableObjects();
    if (!targets.length) return null;
    el.scene.object3D.updateMatrixWorld(true);
    state.raycaster.setFromCamera(pointerNdc(), camera);
    var hits = state.raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    var object = hits[0].object;
    // Walk up to the entity that owns this mesh.
    while (object && !object.el && object.parent) object = object.parent;
    return object && object.el ? object.el : null;
  }

  /* ================================================================== *
   * Pointer wiring.
   * ================================================================== */

  function bindPointer() {
    var canvas = el.scene.canvas;
    if (!canvas) return;

    canvas.addEventListener('pointermove', function (event) {
      updatePointer(event.clientX, event.clientY);
    });

    canvas.addEventListener('pointerup', function (event) {
      updatePointer(event.clientX, event.clientY);
      if (!state.isOwner) return;
      var picked = pickSpawned();
      if (picked) selectEntity(picked);
      else deselect();
    });

    // Suppress the browser context menu so right-drag stays usable for look.
    canvas.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });
  }

  /* ================================================================== *
   * Mesh compiler & exporter.
   * ================================================================== */

  var GLB_MAGIC = 0x46546c67;
  var GLB_CHUNK_JSON = 0x4e4f534a;

  /**
   * The exporter names the container scene "AuxScene" when handed a list of
   * roots. Rewrite that name in the JSON chunk so the downloaded backup is
   * self-describing. Returns a new ArrayBuffer; the input is left untouched.
   */
  function renameGlbScene(arrayBuffer, name) {
    var view = new DataView(arrayBuffer);
    if (view.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) return arrayBuffer;
    var jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== GLB_CHUNK_JSON) return arrayBuffer;

    var json;
    try {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLength)));
    } catch (err) {
      return arrayBuffer;
    }
    if (!json.scenes || !json.scenes.length) return arrayBuffer;
    json.scenes[json.scene || 0].name = name;

    var encoded = new TextEncoder().encode(JSON.stringify(json));
    var padded = encoded.length + ((4 - (encoded.length % 4)) % 4);
    var remainder = new Uint8Array(arrayBuffer, 20 + jsonLength);
    var out = new Uint8Array(12 + 8 + padded + remainder.length);
    var outView = new DataView(out.buffer);

    outView.setUint32(0, GLB_MAGIC, true);
    outView.setUint32(4, 2, true);
    outView.setUint32(8, out.length, true);
    outView.setUint32(12, padded, true);
    outView.setUint32(16, GLB_CHUNK_JSON, true);
    out.set(encoded, 20);
    for (var i = encoded.length; i < padded; i += 1) out[20 + i] = 0x20; // JSON chunk pads with spaces
    out.set(remainder, 20 + padded);
    return out.buffer;
  }

  function exportWorld() {
    if (!state.isOwner) return;
    if (typeof THREE === 'undefined' || typeof THREE.GLTFExporter !== 'function') {
      setStatus('EXPORT FAILED: GLTFExporter UNAVAILABLE', 'err');
      return;
    }

    setStatus('COMPILING SCENE GRAPH -> GLB ...', null);
    el.btnDownload.disabled = true;

    var targets = [];
    var base = threeObjectOf(el.baseWorld);
    if (base) targets.push(base);
    if (el.userObjects.object3D.children.length > 0) {
      targets.push(el.userObjects.object3D);
    }

    var slug = (state.world && state.world.name ? state.world.name : 'homestead')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'homestead';
    var sceneName = slug + '_homestead';

    var exporter = new THREE.GLTFExporter();

    exporter.parse(
      targets,
      function (result) {
        try {
          var buffer = renameGlbScene(result, sceneName);
          var blob = new Blob([buffer], { type: 'model/gltf-binary' });
          var url = URL.createObjectURL(blob);

          var link = document.createElement('a');
          link.href = url;
          link.download = slug + '_backup.glb';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

          var kb = (blob.size / 1024).toFixed(1);
          setStatus('EXPORT OK - ' + link.download + ' (' + kb + ' KB)', 'ok');
        } catch (err) {
          setStatus('EXPORT FAILED: ' + err.message, 'err');
        } finally {
          el.btnDownload.disabled = false;
        }
      },
      function (error) {
        setStatus('EXPORT FAILED: ' + (error && error.message ? error.message : 'unknown'), 'err');
        el.btnDownload.disabled = false;
      },
      { binary: true, trs: true, onlyVisible: true }
    );
  }

  /* ================================================================== *
   * Identity evaluation lock.
   * ================================================================== */

  function evaluateIdentity(world) {
    state.username = readUsername();
    state.isOwner = Boolean(state.username) && state.username === world.creator;

    if (state.isOwner) {
      el.identityBadge.textContent = 'MODE: OWNER (EDIT UNLOCKED)';
      el.identityBadge.classList.add('you');
      el.editorPanel.hidden = false;
      document.body.classList.add('editor-open');
      el.btnDownload.classList.remove('hidden');
      el.btnReset.classList.remove('hidden');
      el.helpOwner.classList.remove('hidden');
      setStatus('OWNER CREDENTIALS ACCEPTED - EDITOR ONLINE', 'ok');
    } else {
      el.identityBadge.textContent = state.username
        ? 'MODE: VISITOR (READ-ONLY)'
        : 'MODE: ANONYMOUS (READ-ONLY)';
      // Hard removal, not just hiding: the editor cannot be reached from the
      // DOM at all in visitor mode.
      if (el.editorPanel && el.editorPanel.parentNode) {
        el.editorPanel.parentNode.removeChild(el.editorPanel);
      }
      el.btnDownload.remove();
      el.btnReset.remove();
      el.helpOwner.remove();
      setStatus(
        state.username
          ? 'READ-ONLY: this parcel belongs to "' + world.creator + '"'
          : 'READ-ONLY: log in as "' + world.creator + '" to edit',
        null
      );
    }

    bindEditorControls();
  }

  /* ================================================================== *
   * Editor wiring (owner only - the DOM is gone otherwise).
   * ================================================================== */

  function bindEditorControls() {
    if (!state.isOwner || !el.editorPanel) return;

    el.editorPanel.querySelectorAll('[data-spawn]').forEach(function (button) {
      button.addEventListener('click', function () {
        spawnPrimitive(button.getAttribute('data-spawn'));
      });
    });

    el.editorPanel.querySelectorAll('[data-slider]').forEach(function (input) {
      var name = input.getAttribute('data-slider');
      input.addEventListener('input', function () {
        applySlider(name, input.value);
      });
    });

    el.btnDelete.addEventListener('click', deleteSelected);
    el.btnDuplicate.addEventListener('click', duplicateSelected);
    el.btnDeselect.addEventListener('click', deselect);
    el.btnDownload.addEventListener('click', exportWorld);
    el.btnReset.addEventListener('click', resetSandbox);
  }

  /* ================================================================== *
   * Boot.
   * ================================================================== */

  function loadBaseWorld(world) {
    el.baseWorld.setAttribute('gltf-model', 'url(' + world.file_path + ')');

    el.baseWorld.addEventListener('model-loaded', function () {
      setBoot('BASE HOMESTEAD PARSED', 'glb -> three.js scene graph');
      hideBoot();
      setStatus(
        (state.isOwner ? 'OWNER MODE ACTIVE' : 'VISITOR MODE ACTIVE') + ' - W A S D to walk',
        'ok'
      );
    });

    el.baseWorld.addEventListener('model-error', function () {
      setBoot('ASSET FAILED TO LOAD', world.file_path);
      setStatus('BASE ASSET FAILED TO LOAD: ' + world.file_path, 'err');
      hideBoot();
    });
  }

  function fail(message) {
    setBoot('HANDSHAKE FAILED', 'geo://error');
    if (el.title) el.title.textContent = 'WORLD UNAVAILABLE';
    setStatus(message, 'err');
    hideBoot();
  }

  function fetchWorld(id) {
    return fetch('/api/worlds/' + id, { headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
        return body.world;
      });
    });
  }

  function main() {
    el.btnExit.addEventListener('click', function () {
      window.location.href = '/';
    });

    var id = worldIdFromUrl();
    if (id === null) {
      fail('MISSING OR INVALID ?id= PARAMETER');
      return;
    }

    setBoot('NEGOTIATING WITH MAINFRAME ...', 'GET /api/worlds/' + id);

    fetchWorld(id)
      .then(function (world) {
        state.world = world;
        el.title.textContent = world.name;
        el.metaId.textContent = '#' + world.id;
        el.metaCreator.textContent = world.creator;
        el.metaCreated.textContent = formatDate(world.created_at);
        el.metaAsset.textContent = world.file_path;
        document.title = 'GeoWorld :: ' + world.name;

        evaluateIdentity(world);
        setBoot('DECOMPRESSING .GLB ASSET ...', world.file_path);
        loadBaseWorld(world);
        bindPointer();
        if (state.isOwner) ensureHelper();
      })
      .catch(function (err) {
        fail('CATALOG LOOKUP FAILED: ' + err.message);
      });

    // Keep the selection outline glued to its node every frame.
    el.scene.addEventListener('loaded', function () {
      el.scene.addEventListener('tick', function () {
        if (state.selectedEl && state.helper && state.helper.visible) {
          state.helper.setFromObject(threeObjectOf(state.selectedEl));
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
