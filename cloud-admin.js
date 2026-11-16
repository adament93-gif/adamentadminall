/* Adam QBank (Admin) - cloud publishing, specialty registry sync, student accounts and reports.
 *
 * Signs you in to Firebase with an account listed in the `admins` collection and:
 *
 *   specialties/<id>                  the specialty list students register from (display name, status ...)
 *   packs/<specialtyId>               small document: version, size, checksum, chunk count, specialtyId
 *   packs/<specialtyId>/chunks/...    the compressed package of THAT specialty, in ~600 KB pieces
 *   packs/main                        (ENT only, optional) legacy copy for students still on app 1.3.x
 *   settings/access                   subscriptionScope: 'selected' (own specialty) or 'all' (every specialty);
 *                                     trialDays: no longer used (no free trial since 13 Nov 2026; saved as 0)
 *   users/<uid>                       student accounts (specialty, subscription)
 *   reports/<id>                      question reports, each tagged with the student's specialty
 *
 * Publishing always works on the OPEN specialty workspace only, asks you to confirm its name and ID,
 * and refuses to overwrite a pack that belongs to a different specialty. The Firestore rules
 * (firestore.rules) enforce the same ownership on the server.
 */
(function () {
  'use strict';

  var Core = window.EntSpecialtyCore;
  var CFG = window.ENT_FIREBASE || {};
  var CONFIGURED = !!(CFG.apiKey && CFG.projectId);
  var SESSION_KEY = 'ent_admin_cloud_session_v1';
  var INFO_KEY = 'ent_admin_cloud_info_v2'; // + ':' + specialtyId
  var CHUNK_BYTES = 600 * 1024;
  var REFRESH_MARGIN_MS = 60 * 1000;
  var LEGACY_PACK_ID = 'main';
  var FS = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(CFG.projectId || '') + '/databases/(default)/documents';
  var busy = false;

  /* ------------------------------------------------------------------ storage */

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  function infoKey(id) { return INFO_KEY + ':' + id; }

  /* ------------------------------------------------------------------ http */

  function cloudError(code, extra) {
    var e = new Error(code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  async function request(url, options) {
    var res;
    try { res = await fetch(url, options); } catch (e) { throw cloudError('NETWORK'); }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var raw = (data && data.error && (data.error.message || data.error.status)) || ('HTTP_' + res.status);
      throw cloudError(String(raw).split(/[\s:]/)[0], { status: res.status });
    }
    return data;
  }

  function authHeaders(token, json) {
    var h = { Authorization: 'Bearer ' + token };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function friendly(e) {
    switch (e && e.code) {
      case 'NETWORK': return 'No internet connection.';
      case 'NOT_ADMIN': return 'This account is not an admin. Add its UID to the admins collection in Firebase first.';
      case 'INVALID_LOGIN_CREDENTIALS':
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_PASSWORD': return 'Wrong email or password.';
      case 'TOO_MANY_ATTEMPTS_TRY_LATER': return 'Too many attempts. Try again in a few minutes.';
      case 'PERMISSION_DENIED': return 'Firestore refused the request. Check that the rules are published and this account is an admin.';
      case 'NOT_SIGNED_IN': return 'Sign in under Settings → Cloud first.';
      default: return (e && e.message) || 'Something went wrong.';
    }
  }

  /* ------------------------------------------------------------------ session */

  async function signIn(email, password) {
    var data = await request('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(CFG.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), password: password, returnSecureToken: true })
    });
    // Only accounts listed in /admins/{uid} may publish.
    try {
      await request(FS + '/admins/' + encodeURIComponent(data.localId), { headers: authHeaders(data.idToken) });
    } catch (e) {
      if (e.status === 404 || e.status === 403) throw cloudError('NOT_ADMIN');
      throw e;
    }
    var s = { uid: data.localId, email: String(email).trim(), idToken: data.idToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000 };
    save(SESSION_KEY, s);
    return s;
  }

  async function token() {
    var s = load(SESSION_KEY);
    if (!s) throw cloudError('NOT_SIGNED_IN');
    if (s.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.idToken;
    var d = await request('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(CFG.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(s.refreshToken)
    });
    s = Object.assign({}, s, { idToken: d.id_token, refreshToken: d.refresh_token || s.refreshToken,
      expiresAt: Date.now() + Number(d.expires_in || 3600) * 1000 });
    save(SESSION_KEY, s);
    return s.idToken;
  }

  function signOut() { drop(SESSION_KEY); }
  function isSignedIn() { return !!load(SESSION_KEY); }

  /* ------------------------------------------------------------------ small helpers */

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function pad(i) { return String(i).padStart(4, '0'); }
  function sv(v) { return { stringValue: String(v) }; }
  function iv(v) { return { integerValue: String(v) }; }
  function tv(iso) { return { timestampValue: iso }; }
  function tsMs(f) { return f && f.timestampValue ? Date.parse(f.timestampValue) : null; }
  function strOf(f) { return f && f.stringValue != null ? f.stringValue : ''; }
  function intOf(f) { return f && f.integerValue != null ? Number(f.integerValue) : 0; }
  function idOf(doc) { return String(doc && doc.name || '').split('/').pop(); }
  function el(id) { return document.getElementById(id); }
  function esc(v) { return typeof escapeHTML === 'function' ? escapeHTML(String(v == null ? '' : v)) : String(v == null ? '' : v); }

  function currentSpec() {
    var U = window.__entUpdatePkg;
    return U && typeof U.currentSpecialty === 'function' ? U.currentSpecialty() : null;
  }

  /* ------------------------------------------------------------------ specialties (registry sync) */

  function specialtyFields(s) {
    return {
      id: sv(s.id), name: sv(s.name), description: sv(s.description || ''), status: sv(s.status),
      sortOrder: iv(s.sortOrder || 0), schemaVersion: iv(Core.SCHEMA_VERSION),
      createdAt: tv(s.createdAt || new Date().toISOString()), updatedAt: tv(s.updatedAt || new Date().toISOString())
    };
  }

  function parseSpecialtyDoc(doc) {
    var f = (doc && doc.fields) || {};
    return {
      id: strOf(f.id) || idOf(doc), name: strOf(f.name), description: strOf(f.description), status: strOf(f.status) || 'inactive',
      sortOrder: intOf(f.sortOrder), createdAt: f.createdAt && f.createdAt.timestampValue || '', updatedAt: f.updatedAt && f.updatedAt.timestampValue || ''
    };
  }

  // Writes the listed specialties (default: every one with unsynced changes) to specialties/<id>.
  async function syncSpecialties(ids) {
    var Reg = window.EntRegistry;
    var want = ids && ids.length ? ids : Reg.dirtyIds();
    var tk = await token();
    var written = 0;
    for (var i = 0; i < want.length; i++) {
      var s = Reg.get(want[i]);
      if (!s) continue;
      await request(FS + '/specialties/' + encodeURIComponent(s.id), { method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: specialtyFields(s) }) });
      Reg.markSynced(s.id);
      written++;
    }
    return { written: written };
  }

  async function pullSpecialties() {
    var tk = await token();
    var out = [];
    var pageToken = '';
    do {
      var d = await request(FS + '/specialties?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseSpecialtyDoc(doc)); });
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return window.EntRegistry.mergeFromCloud(out);
  }

  /* ------------------------------------------------------------------ subscription scope */

  var DEFAULT_TRIAL_DAYS = 0; // no free trial since 13 Nov 2026 (the rules ignore trialDays)
  var DEFAULT_MAX_DEVICES = 2, DEFAULT_SWAP_DAYS = 7;
  var accessSettings = { scope: 'selected', trialDays: DEFAULT_TRIAL_DAYS, maxDevices: DEFAULT_MAX_DEVICES, deviceSwapDays: DEFAULT_SWAP_DAYS };

  // settings/access: who an active subscription covers and how long a new account's free trial lasts.
  async function readAccess() {
    var tk = await token();
    var out = { scope: 'selected', trialDays: DEFAULT_TRIAL_DAYS, maxDevices: DEFAULT_MAX_DEVICES, deviceSwapDays: DEFAULT_SWAP_DAYS };
    try {
      var d = await request(FS + '/settings/access', { headers: authHeaders(tk) });
      var f = d.fields || {};
      out.scope = strOf(f.subscriptionScope) === 'all' ? 'all' : 'selected';
      if (f.trialDays && f.trialDays.integerValue != null) out.trialDays = Math.max(0, Number(f.trialDays.integerValue));
      if (f.maxDevices && f.maxDevices.integerValue != null) out.maxDevices = Number(f.maxDevices.integerValue);
      if (f.deviceSwapDays && f.deviceSwapDays.integerValue != null) out.deviceSwapDays = Number(f.deviceSwapDays.integerValue);
    } catch (e) { if (e.status !== 404) throw e; }
    accessSettings = out;
    return out;
  }

  async function readScope() { return (await readAccess()).scope; }

  // Writes the scope and, when given, the trial length. Only the named fields are touched (updateMask), so saving
  // the scope never erases the trial length and the other way round.
  async function writeScope(scope, trialDays) {
    if (scope !== 'all' && scope !== 'selected') throw new Error('Unknown scope.');
    var fields = { subscriptionScope: sv(scope), updatedAt: tv(new Date().toISOString()) };
    var mask = ['subscriptionScope', 'updatedAt'];
    if (trialDays !== undefined && trialDays !== null) {
      var n = Number(trialDays);
      if (!isFinite(n) || n < 0 || n > 365 || Math.floor(n) !== n) throw new Error('The trial length must be a whole number of days from 0 to 365.');
      fields.trialDays = iv(n);
      mask.push('trialDays');
    }
    var tk = await token();
    await request(FS + '/settings/access?' + mask.map(function (m) { return 'updateMask.fieldPaths=' + m; }).join('&'), {
      method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: fields })
    });
    accessSettings = Object.assign({}, accessSettings, { scope: scope, trialDays: fields.trialDays ? Number(trialDays) : accessSettings.trialDays });
    return scope;
  }

  // How many devices an account works on, and how often a student may replace one. Enforced by the Firestore rules.
  async function writeDeviceLimits(maxDevices, swapDays) {
    var max = Number(maxDevices), days = Number(swapDays);
    if (!isFinite(max) || Math.floor(max) !== max || max < 1 || max > 10) throw new Error('Devices per account must be a whole number from 1 to 10.');
    if (!isFinite(days) || Math.floor(days) !== days || days < 0 || days > 90) throw new Error('Days between replacements must be a whole number from 0 to 90.');
    var current = await readAccess();
    var mask = ['subscriptionScope', 'maxDevices', 'deviceSwapDays', 'updatedAt'];
    var tk = await token();
    await request(FS + '/settings/access?' + mask.map(function (m) { return 'updateMask.fieldPaths=' + m; }).join('&'), {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { subscriptionScope: sv(current.scope), maxDevices: iv(max), deviceSwapDays: iv(days), updatedAt: tv(new Date().toISOString()) } })
    });
    accessSettings = Object.assign({}, accessSettings, { maxDevices: max, deviceSwapDays: days });
    return accessSettings;
  }

  // The devices of one account (devices/{uid}): [{ id, label, addedAt }], oldest first.
  async function readDevices(uid) {
    var tk = await token();
    try {
      var d = await request(FS + '/devices/' + encodeURIComponent(uid), { headers: authHeaders(tk) });
      var f = d.fields || {};
      var info = (f.info && f.info.mapValue && f.info.mapValue.fields) || {};
      var ids = ((f.ids && f.ids.arrayValue && f.ids.arrayValue.values) || []).map(strOf).filter(Boolean);
      return { lastSwapAt: tsMs(f.lastSwapAt) || 0, list: ids.map(function (id) {
        var m = (info[id] && info[id].mapValue && info[id].mapValue.fields) || {};
        return { id: id, label: strOf(m.label) || 'Device', addedAt: tsMs(m.addedAt) || 0 };
      }).sort(function (a, b) { return a.addedAt - b.addedAt; }) };
    } catch (e) { if (e.status === 404) return { lastSwapAt: 0, list: [] }; throw e; }
  }

  async function resetDevices(uid) {
    var tk = await token();
    try { await request(FS + '/devices/' + encodeURIComponent(uid), { method: 'DELETE', headers: authHeaders(tk) }); }
    catch (e) { if (e.status !== 404) throw e; }
  }

  /* ------------------------------------------------------------------ publishing */

  function parseMeta(doc) {
    var f = (doc && doc.fields) || {};
    return { version: strOf(f.version), prefix: strOf(f.prefix), chunkCount: intOf(f.chunkCount), gzBytes: intOf(f.gzBytes),
      rawBytes: intOf(f.rawBytes), questions: intOf(f.questions), specialtyId: strOf(f.specialtyId), specialtyName: strOf(f.specialtyName),
      updatedAt: f.updatedAt && f.updatedAt.timestampValue || '', sha256: strOf(f.sha256),
      deltaPrefix: strOf(f.deltaPrefix), deltaChunks: intOf(f.deltaChunks) };
  }

  async function readMeta(tk, packId, collection) {
    try { return parseMeta(await request(FS + '/' + (collection || 'packs') + '/' + encodeURIComponent(packId), { headers: authHeaders(tk) })); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  // The pack document that a pack path currently holds must belong to the specialty being published.
  // (A pack written by app 1.3.x has no specialtyId: it is the ENT pack.)
  function packOwner(meta) { return meta ? (meta.specialtyId || Core.LEGACY_SPECIALTY_ID) : null; }

  // opts.collection: 'packs' (the full bank, subscribers) or 'freepacks' (the free version, every student of the specialty).
  // opts.extra: more fields for the pack document (freeUids for the free pack).
  async function uploadPack(tk, packId, spec, built, gz, sha, raw, progress, opts) {
    opts = opts || {};
    var coll = opts.collection || 'packs';
    var base = FS + '/' + coll + '/' + encodeURIComponent(packId);
    var version = built.manifest.packageVersion;
    var prefix = 'v' + String(version).replace(/[^A-Za-z0-9]/g, '');
    var count = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));

    var previous = await readMeta(tk, packId, coll);
    if (previous && packOwner(previous) !== spec.id) {
      throw cloudError('CROSS_SPECIALTY', { message: 'The pack at "' + packId + '" belongs to the "' + packOwner(previous) + '" specialty, not "' + spec.id + '". Nothing was uploaded.' });
    }

    for (var i = 0; i < count; i++) {
      progress('Uploading ' + (opts.label || (packId === LEGACY_PACK_ID ? 'legacy ENT copy ' : '')) + (i + 1) + ' / ' + count + '...');
      var part = gz.subarray(i * CHUNK_BYTES, Math.min(gz.length, (i + 1) * CHUNK_BYTES));
      await request(base + '/chunks/' + prefix + '_' + pad(i), {
        method: 'PATCH', headers: authHeaders(tk, true),
        body: JSON.stringify({ fields: { prefix: sv(prefix), i: iv(i), data: { bytesValue: bytesToB64(part) } } })
      });
    }

    var updatedAt = new Date().toISOString();
    var questions = built.manifest.contentSummary.questions;
    var fields = { version: sv(version), prefix: sv(prefix), chunkCount: iv(count), gzBytes: iv(gz.length),
      rawBytes: iv(raw.length), sha256: sv(sha), questions: iv(questions), updatedAt: tv(updatedAt),
      specialtyId: sv(spec.id), specialtyName: sv(spec.name), schemaVersion: iv(Core.SCHEMA_VERSION) };
    Object.keys(opts.extra || {}).forEach(function (k) { fields[k] = opts.extra[k]; });
    await request(base, { method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: fields }) });

    // The new version is live; remove the previous version's chunks (best effort).
    if (previous && previous.prefix && previous.prefix !== prefix) {
      for (var j = 0; j < previous.chunkCount; j++) {
        try { await request(base + '/chunks/' + previous.prefix + '_' + pad(j), { method: 'DELETE', headers: authHeaders(tk) }); }
        catch (e) { /* leftover chunk is harmless */ }
      }
    }
    // ... and the previous "changes only" package.
    var newDelta = opts.extra && opts.extra.deltaPrefix ? opts.extra.deltaPrefix.stringValue : '';
    if (previous && previous.deltaPrefix && previous.deltaPrefix !== newDelta) {
      for (var k = 0; k < previous.deltaChunks; k++) {
        try { await request(base + '/chunks/' + previous.deltaPrefix + '_' + pad(k), { method: 'DELETE', headers: authHeaders(tk) }); }
        catch (e) { /* leftover chunk is harmless */ }
      }
    }
    return { version: version, questions: questions, gzBytes: gz.length, rawBytes: raw.length, chunkCount: count, updatedAt: updatedAt, packId: packId };
  }

  /* ------------------------------------------------------------------ "changes only" package (partial update)
   * A student who already has the previous published version downloads only what changed since it: the new and
   * corrected items and the list of removed ones. It is built by comparing the new package with the one that is
   * published right now (downloaded here, so it is always the real previous version, on any admin device).
   * The student's app checks the result against uidDigest and takes the full bank whenever anything does not fit;
   * every other student (new device, older version) takes the full bank as before. Best effort: any problem here
   * simply means no partial package this time.                                                                    */
  var DELTA_LISTS = ['questions', 'lectures', 'flashcards', 'bookMeta'];
  var DELTA_FOLDER = { questions: 'images', lectures: 'summaries', flashcards: 'flashcards', bookMeta: 'books' };
  var DELTA_MAX_SHARE = 0.6;        // a partial package larger than this share of the full one is not worth it

  async function downloadPackBytes(tk, packId, meta) {
    var root = FS.replace('https://firestore.googleapis.com/v1/', '');
    var parts = new Array(meta.chunkCount);
    for (var start = 0; start < meta.chunkCount; start += 6) {
      var names = [];
      for (var i = start; i < Math.min(meta.chunkCount, start + 6); i++) names.push(root + '/packs/' + packId + '/chunks/' + meta.prefix + '_' + pad(i));
      var got = await request(FS + ':batchGet', { method: 'POST', headers: authHeaders(tk, true), body: JSON.stringify({ documents: names }) });
      got.forEach(function (entry) {
        if (!entry.found) throw new Error('a part of the published bank is missing');
        var bin = atob(entry.found.fields.data.bytesValue || ''), out = new Uint8Array(bin.length);
        for (var b = 0; b < bin.length; b++) out[b] = bin.charCodeAt(b);
        parts[intOf(entry.found.fields.i)] = out;
      });
    }
    var total = 0; parts.forEach(function (x) { if (!x) throw new Error('a part of the published bank is missing'); total += x.length; });
    var gz = new Uint8Array(total), off = 0; parts.forEach(function (x) { gz.set(x, off); off += x.length; });
    if (meta.sha256 && hex(await crypto.subtle.digest('SHA-256', gz)) !== meta.sha256) throw new Error('the published bank did not arrive whole');
    return new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }

  function deltaFilePath(image, list) {
    var path = typeof image === 'string' ? image : image && image.path;
    if (typeof path !== 'string' || !path) return '';
    return path.indexOf('/') !== -1 ? path : DELTA_FOLDER[list] + '/' + path;
  }

  // Everything that makes an item what the student sees: its fields (not the package stamp) and the bytes of its images.
  async function deltaSignatures(zip, database) {
    var fileHash = new Map(), out = {};
    for (var li = 0; li < DELTA_LISTS.length; li++) {
      var list = DELTA_LISTS[li], map = new Map(), items = database[list] || [];
      for (var n = 0; n < items.length; n++) {
        var item = items[n];
        if (!item || typeof item.uid !== 'string' || !item.uid || map.has(item.uid)) throw new Error('an item without its own uid');
        var copy = Object.assign({}, item); delete copy.pkgVersion;
        var sig = JSON.stringify(copy), files = [];
        var images = Array.isArray(item.images) ? item.images : [];
        for (var m = 0; m < images.length; m++) {
          var path = deltaFilePath(images[m], list);
          if (!path) continue;
          if (!fileHash.has(path)) {
            var entry = zip.file(path);
            fileHash.set(path, entry ? hex(await crypto.subtle.digest('SHA-256', await entry.async('uint8array'))) : 'absent');
          }
          sig += '|' + path + ':' + fileHash.get(path);
          if (fileHash.get(path) !== 'absent') files.push(path);
        }
        map.set(item.uid, { sig: sig, files: files });
      }
      out[list] = map;
    }
    return out;
  }

  async function buildDelta(tk, spec, previous, raw, progress) {
    if (!previous || !previous.version || !previous.prefix || !previous.chunkCount || packOwner(previous) !== spec.id) return null;
    if (typeof JSZip === 'undefined' || !window.__entUpdatePkg || !window.__entUpdatePkg.sha256Hex) return null;
    progress('Comparing with the published version...');
    var oldZip = await JSZip.loadAsync(await downloadPackBytes(tk, spec.id, previous));
    var newZip = await JSZip.loadAsync(raw);
    var oldDb = JSON.parse(await oldZip.file('database.json').async('string'));
    var newDb = JSON.parse(await newZip.file('database.json').async('string'));
    var manifest = JSON.parse(await newZip.file('manifest.json').async('string'));
    if (manifest.packageVersion === previous.version) return null;
    var before = await deltaSignatures(oldZip, oldDb), after = await deltaSignatures(newZip, newDb);

    var database = Object.assign({}, newDb), removed = {}, files = new Set(), changed = 0, removedCount = 0;
    DELTA_LISTS.forEach(function (list) {
      database[list] = (newDb[list] || []).filter(function (item) {
        var now = after[list].get(item.uid), was = before[list].get(item.uid);
        if (was && was.sig === now.sig) return false;
        now.files.forEach(function (f) { files.add(f); });
        changed++;
        return true;
      });
      removed[list] = [];
      before[list].forEach(function (v, uid) { if (!after[list].has(uid)) removed[list].push(uid); });
      removedCount += removed[list].length;
    });
    var sameTaxonomy = JSON.stringify([oldDb.taxonomy || null, oldDb.taxonomyV2 || null]) === JSON.stringify([newDb.taxonomy || null, newDb.taxonomyV2 || null]);
    if (!sameTaxonomy) return null;                        // the classification changed: the full bank carries it
    delete database.taxonomy; delete database.taxonomyV2;  // unchanged: the device already has it

    var uids = (newDb.questions || []).map(function (q) { return q.uid; }).sort();
    var uidDigest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uids.join('\n'))));
    var text = JSON.stringify(database);
    manifest.checksum = await window.__entUpdatePkg.sha256Hex(text);
    manifest.partial = { from: previous.version, removed: removed, changed: changed, questions: uids.length, uidDigest: uidDigest };
    manifest.contentSummary = Object.assign({}, manifest.contentSummary, { questions: database.questions.length, lectures: database.lectures.length,
      flashcards: database.flashcards.length, bookMeta: database.bookMeta.length, images: files.size });
    if (manifest.assetChecksums) {
      var sums = {};
      Object.keys(manifest.assetChecksums).forEach(function (path) { if (files.has(path)) sums[path] = manifest.assetChecksums[path]; });
      manifest.assetChecksums = sums;
    }
    var zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('database.json', text);
    var list = Array.from(files);
    for (var i = 0; i < list.length; i++) zip.file(list[i], await newZip.file(list[i]).async('uint8array'));
    var gz = await gzipBytes(await zip.generateAsync({ type: 'uint8array' }));
    return { gz: gz, sha: hex(await crypto.subtle.digest('SHA-256', gz)), from: previous.version, changed: changed, removed: removedCount, uidDigest: uidDigest };
  }

  // Uploads the partial package next to the full one; returns the fields that advertise it in the pack document.
  async function uploadDelta(tk, spec, version, delta, progress) {
    var prefix = 'd' + String(version).replace(/[^A-Za-z0-9]/g, '');
    var count = Math.max(1, Math.ceil(delta.gz.length / CHUNK_BYTES));
    for (var i = 0; i < count; i++) {
      progress('Uploading the changes-only package ' + (i + 1) + ' / ' + count + '...');
      var part = delta.gz.subarray(i * CHUNK_BYTES, Math.min(delta.gz.length, (i + 1) * CHUNK_BYTES));
      await request(FS + '/packs/' + encodeURIComponent(spec.id) + '/chunks/' + prefix + '_' + pad(i), { method: 'PATCH', headers: authHeaders(tk, true),
        body: JSON.stringify({ fields: { prefix: sv(prefix), i: iv(i), data: { bytesValue: bytesToB64(part) } } }) });
    }
    return { deltaFrom: sv(delta.from), deltaPrefix: sv(prefix), deltaChunks: iv(count), deltaSha: sv(delta.sha), deltaGzBytes: iv(delta.gz.length), uidDigest: sv(delta.uidDigest) };
  }

  async function gzipBytes(raw) {
    return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  }

  /**
   * The free version of the open specialty (the questions marked Free, at most 250) at freepacks/<specialtyId>. Any signed-in
   * student of that specialty may read it (no subscription needed), so it reaches the free version, students without a
   * subscription and students whose subscription ended, and it changes for all of them each time you publish.
   * freeUids lists the free questions, so a question you unmark stops being free on the students' devices too.
   */
  // Counts only (no questions): how many different questions the full bank has, per category and per book. It travels
  // with the free version, so a student without a subscription sees what a subscription opens.
  function bankSummary(all) {
    var seen = new Set(), inBook = new Set(), cats = {}, books = {}, total = 0;
    var keyOf = (typeof QuestionImport !== 'undefined' && QuestionImport.dupKey) ? QuestionImport.dupKey : function () { return ''; };
    all.forEach(function (q) {
      var key = keyOf(q) || ('id:' + q.id);
      var book = String(q.book || q.group || '').trim();
      if (book && !inBook.has(book + '\u0000' + key)) { inBook.add(book + '\u0000' + key); books[book] = (books[book] || 0) + 1; }
      if (seen.has(key)) return;
      seen.add(key); total++;
      var cat = q.subject || 'Uncategorized';
      cats[cat] = (cats[cat] || 0) + 1;
    });
    var list = function (o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a] || a.localeCompare(b); }).slice(0, 200).map(function (k) { return [k.slice(0, 120), o[k]]; }); };
    return { total: total, categories: list(cats), books: list(books) };
  }

  async function publishFree(tk, spec, U, progress) {
    var max = (window.ENT_FREE_SAMPLE && window.ENT_FREE_SAMPLE.max) || 250;
    var everything = await db.getAllQuestions();
    var summary = sv(JSON.stringify(bankSummary(everything)));
    var free = everything.filter(function (q) { return q.isFree === true; });
    if (free.length > max) {
      throw cloudError('FREE_LIMIT', { message: free.length + ' questions are marked Free but the free version is limited to ' + max + '. Unmark ' + (free.length - max) + ' in Questions, then publish again. Nothing was uploaded.' });
    }
    var base = FS + '/freepacks/' + encodeURIComponent(spec.id);
    if (!free.length) {
      // Nothing is free: publish an empty free version, so students' devices un-mark their old free questions.
      var prev = await readMeta(tk, spec.id, 'freepacks');
      await request(base, { method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: {
        version: sv('empty-' + Date.now()), prefix: sv(''), chunkCount: iv(0), gzBytes: iv(0), rawBytes: iv(0), sha256: sv(''), questions: iv(0),
        updatedAt: tv(new Date().toISOString()), specialtyId: sv(spec.id), specialtyName: sv(spec.name), schemaVersion: iv(Core.SCHEMA_VERSION), summary: summary,
        freeUids: { arrayValue: {} } } }) });
      if (prev && prev.prefix) {
        for (var j = 0; j < prev.chunkCount; j++) {
          try { await request(base + '/chunks/' + prev.prefix + '_' + pad(j), { method: 'DELETE', headers: authHeaders(tk) }); } catch (e) { /* harmless */ }
        }
      }
      return { questions: 0 };
    }
    progress('Building the free version (' + free.length + ' questions)...');
    var built = await U.buildEntpkg({ mode: 'free' });
    if (!built.manifest.specialty || built.manifest.specialty.id !== spec.id) {
      throw cloudError('MISMATCH', { message: 'The free version was built for a different specialty. Nothing was uploaded.' });
    }
    var raw = new Uint8Array(await built.blob.arrayBuffer());
    var uids = [];
    try {
      var zip = await JSZip.loadAsync(raw);
      var dbFile = zip.file('database.json');
      var data = JSON.parse(await dbFile.async('string'));
      uids = (data.questions || []).map(function (q) { return q && q.uid; }).filter(Boolean);
    } catch (e) {
      throw cloudError('TOOLS', { message: 'The free version could not be read back (' + (e && e.message ? e.message : e) + '). Nothing was uploaded.' });
    }
    var gz = await gzipBytes(raw);
    var sha = hex(await crypto.subtle.digest('SHA-256', gz));
    var info = await uploadPack(tk, spec.id, spec, built, gz, sha, raw, progress, {
      collection: 'freepacks', label: 'free version ',
      extra: { freeUids: { arrayValue: { values: uids.map(function (u) { return sv(u); }) } }, summary: summary }
    });
    return { questions: info.questions, version: info.version };
  }

  /**
   * Publishes the open specialty workspace.
   * options.legacyMirror (ENT only): also write the pre-1.4 location packs/main, built so that students
   * still on app 1.3.x can read it.
   */
  async function publish(progress, options) {
    options = options || {};
    var U = window.__entUpdatePkg;
    if (!U || typeof U.buildEntpkg !== 'function') throw cloudError('TOOLS', { message: 'The update tools are not ready yet.' });
    var spec = currentSpec();
    if (!spec || !spec.id) throw cloudError('NO_SPECIALTY', { message: 'Open a specialty workspace first.' });
    if (spec.archived) throw cloudError('ARCHIVED', { message: '"' + spec.name + '" is archived and read-only, so it cannot be published.' });
    var mirror = options.legacyMirror === true && spec.id === Core.LEGACY_SPECIALTY_ID;

    var tk = await token();
    progress('Registering the specialty...');
    await syncSpecialties([spec.id]); // students and the rules need specialties/<id> to exist

    progress('Building the full package for ' + spec.name + '...');
    var built = await U.buildEntpkg({ mode: 'full', legacyCompatible: mirror });
    if (!built.manifest.specialty || built.manifest.specialty.id !== spec.id) {
      throw cloudError('MISMATCH', { message: 'The package was built for a different specialty than the one you confirmed. Nothing was uploaded.' });
    }
    var raw = new Uint8Array(await built.blob.arrayBuffer());

    progress('Compressing...');
    var gz = await gzipBytes(raw);
    var sha = hex(await crypto.subtle.digest('SHA-256', gz));

    // Students who have the version published now only need what changed (best effort, see buildDelta).
    var extra = null, partial = null;
    try {
      var delta = await buildDelta(tk, spec, await readMeta(tk, spec.id), raw, progress);
      if (delta && delta.gz.length <= gz.length * DELTA_MAX_SHARE) {
        extra = await uploadDelta(tk, spec, built.manifest.packageVersion, delta, progress);
        partial = { gzBytes: delta.gz.length, changed: delta.changed, removed: delta.removed, from: delta.from };
      }
    } catch (e) { console.warn('[cloud-admin] no changes-only package this time:', e); extra = null; partial = null; }

    var main = await uploadPack(tk, spec.id, spec, built, gz, sha, raw, progress, extra ? { extra: extra } : undefined);
    if (mirror) await uploadPack(tk, LEGACY_PACK_ID, spec, built, gz, sha, raw, progress);

    var info = Object.assign({}, main, { specialtyId: spec.id, specialtyName: spec.name, legacyMirror: mirror, partial: partial });
    save(infoKey(spec.id), info);
    return info;
  }

  /**
   * Publishes ONLY the free version of the open specialty (Free version card, separate from the full bank).
   * Each publish gets a new package version, so students' devices notice the change and update their free questions.
   */
  async function publishFreeVersion(progress) {
    var U = window.__entUpdatePkg;
    if (!U || typeof U.buildEntpkg !== 'function') throw cloudError('TOOLS', { message: 'The update tools are not ready yet.' });
    var spec = currentSpec();
    if (!spec || !spec.id) throw cloudError('NO_SPECIALTY', { message: 'Open a specialty workspace first.' });
    if (spec.archived) throw cloudError('ARCHIVED', { message: '"' + spec.name + '" is archived and read-only, so it cannot be published.' });
    var tk = await token();
    progress('Registering the specialty...');
    await syncSpecialties([spec.id]);
    var info = await publishFree(tk, spec, U, progress);
    info.updatedAt = new Date().toISOString();
    save(freeInfoKey(spec.id), info);
    return Object.assign({ specialtyId: spec.id, specialtyName: spec.name }, info);
  }

  function freeInfoKey(id) { return infoKey(id) + '_free'; }

  /* ------------------------------------------------------------------ student accounts */

  var pageSize = 300;
  var accounts = [];
  var accountsLoadedAt = 0;

  function parseUser(doc) {
    var f = doc.fields || {};
    var req = f.specialtyChangeRequest && f.specialtyChangeRequest.mapValue ? f.specialtyChangeRequest.mapValue.fields || {} : null;
    return {
      uid: idOf(doc),
      identifier: strOf(f.identifier) || '(no name)',
      createdAt: tsMs(f.createdAt) || 0,
      plan: strOf(f.plan) || 'none',
      expiresAt: tsMs(f.expiresAt),
      trialEndsAt: tsMs(f.trialEndsAt),
      trialStopped: !!(f.trialStopped && f.trialStopped.booleanValue === true),
      specialtyId: strOf(f.specialtyId),
      specialtyName: strOf(f.specialtyName),
      phone: strOf(f.phone),
      contactConsent: !!(f.contactConsent && f.contactConsent.booleanValue === true),
      lastCode: strOf(f.lastCode),
      lastCodeAt: tsMs(f.lastCodeAt),
      lastSeenAt: tsMs(f.lastSeenAt) || 0,
      request: req ? { specialtyId: strOf(req.specialtyId), specialtyName: strOf(req.specialtyName), requestedAt: tsMs(req.requestedAt) || 0 } : null
    };
  }

  // Reads every student profile (one Firestore read each, so load on demand, not automatically).
  async function loadAccounts(progress) {
    var tk = await token();
    try { await readAccess(); } catch (e) { /* the trial length falls back to the last known value */ }
    var out = [];
    var pageToken = '';
    do {
      var url = FS + '/users?pageSize=' + pageSize + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var d = await request(url, { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseUser(doc)); });
      pageToken = d.nextPageToken || '';
      if (progress) progress('Loaded ' + out.length + ' account(s)...');
    } while (pageToken && out.length < 5000);
    accounts = out.sort(function (a, b) { return b.createdAt - a.createdAt; });
    accountsLoadedAt = Date.now();
    return accounts;
  }

  function fmtDay(ms) {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function accessOf(a) {
    var now = Date.now();
    var paid = a.plan !== 'none' && !!a.expiresAt;
    if (paid && a.expiresAt > now) {
      var days = Math.ceil((a.expiresAt - now) / 86400000);
      return { kind: 'active', text: 'Active until ' + fmtDay(a.expiresAt) + ' (' + days + (days === 1 ? ' day' : ' days') + ' left)' };
    }
    if (paid) return { kind: 'expired', text: 'Expired on ' + fmtDay(a.expiresAt) };
    return { kind: 'free', text: 'Free version (no subscription)' };
  }

  function addMonths(ms, n) {
    var d = new Date(ms);
    d.setMonth(d.getMonth() + n);
    return d.getTime();
  }

  async function saveAccess(a, plan, expiresAt) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=plan&updateMask.fieldPaths=expiresAt', {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { plan: sv(plan), expiresAt: expiresAt ? tv(new Date(expiresAt).toISOString()) : { nullValue: null } } })
    });
    a.plan = plan;
    a.expiresAt = expiresAt || null;
  }

  // +N months counts from the current expiry while the account is still active, otherwise from today.
  function extendAccount(a, months, label) {
    var base = a.expiresAt && a.expiresAt > Date.now() ? a.expiresAt : Date.now();
    return saveAccess(a, label, addMonths(base, months));
  }

  // Sets the student's specialty (and clears any pending change request). Their data on the device is never moved:
  // each specialty keeps its own local copy, so switching back later finds it again.
  async function assignSpecialty(a, spec, by) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=schemaVersion&updateMask.fieldPaths=specialtyId' +
      '&updateMask.fieldPaths=specialtyName&updateMask.fieldPaths=specialtyAssignedAt&updateMask.fieldPaths=specialtyAssignedBy&updateMask.fieldPaths=specialtyChangeRequest', {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { schemaVersion: iv(Core.SCHEMA_VERSION), specialtyId: sv(spec.id), specialtyName: sv(spec.name),
        specialtyAssignedAt: tv(new Date().toISOString()), specialtyAssignedBy: sv(by || 'admin') } })
    });
    a.specialtyId = spec.id; a.specialtyName = spec.name; a.request = null;
  }

  async function declineRequest(a) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=specialtyChangeRequest', {
      method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: {} })
    });
    a.request = null;
  }

  function specLabel(id, name) {
    var known = window.EntRegistry && window.EntRegistry.get(id);
    return (known && known.name) || name || id;
  }

  // +9647701234567 -> 0770 123 4567 (other countries stay in international form).
  function fmtPhone(p) {
    var m = /^\+964(7\d{2})(\d{3})(\d{4})$/.exec(p || '');
    return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : (p || '');
  }

  // WhatsApp chat link for a stored number (wa.me wants the digits only, with the country code).
  function whatsappLink(p) {
    var digits = String(p || '').replace(/[^0-9]/g, '');
    return digits.length >= 8 ? 'https://wa.me/' + digits : '';
  }

  function acctMsg(text, isError) {
    var node = el('entAcctMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function accountsCardHTML() {
    return '<div class="card"><div class="card-header">Student accounts</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">Every account that signs up appears here with the specialty it chose. A new account starts on the free version (only the questions you mark Free, up to 250). It gets the full bank when the student pays online (activated automatically, see Online payments), uses an activation code, or you activate it here (+1/+3/+12 months, Set date). The app unlocks the question bank on their next launch. A student can only use their own specialty\'s questions.</p>' +
      '<button class="btn btn-outline btn-block" id="btnAcctLoad">Load accounts</button>' +
      '<input type="search" id="entAcctFilter" placeholder="Search username, email or mobile number" autocomplete="off" autocapitalize="none" spellcheck="false" style="margin-top:10px;">' +
      '<select id="entAcctSpec" aria-label="Filter by specialty" style="margin-top:8px;"></select>' +
      '<div id="entAcctSummary" style="margin:6px 0;font-size:0.82rem;color:var(--text2);"></div>' +
      '<div id="entAcctBulk"></div>' +
      '<div id="entAcctList"></div>' +
      '<div id="entAcctMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div>' +
      '<hr style="border:none;border-top:1px solid var(--border);margin:14px 0;">' +
      '<div style="font-weight:700;margin-bottom:4px;">Activation codes</div>' +
      '<p style="font-size:0.82rem;color:var(--text2);margin-bottom:8px;">For students who pay you another way (cash, transfer, agreed on WhatsApp): activate the account here (+1 / +3 / +12 months) or tap <b>Activation code</b>, choose the plan and send the code on WhatsApp with one tap. ' +
      'The student enters it in the app (Subscribe → I have an activation code) and the subscription starts at once. A code works once, only for that account, and expires if unused.</p>' +
      '<button class="btn btn-outline btn-block" id="btnCodesLoad">Show recent codes</button>' +
      '<div id="entCodesList" style="margin-top:8px;"></div>' +
      '<hr style="border:none;border-top:1px solid var(--border);margin:14px 0;">' +
      '<div style="font-weight:700;margin-bottom:4px;">Online payments (Wayl)</div>' +
      '<p style="font-size:0.82rem;color:var(--text2);margin-bottom:8px;">Payments made with <b>Pay online</b> in the app. The payment Worker activates the account by itself once Wayl confirms the payment; nothing to do here. ' +
      '<b>Paid</b> = paid but not activated yet (it retries; you can also activate the account by hand). <b>AmountMismatch</b> = the amount differs from the price, nothing was activated: check it in your Wayl dashboard.</p>' +
      '<button class="btn btn-outline btn-block" id="btnPaymentsLoad">Show recent payments</button>' +
      '<div id="entPaymentsList" style="margin-top:8px;"></div></div>';
  }

  function fillSpecFilter() {
    var sel = el('entAcctSpec');
    if (!sel) return;
    var keep = sel.value || 'all';
    var opts = ['<option value="all">All specialties</option>', '<option value="requests">Pending change requests</option>', '<option value="none">No specialty set (before 1.4)</option>'];
    window.EntRegistry.list().forEach(function (s) { opts.push('<option value="' + esc(s.id) + '">' + esc(s.name) + (s.status !== 'active' ? ' (' + esc(Core.STATUS_LABELS[s.status]) + ')' : '') + '</option>'); });
    sel.innerHTML = opts.join('');
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : 'all';
  }

  function renderAccounts() {
    var list = el('entAcctList');
    if (!list) return;
    fillSpecFilter();
    var filterEl = el('entAcctFilter');
    var q = filterEl ? filterEl.value.trim().toLowerCase() : '';
    var specFilter = (el('entAcctSpec') || {}).value || 'all';
    var counts = { active: 0, expired: 0, free: 0 };
    accounts.forEach(function (a) { counts[accessOf(a).kind]++; });
    var unassigned = accounts.filter(function (a) { return !a.specialtyId; }).length;
    var requests = accounts.filter(function (a) { return a.request; }).length;
    var withPhone = accounts.filter(function (a) { return a.phone; }).length;
    var summary = el('entAcctSummary');
    if (summary) {
      summary.textContent = accounts.length
        ? accounts.length + ' account(s): ' + counts.active + ' active, ' + counts.expired + ' expired, ' + counts.free + ' free · ' + requests + ' change request(s) · ' + unassigned + ' without a specialty · ' + withPhone + ' with a mobile number'
        : '';
    }
    var bulk = el('entAcctBulk');
    if (bulk) {
      bulk.textContent = '';
      if (unassigned) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-sm btn-accent'; b.setAttribute('data-act', 'bulk-ent');
        b.textContent = 'Assign the ' + unassigned + ' account(s) with no specialty to ENT';
        bulk.appendChild(b);
        var note = document.createElement('div');
        note.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin:4px 0 8px;';
        note.textContent = 'Accounts created before specialties existed were ENT students. They also set this themselves the first time they open the new app.';
        bulk.appendChild(note);
      }
    }
    list.textContent = '';
    accounts.filter(function (a) {
      if (q) {
        var qDigits = q.replace(/[^0-9]/g, '');
        var phoneDigits = (a.phone || '').replace(/[^0-9]/g, '');
        var localDigits = phoneDigits.indexOf('964') === 0 ? '0' + phoneDigits.slice(3) : phoneDigits;
        var phoneHit = qDigits.length >= 3 && (phoneDigits.indexOf(qDigits) !== -1 || localDigits.indexOf(qDigits) !== -1);
        if (a.identifier.toLowerCase().indexOf(q) === -1 && !phoneHit) return false;
      }
      if (specFilter === 'requests') return !!a.request;
      if (specFilter === 'none') return !a.specialtyId;
      if (specFilter !== 'all') return a.specialtyId === specFilter;
      return true;
    }).forEach(function (a) {
      var st = accessOf(a);
      var row = document.createElement('div');
      row.className = 'ent-acct';
      row.setAttribute('data-uid', a.uid);
      row.style.cssText = 'border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;';

      var top = document.createElement('div');
      var name = document.createElement('b');
      name.textContent = a.identifier;
      top.appendChild(name);
      if (a.createdAt) {
        var created = document.createElement('span');
        created.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-left:8px;';
        created.textContent = 'joined ' + fmtDay(a.createdAt) + (a.lastSeenAt ? ' · last opened ' + agoText(a.lastSeenAt) : '');
        top.appendChild(created);
      }
      row.appendChild(top);

      var spec = document.createElement('div');
      spec.className = 'ent-acct-spec';
      spec.style.cssText = 'font-size:0.85rem;margin:4px 0 0;';
      spec.textContent = a.specialtyId ? 'Specialty: ' + specLabel(a.specialtyId, a.specialtyName) + ' (' + a.specialtyId + ')' : 'Specialty: not set yet (an ENT account from before 1.4)';
      row.appendChild(spec);

      var phoneRow = document.createElement('div');
      phoneRow.className = 'ent-acct-phone';
      phoneRow.style.cssText = 'font-size:0.85rem;margin:4px 0 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;';
      var phoneText = document.createElement('span');
      if (a.phone) {
        phoneText.textContent = 'Mobile: ';
        var num = document.createElement('b');
        num.setAttribute('dir', 'ltr');
        num.textContent = fmtPhone(a.phone);
        phoneText.appendChild(num);
        phoneRow.appendChild(phoneText);
        var wa = whatsappLink(a.phone);
        if (wa) {
          var waBtn = document.createElement('a');
          waBtn.className = 'btn btn-sm btn-success ent-acct-wa';
          waBtn.href = wa;
          waBtn.target = '_blank';
          waBtn.rel = 'noopener noreferrer';
          waBtn.textContent = 'WhatsApp';
          waBtn.style.textDecoration = 'none';
          waBtn.setAttribute('aria-label', 'Open a WhatsApp chat with ' + a.identifier);
          phoneRow.appendChild(waBtn);
        }
      } else {
        phoneText.style.color = 'var(--text-muted)';
        phoneText.textContent = 'Mobile: not added yet';
        phoneRow.appendChild(phoneText);
      }
      row.appendChild(phoneRow);

      if (a.request) {
        var rq = document.createElement('div');
        rq.style.cssText = 'font-size:0.82rem;margin:6px 0;padding:6px 8px;border-radius:8px;background:var(--surface-hover);';
        rq.textContent = 'Asked to change to ' + specLabel(a.request.specialtyId, a.request.specialtyName) + (a.request.requestedAt ? ' on ' + fmtDay(a.request.requestedAt) : '') + '.';
        [['approve', 'Approve'], ['decline', 'Decline']].forEach(function (pair) {
          var rb = document.createElement('button');
          rb.type = 'button'; rb.className = 'btn btn-sm btn-outline'; rb.style.marginLeft = '8px';
          rb.setAttribute('data-act', pair[0]); rb.textContent = pair[1];
          rq.appendChild(rb);
        });
        row.appendChild(rq);
      }

      if (a.lastCode) {
        var lc = document.createElement('div');
        lc.className = 'ent-acct-lastcode';
        lc.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin:2px 0 0;';
        lc.textContent = 'Last activation code used: ' + formatCode(a.lastCode) + (a.lastCodeAt ? ' on ' + fmtDay(a.lastCodeAt) : '');
        row.appendChild(lc);
      }

      var status = document.createElement('div');
      status.className = 'ent-acct-status';
      status.style.cssText = 'font-size:0.85rem;margin:4px 0 8px;color:' +
        (st.kind === 'active' ? 'var(--success,#16a34a)' : st.kind === 'expired' ? 'var(--danger,#dc2626)' : 'var(--text2)') + ';';
      status.textContent = st.text;
      row.appendChild(status);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      [['code', 'Activation code'], ['m1', '+1 month'], ['m3', '+3 months'], ['m12', '+12 months'], ['date', 'Set date'],
        ['spec', 'Change specialty'], ['devices', 'Devices'], ['stop', 'Stop']].forEach(function (pair) {
        var b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'btn btn-sm ' + (pair[0] === 'stop' ? 'btn-danger' : pair[0] === 'code' ? 'btn-primary' : 'btn-outline');
        b2.setAttribute('data-act', pair[0]);
        b2.textContent = pair[1];
        actions.appendChild(b2);
      });
      row.appendChild(actions);
      var devBox = document.createElement('div');
      devBox.className = 'ent-acct-devices';
      devBox.style.cssText = 'display:none;margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--surface-hover);font-size:0.84rem;';
      row.appendChild(devBox);
      list.appendChild(row);
    });
  }

  function agoText(ms) {
    var days = Math.floor((Date.now() - ms) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? days + ' days ago' : fmtDay(ms);
  }

  // The devices panel of one account row: the list, and Reset devices.
  async function showDevices(a, row) {
    var box = row.querySelector('.ent-acct-devices');
    if (!box) return;
    box.style.display = 'block';
    box.textContent = 'Loading devices...';
    var data = await readDevices(a.uid);
    box.textContent = '';
    var head = document.createElement('div');
    head.style.fontWeight = '700';
    head.textContent = data.list.length ? data.list.length + ' of ' + accessSettings.maxDevices + ' device(s) in use' : 'No device registered yet (the student has not opened the new app).';
    box.appendChild(head);
    data.list.forEach(function (d) {
      var line = document.createElement('div');
      line.className = 'ent-acct-device';
      line.textContent = d.label + (d.addedAt ? ' · added ' + fmtDay(d.addedAt) : '');
      box.appendChild(line);
    });
    if (data.lastSwapAt) {
      var sw = document.createElement('div');
      sw.style.color = 'var(--text-muted)';
      sw.textContent = 'Last replaced a device on ' + fmtDay(data.lastSwapAt) + '.';
      box.appendChild(sw);
    }
    if (data.list.length) {
      var rb = document.createElement('button');
      rb.type = 'button'; rb.className = 'btn btn-sm btn-danger'; rb.style.marginTop = '8px';
      rb.setAttribute('data-act', 'devices-reset'); rb.textContent = 'Reset devices';
      box.appendChild(rb);
    }
  }

  function chooseSpecialty(a) {
    return new Promise(function (resolve) {
      var opts = window.EntRegistry.list().filter(function (s) { return s.status !== 'archived'; });
      if (!opts.length) { resolve(null); return; }
      var html = '<h3>Change specialty</h3><p style="font-size:0.9rem;margin:6px 0 12px;">Account: <b>' + esc(a.identifier) + '</b><br>Now: <b>' +
        esc(a.specialtyId ? specLabel(a.specialtyId, a.specialtyName) : 'not set') + '</b></p>' +
        '<label class="modal-field">New specialty<select id="entChooseSpec">' +
        opts.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === a.specialtyId ? ' selected' : '') + '>' + esc(s.name) + (s.status !== 'active' ? ' (' + esc(Core.STATUS_LABELS[s.status]) + ')' : '') + '</option>'; }).join('') + '</select></label>' +
        '<p style="font-size:0.8rem;color:var(--text2);">The student\'s progress in the old specialty stays on their device and returns if they are moved back. Nothing is merged between specialties.</p>' +
        '<button type="button" class="btn btn-primary btn-block" id="entChooseSpecOk">Change specialty</button>' +
        '<button type="button" class="btn btn-outline btn-block mt-2" id="entChooseSpecNo">Cancel</button>';
      showModal(html);
      el('entChooseSpecOk').addEventListener('click', function () {
        var id = el('entChooseSpec').value;
        closeModal();
        resolve(window.EntRegistry.get(id));
      });
      el('entChooseSpecNo').addEventListener('click', function () { closeModal(); resolve(null); });
    });
  }

  async function onAccountAction(e) {
    var btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
    var act = btn.getAttribute('data-act');
    if (act === 'bulk-ent') return bulkAssignEnt();
    var row = btn.closest('.ent-acct');
    var a = accounts.filter(function (x) { return row && x.uid === row.getAttribute('data-uid'); })[0];
    if (!a) return;
    if (act === 'code') return issueCodeFor(a);
    if (act === 'devices' || act === 'devices-reset') {
      try {
        if (act === 'devices-reset') {
          if (!window.confirm('Reset the devices of ' + a.identifier + '? Every device is signed out of the list; the next ' + accessSettings.maxDevices + ' device(s) that open the app are registered again.')) return;
          await resetDevices(a.uid);
          acctMsg('Devices of ' + a.identifier + ' were reset.');
        }
        await showDevices(a, row);
      } catch (err) { acctMsg('Could not read the devices of ' + a.identifier + ': ' + friendly(err), true); }
      return;
    }
    try {
      if (act === 'm1') await extendAccount(a, 1, '1m');
      else if (act === 'm3') await extendAccount(a, 3, '3m');
      else if (act === 'm12') await extendAccount(a, 12, '12m');
      else if (act === 'date') {
        var d0 = a.expiresAt ? new Date(a.expiresAt) : new Date();
        var def = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
        var typed = window.prompt('Active until (YYYY-MM-DD) for ' + a.identifier + ':', def);
        if (typed === null) return;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(typed).trim());
        var when = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) : null;
        if (!when || isNaN(when.getTime()) || when.getMonth() !== Number(m[2]) - 1) return acctMsg('Enter the date as YYYY-MM-DD, for example 2027-03-15.', true);
        await saveAccess(a, 'custom', when.getTime());
      } else if (act === 'stop') {
        if (!window.confirm('Stop the subscription of ' + a.identifier + '? They keep their progress but only the Free questions stay open.')) return;
        await saveAccess(a, 'none', null);
      } else if (act === 'spec') {
        var chosen = await chooseSpecialty(a);
        if (!chosen || chosen.id === a.specialtyId) return;
        await assignSpecialty(a, chosen, 'admin');
        renderAccounts();
        return acctMsg(a.identifier + ' is now in ' + chosen.name + '. They see it the next time they open the app online.');
      } else if (act === 'approve') {
        var target = window.EntRegistry.get(a.request.specialtyId) || { id: a.request.specialtyId, name: a.request.specialtyName };
        if (target.status && target.status !== 'active' && !window.confirm('"' + target.name + '" is ' + (Core.STATUS_LABELS[target.status] || target.status).toLowerCase() + '. Move ' + a.identifier + ' there anyway?')) return;
        await assignSpecialty(a, target, 'admin-approved');
        renderAccounts();
        return acctMsg(a.identifier + ' moved to ' + target.name + '.');
      } else if (act === 'decline') {
        await declineRequest(a);
        renderAccounts();
        return acctMsg('Request declined. ' + a.identifier + ' stays in ' + specLabel(a.specialtyId, a.specialtyName) + '.');
      }
      renderAccounts();
      acctMsg(a.identifier + ': ' + accessOf(a).text + '.');
    } catch (err) {
      acctMsg('Could not update ' + a.identifier + ': ' + friendly(err), true);
    }
  }

  async function bulkAssignEnt() {
    var todo = accounts.filter(function (a) { return !a.specialtyId; });
    if (!todo.length) return;
    var ent = window.EntRegistry.get(Core.LEGACY_SPECIALTY_ID);
    if (!ent) return acctMsg('The ENT specialty is missing from this device\'s list.', true);
    if (!window.confirm('Assign ' + todo.length + ' account(s) that have no specialty to "' + ent.name + '"? This is what they would be set to automatically anyway.')) return;
    try {
      await syncSpecialties([ent.id]); // make sure specialties/ent exists in the cloud
      for (var i = 0; i < todo.length; i++) {
        acctMsg('Assigning ' + (i + 1) + ' / ' + todo.length + '...');
        await assignSpecialty(todo[i], ent, 'migration');
      }
      renderAccounts();
      acctMsg('Done: ' + todo.length + ' account(s) are now ENT students.');
    } catch (err) {
      renderAccounts();
      acctMsg('Stopped: ' + friendly(err), true);
    }
  }

  function wireAccounts() {
    var loadBtn = el('btnAcctLoad');
    if (!loadBtn) return;
    renderAccounts(); // accounts loaded earlier in this session stay visible after Settings re-renders
    loadBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      loadBtn.disabled = true;
      acctMsg('Loading...');
      try {
        await loadAccounts(acctMsg);
        renderAccounts();
        acctMsg(accounts.length ? '' : 'No accounts yet.');
      } catch (e) {
        acctMsg('Could not load accounts: ' + friendly(e), true);
      } finally {
        loadBtn.disabled = false;
      }
    });
    var filter = el('entAcctFilter');
    if (filter) filter.addEventListener('input', renderAccounts);
    var specSel = el('entAcctSpec');
    if (specSel) specSel.addEventListener('change', renderAccounts);
    var list = el('entAcctList');
    if (list) list.addEventListener('click', onAccountAction);
    var bulk = el('entAcctBulk');
    if (bulk) bulk.addEventListener('click', onAccountAction);
    var codesBtn = el('btnCodesLoad');
    if (codesBtn) codesBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      codesBtn.disabled = true;
      try { await loadCodes(); renderCodes(); } catch (e) { var box = el('entCodesList'); if (box) box.textContent = 'Could not load codes: ' + friendly(e); }
      finally { codesBtn.disabled = false; }
    });
    var codesList = el('entCodesList');
    if (codesList) codesList.addEventListener('click', onCodeAction);
    if (codes.length) renderCodes();
    var payBtn = el('btnPaymentsLoad');
    if (payBtn) payBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      payBtn.disabled = true;
      try { await loadPayments(); renderPayments(); } catch (e) { var box = el('entPaymentsList'); if (box) box.textContent = 'Could not load payments: ' + friendly(e); }
      finally { payBtn.disabled = false; }
    });
    if (payments.length) renderPayments();
  }

  /* ------------------------------------------------------------------ activation codes */

  // Plans a code can carry. Days (not calendar months) so the server rules can check the arithmetic exactly.
  var CODE_PLANS = [
    { id: '1m', label: '1 month', labelAr: 'شهر واحد', days: 30 },
    { id: '3m', label: '3 months', labelAr: '3 أشهر', days: 90 },
    { id: '12m', label: '12 months', labelAr: '12 شهراً', days: 365 }
  ];
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: no 0/O/1/I, so a code read aloud or typed is unambiguous
  var CODE_LENGTH = 10;
  var codes = [];

  function newCode() {
    var bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += CODE_ALPHABET[bytes[i] % 32]; // 256 % 32 == 0: no bias
    return out;
  }

  function formatCode(c) { return String(c || '').replace(/(.{4})(?=.)/g, '$1-'); }

  // Creates codes/{code} for one account and one plan. The rules require createdAt == server time, unused, admin only.
  async function createCode(a, plan, validDays) {
    var tk = await token();
    var me = load(SESSION_KEY) || {};
    var validUntil = new Date(Date.now() + validDays * 86400000).toISOString();
    for (var attempt = 0; attempt < 4; attempt++) {
      var code = newCode();
      try {
        await request(FS + ':commit', {
          method: 'POST', headers: authHeaders(tk, true),
          body: JSON.stringify({ writes: [{
            update: { name: FS.replace('https://firestore.googleapis.com/v1/', '') + '/codes/' + code, fields: {
              uid: sv(a.uid), identifier: sv(a.identifier), plan: sv(plan.id), planLabel: sv(plan.label), days: iv(plan.days),
              createdBy: sv(me.uid || ''), validUntil: tv(validUntil), usedAt: { nullValue: null }, usedBy: { nullValue: null } } },
            currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]
          }] })
        });
        var rec = { code: code, uid: a.uid, identifier: a.identifier, plan: plan.id, planLabel: plan.label, days: plan.days,
          createdAt: Date.now(), validUntil: Date.parse(validUntil), usedAt: null, usedBy: null };
        codes.unshift(rec);
        return rec;
      } catch (e) {
        if (e.status === 409 || e.code === 'ALREADY_EXISTS') continue; // astronomically rare: try another code
        throw e;
      }
    }
    throw cloudError('CODE_COLLISION');
  }

  // The message the student receives on WhatsApp (written outside the app, by you).
  function codeMessage(rec) {
    var plan = CODE_PLANS.filter(function (p) { return p.id === rec.plan; })[0] || { labelAr: rec.planLabel, label: rec.planLabel };
    var until = new Date(rec.validUntil).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    return 'Adam QBank\n' +
      'رمز التفعيل الخاص بك: ' + formatCode(rec.code) + '\n' +
      'الباقة: ' + plan.labelAr + ' (' + rec.days + ' يوماً)\n' +
      'الحساب: ' + rec.identifier + '\n\n' +
      'افتح التطبيق ← الإعدادات (Settings) ← Access ← Enter activation code، واكتب الرمز.\n' +
      'الرمز يعمل مرة واحدة ولهذا الحساب فقط، وصالح حتى ' + until + '.\n\n' +
      'Your activation code: ' + formatCode(rec.code) + ' (' + plan.label + ', account ' + rec.identifier + ').';
  }

  function issueCodeFor(a) {
    var html = '<h3>Activation code</h3>' +
      '<p style="font-size:0.9rem;margin:6px 0 12px;">Account: <b>' + esc(a.identifier) + '</b><br>' + esc(accessOf(a).text) + '</p>' +
      '<label class="modal-field">Plan<select id="entCodePlan">' +
      CODE_PLANS.map(function (p) { return '<option value="' + p.id + '">' + esc(p.label) + ' (' + p.days + ' days)</option>'; }).join('') + '</select></label>' +
      '<label class="modal-field">The code must be used within<select id="entCodeValid"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></label>' +
      '<p style="font-size:0.8rem;color:var(--text2);">The days are added to the account: from today, or from the current end date if Premium is still running.</p>' +
      '<div id="entCodeErr" style="color:var(--danger);font-size:0.85rem;min-height:1.2em;"></div>' +
      '<button type="button" class="btn btn-primary btn-block" id="entCodeCreate">Create code</button>' +
      '<button type="button" class="btn btn-outline btn-block mt-2" id="entCodeCancel">Cancel</button>';
    showModal(html);
    el('entCodeCancel').addEventListener('click', closeModal);
    el('entCodeCreate').addEventListener('click', async function () {
      var btn = el('entCodeCreate');
      var plan = CODE_PLANS.filter(function (p) { return p.id === el('entCodePlan').value; })[0];
      var validDays = Number(el('entCodeValid').value) || 7;
      btn.disabled = true; btn.textContent = 'Creating...';
      try {
        var rec = await createCode(a, plan, validDays);
        showCodeResult(a, rec);
        renderCodes();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Create code';
        el('entCodeErr').textContent = 'Could not create the code: ' + friendly(e);
      }
    });
  }

  function showCodeResult(a, rec) {
    var wa = a.phone ? whatsappLink(a.phone) : '';
    var html = '<h3>Code for ' + esc(a.identifier) + '</h3>' +
      '<div id="entCodeValue" dir="ltr" style="font:700 1.7rem/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;text-align:center;padding:16px 8px;margin:10px 0;border:2px dashed var(--primary);border-radius:14px;user-select:all;">' + esc(formatCode(rec.code)) + '</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);margin:0 0 12px;">' + esc(rec.planLabel) + ' · ' + rec.days + ' days · must be used by ' + esc(fmtDay(rec.validUntil)) + '</p>' +
      (wa ? '<a class="btn btn-success btn-block" id="entCodeWa" target="_blank" rel="noopener noreferrer" style="text-decoration:none;" href="' + esc(wa + '?text=' + encodeURIComponent(codeMessage(rec))) + '">Send on WhatsApp to ' + esc(fmtPhone(a.phone)) + '</a>'
          : '<p style="font-size:0.85rem;color:var(--warning,#b45309);">This account has no mobile number. Copy the code and send it yourself.</p>') +
      '<button type="button" class="btn btn-outline btn-block mt-2" id="entCodeCopy">Copy message</button>' +
      '<button type="button" class="btn btn-outline btn-block mt-2" id="entCodeDone">Done</button>';
    showModal(html);
    el('entCodeDone').addEventListener('click', closeModal);
    el('entCodeCopy').addEventListener('click', function () {
      var text = codeMessage(rec);
      var done = function () { el('entCodeCopy').textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy the message:', text); });
      else window.prompt('Copy the message:', text);
    });
    acctMsg('Code ' + formatCode(rec.code) + ' created for ' + a.identifier + ' (' + rec.planLabel + ').');
  }

  function parseCode(doc) {
    var f = doc.fields || {};
    return { code: idOf(doc), uid: strOf(f.uid), identifier: strOf(f.identifier), plan: strOf(f.plan), planLabel: strOf(f.planLabel) || strOf(f.plan),
      days: f.days && f.days.integerValue != null ? Number(f.days.integerValue) : 0, createdAt: tsMs(f.createdAt) || 0,
      validUntil: tsMs(f.validUntil) || 0, usedAt: tsMs(f.usedAt), usedBy: strOf(f.usedBy) };
  }

  async function loadCodes() {
    var tk = await token();
    var out = [], pageToken = '';
    do {
      var d = await request(FS + '/codes?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseCode(doc)); });
      pageToken = d.nextPageToken || '';
    } while (pageToken && out.length < 3000);
    codes = out.sort(function (x, y) { return y.createdAt - x.createdAt; });
  }

  function codeState(c) {
    if (c.usedAt) return { kind: 'used', text: 'Used on ' + fmtDay(c.usedAt) };
    if (c.validUntil && c.validUntil < Date.now()) return { kind: 'expired', text: 'Expired unused (' + fmtDay(c.validUntil) + ')' };
    return { kind: 'open', text: 'Not used yet · valid until ' + fmtDay(c.validUntil) };
  }

  function renderCodes() {
    var box = el('entCodesList');
    if (!box) return;
    box.textContent = '';
    if (!codes.length) { box.textContent = 'No codes yet.'; return; }
    codes.slice(0, 60).forEach(function (c) {
      var st = codeState(c);
      var row = document.createElement('div');
      row.className = 'ent-code-row';
      row.setAttribute('data-code', c.code);
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;font-size:0.84rem;';
      var code = document.createElement('b'); code.setAttribute('dir', 'ltr'); code.style.fontFamily = 'ui-monospace,Menlo,Consolas,monospace'; code.textContent = formatCode(c.code);
      var who = document.createElement('span'); who.textContent = c.identifier + ' · ' + c.planLabel;
      var state = document.createElement('span');
      state.style.color = st.kind === 'used' ? 'var(--success,#16a34a)' : st.kind === 'expired' ? 'var(--text-muted)' : 'var(--primary)';
      state.textContent = st.text;
      row.appendChild(code); row.appendChild(who); row.appendChild(state);
      if (st.kind === 'open') {
        var rv = document.createElement('button');
        rv.type = 'button'; rv.className = 'btn btn-sm btn-outline'; rv.setAttribute('data-code-act', 'revoke'); rv.textContent = 'Revoke';
        rv.style.marginInlineStart = 'auto';
        row.appendChild(rv);
      }
      box.appendChild(row);
    });
  }

  async function onCodeAction(e) {
    var btn = e.target.closest && e.target.closest('button[data-code-act]');
    if (!btn) return;
    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
    var code = btn.closest('.ent-code-row').getAttribute('data-code');
    if (!window.confirm('Revoke code ' + formatCode(code) + '? It will stop working.')) return;
    btn.disabled = true;
    try {
      var tk = await token();
      await request(FS + '/codes/' + encodeURIComponent(code), { method: 'DELETE', headers: authHeaders(tk) });
      codes = codes.filter(function (c) { return c.code !== code; });
      renderCodes();
    } catch (err) { btn.disabled = false; acctMsg('Could not revoke the code: ' + friendly(err), true); }
  }

  /* ------------------------------------------------------------------ online payments (written by the payment Worker) */

  var payments = [];
  var PAY_STATES = {
    Activated: ['Activated', 'var(--success,#16a34a)'], Paid: ['Paid, activation pending', 'var(--warning,#b45309)'],
    Activating: ['Activating...', 'var(--primary)'], Created: ['Payment page opened, not paid', 'var(--text-muted)'],
    AmountMismatch: ['Amount mismatch: not activated', 'var(--danger,#dc2626)'], LinkFailed: ['Wayl refused the link', 'var(--danger,#dc2626)']
  };

  function parsePayment(doc) {
    var f = doc.fields || {};
    return { ref: doc.name.split('/').pop(), uid: strOf(f.uid), identifier: strOf(f.identifier) || strOf(f.uid), planLabel: strOf(f.planLabel) || strOf(f.plan),
      amount: f.amount && f.amount.integerValue != null ? Number(f.amount.integerValue) : 0, status: strOf(f.status), waylStatus: strOf(f.waylStatus),
      env: strOf(f.env), method: strOf(f.paymentMethod), createdAt: tsMs(f.createdAt) || 0, activatedAt: tsMs(f.activatedAt), error: strOf(f.error) };
  }

  async function loadPayments() {
    var tk = await token();
    var out = [], pageToken = '';
    do {
      var d = await request(FS + '/payments?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parsePayment(doc)); });
      pageToken = d.nextPageToken || '';
    } while (pageToken && out.length < 3000);
    payments = out.sort(function (x, y) { return y.createdAt - x.createdAt; });
  }

  function renderPayments() {
    var box = el('entPaymentsList');
    if (!box) return;
    box.textContent = '';
    if (!payments.length) { box.textContent = 'No online payments yet.'; return; }
    var since = Date.now() - 30 * 86400000, total = 0, count = 0;
    payments.forEach(function (p) { if (p.status === 'Activated' && p.env === 'live' && p.activatedAt >= since) { total += p.amount; count++; } });
    var sum = document.createElement('div');
    sum.style.cssText = 'font-size:0.84rem;color:var(--text2);margin-bottom:8px;';
    sum.textContent = 'Last 30 days (live): ' + count + ' activated payment(s), ' + total.toLocaleString('en-US') + ' IQD.';
    box.appendChild(sum);
    payments.slice(0, 80).forEach(function (p) {
      var st = PAY_STATES[p.status] || [p.status || 'Unknown', 'var(--text2)'];
      var row = document.createElement('div');
      row.className = 'ent-pay-row';
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;font-size:0.84rem;';
      var who = document.createElement('b'); who.textContent = p.identifier;
      var what = document.createElement('span'); what.textContent = p.planLabel + ' · ' + p.amount.toLocaleString('en-US') + ' IQD' + (p.env === 'test' ? ' · TEST' : '');
      var state = document.createElement('span'); state.style.color = st[1]; state.style.fontWeight = '600'; state.textContent = st[0];
      var when = document.createElement('span'); when.style.color = 'var(--text-muted)';
      when.textContent = fmtDay(p.createdAt) + (p.method ? ' · ' + p.method : '') + (p.error ? ' · ' + p.error : '');
      var ref = document.createElement('code'); ref.setAttribute('dir', 'ltr'); ref.style.cssText = 'font-size:0.74rem;color:var(--text-muted);flex-basis:100%;'; ref.textContent = p.ref;
      row.appendChild(who); row.appendChild(what); row.appendChild(state); row.appendChild(when); row.appendChild(ref);
      box.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ question reports */

  var REASON_LABELS = { wrong_answer: 'Wrong answer', wrong_explanation: 'Wrong explanation', typo: 'Typo / unclear', other: 'Other' };
  var reports = [];

  function parseReport(doc) {
    var f = doc.fields || {};
    return {
      id: idOf(doc),
      questionUid: strOf(f.questionUid),
      questionText: strOf(f.questionText),
      subject: strOf(f.subject),
      chapter: strOf(f.chapter),
      correctAnswer: strOf(f.correctAnswer),
      reason: strOf(f.reason),
      note: strOf(f.note),
      reporter: strOf(f.reporterIdentifier),
      specialtyId: strOf(f.specialtyId),
      specialtyName: strOf(f.specialtyName),
      createdAt: tsMs(f.createdAt) || 0
    };
  }

  // Reports written before specialties existed carry no specialtyId: they are ENT reports.
  function reportSpecialty(r) { return r.specialtyId || Core.LEGACY_SPECIALTY_ID; }

  // One Firestore read per report: load on demand, resolve (delete) reports once handled.
  async function loadReports(progress) {
    var tk = await token();
    var out = [];
    var pageToken = '';
    do {
      var url = FS + '/reports?pageSize=' + pageSize + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var d = await request(url, { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseReport(doc)); });
      pageToken = d.nextPageToken || '';
      if (progress) progress('Loaded ' + out.length + ' report(s)...');
    } while (pageToken && out.length < 5000);
    reports = out.sort(function (a, b) { return b.createdAt - a.createdAt; });
    return reports;
  }

  function reportsCardHTML() {
    return '<div class="card"><div class="card-header">Question reports</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">Problems students report on questions. Each report names the student\'s specialty. Open that specialty\'s workspace, fix the question in the Questions list, then tap Resolve.</p>' +
      '<button class="btn btn-outline btn-block" id="btnRepLoad">Load reports</button>' +
      '<input type="search" id="entRepFilter" placeholder="Search question, student or note" autocomplete="off" spellcheck="false" style="margin-top:10px;">' +
      '<select id="entRepSpec" aria-label="Filter reports by specialty" style="margin-top:8px;"></select>' +
      '<div id="entRepSummary" style="margin:6px 0;font-size:0.82rem;color:var(--text2);"></div>' +
      '<div id="entRepList"></div>' +
      '<div id="entRepMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  function repMsg(text, isError) {
    var node = el('entRepMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function fillReportSpecFilter() {
    var sel = el('entRepSpec');
    if (!sel) return;
    var keep = sel.value || 'all';
    var cur = currentSpec();
    var opts = ['<option value="all">All specialties</option>'];
    if (cur) opts.push('<option value="' + esc(cur.id) + '">Open workspace: ' + esc(cur.name) + '</option>');
    window.EntRegistry.list().forEach(function (s) { if (!cur || s.id !== cur.id) opts.push('<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'); });
    sel.innerHTML = opts.join('');
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : 'all';
  }

  function renderReports() {
    var list = el('entRepList');
    if (!list) return;
    fillReportSpecFilter();
    var filterEl = el('entRepFilter');
    var q = filterEl ? filterEl.value.trim().toLowerCase() : '';
    var specFilter = (el('entRepSpec') || {}).value || 'all';
    var counts = {};
    reports.forEach(function (r) { counts[r.reason] = (counts[r.reason] || 0) + 1; });
    var summary = el('entRepSummary');
    if (summary) {
      summary.textContent = reports.length
        ? reports.length + ' open report(s): ' + Object.keys(REASON_LABELS).map(function (k) { return (counts[k] || 0) + ' ' + REASON_LABELS[k].toLowerCase(); }).join(', ')
        : '';
    }
    list.textContent = '';
    reports.filter(function (r) {
      if (specFilter !== 'all' && reportSpecialty(r) !== specFilter) return false;
      return !q || (r.questionText + ' ' + r.reporter + ' ' + r.note + ' ' + r.subject + ' ' + r.chapter).toLowerCase().indexOf(q) !== -1;
    }).forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'ent-report';
      row.setAttribute('data-rid', r.id);
      row.style.cssText = 'border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;';

      var top = document.createElement('div');
      var reason = document.createElement('b');
      reason.className = 'ent-report-reason';
      reason.textContent = REASON_LABELS[r.reason] || r.reason || 'Report';
      top.appendChild(reason);
      var sid = reportSpecialty(r);
      var chip = document.createElement('span');
      chip.className = 'badge badge-primary ent-report-spec';
      chip.style.marginLeft = '8px';
      chip.textContent = specLabel(sid, r.specialtyName) + (r.specialtyId ? '' : ' (legacy)');
      top.appendChild(chip);
      var when = document.createElement('span');
      when.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-left:8px;';
      when.textContent = r.createdAt ? fmtDay(r.createdAt) : '';
      top.appendChild(when);
      row.appendChild(top);

      var text = document.createElement('div');
      text.style.cssText = 'font-size:0.88rem;margin:4px 0;';
      text.setAttribute('dir', 'auto');
      text.textContent = r.questionText.length > 140 ? r.questionText.slice(0, 140) + '...' : r.questionText;
      row.appendChild(text);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.78rem;color:var(--text2);';
      meta.textContent = [r.subject, r.chapter].filter(Boolean).join(' / ') + (r.subject || r.chapter ? ' - ' : '') + 'from ' + (r.reporter || 'unknown');
      row.appendChild(meta);

      if (r.note) {
        var note = document.createElement('div');
        note.style.cssText = 'font-size:0.85rem;margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--bg-secondary,rgba(0,0,0,.05));';
        note.setAttribute('dir', 'auto');
        note.textContent = r.note;
        row.appendChild(note);
      }

      var detail = document.createElement('div');
      detail.className = 'ent-report-detail';
      detail.style.cssText = 'display:none;margin-top:8px;font-size:0.85rem;';
      row.appendChild(detail);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
      var openHere = !currentSpec() || sid === currentSpec().id;
      var buttons = openHere ? [['show', 'Show question'], ['resolve', 'Resolve']] : [['workspace', 'Open ' + specLabel(sid, r.specialtyName) + ' workspace'], ['resolve', 'Resolve']];
      buttons.forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline';
        b.setAttribute('data-act', pair[0]);
        b.textContent = pair[1];
        actions.appendChild(b);
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Shows the question as it is in THIS device's database for the report's specialty (the one you edit).
  async function showReportedQuestion(r, holder) {
    if (holder.style.display === 'block') { holder.style.display = 'none'; return; }
    holder.textContent = '';
    var all = await db.getAllQuestions();
    var q = all.filter(function (x) { return x.uid && x.uid === r.questionUid; })[0];
    if (!q) {
      holder.textContent = 'This question was not found in this specialty\'s workspace (it may have been deleted, or this device does not have it).';
    } else {
      var line = function (label, value, strong) {
        var d = document.createElement('div');
        d.style.margin = '2px 0';
        d.setAttribute('dir', 'auto');
        if (label) { var s = document.createElement('b'); s.textContent = label + ' '; d.appendChild(s); }
        var t = document.createElement(strong ? 'b' : 'span');
        t.textContent = value;
        d.appendChild(t);
        holder.appendChild(d);
      };
      line('Q:', q.questionText);
      ['A', 'B', 'C', 'D', 'E'].forEach(function (l) {
        if (q['option' + l]) line(l + '.', q['option' + l] + (l === q.correctAnswer ? '  ✓' : ''), l === q.correctAnswer);
      });
      if (r.correctAnswer && r.correctAnswer !== q.correctAnswer) line('', 'Note: the student saw "' + r.correctAnswer + '" as the correct answer; it is now "' + q.correctAnswer + '".');
      if (q.explanation) line('Explanation:', q.explanation);
    }
    holder.style.display = 'block';
  }

  async function onReportAction(e) {
    var btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
    var row = btn.closest('.ent-report');
    var r = reports.filter(function (x) { return row && x.id === row.getAttribute('data-rid'); })[0];
    if (!r) return;
    try {
      var act = btn.getAttribute('data-act');
      if (act === 'show') {
        await showReportedQuestion(r, row.querySelector('.ent-report-detail'));
      } else if (act === 'workspace') {
        var sid = reportSpecialty(r);
        if (!window.EntRegistry.get(sid)) return repMsg('This device does not have a "' + sid + '" workspace. Pull the specialty list from Specialties first.', true);
        if (typeof AppState !== 'undefined' && AppState.examInProgress) return repMsg('Finish or leave the exam first.', true);
        window.EntRegistry.openWorkspace(sid);
      } else {
        if (!window.confirm('Mark this report as resolved? It will be deleted.')) return;
        var tk = await token();
        await request(FS + '/reports/' + encodeURIComponent(r.id), { method: 'DELETE', headers: authHeaders(tk) });
        reports = reports.filter(function (x) { return x.id !== r.id; });
        renderReports();
        repMsg('Report resolved.');
      }
    } catch (err) {
      repMsg('Could not complete that: ' + friendly(err), true);
    }
  }

  function wireReports() {
    var loadBtn = el('btnRepLoad');
    if (!loadBtn) return;
    renderReports(); // reports loaded earlier in this session stay visible after Settings re-renders
    loadBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      loadBtn.disabled = true;
      repMsg('Loading...');
      try {
        await loadReports(repMsg);
        renderReports();
        repMsg(reports.length ? '' : 'No open reports.');
      } catch (e) {
        repMsg('Could not load reports: ' + friendly(e), true);
      } finally {
        loadBtn.disabled = false;
      }
    });
    var filter = el('entRepFilter');
    if (filter) filter.addEventListener('input', renderReports);
    var specSel = el('entRepSpec');
    if (specSel) specSel.addEventListener('change', renderReports);
    var list = el('entRepList');
    if (list) list.addEventListener('click', onReportAction);
  }

  /* ------------------------------------------------------------------ access scope card + ENT migration checklist */

  function accessCardHTML() {
    return '<div class="card"><div class="card-header">Subscription scope</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">What does an active subscription unlock? This is enforced by the Firestore rules, not just by the app.</p>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;"><input type="radio" name="entScope" value="selected"> <span><b>The student\'s own specialty only</b> (recommended). A student of Dermatology downloads only the Dermatology bank.</span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;"><input type="radio" name="entScope" value="all"> <span><b>All specialties.</b> Any active subscriber may download every active specialty\'s bank. The app still only shows the student\'s own specialty.</span></label>' +
      '<p style="font-size:0.8rem;color:var(--text2);margin:10px 0;">There is no free trial: a new account starts on the free version, which opens only the questions you mark <b>Free</b> (up to 250 per specialty, published with Export Free Pack).</p>' +
      '<button class="btn btn-outline btn-block" id="btnScopeSave">Save</button>' +
      '<div id="entScopeMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  function devicesCardHTML() {
    return '<div class="card" id="entDevicesCard"><div class="card-header">Devices per account</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">An account works on this many devices (a phone and a computer, for example). A third device is refused until the student signs one out, which is allowed once per the number of days below. ' +
      'Open <b>Devices</b> on a student in Student accounts to see or reset theirs.</p>' +
      '<div class="form-row"><div><label for="entMaxDevices">Devices per account</label><input type="number" id="entMaxDevices" min="1" max="10" step="1" inputmode="numeric"></div>' +
      '<div><label for="entSwapDays">Days between replacements</label><input type="number" id="entSwapDays" min="0" max="90" step="1" inputmode="numeric"></div></div>' +
      '<button class="btn btn-outline btn-block mt-2" id="btnDevicesSave">Save</button>' +
      '<div id="entDevicesMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  async function wireDevicesCard() {
    var save = el('btnDevicesSave'), max = el('entMaxDevices'), days = el('entSwapDays'), msg = el('entDevicesMsg');
    if (!save || !max || !days) return;
    var say = function (text, isError) { if (msg) { msg.textContent = text || ''; msg.style.color = isError ? 'var(--danger)' : 'var(--text2)'; } };
    try { var cur = await readAccess(); max.value = cur.maxDevices; days.value = cur.deviceSwapDays; }
    catch (e) { max.value = accessSettings.maxDevices; days.value = accessSettings.deviceSwapDays; }
    save.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      save.disabled = true;
      try {
        var out = await writeDeviceLimits(max.value, days.value);
        say('Saved: ' + out.maxDevices + ' device(s) per account, a replacement every ' + out.deviceSwapDays + ' day(s).');
      } catch (e) { say('Could not save: ' + friendly(e), true); }
      finally { save.disabled = false; }
    });
  }

  /* ------------------------------------------------------------------ board exam simulation (settings/board) */
  // One small document for all specialties: { "<specialtyId>": { questions, minutes, mix: { "<category>": percent } } }.
  // Students read it (Exam > Board exam simulation). Without an entry the app uses 100 questions in 120 minutes.

  async function readBoard() {
    var tk = await token();
    try {
      var d = await request(FS + '/settings/board', { headers: authHeaders(tk) });
      var parsed = JSON.parse(strOf((d.fields || {}).json) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) { if (e.status === 404) return {}; throw e; }
  }

  async function writeBoard(specId, config) {
    var q = Number(config.questions), m = Number(config.minutes);
    if (!isFinite(q) || Math.floor(q) !== q || q < 5 || q > 500) throw new Error('Questions must be a whole number from 5 to 500.');
    if (!isFinite(m) || Math.floor(m) !== m || m < 1 || m > 600) throw new Error('Minutes must be a whole number from 1 to 600.');
    var mix = null, sum = 0;
    Object.keys(config.mix || {}).forEach(function (cat) {
      var v = Number(config.mix[cat]);
      if (!v) return;
      if (!isFinite(v) || v < 0 || v > 100) throw new Error('Each percentage must be between 0 and 100.');
      mix = mix || {}; mix[cat] = v; sum += v;
    });
    if (mix && Math.abs(sum - 100) > 0.01) throw new Error('The percentages add up to ' + sum + '%. They must add up to 100%, or leave them all empty.');
    var all = await readBoard();
    all[specId] = { questions: q, minutes: m, mix: mix };
    var text = JSON.stringify(all);
    if (text.length > 40000) throw new Error('The board settings are too large.');
    var tk = await token();
    await request(FS + '/settings/board', { method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { json: sv(text), updatedAt: tv(new Date().toISOString()) } }) });
    return all[specId];
  }

  function boardCardHTML() {
    var spec = currentSpec();
    return '<div class="card" id="entBoardCard"><div class="card-header">Board exam simulation</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">How long the real ' + esc(spec ? spec.name : '') + ' board exam is. Students get a <b>Board exam simulation</b> button in Exam with this length, and their score for each category. ' +
      'The percentages are optional: leave them empty and the questions are spread like your bank.</p>' +
      '<div class="form-row"><div><label for="entBoardQ">Questions</label><input type="number" id="entBoardQ" min="5" max="500" step="1" inputmode="numeric"></div>' +
      '<div><label for="entBoardM">Minutes</label><input type="number" id="entBoardM" min="1" max="600" step="1" inputmode="numeric"></div></div>' +
      '<div style="font-weight:700;margin:10px 0 4px;">Share of each category (%)</div>' +
      '<div id="entBoardMix" style="display:grid;grid-template-columns:1fr 90px;gap:6px 10px;align-items:center;font-size:0.88rem;"></div>' +
      '<div id="entBoardSum" style="font-size:0.82rem;color:var(--text2);margin-top:6px;"></div>' +
      '<button class="btn btn-outline btn-block mt-2" id="btnBoardSave">Save</button>' +
      '<div id="entBoardMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  async function wireBoardCard() {
    var save = el('btnBoardSave'), qEl = el('entBoardQ'), mEl = el('entBoardM'), mixEl = el('entBoardMix'), sumEl = el('entBoardSum'), msg = el('entBoardMsg');
    var spec = currentSpec();
    if (!save || !qEl || !mEl || !mixEl || !spec) return;
    var say = function (text, isError) { if (msg) { msg.textContent = text || ''; msg.style.color = isError ? 'var(--danger)' : 'var(--text2)'; } };
    var current = { questions: 100, minutes: 120, mix: null };
    try { var all = await readBoard(); if (all[spec.id]) current = all[spec.id]; }
    catch (e) { say('Could not read the current settings: ' + friendly(e), true); }
    qEl.value = current.questions; mEl.value = current.minutes;
    var cats = {};
    try { (await db.getAllQuestions()).forEach(function (q) { var c = q.subject || 'Uncategorized'; cats[c] = (cats[c] || 0) + 1; }); } catch (e) { /* empty workspace */ }
    Object.keys(current.mix || {}).forEach(function (c) { if (!(c in cats)) cats[c] = 0; });
    var names = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a] || a.localeCompare(b); });
    mixEl.textContent = '';
    names.forEach(function (name) {
      var label = document.createElement('label');
      label.textContent = name + ' (' + cats[name] + ' questions)';
      var input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1'; input.inputMode = 'numeric';
      input.className = 'ent-board-pct'; input.setAttribute('data-cat', name); input.setAttribute('aria-label', 'Percent for ' + name);
      if (current.mix && current.mix[name]) input.value = current.mix[name];
      label.htmlFor = input.id = 'entBoardPct' + mixEl.children.length;
      mixEl.appendChild(label); mixEl.appendChild(input);
    });
    if (!names.length) mixEl.textContent = 'This workspace has no questions yet.';
    var total = function () {
      var sum = 0, any = false;
      Array.prototype.forEach.call(mixEl.querySelectorAll('.ent-board-pct'), function (i) { var v = Number(i.value); if (v) { sum += v; any = true; } });
      if (sumEl) { sumEl.textContent = any ? 'Total: ' + sum + '%' + (Math.abs(sum - 100) > 0.01 ? ' (must be 100%)' : '') : 'No percentages: the questions are spread like your bank.'; sumEl.style.color = any && Math.abs(sum - 100) > 0.01 ? 'var(--danger)' : 'var(--text2)'; }
    };
    mixEl.addEventListener('input', total); total();
    save.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var mix = {};
      Array.prototype.forEach.call(mixEl.querySelectorAll('.ent-board-pct'), function (i) { if (Number(i.value)) mix[i.getAttribute('data-cat')] = Number(i.value); });
      save.disabled = true;
      try {
        var out = await writeBoard(spec.id, { questions: qEl.value, minutes: mEl.value, mix: mix });
        say('Saved: ' + out.questions + ' questions in ' + out.minutes + ' minutes' + (out.mix ? ', with your category shares.' : ', spread like the bank.') + ' Students see it within a few hours.');
      } catch (e) { say('Could not save: ' + friendly(e), true); }
      finally { save.disabled = false; }
    });
  }

  /* ------------------------------------------------------------------ overview (statistics) */

  function overviewCardHTML() {
    return '<div class="card" id="entOverviewCard"><div class="card-header">Overview</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">Students, activity and income at a glance. The numbers are read when you press the button (one read per account).</p>' +
      '<select id="entOverviewSpec" aria-label="Specialty" style="margin-bottom:8px;"></select>' +
      '<button class="btn btn-outline btn-block" id="btnOverviewLoad">Load overview</button>' +
      '<div id="entOverviewBody" style="margin-top:10px;"></div>' +
      '<div id="entOverviewMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  // Pure calculation, so it can be tested: accounts + payments -> the numbers of the Overview card.
  function overviewOf(list, pays, now) {
    now = now || Date.now();
    var DAY = 86400000;
    var monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    var lastMonthStart = new Date(monthStart); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    var out = { total: list.length, active: 0, free: 0, expired: 0, newWeek: 0, seen7: 0, seen30: 0, plans: {}, ending: [],
      incomeThisMonth: 0, incomeLastMonth: 0, paymentsThisMonth: 0, paymentsLastMonth: 0 };
    list.forEach(function (a) {
      var st = accessOf(a).kind;
      out[st]++;
      if (a.createdAt && now - a.createdAt < 7 * DAY) out.newWeek++;
      if (a.lastSeenAt && now - a.lastSeenAt < 7 * DAY) out.seen7++;
      if (a.lastSeenAt && now - a.lastSeenAt < 30 * DAY) out.seen30++;
      if (st === 'active') {
        out.plans[a.plan] = (out.plans[a.plan] || 0) + 1;
        if (a.expiresAt - now <= 7 * DAY) out.ending.push(a);
      }
    });
    out.ending.sort(function (x, y) { return x.expiresAt - y.expiresAt; });
    var uids = {}; list.forEach(function (a) { uids[a.uid] = 1; });
    (pays || []).forEach(function (p) {
      if (p.status !== 'Activated' || p.env !== 'live' || !p.activatedAt || !uids[p.uid]) return;
      if (p.activatedAt >= monthStart.getTime()) { out.incomeThisMonth += p.amount; out.paymentsThisMonth++; }
      else if (p.activatedAt >= lastMonthStart.getTime()) { out.incomeLastMonth += p.amount; out.paymentsLastMonth++; }
    });
    return out;
  }

  function renderOverview() {
    var body = el('entOverviewBody');
    if (!body) return;
    var specSel = el('entOverviewSpec');
    var sid = specSel ? specSel.value : 'all';
    var list = accounts.filter(function (a) { return sid === 'all' || a.specialtyId === sid; });
    var o = overviewOf(list, payments);
    var money = function (n) { return Number(n).toLocaleString('en-US') + ' IQD'; };
    var tile = function (value, label, id) { return '<div class="stat-card"' + (id ? ' id="' + id + '"' : '') + '><div class="stat-value">' + esc(String(value)) + '</div><div class="stat-label">' + esc(label) + '</div></div>'; };
    var plans = Object.keys(o.plans).sort().map(function (k) { return esc(k) + ': ' + o.plans[k]; }).join(' · ');
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;">' +
      tile(o.total, 'Students', 'ovTotal') + tile(o.active, 'Subscribed', 'ovActive') + tile(o.free, 'Free version', 'ovFree') + tile(o.expired, 'Expired', 'ovExpired') +
      tile(o.newWeek, 'New this week', 'ovNew') + tile(o.seen7, 'Opened in 7 days', 'ovSeen7') + tile(o.seen30, 'Opened in 30 days', 'ovSeen30') + '</div>' +
      '<div id="ovIncome" style="margin:12px 0 4px;font-size:0.9rem;"><b>Income (online payments):</b> this month ' + money(o.incomeThisMonth) + ' (' + o.paymentsThisMonth + '), last month ' + money(o.incomeLastMonth) + ' (' + o.paymentsLastMonth + ').</div>' +
      (plans ? '<div id="ovPlans" style="font-size:0.84rem;color:var(--text2);">Active subscriptions by plan: ' + plans + '</div>' : '') +
      '<div style="font-weight:700;margin:14px 0 6px;">Ending within 7 days (' + o.ending.length + ')</div><div id="ovEnding"></div>';
    body.innerHTML = html;
    var endBox = el('ovEnding');
    if (!o.ending.length) { endBox.textContent = 'No subscription ends this week.'; endBox.style.cssText = 'font-size:0.84rem;color:var(--text2);'; return; }
    o.ending.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'ent-ov-ending';
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;font-size:0.86rem;';
      var days = Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 86400000));
      var text = document.createElement('span');
      text.style.flex = '1';
      text.textContent = a.identifier + ' · ' + (specLabel(a.specialtyId, a.specialtyName) || '') + ' · ends ' + fmtDay(a.expiresAt) + ' (' + days + (days === 1 ? ' day' : ' days') + ')';
      row.appendChild(text);
      var wa = whatsappLink(a.phone);
      if (wa && a.contactConsent) {
        var link = document.createElement('a');
        link.className = 'btn btn-sm btn-success'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.style.textDecoration = 'none';
        link.href = wa + '?text=' + encodeURIComponent('Hello, this is Adam QBank. Your subscription (' + a.identifier + ') ends on ' + fmtDay(a.expiresAt) + '. You can renew from the app: Subscribe.');
        link.textContent = 'WhatsApp reminder';
        row.appendChild(link);
      } else {
        var none = document.createElement('span');
        none.style.color = 'var(--text-muted)'; none.textContent = 'no mobile number';
        row.appendChild(none);
      }
      endBox.appendChild(row);
    });
  }

  function wireOverview() {
    var btn = el('btnOverviewLoad'), sel = el('entOverviewSpec'), msg = el('entOverviewMsg');
    if (!btn || !sel) return;
    var specs = (window.EntRegistry ? window.EntRegistry.list() : []);
    sel.innerHTML = '<option value="all">All specialties</option>' + specs.map(function (sp) { return '<option value="' + esc(sp.id) + '">' + esc(sp.name) + '</option>'; }).join('');
    sel.addEventListener('change', function () { if (accounts.length) renderOverview(); });
    btn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      btn.disabled = true;
      try {
        if (msg) msg.textContent = 'Loading accounts...';
        await loadAccounts(function (t) { if (msg) msg.textContent = t; });
        try { await loadPayments(); } catch (e) { /* no payments yet, or the rules without payments: income shows 0 */ }
        renderOverview();
        renderAccounts();
        if (msg) msg.textContent = 'Updated ' + new Date().toLocaleTimeString() + '.';
      } catch (e) {
        if (msg) { msg.textContent = 'Could not load the overview: ' + friendly(e); msg.style.color = 'var(--danger)'; }
      } finally { btn.disabled = false; }
    });
  }

  function scopeMsg(text, isError) {
    var node = el('entScopeMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  async function wireScope() {
    var save2 = el('btnScopeSave');
    if (!save2) return;
    var radios = document.querySelectorAll('input[name="entScope"]');
    try {
      var current = await readAccess();
      Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === current.scope; });
    } catch (e) { scopeMsg('Could not read the current settings: ' + friendly(e), true); }
    save2.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var chosen = Array.prototype.filter.call(radios, function (r) { return r.checked; })[0];
      if (!chosen) return scopeMsg('Choose one option.', true);
      save2.disabled = true;
      try {
        await writeScope(chosen.value, 0);
        scopeMsg('Saved: ' + (chosen.value === 'all' ? 'subscriptions cover all specialties.' : 'subscriptions cover the student\'s own specialty.'));
      }
      catch (e) { scopeMsg('Could not save: ' + friendly(e), true); }
      finally { save2.disabled = false; }
    });
  }

  function freeCardHTML() {
    var max = (window.ENT_FREE_SAMPLE && window.ENT_FREE_SAMPLE.max) || 250;
    return '<div class="card" id="entFreeCard"><div class="card-header">Free version (students without a subscription)</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);margin-bottom:8px;">The questions marked <b>Free</b> are what every student of this specialty sees without a subscription: right after signing up, without a plan, and after a plan ends. ' +
      'Choose them here or with the <b>Free</b> button on each question, then publish them. This does not touch the full bank.</p>' +
      '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;margin:0 0 10px;font-size:0.9rem;">Marked Free now: <b id="entFreeCount">…</b> / ' + max +
      '<br><span style="font-size:0.8rem;color:var(--text2);">Last published: <span id="entFreeLast">…</span></span></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">' +
      '<button class="btn btn-outline" id="btnFreeAuto">Auto-select ' + max + '</button>' +
      '<button class="btn btn-outline" id="btnFreeChoose">Choose in Questions</button>' +
      '<button class="btn btn-outline" id="btnFreeClear">Clear all Free</button></div>' +
      '<button class="btn btn-primary btn-block" id="btnFreePublish">Publish free version</button>' +
      '<div id="entFreeMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  async function fillFreeCard() {
    var countEl = el('entFreeCount'), lastEl = el('entFreeLast');
    if (!countEl) return;
    try { countEl.textContent = String((await db.getAllQuestions()).filter(function (q) { return q.isFree === true; }).length); } catch (e) { countEl.textContent = '?'; }
    var spec = currentSpec();
    if (!lastEl || !spec) return;
    var local = load(freeInfoKey(spec.id));
    try {
      var meta = await readMeta(await token(), spec.id, 'freepacks');
      if (!meta) lastEl.textContent = 'never (students without a subscription see no questions yet)';
      else lastEl.textContent = meta.questions + ' question(s)' + (meta.updatedAt ? ', ' + new Date(meta.updatedAt).toLocaleString() : '');
    } catch (e) {
      lastEl.textContent = local ? local.questions + ' question(s), ' + new Date(local.updatedAt).toLocaleString() + ' (from this device)' : 'unknown (offline)';
    }
  }

  function freeMsg(text, isError) {
    var node = el('entFreeMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function wireFreeCard() {
    if (!el('entFreeCard')) return;
    fillFreeCard();
    var auto = el('btnFreeAuto'), choose = el('btnFreeChoose'), clear = el('btnFreeClear'), pub = el('btnFreePublish');
    if (auto) auto.addEventListener('click', async function () { if (window.autoSelectFree) await window.autoSelectFree(); fillFreeCard(); });
    if (clear) clear.addEventListener('click', async function () { if (window.clearAllFree) await window.clearAllFree(); fillFreeCard(); });
    if (choose) choose.addEventListener('click', function () {
      try { if (window.AppState && AppState.questionFilters) AppState.questionFilters.special = 'all'; } catch (e) { /* ignore */ }
      if (typeof navigateTo === 'function') navigateTo('questions');
    });
    if (pub) pub.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var cur = currentSpec();
      if (!cur) return freeMsg('Open a specialty workspace first.', true);
      var n = 0;
      try { n = (await db.getAllQuestions()).filter(function (q) { return q.isFree === true; }).length; } catch (e) { n = 0; }
      var ok = window.confirm('Publish the free version of ' + cur.name + '?\n\n    ' + n + ' question(s) marked Free\n\n' +
        (n ? 'Every ' + cur.name + ' student without a subscription will see exactly these questions (questions you unmarked disappear for them). ' : 'Nothing is marked Free: students without a subscription will see no questions. ') +
        'The full bank for subscribers is not changed.\n\nContinue?');
      if (!ok) return;
      pub.disabled = true;
      try {
        var r = await publishFreeVersion(function (t) { freeMsg(t); });
        freeMsg('Free version published: ' + r.questions + ' question(s). Students get it the next time they open the app.');
        if (typeof showToast === 'function') showToast(cur.name + ' free version published.', 'success');
        fillFreeCard();
      } catch (e) {
        if (e.code === 'NOT_SIGNED_IN') { signOut(); rerender(); }
        freeMsg('Publish failed: ' + friendly(e), true);
        console.error('Free version publish error', e);
      } finally { pub.disabled = false; }
    });
  }

  function migrationCardHTML() {
    return '<div class="card"><div class="card-header">ENT migration check</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">If this project already served ENT students before specialties, run the check to see which one-time steps are still open. Nothing is changed by the check.</p>' +
      '<button class="btn btn-outline btn-block" id="btnMigCheck">Run check</button>' +
      '<div id="entMigResult" style="margin-top:10px;font-size:0.85rem;"></div></div>';
  }

  async function runMigrationCheck() {
    var box = el('entMigResult');
    if (!box) return;
    box.textContent = 'Checking...';
    var tk = await token();
    var rows = [];
    function row(ok, text) { rows.push('<div style="margin:4px 0;">' + (ok ? '✅ ' : '⬜ ') + esc(text) + '</div>'); }
    var specDoc = null, entPack = null, mainPack = null, scope = 'selected';
    try { specDoc = parseSpecialtyDoc(await request(FS + '/specialties/' + Core.LEGACY_SPECIALTY_ID, { headers: authHeaders(tk) })); } catch (e) { if (e.status !== 404) throw e; }
    entPack = await readMeta(tk, Core.LEGACY_SPECIALTY_ID);
    mainPack = await readMeta(tk, LEGACY_PACK_ID);
    try { scope = await readScope(); } catch (e) { /* default */ }
    row(!!specDoc, specDoc ? 'ENT exists in the cloud specialty list (status: ' + specDoc.status + ').' : 'ENT is not in the cloud specialty list yet → open Specialties and tap "Sync list to cloud".');
    row(!!entPack, entPack ? 'ENT bank published at packs/ent (' + entPack.questions + ' questions, version ' + entPack.version + ').' : 'ENT bank is not published at packs/ent yet → open the ENT workspace and publish it.');
    row(!!mainPack, mainPack ? 'The old packs/main copy exists (' + mainPack.questions + ' questions), so students on app 1.3.x still work.' : 'No old packs/main copy. Fine if every student has updated to 1.4.0; otherwise publish ENT with "also update the legacy copy".');
    if (accountsLoadedAt) {
      var n = accounts.filter(function (a) { return !a.specialtyId; }).length;
      row(n === 0, n ? n + ' student account(s) still have no specialty → use "Assign ... to ENT" in Student accounts.' : 'Every loaded student account has a specialty.');
    } else {
      row(false, 'Student accounts not loaded yet → tap "Load accounts" to count the ones without a specialty.');
    }
    row(true, 'Subscription scope: ' + (scope === 'all' ? 'all specialties' : 'the student\'s own specialty') + '. New students start on the free version (no trial).');
    box.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ UI */

  function fmtBytes(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function cardHTML() {
    var head = '<div class="card"><div class="card-header">Cloud (Firebase)</div>';
    if (!CONFIGURED) {
      return head + '<p style="font-size:0.85rem;color:var(--text2);">Firebase is not set up yet. Fill in <code>firebase-config.js</code> first (see FIREBASE-SETUP.md).</p></div>';
    }
    var s = load(SESSION_KEY);
    if (!s) {
      return head +
        '<p style="font-size:0.85rem;color:var(--text2);">Sign in with your admin account to publish question banks to subscribers.</p>' +
        '<label class="modal-field">Email<input type="email" id="entCloudEmail" autocomplete="username" autocapitalize="none" spellcheck="false"></label>' +
        '<label class="modal-field">Password<input type="password" id="entCloudPassword" autocomplete="current-password"></label>' +
        '<button class="btn btn-primary btn-block mt-2" id="btnCloudSignIn">Sign in</button>' +
        '<div id="entCloudMsg" style="margin-top:10px;font-size:0.82rem;color:var(--text2);"></div></div>';
    }
    var spec = currentSpec() || { id: '?', name: '?' };
    var info = load(infoKey(spec.id));
    var last = info
      ? 'Last published from this device: <b id="entCloudLast"></b>'
      : 'Nothing published for this specialty from this device yet.';
    var mirror = spec.id === Core.LEGACY_SPECIALTY_ID
      ? '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:0.82rem;"><input type="checkbox" id="entCloudMirror" checked> <span>Also update the old ENT location (<code>packs/main</code>) so students still on app 1.3.x keep working. Untick once everyone has updated.</span></label>'
      : '';
    return head +
      '<p style="font-size:0.85rem;color:var(--text2);margin-bottom:6px;">Signed in as <b id="entCloudWho"></b></p>' +
      '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--primary-soft);margin:8px 0;font-size:0.88rem;">' +
      'Publishing target: <b id="entCloudSpecName"></b> <code id="entCloudSpecId"></code><br><span style="color:var(--text2);">Goes to <code>packs/' + esc(spec.id) + '</code>. Only this specialty\'s questions are included.</span></div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">' + last + '</p>' +
      '<p style="font-size:0.8rem;color:var(--text-muted);">Publishes <b>all</b> current content of this specialty for <b>subscribers</b>. Students of this specialty with an active subscription download it automatically. The free version is chosen and published separately, in the <b>Free version</b> card below.</p>' +
      mirror +
      '<button class="btn btn-accent btn-block mt-2" id="btnCloudPublish">Publish ' + esc(spec.name) + ' question bank</button>' +
      '<button class="btn btn-outline btn-block mt-2" id="btnCloudSignOut">Sign out</button>' +
      '<div id="entCloudMsg" style="margin-top:10px;font-size:0.82rem;color:var(--text2);"></div></div>' +
      freeCardHTML() + boardCardHTML() + overviewCardHTML() + accessCardHTML() + devicesCardHTML() + accountsCardHTML() + reportsCardHTML() + migrationCardHTML();
  }

  function setMsg(text, isError) {
    var node = el('entCloudMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function rerender() {
    try { if (typeof navigateTo === 'function') navigateTo('settings'); } catch (e) { /* ignore */ }
  }

  function wire() {
    var s = load(SESSION_KEY);
    var who = el('entCloudWho');
    if (who && s) who.textContent = s.email;
    var spec = currentSpec();
    if (spec) {
      var nm = el('entCloudSpecName'), idn = el('entCloudSpecId');
      if (nm) nm.textContent = spec.name;
      if (idn) idn.textContent = spec.id;
    }
    var last = el('entCloudLast');
    var info = spec ? load(infoKey(spec.id)) : null;
    if (last && info) {
      last.textContent = info.version + ' - ' + info.questions + ' questions, ' + fmtBytes(info.gzBytes) +
        ' (' + new Date(info.updatedAt).toLocaleString() + ')';
    }

    var signInBtn = el('btnCloudSignIn');
    if (signInBtn) signInBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var email = el('entCloudEmail').value;
      var password = el('entCloudPassword').value;
      if (!email || !password) return setMsg('Enter your email and password.', true);
      signInBtn.disabled = true;
      setMsg('Signing in...');
      try { await signIn(email, password); rerender(); }
      catch (e) { setMsg(friendly(e), true); signInBtn.disabled = false; }
    });

    var outBtn = el('btnCloudSignOut');
    if (outBtn) outBtn.addEventListener('click', function () { signOut(); rerender(); });
    wireFreeCard();
    wireOverview();
    wireDevicesCard();
    wireBoardCard();

    var pubBtn = el('btnCloudPublish');
    if (pubBtn) pubBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      if (busy) return;
      var cur = currentSpec();
      if (!cur) return setMsg('Open a specialty workspace first.', true);
      var count = 0;
      try { count = (await db.getAllQuestions()).length; } catch (e) { count = 0; }
      var mirrorBox = el('entCloudMirror');
      var mirror = !!(mirrorBox && mirrorBox.checked);
      var scope = 'selected';
      try { scope = await readScope(); } catch (e) { /* shown below as the default */ }
      // Students' devices follow the published bank exactly: what is not in it any more is removed there. A smaller bank
      // than the published one is therefore pointed out, in case this device does not hold the whole bank.
      var published = 0;
      try { var lastMeta = await readMeta(await token(), cur.id); published = lastMeta && lastMeta.questions ? Number(lastMeta.questions) : 0; } catch (e) { published = 0; }
      var fewer = published > count ? published - count : 0;
      var ok = window.confirm('Publish this specialty?\n\n' +
        '    ' + cur.name + '   (ID: ' + cur.id + ')\n' +
        '    ' + count + ' question(s) from this workspace\n\n' +
        (fewer ? 'ATTENTION: the bank published now has ' + published + ' question(s), this one has ' + count + '. The ' + fewer + ' question(s) that are no longer here will be REMOVED from students\' devices. ' +
          'If you did not delete or merge them on purpose (for example this device does not hold your whole bank), press Cancel.\n\n' : '') +
        'It will REPLACE the bank that ' + cur.name + ' students download (packs/' + cur.id + (mirror ? ' and the old packs/main' : '') + '): questions you deleted or merged disappear for students too. The free version is not changed (it has its own Publish button). Other specialties are not touched.\n' +
        'Subscription scope: ' + (scope === 'all' ? 'all specialties' : 'the student\'s own specialty') + '.\n\nContinue?');
      if (!ok) return;
      busy = true;
      pubBtn.disabled = true;
      try {
        var info2 = await publish(function (t) { setMsg(t); }, { legacyMirror: mirror });
        setMsg('Published ' + info2.specialtyName + ' ' + info2.version + ': ' + info2.questions + ' questions, ' + fmtBytes(info2.gzBytes) +
          ' in ' + info2.chunkCount + ' part(s)' + (info2.legacyMirror ? ' (and the legacy ENT copy)' : '') + '.' +
          (info2.partial ? ' Students who have the previous version download only the changes: ' + fmtBytes(info2.partial.gzBytes) + ' (' + info2.partial.changed + ' new or corrected, ' + info2.partial.removed + ' removed).' : ''));
        if (typeof showToast === 'function') showToast(info2.specialtyName + ' question bank published.', 'success');
        var lastEl = el('entCloudLast');
        if (lastEl) lastEl.textContent = info2.version + ' - ' + info2.questions + ' questions, ' + fmtBytes(info2.gzBytes);
      } catch (e) {
        if (e.code === 'NOT_SIGNED_IN') { signOut(); rerender(); }
        setMsg('Publish failed: ' + friendly(e), true);
        console.error('Cloud publish error', e);
      } finally {
        busy = false;
        pubBtn.disabled = false;
      }
    });

    var mig = el('btnMigCheck');
    if (mig) mig.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      mig.disabled = true;
      try { await runMigrationCheck(); } catch (e) { var box = el('entMigResult'); if (box) box.textContent = 'Check failed: ' + friendly(e); }
      finally { mig.disabled = false; }
    });

    wireScope();
    wireAccounts();
    wireReports();
  }

  window.EntCloudAdmin = {
    cardHTML: cardHTML, wire: wire, publish: publish, publishFreeVersion: publishFreeVersion, overviewOf: overviewOf, readDevices: readDevices, writeDeviceLimits: writeDeviceLimits, readBoard: readBoard, writeBoard: writeBoard, signIn: signIn, signOut: signOut, isSignedIn: isSignedIn,
    isConfigured: CONFIGURED, friendly: friendly,
    syncSpecialties: syncSpecialties, pullSpecialties: pullSpecialties, readScope: readScope, writeScope: writeScope,
    loadAccounts: loadAccounts,
    loadReports: loadReports,
    setPageSize: function (n) { pageSize = n; }
  };
})();
