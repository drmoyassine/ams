# Organization, languages and the org chart — plan (2026-10-13; nothing built yet)

Owner's list: (1) a primary and a secondary language, with translation of the IQF and the standards, a content switcher and a UI language switcher; primary is always English; (2) an org chart that is built visually and systematically, can be created from an uploaded image by vision/OCR, and can be kept in sync with a directory (LDAP / Active Directory); (3) Programs becomes a tab under Organization.

## What exists today

- Organization page: institution name (English and Arabic), country, default language (en or ar), accent colour, org units (college, school, department, administrative unit, other) as a list, and a separate Programs page. "Logo upload arrives later" (storage exists since M3).
- The UI uses i18next. Content has an original `language` per requirement and one `translation_en` field, built for Arabic originals with an English view.
- Better Auth handles sign-in (password, OIDC, SAML). Nothing reads a directory.

## 1. Organization screen (small, first)

Settings → Organization becomes one screen with tabs: **Institution** · **Languages** · **Org chart** · **Programs**. The Programs entry leaves the Settings sidebar (the old address redirects). The institution logo (reusing the accreditor-logo upload: PNG/JPEG/WebP, 512 KB, bytes sniffed, no SVG) goes on the Institution tab and shows in the header and sign-in page. Settings visible read-only to every role (editing stays with those who can edit today).

## 2. Languages

**Model.** Primary language: English, fixed. Secondary language: chosen by an administrator (Arabic, Chinese, French, any language; one at a time at first, the data model allows several). A language registry gives each language its direction (RTL for Arabic, Hebrew, Persian, Urdu), a font stack (CJK, Arabic) and a name in its own script.

**Content translation.** Translations are stored beside the English, never over it: a `content_translation` table (entity kind, entity id, language, field, text, origin AI or person, reviewed or not, and the hash of the English it was made from, so a later English edit marks it out of date). Covered: the IQF (title, description, notes) and external standards (title, description, notes), then glossary terms, report templates and lifecycle labels. Translating is a background job in the `agent` service using the Assistant-style AI role (framework text only, DEC-021), glossary-aware (the glossary maps each internal term to the standards' terms), with a spend cap and progress; each translation is marked "AI translation, not reviewed" until a person accepts or edits it. A side-by-side review screen (English left, translation right, accept / edit / retranslate, filter "needs review" / "out of date"), and the assistant can offer to translate a selection.

**External standards.** The accreditor's words are the official text, whatever language they are in. A translation is a convenience: shown with the label "Translation, not the official wording", with a toggle to the original. The existing `translation_en` becomes the English row of the same table.

**Switchers.** (a) UI language: each person picks English or the secondary language (menu in the header; default from the institution's setting); the interface strings come from catalogues. (b) Content language: a toggle on the library screens: original / English / secondary; falls back to English when a translation is missing, and says so.

**Interface strings.** The English catalogue is in the repository; the secondary language's catalogue is produced by the same translation job (a `ui_translation` table, reviewable in Settings → Languages), so any language can be offered without a code release. RTL: the layout already uses logical spacing (start/end); a language registry flips `dir`, and a visual pass checks the main screens in Arabic. Not translated at first: dates and numbers use the browser's locale; reports and exports in the secondary language come with M4.

## 3. Org chart

Three layers, each usable on its own.

1. **Visual builder (first).** The tree editor reuses the drag-and-drop, multi-select, Trash and Undo/Redo already built for the standards; a chart view draws the same units as boxes and lines (auto-laid-out, zoom and pan, collapsible branches, RTL aware, export as PNG/SVG/PDF). Each unit has a name in both languages, a type, a head (a person), and its programs. Levels and types are configurable, not fixed.
2. **From an image.** Upload a picture or PDF of an existing chart; a vision model (the Reading role) reads the boxes and lines and proposes a tree. It is a proposal: the person sees the proposed tree beside the image, edits, and applies it as one undoable change. It needs a decision first: the image goes to the AI model and may show people's names (DEC-021 covers standards text, not this).
3. **Directory sync.** A read-only connector to LDAP / LDAPS (Active Directory and OpenLDAP speak it; SCIM for cloud directories later; no vendor SDKs, DEC-008). Settings: server, bind account (secret encrypted at rest), base DN, filters and the mapping of directory attributes to units, heads and members. A scheduled job in the general `worker` service reads the directory, compares with the chart and shows a "what would change" list; the person applies it, or turns on automatic apply. Each unit records where it came from (manual, image, directory); the sync never overwrites a unit a person edited or locked, and never deletes (removed units go to the Trash). Sign-in through the directory is a separate, later question (OIDC/SAML cover it today).

## Build order

1. Organization tabs, Programs tab, institution logo, read-only Settings (small).
2. Languages: registry, secondary-language setting, UI language and content switchers, UI catalogues, RTL pass.
3. Translation job and review screen for the IQF, then external standards.
4. Org chart builder (tree and chart view).
5. Org chart from an image (after the vision decision).
6. Directory sync (after you say which directory you use).

## Decisions needed

1. One secondary language, or several at once? (Recommended: one now; the data model allows more.)
2. External-standard translations labelled "not the official wording", shown beside the original: agreed?
3. UI language chosen per person (default from the institution setting)?
4. Org-chart images and the names on them may go to the AI vision model: allowed? (Needs a decision record.)
5. Which directory do you use (Active Directory, Entra ID, Google Workspace, OpenLDAP)? Sync only, or sign-in too?
