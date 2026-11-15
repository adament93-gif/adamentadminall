/* Adam QBank - per-specialty category / section tree (identical in the Admin and Student apps).
 *
 *   Specialty -> Category -> Section -> Question
 *
 * The tree for the CURRENT specialty lives in the specialty's own database (settings key
 * "ent_taxonomy_v2"), so one specialty's categories can never show up in another one.
 *
 *  - Admin: edits it (Specialties -> Categories & sections) and ships it inside every package as
 *    database.taxonomyV2.
 *  - Student: receives it from the package of the student's own specialty.
 *  - ENT keeps its built-in Scott-Brown tree as the starting point (same IDs as before), until an
 *    administrator saves a changed tree. Other specialties start empty.
 *
 * Questions keep the field names subject (= category name) and chapter (= section name), plus
 * subjectId (= category id) and chapterId (= section id), so all existing filters, search and exam
 * code keep working.
 *
 * Loaded after app.js (it reads `db` and, for ENT, SCOTT_BROWN_TAXONOMY at call time).
 */
(function () {
  'use strict';

  var Core = window.EntSpecialtyCore;
  var KEY = 'ent_taxonomy_v2';
  var BASELINE_AT = '2000-01-01T00:00:00.000Z'; // marks the untouched built-in ENT tree
  var state = null;        // canonical tree saved in this database (or null)
  var baselineCache = null; // { forId, tree }
  var listeners = [];

  function specialtyId() {
    if (window.EntScope) return window.EntScope.specialtyId();
    if (window.EntWorkspace) return window.EntWorkspace.id();
    return null;
  }

  function isEnt() { return specialtyId() === Core.LEGACY_SPECIALTY_ID; }

  /** The built-in ENT tree, converted from SCOTT_BROWN_TAXONOMY with the same ids and numbering. */
  function fromScottBrown() {
    var src = typeof SCOTT_BROWN_TAXONOMY !== 'undefined' ? SCOTT_BROWN_TAXONOMY : [];
    var tax = Core.emptyTaxonomy(Core.LEGACY_SPECIALTY_ID);
    tax.updatedAt = BASELINE_AT;
    src.forEach(function (s, ci) {
      var cat = { id: s.subjectId, name: s.subject, description: '', order: ci, status: 'active', sections: [] };
      var order = 0;
      (s.chapters || []).forEach(function (c) {
        cat.sections.push({ id: c.chapterId, name: c.chapter, order: order++, status: 'active', number: c.chapterNumber });
      });
      (s.parts || []).forEach(function (p) {
        (p.chapters || []).forEach(function (c) {
          cat.sections.push({ id: c.chapterId, name: c.chapter, order: order++, status: 'active', number: c.chapterNumber, partId: p.partId });
        });
      });
      tax.categories.push(cat);
    });
    return tax;
  }

  function baseline() {
    var id = specialtyId();
    if (baselineCache && baselineCache.forId === id) return baselineCache.tree;
    var tree = isEnt() ? fromScottBrown() : Core.emptyTaxonomy(id || '');
    baselineCache = { forId: id, tree: tree };
    return tree;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function notify() { listeners.forEach(function (cb) { try { cb(get()); } catch (e) { console.error(e); } }); }

  /* ------------------------------------------------------------------ read */

  var loadedResolve;
  var loadedPromise = new Promise(function (r) { loadedResolve = r; });

  async function load() {
    state = null;
    try {
      var raw = await db.getSetting(KEY, null);
      if (raw) {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var tree = Core.normalizeTaxonomy(parsed, specialtyId());
        // A tree saved for another specialty is never used (cannot normally happen: databases are per specialty).
        if (!tree.specialtyId || tree.specialtyId === specialtyId()) state = tree;
      }
    } catch (e) { state = null; }
    loadedResolve();
    return get();
  }

  function get() { return state || baseline(); }
  function hasCustomTree() { return !!state; }
  /** True while the tree is still the untouched built-in ENT list (then the apps keep their classic alphabetical order). */
  function isBaseline() { return get().updatedAt === BASELINE_AT; }

  function index() { return Core.indexTaxonomy(get()); }

  /** Shape used by the classification code that was written for SCOTT_BROWN_TAXONOMY. */
  function asScottBrownShape() {
    return get().categories.map(function (c) {
      var chapters = [], parts = new Map();
      c.sections.forEach(function (s) {
        var ch = { chapterId: s.id, chapterNumber: s.number != null ? s.number : null, chapter: s.name, status: s.status };
        if (s.partId) {
          if (!parts.has(s.partId)) parts.set(s.partId, { partId: s.partId, part: s.partId, chapters: [] });
          parts.get(s.partId).chapters.push(ch);
        } else chapters.push(ch);
      });
      return { subjectId: c.id, subject: c.name, pending: false, chapters: chapters, parts: parts.size ? Array.from(parts.values()) : null, status: c.status };
    });
  }

  /* ------------------------------------------------------------------ write */

  async function save(tree) {
    var clean = Core.normalizeTaxonomy(tree, specialtyId());
    clean.specialtyId = specialtyId() || clean.specialtyId;
    clean.updatedAt = new Date().toISOString();
    // renumber orders to be contiguous so reordering is stable
    clean.categories.forEach(function (c, ci) { c.order = ci; c.sections.forEach(function (s, si) { s.order = si; }); });
    var v = Core.validateTaxonomy(clean, specialtyId());
    if (!v.valid) { var err = new Error(v.errors[0]); err.details = v.errors; throw err; }
    await db.setSetting(KEY, JSON.stringify(clean));
    state = clean;
    notify();
    return clean;
  }

  /** Editable deep copy of the current tree (for the admin editor). */
  function draft() { return clone(get()); }

  /**
   * Applies the tree from a package. A full/free package replaces the saved tree when it is not older
   * than the one already here; an incremental package merges categories and sections by id.
   */
  async function applyFromPackage(incoming, opts) {
    opts = opts || {};
    if (!incoming || !Array.isArray(incoming.categories)) return { applied: false };
    var tree = Core.normalizeTaxonomy(incoming, specialtyId());
    if (tree.specialtyId && tree.specialtyId !== specialtyId()) throw new Error('The category list belongs to a different specialty.');
    var v = Core.validateTaxonomy(tree, specialtyId());
    if (!v.valid) throw new Error(v.errors[0]);
    var current = state;
    if (opts.incremental && current) {
      var byId = new Map(current.categories.map(function (c) { return [c.id, c]; }));
      tree.categories.forEach(function (c) {
        var have = byId.get(c.id);
        if (!have) { current.categories.push(c); return; }
        have.name = c.name; have.status = c.status; have.order = c.order; have.description = c.description;
        var secs = new Map(have.sections.map(function (s) { return [s.id, s]; }));
        c.sections.forEach(function (s) { if (secs.has(s.id)) Object.assign(secs.get(s.id), s); else have.sections.push(s); });
      });
      current.updatedAt = tree.updatedAt;
      var merged = Core.validateTaxonomy(current, specialtyId());
      if (!merged.valid) throw new Error(merged.errors[0]);
      tree = Core.normalizeTaxonomy(current, specialtyId());
    } else if (current && current.updatedAt && tree.updatedAt && tree.updatedAt < current.updatedAt) {
      return { applied: false, reason: 'older' };
    }
    tree.specialtyId = specialtyId();
    await db.setSetting(KEY, JSON.stringify(tree));
    state = tree;
    notify();
    return { applied: true, categories: tree.categories.length };
  }

  /**
   * Merges a legacy {category: [sections]} map (schema-1 package adopted by the administrator) into this specialty's tree.
   * Existing categories/sections are matched by name (case-insensitive); nothing is removed or renamed.
   */
  async function mergeLegacyMap(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return { categoriesAdded: 0, sectionsAdded: 0 };
    var tree = draft();
    var categoriesAdded = 0, sectionsAdded = 0;
    Object.keys(map).forEach(function (catName) {
      var n = Core.normalizeName(catName);
      if (!n) return;
      var cat = tree.categories.filter(function (c) { return Core.nameKey(c.name) === Core.nameKey(n); })[0];
      if (!cat) { try { cat = addCategory(tree, n); categoriesAdded++; } catch (e) { return; } }
      (Array.isArray(map[catName]) ? map[catName] : []).forEach(function (secName) {
        var sn = Core.normalizeName(secName);
        if (!sn || cat.sections.some(function (s) { return Core.nameKey(s.name) === Core.nameKey(sn); })) return;
        try { addSection(tree, cat.id, sn); sectionsAdded++; } catch (e) { /* skip a bad name */ }
      });
    });
    if (categoriesAdded || sectionsAdded) await save(tree);
    return { categoriesAdded: categoriesAdded, sectionsAdded: sectionsAdded };
  }

  /** The tree as it travels in a package (taxonomyV2) plus the legacy {category: [sections]} map. */
  function exportV2() {
    var t = clone(get());
    t.specialtyId = specialtyId();
    return t;
  }

  function exportLegacyMap() {
    var map = {};
    get().categories.forEach(function (c) { map[c.name] = c.sections.map(function (s) { return s.name; }); });
    return map;
  }

  /* ------------------------------------------------------------------ tree operations (pure, on a draft) */

  function findCategory(tree, id) { return tree.categories.filter(function (c) { return c.id === id; })[0] || null; }

  function findSection(tree, id) {
    for (var i = 0; i < tree.categories.length; i++) {
      var hit = tree.categories[i].sections.filter(function (s) { return s.id === id; })[0];
      if (hit) return { category: tree.categories[i], section: hit };
    }
    return null;
  }

  function addCategory(tree, name) {
    var n = Core.normalizeName(name);
    if (!n) throw new Error('Enter a category name.');
    if (tree.categories.some(function (c) { return Core.nameKey(c.name) === Core.nameKey(n); })) throw new Error('A category named "' + n + '" already exists.');
    var cat = { id: Core.newId('cat'), name: n, description: '', order: tree.categories.length, status: 'active', sections: [] };
    tree.categories.push(cat);
    return cat;
  }

  function addSection(tree, categoryId, name) {
    var cat = findCategory(tree, categoryId);
    if (!cat) throw new Error('That category no longer exists.');
    var n = Core.normalizeName(name);
    if (!n) throw new Error('Enter a section name.');
    if (cat.sections.some(function (s) { return Core.nameKey(s.name) === Core.nameKey(n); })) throw new Error('"' + cat.name + '" already has a section named "' + n + '".');
    var sec = { id: Core.newId('sec'), name: n, order: cat.sections.length, status: 'active' };
    cat.sections.push(sec);
    return sec;
  }

  function move(list, id, delta) {
    var i = list.findIndex(function (x) { return x.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    list.forEach(function (x, k) { x.order = k; });
    return true;
  }

  /* ------------------------------------------------------------------ classification files (Classification Guide) */

  var GENERIC_CATEGORY = ['', 'uncategorized', 'uncategorised', 'unclassified', 'غير مصنف', 'غير مصنفة'];

  /**
   * Reads a classification file:
   *  - the Classification Guide format (also what Settings -> Download Classification Guide writes):
   *      { classifications: [ { subject, chapters: [ { chapter, topics: [...] } ] } ] }
   *  - or this app's own tree: { categories: [ { name, sections: [ { name, topics? } ] } ] }
   * subject = category, chapter = section, topics = the topics of the section. "Uncategorized" is not a real category and
   * is skipped; "General" topics are built in. Returns { categories: [{ name, sections: [{ name, topics }] }], specialty,
   * source, counts: { categories, sections, topics }, warnings }. Throws a readable error for a file it cannot use.
   */
  function parseGuide(obj) {
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj.replace(/^\uFEFF/, '')); } catch (e) { throw new Error('This file is not valid JSON (' + e.message + ').'); }
    }
    if (!obj || typeof obj !== 'object') throw new Error('This file is empty.');
    var list, catName, secList, secName, topicList;
    if (Array.isArray(obj.classifications)) {
      list = obj.classifications; catName = 'subject'; secList = 'chapters'; secName = 'chapter'; topicList = 'topics';
    } else if (Array.isArray(obj.categories)) {
      list = obj.categories; catName = 'name'; secList = 'sections'; secName = 'name'; topicList = 'topics';
    } else {
      throw new Error('This file has no "classifications" list (subject / chapters / topics). Use a Classification Guide JSON file.');
    }
    var warnings = [], cats = [], byCat = new Map(), skipped = 0;
    list.forEach(function (c, ci) {
      if (!c || typeof c !== 'object') { warnings.push('Item ' + (ci + 1) + ' is not a category and was skipped.'); return; }
      var name = Core.normalizeName(c[catName]);
      if (GENERIC_CATEGORY.indexOf(Core.nameKey(name)) !== -1) { skipped++; return; }
      if (name.length > Core.LIMITS.itemName) { warnings.push('Category "' + name.slice(0, 40) + '..." is too long and was skipped.'); return; }
      var cat = byCat.get(Core.nameKey(name));
      if (!cat) { cat = { name: name, sections: [], _secs: new Map() }; byCat.set(Core.nameKey(name), cat); cats.push(cat); }
      else warnings.push('Category "' + name + '" appears twice; the two were combined.');
      (Array.isArray(c[secList]) ? c[secList] : []).forEach(function (s) {
        if (!s || typeof s !== 'object') return;
        var sn = Core.normalizeName(s[secName]);
        if (!sn) return;
        if (sn.length > Core.LIMITS.itemName) { warnings.push('A section of "' + name + '" is too long and was skipped.'); return; }
        var sec = cat._secs.get(Core.nameKey(sn));
        if (!sec) { sec = { name: sn, topics: [], _t: new Set() }; cat._secs.set(Core.nameKey(sn), sec); cat.sections.push(sec); }
        else warnings.push('Section "' + sn + '" appears twice in "' + name + '"; the two were combined.');
        (Array.isArray(s[topicList]) ? s[topicList] : []).forEach(function (t) {
          var tn = Core.normalizeName(t), tk = Core.nameKey(tn);
          if (!tn || tk === 'general' || sec._t.has(tk) || tn.length > Core.LIMITS.itemName) return;
          sec._t.add(tk); sec.topics.push(tn);
        });
      });
    });
    var counts = { categories: cats.length, sections: 0, topics: 0 };
    cats.forEach(function (c) {
      delete c._secs;
      if (c.sections.length > Core.LIMITS.sectionsPerCategory) throw new Error('"' + c.name + '" has more than ' + Core.LIMITS.sectionsPerCategory + ' sections.');
      c.sections.forEach(function (s) { delete s._t; counts.sections++; counts.topics += s.topics.length; });
    });
    if (!cats.length) throw new Error('This file has no categories to load.');
    if (cats.length > Core.LIMITS.categories) throw new Error('This file has more than ' + Core.LIMITS.categories + ' categories.');
    if (skipped) warnings.push('"Uncategorized" is not a real category and was skipped (questions using it stay for your review).');
    var spec = obj.specialty && typeof obj.specialty === 'object' ? { id: String(obj.specialty.id || ''), name: String(obj.specialty.name || '') } : null;
    var source = obj.sourceBook && obj.sourceBook.name ? String(obj.sourceBook.name) : '';
    return { categories: cats, specialty: spec, source: source, counts: counts, warnings: warnings };
  }

  /**
   * Puts a parsed classification file into a tree draft.
   *  merge   (default): keeps everything already there; adds the missing categories / sections and the missing topics.
   *  replace: the tree becomes exactly the file (in the file's order). Categories and sections whose names already exist
   *           keep their IDs, so questions stay linked to them.
   * Returns { categoriesAdded, sectionsAdded, topicsAdded }.
   */
  function applyGuide(tree, parsed, mode) {
    var out = { categoriesAdded: 0, sectionsAdded: 0, topicsAdded: 0 };
    var before = tree.categories.slice();
    function findByName(list, name) { return list.filter(function (x) { return Core.nameKey(x.name) === Core.nameKey(name); })[0] || null; }
    if (mode === 'replace') tree.categories = [];
    parsed.categories.forEach(function (pc) {
      var cat = findByName(tree.categories, pc.name);
      if (!cat) {
        var old = mode === 'replace' ? findByName(before, pc.name) : null;
        cat = old ? Object.assign({}, old, { name: pc.name, status: 'active', sections: [] }) : { id: Core.newId('cat'), name: pc.name, description: '', status: 'active', sections: [] };
        cat.order = tree.categories.length;
        tree.categories.push(cat);
        if (!old) out.categoriesAdded++;
        cat.__old = old;
      }
      pc.sections.forEach(function (ps) {
        var sec = findByName(cat.sections, ps.name);
        if (!sec) {
          var oldSec = cat.__old ? findByName(cat.__old.sections || [], ps.name) : null;
          sec = oldSec ? Object.assign({}, oldSec, { name: ps.name, status: 'active' }) : { id: Core.newId('sec'), name: ps.name, status: 'active' };
          sec.order = cat.sections.length;
          cat.sections.push(sec);
          if (!oldSec) out.sectionsAdded++;
        }
        var have = Array.isArray(sec.topics) ? sec.topics.slice() : [];
        var keys = new Set(have.map(Core.nameKey));
        ps.topics.forEach(function (t) { if (!keys.has(Core.nameKey(t))) { keys.add(Core.nameKey(t)); have.push(t); out.topicsAdded++; } });
        if (have.length) sec.topics = have;
      });
    });
    tree.categories.forEach(function (c) { delete c.__old; });
    return out;
  }

  /** Topics stored for a category / section (by name), without "General". */
  function topicsOf(categoryName, sectionName) {
    var cat = get().categories.filter(function (c) { return c.name === categoryName; })[0];
    var sec = cat && cat.sections.filter(function (s) { return s.name === sectionName; })[0];
    return sec && Array.isArray(sec.topics) ? sec.topics.slice() : [];
  }

  window.EntTaxonomy = {
    KEY: KEY, BASELINE_AT: BASELINE_AT, load: load, get: get, hasCustomTree: hasCustomTree, isBaseline: isBaseline, index: index, asScottBrownShape: asScottBrownShape,
    save: save, draft: draft, applyFromPackage: applyFromPackage, mergeLegacyMap: mergeLegacyMap, exportV2: exportV2, exportLegacyMap: exportLegacyMap,
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    whenLoaded: function () { return loadedPromise; },
    parseGuide: parseGuide, applyGuide: applyGuide, topicsOf: topicsOf,
    ops: { findCategory: findCategory, findSection: findSection, addCategory: addCategory, addSection: addSection, move: move },
    _fromScottBrown: fromScottBrown
  };
})();
