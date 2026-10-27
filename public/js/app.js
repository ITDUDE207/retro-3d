/* ==================================================================
   GeoWorld 3D Network - Central Hub dashboard logic.
   Vanilla JS, no build step.
   ================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'geoworld_username';
  var POLL_INTERVAL_MS = 8000;

  var els = {
    loginForm: document.getElementById('login-form'),
    username: document.getElementById('username-input'),
    loginBtn: document.getElementById('login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    loginStatus: document.getElementById('login-status'),
    createForm: document.getElementById('create-form'),
    worldName: document.getElementById('world-name-input'),
    createBtn: document.getElementById('create-btn'),
    createStatus: document.getElementById('create-status'),
    catalogBody: document.getElementById('catalog-body'),
    catalogStatus: document.getElementById('catalog-status'),
    worldCount: document.getElementById('world-count'),
    refreshBtn: document.getElementById('refresh-btn'),
  };

  var currentUser = null;
  var pollHandle = null;
  var lastWorlds = [];

  /* ---------------------------- helpers --------------------------- */

  function readUser() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function writeUser(name) {
    try {
      if (name) window.localStorage.setItem(STORAGE_KEY, name);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* private mode - identity simply will not persist */
    }
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.classList.remove('ok', 'err');
    if (kind) el.classList.add(kind);
  }

  /** Escapes text before it ever touches innerHTML. */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(raw) {
    if (!raw) return '--';
    // SQLite CURRENT_TIMESTAMP is UTC without a timezone marker.
    var iso = String(raw).indexOf('T') === -1 ? String(raw).replace(' ', 'T') + 'Z' : raw;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(raw);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  /* ---------------------------- identity -------------------------- */

  function applyIdentity(name) {
    currentUser = name || null;
    if (currentUser) {
      els.username.value = currentUser;
      setStatus(els.loginStatus, 'STATUS: JACKED IN AS "' + currentUser + '"', 'ok');
      els.createBtn.disabled = false;
      setStatus(els.createStatus, 'STATUS: READY TO ASSEMBLE', 'ok');
    } else {
      els.username.value = '';
      setStatus(els.loginStatus, 'STATUS: OFFLINE', null);
      els.createBtn.disabled = true;
      setStatus(els.createStatus, 'STATUS: AWAITING IDENTITY', null);
    }
    renderCatalog(lastWorlds);
  }

  els.loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = els.username.value.replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!name) {
      setStatus(els.loginStatus, 'STATUS: HANDLE REQUIRED', 'err');
      return;
    }
    writeUser(name);
    applyIdentity(name);
  });

  els.logoutBtn.addEventListener('click', function () {
    writeUser(null);
    applyIdentity(null);
    setStatus(els.loginStatus, 'STATUS: JACKED OUT - LOCAL HANDLE CLEARED', null);
  });

  /* -------------------------- world catalog ----------------------- */

  function renderCatalog(worlds) {
    var list = Array.isArray(worlds) ? worlds : [];
    els.worldCount.textContent = list.length + (list.length === 1 ? ' WORLD' : ' WORLDS');

    if (!list.length) {
      els.catalogBody.innerHTML =
        '<tr><td colspan="5" class="empty-row">No homestead parcels claimed yet. Be the first!</td></tr>';
      return;
    }

    els.catalogBody.innerHTML = list
      .map(function (w) {
        var mine = currentUser && w.creator === currentUser;
        return (
          '<tr>' +
            '<td>#' + esc(w.id) + '</td>' +
            '<td>' + esc(w.name) +
              (mine ? ' <span class="badge you">YOURS</span>' : '') +
              '<div style="color:var(--neon-dim);font-size:11px;">' + esc(w.file_path) + '</div>' +
            '</td>' +
            '<td>' + esc(w.creator) + '</td>' +
            '<td>' + esc(formatDate(w.created_at)) + '</td>' +
            '<td><a href="/explore?id=' + encodeURIComponent(w.id) + '">Enter World &gt;</a></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function loadWorlds(opts) {
    var quiet = opts && opts.quiet;
    if (!quiet) setStatus(els.catalogStatus, 'Polling /api/worlds ...', null);

    return fetch('/api/worlds', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        lastWorlds = data.worlds || [];
        renderCatalog(lastWorlds);
        setStatus(
          els.catalogStatus,
          'SYNC OK - ' + lastWorlds.length + ' active parcel(s) @ ' +
            new Date().toLocaleTimeString(),
          'ok'
        );
      })
      .catch(function (err) {
        setStatus(els.catalogStatus, 'SYNC FAILED: ' + err.message, 'err');
      });
  }

  els.refreshBtn.addEventListener('click', function () {
    loadWorlds();
  });

  /* -------------------------- create world ------------------------ */

  els.createForm.addEventListener('submit', function (event) {
    event.preventDefault();

    if (!currentUser) {
      setStatus(els.createStatus, 'STATUS: JACK IN FIRST', 'err');
      return;
    }

    var worldName = els.worldName.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!worldName) {
      setStatus(els.createStatus, 'STATUS: WORLD NAME REQUIRED', 'err');
      return;
    }

    els.createBtn.disabled = true;
    setStatus(els.createStatus, 'STATUS: ASSEMBLING BINARY .GLB ...', null);

    fetch('/api/create-world', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ worldName: worldName, homesteaderName: currentUser }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
          return body;
        });
      })
      .then(function (body) {
        els.worldName.value = '';
        setStatus(
          els.createStatus,
          'STATUS: PARCEL #' + body.world.id + ' CLAIMED (' + body.bytes + ' BYTES)',
          'ok'
        );
        return loadWorlds({ quiet: true });
      })
      .catch(function (err) {
        setStatus(els.createStatus, 'STATUS: FAILED - ' + err.message, 'err');
      })
      .finally(function () {
        els.createBtn.disabled = !currentUser;
      });
  });

  /* ------------------------------ boot ---------------------------- */

  applyIdentity(readUser());
  loadWorlds();
  pollHandle = window.setInterval(function () {
    loadWorlds({ quiet: true });
  }, POLL_INTERVAL_MS);

  window.addEventListener('beforeunload', function () {
    if (pollHandle) window.clearInterval(pollHandle);
  });
})();
