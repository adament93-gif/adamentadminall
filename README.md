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

**Classification file (15 Nov 2026).** A specialty's whole classification can be loaded from a Classification Guide JSON
(`{ classifications: [ { subject, chapters: [ { chapter, topics: [...] } ] } ] }`, the same format Settings → *Download Classification
Guide* writes): either when creating the specialty (*Classification file (optional)*; the workspace opens with it) or in *Categories &
sections* → *Upload classification file* (preview, then **Merge**: adds what is missing, or **Replace**: exactly the file, refused while
questions would lose their category/section). subject = category, chapter = section, topics are stored per section (used by the topic
list when editing a question and exported in the guide); "Uncategorized" is skipped. Question JSON imports are matched to these names:
small differences (capitals, spaces, punctuation, &/and) are corrected automatically, and names that do not exist are listed with
*Add the missing names to the classification*.

**Books and duplicates (15 Nov 2026).** A JSON book is imported in full: a question already present in **another** book is added for
this book too (its own record and uid); only a repeat inside the **same** book (same text + same set of options) is skipped.
Re-importing a book adds only what it is missing. *Remove Repeats Inside a Book* (admin dashboard) never deletes the copy in another book.

**Group B (16 Nov 2026; needs the new `firestore.rules`).**
*Devices*: `settings/access.maxDevices` (default 2) and `deviceSwapDays` (default 7) from the *Devices per account* card;
`devices/{uid}` = `{ ids, info, lastSwapAt }`; the rules allow adding while there is room and one replacement per
`deviceSwapDays`; the account row's *Devices* button reads it, *Reset devices* deletes it.
*Progress backup* (student `progress-sync.js`): `progress/{uid}/scopes/{specialtyId}` holds a gzip copy of the student's
answers, exam results, bookmarks, High Yield marks, streak and goal (`rev`, `hash`, `data` or `chunkCount` + `prefix` with
parts in `.../chunks`). Owner only (rules). Each sync is a three-way merge (last agreed copy, device, server): answers and
exams are unions, marks follow what the device added or removed, *Reset My Progress* stores `resetAt`.

*Changes-only package* (`buildDelta` / `uploadDelta` in `cloud-admin.js`, `applyPartial` in the student's
`subscription.js`): on Publish the admin downloads the currently published bank, compares item by item (fields and image
bytes, not the package stamp) and uploads the new and corrected items plus the removed uids as `packs/<id>/chunks/d<version>_NNNN`,
advertised by `deltaFrom`, `deltaPrefix`, `deltaChunks`, `deltaSha`, `uidDigest` in `packs/<id>`. A student whose device is an
exact copy of `deltaFrom` installs it and checks its question list against `uidDigest`; anything else (new device, older
version, failed check, changes larger than 60% of the bank) takes the full bank.

*Board exam*: `settings/board` = `{ json }` with `{ "<specialtyId>": { questions, minutes, mix } }` from the *Board exam
simulation* card (`readBoard` / `writeBoard`).
*Overview*: `overviewOf(accounts, payments)` counts students, activity (`users/{uid}.lastSeenAt`), income (live, Activated
payments) and subscriptions ending within 7 days.

**Corrections from a file (16 Nov 2026).** A file row that is the same question in the same book but differs from the stored
copy (answer, explanation, classification, difficulty, reference, spelling) is a *Changed* row: `QuestionImport.questionChanges`
lists the differences and `applyQuestionChanges` writes only those into the stored record on Confirm Import (same id, uid, book,
Free mark). The Corrections card can untick them all. Identical rows are still skipped.
The free version's document carries `summary` (JSON: total, categories, books of the full bank; counts only).

**Every book complete (16 Nov 2026).** A book is always imported in full. Only the same question (same text and set of
options) in the same book, or repeated inside the file, is skipped. A uid in the file is not a duplicate signal: a uid that is
already used gets a new one on saving. The **Book check** only reports how many questions a new book shares with an existing
one; a name that differs only in capitals, spacing or punctuation is saved under the stored spelling. Publishing gives every
item its own uid (two records sharing one would become one record on students' devices). The admin dashboard shows
**Different questions** (what students see when they study all books) next to the total.
*Import → Books stored twice* merges two books that are really one (`db.mergeBooks`): a shared question is kept once (the oldest
record stays, with the details of the latest upload); everything else moves to the chosen name.

**Publish replaces the bank on students' devices.** The published bank is the whole bank: after a subscriber installs it, the
device becomes an exact copy of it (`mirrorPublishedBank` in the student `subscription.js`), so whatever is not in this workspace
when you publish disappears for students. Their answers, bookmarks, notes and High Yield marks move to the question with the same
text and options (or the same text). The free version follows **Publish free version** in the same way (only the published Free
questions are visible).
Students see one copy outside book study (see the student README).

**Free questions = the free version.** There is no free trial (since 13 Nov 2026): a student without a subscription sees only the
questions marked *Free*, 250 per specialty. In the Questions list press **Auto-select 250** (keeps what you marked and fills the rest,
spread evenly over every category and section) or mark them one by one; **Clear all Free** starts over. The counter shows `N / 250`;
250 is the hard limit. The free version has its **own card and button**, separate from the full bank: Settings → **Free version**
(count, *Auto-select 250*, *Choose in Questions*, *Clear all Free*, last publish) → **Publish free version**. It writes
`freepacks/<specialtyId>` for every student of the specialty without a subscription; students' devices update automatically, and a
question you unmark stops being free on them. The Cloud card's *Publish <Specialty> question bank* publishes only the full bank for
subscribers. Nothing is uploaded to the Student site (*Download a copy of the free version* is only a backup).

**Cloud publishing** (Settings → *Cloud (Firebase)*): sign in with your admin e-mail, open the specialty, press
*Publish <Specialty> question bank*. The confirm dialog names the specialty. It writes `packs/<specialtyId>` and refuses to
overwrite a pack that belongs to another specialty (`CROSS_SPECIALTY`). For ENT you can also refresh the old
`packs/main` copy so students still on 1.3.x keep working.

**Subscription scope** (Settings → *Subscription scope*): `selected` (default) — a subscriber reads only the bank of the specialty on
their account; `all` — an active subscription opens every active specialty. Enforced by the rules, not just the UI.

**Subscriptions and payments.** Students subscribe from the app: **Pay online** (Wayl, through the payment Worker in `wayl-worker/`,
which activates the account automatically), **WhatsApp** (you agree on payment, then activate the account or send an activation code),
or an **activation code**. *Student accounts → Online payments* lists the Worker's payments (Activated, Paid = activation pending,
AmountMismatch = not activated, check Wayl) with the last 30 days' live total. Prices live in the Worker's `PLANS` setting.

**Student accounts** (Settings → *Student accounts*): shows each student's specialty and access (Active / Expired / Free version),
filters by specialty, extends or stops a subscription, changes a student's specialty, approves/declines a student's change request, and (for the migration)
*Assign the N account(s) with no specialty to ENT*.

**Reports** (Settings → *Question reports*): each report shows its specialty; filter by specialty; *Show question* jumps to the
right workspace.

**Admin mode and the passcode.** Version 1.3.0 shipped a fixed password inside `app.js`. It was removed. The first time you
unlock Admin mode the app asks you to choose a passcode (at least 8 characters) for that device; only a salted PBKDF2 hash is
stored. This only hides the admin screens on the device. The real protection is the Firestore rules plus `admins/{uid}`.

### Activation codes (Admin app)
Settings → *Student accounts* → *Load accounts* → **Activation code** on a row: choose the plan (1 month = 30 days, 3 months = 90, 12 months = 365) and
how long the code stays usable (3/7/30 days) → *Create code*. The code (`XXXX-XXXX-XX`) is shown with **Send on WhatsApp to <the student's number>**
(a ready Arabic + English message with the code, plan and account) and *Copy message*. The student enters it in the app (Settings → Access → Enter activation code) and full access starts at once;
the row then shows *Last activation code used*. *Show recent codes* lists codes (not used / used / expired) and lets you **Revoke** an unused one.
Codes live in Firestore `codes/{code}`; only an admin can create, list or delete them. You can still use +1/+3/+12 months and Set date as before.

### Importing an old-format package (.entpkg) into a new specialty
A package made by Adam ENT 1.3.x, or by a tool/AI following the old format, has no specialty (schema 1) and therefore counts as ENT. Importing it
into another workspace (e.g. Obstetrics & Gynecology) now asks: *Import it into "<this specialty>"?* OK stamps every item with the open specialty
and turns its `{category: [sections]}` map into this specialty's category tree; Cancel leaves everything untouched. Then export a `.qbpkg` from that
workspace and publish it. The importer also accepts a package zipped as a folder, JSON files with a BOM, and AI-style question shapes (nested
`options` objects/arrays, `question`/`stem`, `answer: "B"` / `"Option B"` / the option text, `category`/`section`); an incomplete question is
reported by number, uid and text. The **Classification Guide** now also documents the exact `.qbpkg` format (`packageFormat`), so attach it when
asking an AI to build a package.

### Students' mobile numbers (Admin app)
Settings → *Student accounts* → *Load accounts*: each account shows its mobile number (`0770 123 4567`) and a green **WhatsApp** button that opens a chat
with that student (`wa.me`). Accounts without a number say *Mobile: not added yet*. The search box also finds accounts by number (local `0770...` or
international `964...`), and the summary counts how many accounts have a number. Students give the number at registration with their consent to be
contacted on WhatsApp about their account; older accounts are asked once. Use it only for that, and remember that whatever you send on WhatsApp is outside
the app (allowed by Google Play's policy), but the Google Play listing and the app itself must not point students to paying outside Google Play.

### Renaming a book (Admin app)

*Import & Export* → **Delete One Book**: the list offers every book with its question count (a book whose name came from
inside a JSON file is stored in `book` with an empty `group`, and used to be missing from this list). Deleting removes the
book's questions (matched on `book` or `group`), its lectures and its book entry (`db.deleteBook`); the confirmation says how
many of its questions exist in no other book and are therefore lost.

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
* Free version: right after registration the student has the Free questions (up to 250) and a bar with a *Subscribe* button that lists the
  plans with prices and offers Pay online (Wayl), WhatsApp and an activation code. When a plan ends, progress, bookmarks and notes are kept and
  everything returns when it is renewed.
* Works offline after the first sign-in, as before.
* The student app is a website/PWA (adamqbank.com) with in-app **Delete account** and public privacy / terms / delete-account pages. It is not
  published on Google Play (the Play kit is kept but unused).
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
| `users/{uid}` | identifier, plan, expiresAt, `createdAt` (server time), **specialtyId**, specialtyName, specialtyAssignedBy, specialtyChangeRequest | student creates own (plan `none`, active specialty, `createdAt` = server time); student may only add a change request; admin does the rest |
| `packs/{specialtyId}` + `/chunks/*` | published bank | admin |
| `packs/main` | legacy ENT copy | admin |
| `settings/access` | `subscriptionScope` = `selected` \| `all`; `trialDays` (unused since 13 Nov 2026, saved as 0) | admin |
| `reports/{uid}_{questionUid}` | report with `specialtyId` | student creates (own specialty only), admin reads |
| `codes/{code}` | uid, plan, days, validUntil, usedAt, usedBy | admin creates; the student marks their own code used while redeeming |
| `freepacks/{specialtyId}` + `/chunks/*` | the free version (questions marked Free, ≤ 250) + `freeUids` | admin writes (Publish); every signed-in student of that specialty reads |
| `payments/{referenceId}` | uid, identifier, plan, days, amount, status (Created / Activating / Activated / Paid / AmountMismatch / LinkFailed), env, paymentMethod, dates | the payment Worker (signs in as a service admin); admin reads |
| `admins/{uid}` | membership marker | you, in the console |

The rules in `firebase/firestore.rules` enforce: a student reads only the pack of their own specialty (unless scope is `all`),
only while the subscription is active and the specialty is `active`; students cannot change their plan, expiry or specialty;
reports must carry the student's own specialty; only admins publish and manage.

## 6. What needs the owner

Host the two apps on **different origins** (see FIREBASE-SETUP.md step 8); one shared origin makes them share browser storage.


See the checklist at the end of [FIREBASE-SETUP.md](FIREBASE-SETUP.md): create the Firebase project, enable Email/Password,
fill `firebase-config.js` (both apps) and `subscription-config.js` (student), publish the rules, add `admins/{uid}`, sign in
once to publish. Nothing in these zips can do that for you.

## 7. Honest limits of this release

* The security rules were written together with an automated test (`firebase/firestore-rules.test.js`) but that test needs the
  Firestore emulator, which could not be started where the code was produced. **Run `npm test` in `firebase/` before you publish the rules.**
* **Offline grace is a convenience, not copy protection.** The server decides who may download the bank, but a student whose bank is already on the
  phone keeps it for `offlineGraceDays` without checking. The free pack is a public static file by design.
* **Rules must be republished** (and re-tested) for this build: the paid bank needs a paid, unexpired plan (no trial) and `payments/*` is admin-only.
* Reordering is available for specialties, categories and sections. Questions keep their creation order.
* A browser-side check (headless Chromium with a mocked Firebase) covered registration, isolation, switching, blocked states,
  package gates, publishing, migration from 1.3.0 and offline reload. It does not replace a trial against your real project.
