# Adam QBank 1.4.0 — Admin app

Multi-specialty medical question-bank platform. This folder is the **Admin app**. Its companion is the
**Student app** (`Adam-QBank-Student-v1.4.0`). Both are plain static files (no build step) that talk to one
Firebase project over REST (Authentication + Firestore). Both were Adam ENT 1.3.0; ENT is now simply one specialty.

| You want to… | Read |
|---|---|
| Set up Firebase, rules, config files, first admin | [FIREBASE-SETUP.md](FIREBASE-SETUP.md) (عربي: [FIREBASE-SETUP-AR.md](FIREBASE-SETUP-AR.md)) |
| Upgrade an existing Adam ENT 1.3.x installation | [MIGRATION.md](MIGRATION.md) |
| Run / change the security rules and their tests | [firebase/README.md](firebase/README.md) |

No credential, key or secret is shipped in this package. `firebase-config.js` is empty; you fill it in.

---

## 1. The model

```
Specialty  ->  Category  ->  Section  ->  Question
 (ENT)         (Otology)     (Hearing tests)
```

* Every question belongs to **exactly one** specialty, category and section.
* A specialty has a **stable id** (`ent`, `dermatology`, …; 3–40 chars, lowercase letters, digits and hyphens,
  starts with a letter, never changes), a display **name**, an optional description and a **status**:
  `active` (students can register and read), `inactive` (closed for now), `archived` (closed and read-only in the admin).
  Specialties are never deleted.
* Categories and sections are stored per specialty. In question rows the older field names are kept for compatibility:
  `subject` = category name, `chapter` = section name, `subjectId` / `chapterId` = their ids.
* ENT keeps its built-in classic tree (Otology, Rhinology, … with the same ids as before). A new specialty starts empty.

## 2. Admin app

**Workspaces.** The admin works in one specialty at a time. Each specialty has its own local database
(ENT keeps `ENTQuestionBank`, the others use `ENTAdminBank::<id>`), so questions, categories, sections, backups,
imports, exports, free selection and reports can never be mixed. The open specialty is shown in the header chip and in a
banner; tap the chip to switch specialty. An archived specialty opens read-only.

**Specialties** (tap the chip → Specialties): create, edit name/description, activate, deactivate, archive, restore,
reorder, open its workspace, and **Sync list to cloud** (publishes the list of specialties to Firestore; students can only
register into an `active` one). Use *Pull list from cloud* to load the list on a new device.

**Categories & sections** (Specialties → *Categories & sections*): add, rename, reorder, move a section to another
category, archive/restore, delete when unused. Renaming rewrites the questions that use the old name.
Questions keep their creation order inside a section; move a question with *Reclassify* in the Questions list.

**Import / export.**
* Export (Settings → *Update package*) builds a `.qbpkg` file for the open specialty. The card shows the specialty and asks
  you to confirm it before the file is created. ENT also offers *Compatible with app 1.3.x* so students still on 1.3.x can read it.
* Import accepts `.qbpkg` (also `.entpkg`, `.zip`, `.json`). A package of another specialty is **refused as a whole**.
  A v1 package without a specialty is treated as ENT.
* Backups record their specialty and refuse to restore into another one.

**Free questions.** Mark questions *Free* in the Questions list (the counter shows `N / 250`; **100–250 recommended, 250 is the
hard limit**: the 251st cannot be marked and a free pack with more than 250 is not exported). Then Settings →
*Export <Specialty> Free Pack* and put the file in `free-packs/<specialtyId>.qbpkg` next to the Student app's `index.html`
(ENT may also keep the old `free-pack.entpkg`). The Free marks also travel inside the published bank, so republish after you change them.
These are the only questions a student keeps after the free trial, until they subscribe (see *Free trial* below).

**Cloud publishing** (Settings → *Cloud (Firebase)*): sign in with your admin e-mail, open the specialty, press
*Publish <Specialty> question bank*. The confirm dialog names the specialty. It writes `packs/<specialtyId>` and refuses to
overwrite a pack that belongs to another specialty (`CROSS_SPECIALTY`). For ENT you can also refresh the old
`packs/main` copy so students still on 1.3.x keep working.

**Subscription scope & free trial** (Settings → *Subscription scope & free trial*): `selected` (default) — a subscriber reads only the bank of the
specialty on their account; `all` — an active subscription opens every active specialty. Below it, **Free trial for new students (days)**
(default 5, `0` = no trial). Enforced by the rules, not just the UI.

**Free trial.** Every new student account gets the full app for `trialDays` days, counted from the moment the account is created
(the time is written by the Firebase server, not by the phone). When the trial ends the student keeps their progress but only
sees the questions you marked *Free* until you activate a subscription. During the trial the student downloads the full bank
(the rules treat a running trial like a paid plan). Existing accounts are not given a new trial: an account older than the trial length
simply has none; an account without a creation time (created by a very old version) has none. For one student use
*Student accounts → Start trial* (N days from today) or *End trial*; *Stop* ends both the subscription and the trial.

**Student accounts** (Settings → *Student accounts*): shows each student's specialty and access (Active / Free trial N days left / Expired / Free),
filters by specialty, extends or stops a subscription, starts or ends a free trial, changes a student's specialty, approves/declines a student's change request, and (for the migration)
*Assign the N account(s) with no specialty to ENT*.

**Reports** (Settings → *Question reports*): each report shows its specialty; filter by specialty; *Show question* jumps to the
right workspace.

**Admin mode and the passcode.** Version 1.3.0 shipped a fixed password inside `app.js`. It was removed. The first time you
unlock Admin mode the app asks you to choose a passcode (at least 8 characters) for that device; only a salted PBKDF2 hash is
stored. This only hides the admin screens on the device. The real protection is the Firestore rules plus `admins/{uid}`.

### Students' mobile numbers (Admin app)
Settings → *Student accounts* → *Load accounts*: each account shows its mobile number (`0770 123 4567`) and a green **WhatsApp** button that opens a chat
with that student (`wa.me`). Accounts without a number say *Mobile: not added yet*. The search box also finds accounts by number (local `0770...` or
international `964...`), and the summary counts how many accounts have a number. Students give the number at registration with their consent to be
contacted on WhatsApp about their account; older accounts are asked once. Use it only for that, and remember that whatever you send on WhatsApp is outside
the app (allowed by Google Play's policy), but the Google Play listing and the app itself must not point students to paying outside Google Play.

### Renaming a book (Admin app)

*Import & Export* → **Rename a Book** (next to *Delete One Book*): pick the book, type the new name, confirm. The name is changed in every question
(`book` and `group`), every lecture and every book entry of the book in the open specialty; extra spaces are tidied. If the new name already belongs to
another book (capitals ignored) the two books are **merged** under the existing spelling. Changed records get a new `updatedAt`, so the next update
package or published pack carries the new name: export / sync an update afterwards so students receive it. It works only in Admin mode and not in an
archived (read-only) specialty.

## 3. Student app (summary)

* Registration: username or e-mail + password + **one active specialty** (list loaded from Firestore, no hard-coded list).
* Everything is filtered by the account's specialty: categories, sections, questions, search, bookmarks, notes, exam mode,
  progress, free questions, reports, imported / downloaded / local data. Data is stored per student **and** specialty.
* The specialty is shown in the header and in Settings. Changing it is never silent: the student sends a request, the admin
  approves it (or changes it directly), the page reloads into the other scope, and the old scope's data stays untouched.
* A specialty that is inactive, archived or deleted shows a clear "unavailable" screen. The student is not moved and nothing
  is deleted; the bank returns as soon as the specialty is active again.
* Free trial: right after registration the student has the full app for the trial length (a bar shows the days left and a *Subscribe*
  button). Afterwards only the Free questions stay open; progress, bookmarks and notes are kept and everything returns when a plan is activated.
* Works offline after the first sign-in, as before.
* Google Play: the student app can be published as an Android app (see the separate `Adam-QBank-GooglePlay-Kit`). It adds in-app **Delete account**,
  public privacy / terms / delete-account pages and a "Play mode" that hides every Subscribe / WhatsApp / payment prompt inside the Play build.
  This needs the current `firebase/firestore.rules` (students may delete their own account document and reports). Read the kit's
  `PAYMENTS-AND-POLICY-NOTES.md` before deciding to publish a subscription app on Play.

## 4. Package format v2 (`.qbpkg`)

A zip file: `manifest.json`, `database.json`, optional `assets/`.

```jsonc
// manifest.json
{ "schemaVersion": 2,
  "specialty": { "id": "dermatology", "name": "Dermatology" },
  "packageVersion": "2026.11.05.1", "minAppVersion": "1.4.0",
  "sha256": "<hash of database.json>", "counts": { "questions": 120 } }
// database.json
{ "specialtyId": "dermatology",
  "taxonomyV2": { "categories": [ { "id": "...", "name": "...", "sections": [ { "id": "...", "name": "..." } ] } ] },
  "taxonomy": { /* legacy map, kept for old readers */ },
  "questions": [ { "uid": "...", "specialtyId": "dermatology", "subjectId": "...", "chapterId": "...", "...": "..." } ] }
```

Validation on import: schema version, SHA-256, `specialtyId` equals the account/workspace specialty, every item names the same
specialty (or none, for v1), no duplicate uids, every question points to a category and section that exist in the package
tree. Any failure rejects the **whole** package before anything is written. ENT packages built with *Compatible with app 1.3.x* set
`minAppVersion` to 1.2.7 so unchanged 1.3.x students can import them (that app ignores unknown fields).

## 5. Firestore layout

| Path | Content | Who writes |
|---|---|---|
| `specialties/{id}` | id, name, description, status, sortOrder, schemaVersion | admin |
| `users/{uid}` | identifier, plan, expiresAt, `createdAt` (server time = trial start), **specialtyId**, specialtyName, specialtyAssignedBy, specialtyChangeRequest, admin-only `trialEndsAt`, `trialStopped` | student creates own (plan `none`, active specialty, `createdAt` = server time); student may only add a change request; admin does the rest |
| `packs/{specialtyId}` + `/chunks/*` | published bank | admin |
| `packs/main` | legacy ENT copy | admin |
| `settings/access` | `subscriptionScope` = `selected` \| `all`; `trialDays` (integer 0–365, default 5) | admin |
| `reports/{uid}_{questionUid}` | report with `specialtyId` | student creates (own specialty only), admin reads |
| `admins/{uid}` | membership marker | you, in the console |

The rules in `firebase/firestore.rules` enforce: a student reads only the pack of their own specialty (unless scope is `all`),
only while the subscription is active **or the free trial is running** and the specialty is `active`; students cannot change their plan, expiry or specialty;
reports must carry the student's own specialty; only admins publish and manage.

## 6. What needs the owner

Host the two apps on **different origins** (see FIREBASE-SETUP.md step 8); one shared origin makes them share browser storage.


See the checklist at the end of [FIREBASE-SETUP.md](FIREBASE-SETUP.md): create the Firebase project, enable Email/Password,
fill `firebase-config.js` (both apps) and `subscription-config.js` (student), publish the rules, add `admins/{uid}`, sign in
once to publish. Nothing in these zips can do that for you.

## 7. Honest limits of this release

* The security rules were written together with an automated test (`firebase/firestore-rules.test.js`) but that test needs the
  Firestore emulator, which could not be started where the code was produced. **Run `npm test` in `firebase/` before you publish the rules.**
* **The free trial is a convenience, not copy protection.** The server decides who may download the bank, but a student whose bank is already on the
  phone could set the phone's clock back, and someone can register a second account to get another trial. Switch the trial off (`0` days) if that matters more
  than the conversion benefit. The free pack is a public static file by design.
* **Rules must be republished** (and re-tested) when you move from the first 1.4.0 build to this one: they now know about `trialDays`, `createdAt` and the
  admin-only trial fields. Accounts created by 1.3.x can still read; they have no trial.
* Reordering is available for specialties, categories and sections. Questions keep their creation order.
* A browser-side check (headless Chromium with a mocked Firebase) covered registration, isolation, switching, blocked states,
  package gates, publishing, migration from 1.3.0 and offline reload. It does not replace a trial against your real project.
