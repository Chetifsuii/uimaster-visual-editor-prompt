# SPEC.md — UIMaster v1 Technical Specification

> Read together with `CLAUDE.md` (rules) and `PLAN.md` (phases). Section numbers are referenced from both.

## 0. Definition

**UIMaster** is a local-first, browser-only, **no-AI**, no-backend visual editor for **pasted page source** of published **Framer** and **Webflow** sites (the output of Ctrl+U / "View Page Source", or `outerHTML` copied from DevTools).

The user pastes HTML (optionally with the page URL). UIMaster:

1. **freezes** the source into a static, script-free, self-contained document,
2. renders it in an in-app canvas (an `<iframe srcdoc>`),
3. lets the user **hover / click any element** and edit it manually like Figma or Framer — text, typography (with real font detection), colors (element, rule, or whole-palette scope), spacing, size, images and logos, inline SVG icons, links, attributes, visibility, structure (delete/duplicate/move), platform badges ("Made in Framer" / "Made in Webflow"),
4. keeps every edit as an **invertible op** (undo/redo, autosave, replay),
5. **exports** a clean standalone HTML file (plus an optional JSON patch).

There is no chat, no prompt box, no model call anywhere in the product.

### 0.1 Non-goals (v1)
- No AI assistance of any kind. No server, auth, collaboration, or cloud sync.
- No re-hydration of the template's JavaScript (animations, sliders, CMS, forms) — v1 is a *static freeze* editor. Interactive behaviors are listed under Issues as "requires original scripts".
- No multi-page projects (one pasted page = one project; v1.1 adds pages).
- No visual drag-to-move on canvas (structure changes happen via Layers and Move up/down). Resize handles are display-only in v1.
- No editing of `@keyframes`, gradients (read-only display), or pseudo-element content.

---

## 1. Truth model (the single most important rule)

```
Truth      = Project.sourceHtml (immutable)  +  Project.ops[] (append-only, invertible)  +  Project.cursor
Projection = freeze(sourceHtml).html  →  loaded into iframe  →  apply(ops[0..cursor])
Export     = clean(serialize(Projection))
```

- `sourceHtml` is never mutated after import.
- The live iframe DOM is a **projection**, never a source of truth — except that an op captures its `before` value from the live DOM at the moment it is applied (so it can be reverted).
- Reopening a project = freeze → load → replay ops. Replay must be deterministic: inserted nodes get IDs from a persisted counter (`Project.idCounter`), never from `Math.random`.
- The ops ledger and `sourceHtml` are what is persisted (IndexedDB). The projection is disposable.

---

## 2. Architecture: the F-M-S-P-E pipeline

```
paste ──▶ FREEZE ──▶ MAP ──▶ [iframe] ──▶ SENSE ──▶ user edits ──▶ PATCH (ops) ──▶ EXPORT
           pure       pure     render      measure                   invertible       clean+serialize
```

All engine stages live in `src/engine/**`, are pure (`(doc: Document, win?: Window, …) => Result`), import nothing from React, and are unit-tested in jsdom.

### 2.1 FREEZE — `src/engine/freeze/`

Input: `rawHtml: string`, `options: { baseUrl?: string; autoRemoveBadges: boolean; internalizeCss: boolean }`.
Output: `Result<FrozenDoc>` where `FrozenDoc = { html: string; baseUrl: string | null; platform: Platform; report: FreezeReport }`.

Parse with `new DOMParser().parseFromString(rawHtml, 'text/html')` (inert: scripts do not execute, images do not load). Run the steps **in this exact order**; each step is its own module with its own tests and appends counters/warnings to `report`.

| # | Step | What it does |
|---|------|--------------|
| F1 | `detectPlatform` | See §7. Returns `'framer' \| 'webflow' \| 'unknown'` plus the evidence list used (shown in the import summary). |
| F2 | `collectFromScripts` | **Runs before scripts are removed.** Extracts data that only exists inside scripts: Webflow `WebFont.load({...})` families (regex on `families\s*:\s*\[([^\]]*)\]` per provider `google`/`typekit`/`custom`), Typekit kit ids. Stores them in `report.fontsRescuedFrom`. |
| F3 | `resolveBaseUrl` | Priority: `options.baseUrl` → `<base href>` → `<link rel=canonical href>` → `<meta property="og:url">` → `null`. If `null` **and** the document contains any relative URL (`src`/`href`/`srcset`/`url()` not starting with `http(s):`, `data:`, `blob:`, `#`, `mailto:`, `tel:`), push warning `MISSING_BASE_URL` with the count. The UI then shows an inline URL field on the import screen without discarding the paste. |
| F4 | `stripExecutables` | Remove every `<script>` whose `type` is executable (missing, `text/javascript`, `application/javascript`, `module`, `text/ecmascript`, `importmap`). Keep inert data scripts (`application/ld+json`, `application/json`, `text/template`). Remove `<noscript>` (its content would otherwise render twice — Webflow lazy-load fallbacks). Remove all `on*` attributes. Rewrite `href`/`action`/`formaction`/`xlink:href` starting with `javascript:` to `#`. Remove `<link rel="preload" as="script">`, `<link rel="modulepreload">`, `<meta http-equiv="refresh">`. Count everything. |
| F5 | `injectCsp` | Prepend to `<head>`: `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`. **Rationale (verified):** WebKit bug 218086 — Safari blocks event listeners that the *parent* attached inside an `iframe[srcdoc][sandbox="allow-same-origin"]` that lacks `allow-scripts`. Therefore UIMaster does **not** use the `sandbox` attribute for script blocking; it relies on F4 (removal) + F5 (CSP belt-and-braces). Write the Playwright spike `tests/e2e/spike-iframe-listeners.spec.ts` in Phase 2 to prove parent listeners fire in Chromium and WebKit with this setup. |
| F6 | `internalizeStylesheets` | For each `<link rel="stylesheet" href>` (after absolutizing `href` with F3's base): `fetch(url, { mode: 'cors', signal: AbortSignal.timeout(8000) })`. On success → replace the link with `<style data-uim-sheet="s{n}" data-uim-origin="{url}">{css}</style>` after rewriting `url(...)` and `@import` **relative to the stylesheet URL, not the page URL**. On failure (CORS/network) → keep the `<link>`, tag it `data-uim-sheet="s{n}" data-uim-external="1"`, push warning `EXTERNAL_SHEET_UNREADABLE {url, reason}`. Tag pre-existing `<style>` elements `data-uim-sheet="s{n}"` too. The import screen shows "3 stylesheets internalized · 1 external (rules from it can be overridden but not edited)". Never assume a CDN allows CORS; measure it. |
| F7 | `absolutizeUrls` | With base from F3, rewrite: `src`, `href` (except `#…`), `poster`, `data-src`, `data-srcset`, `srcset`, `xlink:href`, `<use href>`, `content` of `<meta property="og:image">`, inline `style` `url()`, and `url()` inside internal `<style>` text. `srcset` must be parsed with the HTML spec algorithm (split on commas that are followed by whitespace or end; URLs can contain commas). Skip `data:`, `blob:`, `about:`, `mailto:`, `tel:`. Record count. Also rewrite `<a href="/path">` to absolute site URLs (documented in LIMITATIONS: exported links point to the original site until the user edits them). |
| F8 | `rescueFonts` | Convert F2 findings to `<link rel="stylesheet">` elements inserted at the end of `<head>`. Webflow token format `"Inter:regular,500,600,700"` / `"Lora:regular,italic,700,700italic"` → Google Fonts CSS2: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,700;1,400;1,700&display=swap`. Mapping: `regular`→`400`, `italic`→`ital 1 / 400`, `<n>italic`→`ital 1 / n`, `<n>`→`n`; when any italic exists use the `ital,wght@` axis list sorted ascending (ital first, then weight) — the CSS2 API rejects unsorted tuples. Typekit → `https://use.typekit.net/{id}.css`. Framer needs no rescue (fonts are `@font-face` in inline `<style>`), but verify every `<link rel="preload" as="font">` has `crossorigin` (add it if missing; fonts fail to load cross-origin without it). |
| F9 | `neutralizeMotion` | Framer: for each `[data-framer-appear-id]` element, if its inline `opacity` parses to `< 0.05` remove the inline `opacity`; remove inline `transform` when it contains `translate`/`scale`/`rotate`/`perspective`; **remove inline `filter`/`-webkit-filter` when it contains `blur(`** — appear animations start from a blurred frame and, with scripts stripped, that blur otherwise stays on the element forever ("stuck blurred first frame"). Webflow: same three removals for each `[data-w-id]` element. Never touch `display` or `visibility` here (menus and modals legitimately use them). Count. Everything else is handled at runtime by `detectInvisible` (§2.3), which is measurement-based and also catches blur/paused states set from CSS. |
| F9b | (runtime) `visibilitySweep` | F9 only fixes *inline* starting states. Real templates also hide content through CSS rules and opaque overlays that their own JavaScript would dismiss (preloader/intro screens, cookie walls). Therefore, after `iframe.onload` (and again after `document.fonts.ready`, because webfonts shift layout), run `detectHidden` + `detectOpaqueCovers` (§2.3) and commit one `batch` op per kind: `applyReveal` on the **culprit** element that sets the hiding value (nearest ancestor with computed `opacity < 0.9` / `visibility:hidden` / stuck blur / paused play-state, else the element itself for off-screen transforms), applying per reason, all `!important`: `opacity:1`, `visibility:visible`, `transform:none`, **blur → strip only the `blur(…)` component from `filter` (keep every other filter function the design intends; `none` if nothing remains)**, **paused-animation → `animation-play-state: running`**; and `applyHide` (inline `display:none !important` on covers). Both are undoable history entries and both are listed in the Report/Issues panel with their measurement reasons. `display:none` containers that hold ≥ 8 content descendants are **not** auto-fixed (they may be legitimate variants/tabs): they are listed with a per-item *Reveal* action. Verified against a real 7.8k-node Framer capture: without this sweep the canvas renders as an opaque black rectangle while every detector still reports correct computed styles — detection and appearance must be fixed independently. |
| F10 | `markBadges` | Mark (do not remove) badge elements with `data-uim-role="badge"` and `data-uim-badge="framer\|webflow"`. Selectors: Framer `#__framer-badge-container, .__framer-badge` (VERIFIED); Webflow `.w-webflow-badge, a[href^="https://webflow.com?utm_campaign=brandjs"]` (VERIFIED). Heuristic extra: `<a>` with ≤ 2 children whose text matches `/made (in|with) (framer|webflow)/i`. Also inject the runtime kill rule `.w-webflow-badge,#__framer-badge-container{display:none!important}` into the editor CSS (§2.1.1) because Webflow injects its badge from `webflow.js` at runtime — absent in Ctrl+U source, present in DevTools copies. If `options.autoRemoveBadges` is on, the **editor** (not FREEZE) commits a `removeNode` op for each marked badge right after load, so the removal is visible in History and undoable. |
| F11 | `finalize` | Ensure `<!doctype html>`, `<meta charset>`, add `<meta name="uimaster-frozen" content="1">`, inject `<style id="uim-editor-css">` (§2.1.1), and inject `<base href>` **only** if F7 reported URLs it could not rewrite. |
| F12 | `assignIds` | MAP step (§2.2). Runs last so every injected element also has an id. |

Serialize with `'<!DOCTYPE html>\n' + doc.documentElement.outerHTML`. Do not keep the `DOMParser` document after this point (memory).

#### 2.1.1 Editor CSS (`#uim-editor-css`)
Injected into the frozen document; removed at export. Motion is frozen **only while `html[data-uim-mode="edit"]`** is set — the canvas host flips that attribute on mode change. Preview mode must play the template's own CSS animations, transitions and `:hover` states; freezing them globally is a bug (the canvas looks dead and, worse, a paused/at-frame-0 animation reads as "broken render"):
```css
html[data-uim-mode="edit"] *,html[data-uim-mode="edit"] *::before,html[data-uim-mode="edit"] *::after{transition-duration:0s!important;transition-delay:0s!important}
html[data-uim-mode="edit"]{scroll-behavior:auto!important}
html[data-uim-mode="preview"]{scroll-behavior:smooth}
.w-webflow-badge,#__framer-badge-container{display:none!important}
[data-uim-editing="1"]{outline:none!important;cursor:text!important;-webkit-user-modify:read-write-plaintext-only}
```
Never add `animation-play-state: paused` here: it would pin every CSS keyframe animation to its first frame (which on Framer templates is the blurred, offset appear state) and reproduce exactly the "stuck blurred" defect this spec forbids. Nothing else goes in this stylesheet. The hover/selection overlay is **not** inside the iframe (§4.2).

#### 2.1.2 FreezeReport
```ts
interface FreezeReport {
  platform: Platform; evidence: string[];
  nodeCount: number; scriptsRemoved: number; inlineHandlersRemoved: number;
  sheetsInternalized: number; sheetsExternal: { url: string; reason: string }[];
  fontsRescuedFrom: { provider: 'google' | 'typekit'; families: string[] }[];
  urlsAbsolutized: number; motionNeutralized: number;
  badges: { id: string; platform: 'framer' | 'webflow' }[];
  warnings: FreezeWarning[]; durationMs: number;
}
```

### 2.2 MAP — `src/engine/identity/`

- `assignIds(doc)`: document-order traversal of `doc.querySelectorAll('*')` (includes `<head>` children and SVG descendants). Set `data-uim-id` to the decimal index. Skip elements that already have one (idempotent). Return `{ count, maxId }`. `Project.idCounter` starts at `maxId + 1`.
- `NodeIndex` (built in the parent after iframe load, chunked): `Map<string, NodeMeta>`.
  - `name`: Framer `data-framer-name` → Webflow first class not starting with `w-` and not `w--` → `id` attribute → tag name.
  - `kind`: `'text'` (has a direct non-whitespace text node), `'image'` (`img`, `picture`, `video`, element with computed `background-image` ≠ none), `'svg'` (outermost `svg`), `'link'` (`a[href]`), `'badge'`, `'style'` (`style`/`link[rel=stylesheet]`), `'head'`, `'container'`, `'other'`.
- `byId(doc, id)` = `doc.querySelector('[data-uim-id="' + id + '"]')` cached in a `WeakRef` map invalidated per op.

### 2.3 SENSE — `src/engine/sense/`

All detectors: `(ctx: SenseContext) => Promise<T>` where `SenseContext = { doc, win, index, platform, baseUrl }`. They run after `iframe.onload` in a cooperative scheduler (`src/engine/sense/scheduler.ts`): work is split into chunks of ≤ 200 elements, yielding with `requestIdleCallback` (fallback `setTimeout(0)`), each chunk ≤ 50 ms. Results carry `basis: string[]` — human-readable reasons shown in the UI ("chosen because inside `a[href='/']` inside `nav`; alt contains 'logo'").

| Detector | Output | Method |
|----------|--------|--------|
| `fontInventory` | `FontEntry[] { family, weights[], styles[], status, provider, sources[] }` | Iterate `doc.fonts` (`FontFaceSet`) for real load status; union with `@font-face` rules from readable sheets and Google/Typekit `<link>`s. Provider by URL host: `framerusercontent.com` → Framer-hosted, `fonts.gstatic.com`/`fonts.googleapis.com` → Google, `website-files.com`/`webflow.com` → Webflow-hosted, `use.typekit.net` → Adobe, `local(` → system, else custom. Families ending in ` Placeholder` (Framer metric fallbacks) are excluded from the inventory and skipped during resolution. |
| `fontOf(el)` | `ResolvedFont { stack, resolvedFamily, provider, loaded, weight, size, lineHeight, letterSpacing, transform, color }` | `cs = win.getComputedStyle(el)`; parse `cs.fontFamily` into a family list (handle quotes, commas inside quotes); `resolvedFamily` = first family that has a `FontFace` with `status === 'loaded'` in `doc.fonts`; if none is a web font, mark `provider: 'system'` and use the first family. Never show "loaded" unless `doc.fonts` says so. |
| `cascadeTracer(el, prop)` | `CascadeHit[] { sheetId, rulePath, selector, specificity, important, value, media, readable }` sorted by winner first | Walk `doc.styleSheets`; for each sheet try `sheet.cssRules` (catch `SecurityError` → push one `{readable:false}` entry). Recurse `CSSMediaRule` (only if `win.matchMedia(media).matches`), `CSSSupportsRule`, `CSSLayerBlockRule`. For `CSSStyleRule` with `style.getPropertyValue(prop) !== ''`: split `selectorText` on top-level commas, strip `::before/::after/::marker/::placeholder`, skip selectors containing `:hover/:focus/:active` unless `opts.includeInteractive`, test `el.matches(sel)` in try/catch. Specificity computed by `src/engine/css/specificity.ts` (ids, classes/attrs/pseudo-classes, types; `:is()/:where()/:not()` per CSS Selectors 4). Prepend inline style if set. Sort by `important` desc, layer order, specificity desc, source order desc. |
| `extractPalette` | `PaletteEntry[] { hex, usage: {text,bg,border,svg,shadow}, areaWeight, sources: {variables: VarRef[], rules: RuleRef[], inline: number}, cluster: string[] }` top 24 | Computed pass (chunked): `color`, `background-color`, `border-*-color`, `outline-color`, `fill`, `stroke`, color stops parsed from computed `background-image` gradients, `box-shadow` colors. Normalize with `culori` to 8-digit hex; drop alpha 0. Weight: backgrounds by element area (`w*h`), text by character count, others by 1. Cluster ΔE2000 < 2 into the most frequent representative. Then a **literal pass** over readable sheets' `cssText` and inline styles to find where each color is *written* (rules, `--custom-property` definitions on `:root/html/body/.framer-*`, inline). Variables are the golden path for global recolor (§2.4.4). |
| `detectLogo` | `LogoCandidate[] { id, score, basis, assetKey }` desc | Candidates: `img`, outermost `svg`, elements with computed `background-image` — restricted to zone = inside `header, nav, [role=banner], .w-nav, [data-framer-name*="nav" i], [data-framer-name*="header" i]` **or** `rect.top < 160 && rect.top >= 0`. Score: +3 inside `a[href]` whose resolved href equals `baseUrl` origin root (`/`, `./`, `index.html`) or has class `w-nav-brand` or `w--current` at nav position; +3 `[data-framer-name*="logo" i]`; +2 `alt/class/src/id` contains `logo|brand|wordmark`; +1 `rect.left < 0.35 * viewportWidth`; +1 area between 400 and 40 000 px²; −2 area > 90 000 px²; −3 inside `footer`; −5 if `data-uim-role="badge"`. `assetKey` = normalized `src` or SHA-1 of SVG `outerHTML` (via `crypto.subtle.digest`) so all instances of the same logo are grouped and replaced together. If best score ≤ 2 → return empty and the UI says "No obvious logo — click any image and choose *Mark as logo*". |
| `detectBadges` | `BadgeHit[]` | Elements with `data-uim-role="badge"` plus a post-render text heuristic (`/made (in\|with) (framer\|webflow)/i` in `a` with ≤ 2 children). |
| `detectIcons` | `IconGroup[] { hash, ids[], sample: string }` | Outermost inline `svg` with rendered area < 4 096 px² and not a logo candidate; `img[src$=".svg" i]` with area < 4 096 px². Group by hash of `outerHTML` with whitespace collapsed. |
| `detectInvisible` | `InvisibleHit[] { id, culpritId, reason }` with `reason ∈ {opacity, visibility, transform-offscreen, blur, paused-animation}` | Leaf content elements (`hasDirectText` or `img/svg/video`) whose **effective** opacity (product of the chain up to `<html>`) is `< 0.05`, or whose visibility chain contains `hidden`, or whose computed `transform` moves the box entirely outside the viewport, or whose chain contains a **stuck `filter: blur(…)`** (computed filter matches `blur(` while the element's animation is absent, paused, or itself faded — a *running* CSS animation is left alone because it resolves on its own), or a **paused keyframe animation** (`animation-name ≠ none` with `animation-play-state: paused`, i.e. frame 0 held until JS). The hit reports the **culprit** (nearest ancestor with computed `opacity < 0.9` / `visibility: hidden` / stuck blur / paused play-state, else the element itself) so the fix lands where the hiding value is set, not on the leaf. Feeds F9b and the per-element *Force visible* action. |
| `detectOpaqueCovers` | `CoverHit[] { id, coverage, reason }` | `position: fixed/absolute/sticky` elements, visible, whose rect intersects ≥ 95 % of the iframe viewport, with computed `background-color` alpha > 0.85 or a gradient `background-image`, and ≤ 160 characters of text inside. These are preloaders/intros/cookie walls that the site's own script dismisses; in a script-free freeze they paint an opaque rectangle over the whole page. Hidden by F9b with a recorded, undoable op and a `reason` string shown in the UI. |
| `detectHiddenContainers` | `SuspiciousHidden[] { id, name, contentDescendants }` | Outermost computed `display:none` elements containing ≥ 8 content descendants (not nested in another `display:none`). Never auto-fixed — surfaced in Issues with a per-item *Reveal*. |
| `imageInventory` | `ImageAsset[] { assetKey, ids[], src, naturalW, naturalH, renderedW, renderedH, kind: 'img'\|'picture'\|'bg'\|'poster' }` | All `img`, `picture > img`, `video[poster]`, computed `background-image: url()`. Natural size read lazily from `HTMLImageElement.naturalWidth` after `decode()`; broken images (`complete && naturalWidth === 0`) → Issues "Broken image". |
| `linkInventory` | `LinkGroup[] { href, ids[] }` | All `a[href]` grouped by resolved href. |

Re-run policy (`senseStore`): palette after any color op (debounced 500 ms), image/logo/icon inventories after image/structure ops, invisible after style ops on the affected subtree, fonts after typography ops. Detectors never write to the DOM.

### 2.4 PATCH — `src/engine/ops/`

#### 2.4.1 Op contract
```ts
type Op =
  | { t: 'setInnerHtml'; id: string; before: string; after: string }
  | { t: 'setAttr'; id: string; name: string; before: string | null; after: string | null }
  | { t: 'setInlineStyle'; id: string; prop: string; before: string | null; after: string | null; important?: boolean }
  | { t: 'removeNode'; id: string; parentId: string; index: number; html: string }
  | { t: 'insertHtml'; parentId: string; index: number; html: string; ids: string[] }
  | { t: 'moveNode'; id: string; from: { parentId: string; index: number }; to: { parentId: string; index: number } }
  | { t: 'replaceImage'; id: string; before: ImageState; after: ImageState }
  | { t: 'setRuleDeclaration'; sheetId: string; rulePath: number[]; prop: string; before: string | null; after: string | null; important: boolean }
  | { t: 'setCssVariable'; sheetId: string; rulePath: number[]; name: string; before: string | null; after: string }
  | { t: 'injectRule'; ruleId: string; selector: string; declarations: string; before: string | null }
  | { t: 'batch'; label: string; ops: Op[] };

interface ImageState { src: string | null; srcset: string | null; sizes: string | null; pictureSources: string[]; bgImage: string | null }
```
Rules:
- JSON-serializable; **no DOM references**. `before` is captured from the live DOM at apply time and stored in the op object before it is committed.
- `apply(op, ctx)` and `revert(op, ctx)` are total: they throw `OpError` if the target id is missing; the ledger catches, marks the op `broken`, and reports in Issues.
- `batch` applies in order and reverts in reverse.
- Structural ops that create nodes (`insertHtml`, duplicate) assign `data-uim-id` to **every** created element from `ctx.nextId()` (persisted counter) and store them in `ids` so replay is deterministic.
- Property test (fast-check): for each op type, `apply → revert` yields `documentElement.outerHTML` identical to the pre-apply snapshot; `apply → revert → apply` equals `apply`.

#### 2.4.2 Ledger
`Ledger { ops: Op[]; cursor: number; commit(op); undo(); redo(); preview(op); cancelPreview(); }`
- `preview` applies an op to the DOM **without** recording it (used while dragging a slider or typing in a field); `commit` first cancels any active preview, then applies and records. This replaces fragile op coalescing.
- `commit` truncates the redo tail. `undo/redo` move `cursor`.
- Every commit emits `ledger:changed` → autosave (debounce 800 ms) and overlay refresh.

#### 2.4.3 CSS ops and text sync
CSS ops mutate the CSSOM (`sheet.cssRules[...]`) for instant preview, then **sync**: rewrite the owning `<style>` element's `textContent` from `Array.from(sheet.cssRules, r => r.cssText).join('\n')` so that the DOM text (what export serializes) equals what renders. Only internal sheets (`data-uim-sheet` without `data-uim-external`) are editable; the tracer marks the others `readable:false`, and the UI offers the override rung instead. `injectRule` writes into `<style id="uim-overrides" data-uim-sheet="overrides">`; selectors there use `[data-uim-id="…"]` and are converted at export (§2.5).

#### 2.4.4 Scope Switch and the Override Ladder
Every style control in the Inspector has a **Scope** segmented control: `This element · Same rule · Everywhere`.
1. **This element** → `setInlineStyle`. Add `important: true` only if `cascadeTracer` shows the winning rule is `!important`.
2. **Same rule** → the winning `CascadeHit` for that property. If `readable` → `setRuleDeclaration` on that rule (affects all elements matching it; the UI shows the count via `doc.querySelectorAll(selector).length`). If unreadable → `injectRule` with the same `selector` and `!important`.
3. **Everywhere** (palette / font replace) → composite `batch`:
   - Colors: if ≥ 80 % of the color's weighted usage resolves to a CSS custom property → `setCssVariable` at each definition (Framer `--token-*`, Webflow `--*`). Else `setRuleDeclaration` for every readable rule literal (from `PaletteEntry.sources.rules`), `setInlineStyle` for inline occurrences, `setAttr` for SVG `fill`/`stroke` attributes. For occurrences that come from unreadable sheets → `injectRule` per affected element (`[data-uim-id="n"]{prop:new!important}`), computed-matched.
   - Fonts: rewrite every `font-family` declaration whose first non-placeholder family equals `from` (readable rules + inline) to `"{to}", {original fallbacks}`; if `to` is a Google Font, `insertHtml` a `<link rel="stylesheet">` for it with the union of weights in use (fallback `400;500;600;700`); keep `@font-face` blocks untouched.

#### 2.4.5 Text editing
Double-click on a `kind === 'text'` element (or Enter with it selected): set `contenteditable="plaintext-only"` (fallback `"true"` when unsupported — Firefox < 136) and `data-uim-editing="1"`, focus, place caret at click point via `caretRangeFromPoint`/`caretPositionFromPoint`. Overlay switches to a text-editing state and all canvas click interception pauses. Commit on blur / `Esc` / `Cmd+Enter` as `setInnerHtml { before: originalInnerHTML, after: currentInnerHTML }` (only if changed). `Enter` inserts `<br>` in single-line containers (`h1–h6`, `a`, `button`, `span`) and a newline in `p`/`div`. Remove both attributes on commit. Inline children (`<span>`, `<strong>`, `<br>`) are preserved because we serialize `innerHTML`, not `textContent`.

#### 2.4.6 Images
`replaceImage` sets `src`, removes `srcset`/`sizes` (a replaced image must not be overridden by the old responsive set), removes `<source>` children of a parent `<picture>` (stored in `before.pictureSources` for revert), or — for background images — writes `background-image: url("…")` inline. Sources: URL field, file upload (converted to a data URL with `FileReader`; show size; warn above 2 MB), paste (`ClipboardEvent.clipboardData.files`). "Replace all N instances" uses `assetKey` grouping → `batch`. Show natural vs rendered size and an `object-fit` selector.

### 2.5 EXPORT — `src/engine/export/`

`exportHtml(doc, opts: { inlineImages: boolean; keepCsp: boolean })`:
1. `const clone = doc.documentElement.cloneNode(true)` (work on the clone; never touch the projection).
2. Remove: `#uim-editor-css`, `meta[name="uimaster-frozen"]`, the CSP meta unless `keepCsp`, `[data-uim-editing]`/`contenteditable` we set, any `<base>` we injected (`data-uim-injected`).
3. Convert overrides: for each rule in `#uim-overrides` whose selector is `[data-uim-id="n"]`, add class `uim-n` to that element and rewrite the selector to `.uim-n`; rename the style element to `id="uimaster-overrides"` and keep it.
4. Strip every `data-uim-*` attribute — **including on the root `<html>` element**: `querySelectorAll('*')` returns descendants only, so iterate `[clone, ...clone.querySelectorAll('*')]` (this exact omission was caught by the round-trip test in the reference implementation).
5. `inlineImages`: for each `img[src^="http"]` fetch → blob → data URL; on CORS failure keep the URL and log it in the export summary. Never fail the whole export because one asset failed.
6. Serialize `'<!DOCTYPE html>\n' + clone.outerHTML`. Download as `{project-name}.html`; also "Copy HTML".
7. Round-trip test: exporting, then importing the export as a new project must yield the same `nodeCount` (± injected elements) and contain every edit; the output must contain **zero** `data-uim-`, `uimaster-frozen`, or `uim-editor-css` strings.

`exportPatch()` → `{ version: 1, platform, baseUrl, sourceSha256, ops }`. `exportProject()` → `{ …meta, sourceHtml, ops, cursor, idCounter }` as `{name}.uimaster.json`; importable from the home screen.

---

## 3. Product surface

### 3.1 Screens
1. **Home** — project list (name, platform chip, node count, updated), "New from paste", "Import .uimaster.json", delete with confirm.
2. **Import** — big textarea (monospace, virtualization not needed; show byte size), drag-and-drop `.html`, "Read clipboard" button (`navigator.clipboard.readText` with permission error handling), URL field (`baseUrl`), toggles (auto-remove badges ✓, internalize CSS ✓), **Freeze** button → summary card (report §2.1.2 rendered truthfully) → "Open editor". Errors keep the paste.
3. **Editor** — layout below.

### 3.2 Editor layout (dark, Figma-density, 12–13 px UI type)
```
┌ TopBar: [◀ Home] [Project name ✎] [platform chip] [page path chip] [◀ Back (preview history)] │ [Fit 1440 1280 1024 810/991 390 ▢custom] [zoom −  100%  +] │ [Edit ▸ Preview] │ [PanelLeft] [PanelRight] [Fullscreen] [↶ ↷] [⌘K] [Export ▾] ┐
├ Left (280px, tabs): Layers │ Assets │ Palette │ Fonts │ Issues                                                                    ┤
├ Canvas: checkerboard backdrop, iframe centered at viewport width × zoom, parent-side overlay layer                                 ┤
├ Right (320px): Inspector (sections §3.4)                                                                                            ┤
└ StatusBar: 12 480 nodes · hover: div.framer-1a2b3c › a.framer-logo · last: setInlineStyle color · saved 2s ago                    ┘
```
Viewport presets: Framer breakpoints 1200/810, Webflow 991/767/479 — show the platform's set first. Zoom 25–200 % via CSS `transform: scale()` on the iframe wrapper, with `width/height` of the wrapper set to the scaled size so scrollbars are correct.

### 3.3 Left panel
- **Layers**: virtualized tree (`@tanstack/react-virtual`, 22 px rows, indentation 12 px/level), kind icon, name, dim rows for `display:none` with an eye toggle (op `setInlineStyle display`), badge rows with a red dot, `<head>` collapsed under "Document head". Expand state in store; auto-expand ancestors of selection and scroll into view; hover sync both ways (tree hover → canvas highlight, canvas hover → row highlight via imperative class toggling, no re-render). Context menu: Select parent, Hide/Show, Delete, Duplicate, Move up/down, Force visible, Mark as logo, Copy CSS selector, Copy outerHTML.
- **Assets**: Logos (grouped by `assetKey`, primary first with basis tooltip, Replace all), Images (grid with natural/rendered size, broken marker), Icons (groups; replace all with pasted SVG markup — sanitized: strip `<script>`, `on*`, `foreignObject`).
- **Palette**: swatches with usage breakdown and where-defined counts; click → color picker with live `preview` and commit on close; the change is `Everywhere` scope by default (§2.4.4). Also "Extract again".
- **Fonts**: inventory with provider badge, loaded/not-loaded status and usage count; "Replace with…" (curated list of 60 Google Fonts + fonts already in the page + custom name) at `Everywhere` scope.
- **Issues**: missing base URL, external sheets not internalized, invisible content (Force visible / all), opaque overlays hidden by the sweep (with coverage % and reason), `display:none` containers still hiding content (per-item Reveal), broken images, features that need scripts (sliders `.w-slider`, forms `.w-form`, Framer components with `data-framer-component-type="…"` that are interactive), badge found.

### 3.4 Inspector (right panel) — sections render only when applicable to the selection
1. **Header**: kind icon, name, tag, class chips (click a chip → select all elements with that class as a multi-selection for batch ops), size `w × h`, breadcrumb of ancestors (clickable).
2. **Text**: quick textarea bound to `textContent` when the element has no element children; otherwise a note "Contains inline formatting — edit on canvas" + button.
3. **Typography**: resolved font row (family · provider badge · loaded ✓/✗ · "where defined" popover from the tracer), family select, weight (from inventory for that family, else 100–900), size with unit switch `px/rem/em`, line-height, letter-spacing, align, transform, decoration, color. Scope switch applies to every control.
4. **Fill & Border**: background-color, background-image (URL/upload, plus size/position/repeat), border per side (width/style/color, link toggle), radius per corner (link toggle), opacity, box-shadow (raw string + 4 presets).
5. **Layout & Spacing**: display, position, width/height/min/max (unit switch, `auto`), margin/padding 4-side inputs (arrow keys ±1, Shift ±10, `preview` while dragging, `commit` on blur), gap / direction / justify / align (only when flex or grid), overflow.
6. **Image** (img/picture/video poster/background): preview, natural size vs rendered, alt, object-fit/position, Replace (URL/upload/paste), Replace all N instances, Set as logo.
7. **Link** (is `a` or inside `a`): href, target, rel, "Apply to all N links with this href".
8. **Attributes**: table of all attributes except `data-uim-*` (add / edit / remove → `setAttr`).
9. **Source**: cascade chain for the property picked in a dropdown (default `color`), each hit with selector, specificity, sheet origin, editable value when readable; raw inline-style textarea validated by round-tripping through a detached element's `style.cssText`.
10. **Actions**: Hide/Show, Delete, Duplicate, Move up/down, Force visible, Remove badge (badge only), Select parent.

### 3.5 Keyboard (when focus is not in an input)
`V` select/edit mode · `P` preview mode · `F` fullscreen · `` ` `` toggle status bar · `\` focus mode · `[` / `]` toggle left panels / Inspector · `Esc` clear selection / exit text edit · `Enter` drill into child under pointer (or first child) / start text edit on text · `Shift+Enter` select parent · `←/→` previous/next sibling · `Delete/Backspace` delete · `Cmd/Ctrl+D` duplicate · `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` undo/redo · `Cmd/Ctrl+K` command palette · `Cmd/Ctrl+E` export · `Cmd/Ctrl + / − / 0` zoom · `Alt+click` raw deepest element · `Cmd/Ctrl+click` cycle through the element stack under the pointer · `H` hide/show. Key events inside the iframe are forwarded to the same handler.

---

## 4. Canvas host, overlay, targeting

### 4.1 CanvasHost (`src/engine/canvas/CanvasHost.ts`)
```ts
interface CanvasHost {
  mount(iframe: HTMLIFrameElement, frozenHtml: string): Promise<{ doc: Document; win: Window }>;
  setMode(mode: 'edit' | 'preview'): void;
  onHover(cb: (id: string | null, point: Point) => void): Unsubscribe;
  onSelect(cb: (id: string, modifiers: Modifiers) => void): Unsubscribe;
  onTextEditRequest(cb: (id: string, point: Point) => void): Unsubscribe;
  onViewportChange(cb: () => void): Unsubscribe;   // scroll, resize, mutation
  dispose(): void;
}
```
- `<iframe srcdoc title="canvas" referrerpolicy="no-referrer-when-downgrade">`. **No `sandbox` attribute** (see F5 rationale). Same-origin (srcdoc inherits the parent origin) → direct `contentDocument` access; no `postMessage` bridge needed. Keep the interface so a bridge could be added later without touching the UI.
- `mount` sets `srcdoc`, awaits `load`, then attaches (capture phase) `mousemove` (rAF-throttled), `mouseleave`, `mousedown/click/auxclick` (in edit mode: `preventDefault` + `stopPropagation`), `dblclick`, `contextmenu`, `scroll` (capture, passive), `keydown` (forward), and a `ResizeObserver` on `documentElement`, plus a `MutationObserver` (childList + attributes, throttled) to refresh the overlay after ops.
- **Mode attribute**: `setMode('edit')` sets `html[data-uim-mode="edit"]` inside the frame; `setMode('preview')` removes it. Edit mode freezes transitions (see §2.1.1) so dragging and overlays stay stable; preview mode therefore plays the template's own CSS animations, transitions and `:hover` states. The attribute is `data-uim-*` and is stripped at export (§2.5).
- **Preview-mode navigation** (the page must never feel dead; every control goes somewhere):
  1. `href^="#"` → do not intercept; the frame smooth-scrolls (preview CSS rule above).
  2. Same-origin (vs `baseUrl`) → `fetch(url, { signal: AbortSignal.timeout(7000) })`; on `ok` + `content-type: text/html` run FREEZE on the response, push the current projection (`'<!DOCTYPE html>\n' + doc.documentElement.outerHTML`, which carries all edits) onto an in-memory **page stack**, swap the iframe `srcdoc`, update the page label chip, re-run SENSE + sweep. A **Back** control in the TopBar pops the stack (restores the saved HTML verbatim, edits intact).
  3. Anything else (cross-origin, CORS rejection, non-HTML) → `window.open(url, '_blank', 'noopener')` plus a toast naming the hostname. Never a silent `preventDefault`: a button that does nothing reads as broken.
  4. `<button>` / `[role="button"]` / submit inputs (behaviors that need the stripped JS) → toast: needs the template's JavaScript; the full app lists them under Issues.
  The frame itself never leaves `about:srcdoc`; "navigation" is always a srcdoc swap or a new tab.
- In **preview** mode CSS `:hover` works because there is no overlay in the way (overlay layer gets `pointer-events:none` in both modes).
- **Workspace controls** (TopBar, always visible, icon + tooltip + key): `⛶ Fullscreen (F)` via the Fullscreen API on the editor root (`requestFullscreen`/`exitFullscreen`, synced from `fullscreenchange`; the root carries a class whose `:fullscreen` rule pins it to `100vw/100vh`), `◧ ( [ )` toggles the left panel column, `◨ ( ] )` toggles the Inspector, so the canvas can own the whole screen. Panel state persists per session.
- **Workspace ergonomics (the canvas must never feel cramped):**
  - The default viewport preset is **Fit (fluid)**: the frame fills the available width. A live chip above the frame shows the measured frame width (ResizeObserver), the active breakpoint name for the detected platform (Framer 1200/810, Webflow 992/768) and the platform — the user always knows which responsive variant they are editing.
  - Both side panels are **drag-resizable** (1 px col-resize handles between canvas and panel, hover highlight, `cursor: col-resize` on body while dragging, double-click resets to 264 px / 320 px; ranges left 200–440, right 260–520). Widths animate (200 ms) on toggle but not while dragging.
  - The bottom status bar is **collapsible** (chevron at its right edge or key `` ` ``); while hidden a floating mini-toolbar (bottom-right) keeps mode swap, undo, focus-exit and status-restore reachable — nothing becomes unreachable when chrome is hidden.
  - **Focus mode (`\`)** hides left column, Inspector and status bar in one action, tightens canvas padding, and shows the same floating mini-toolbar so the user is never stranded.
  - The TopBar scrolls horizontally instead of clipping when the window is narrow; verbose labels collapse to icons below `2xl`.

### 4.2 Overlay (`src/engine/canvas/Overlay.ts`) — parent-side, imperative
A `position:absolute; inset:0; pointer-events:none` layer over the iframe wrapper containing: hover box (1 px `#3b82f6` outline + label chip "`div.framer-1a2b3c` 320 × 48"), selection box (2 px outline, corner squares display-only), margin ring (orange, `rgba(249,115,22,.25)`) and padding ring (green, `rgba(34,197,94,.25)`) from computed style, text-edit state (dashed outline). Coordinates: `rect = el.getBoundingClientRect()` (iframe CSS px, already scroll-adjusted) → `screen = wrapperOrigin + rect × zoom`. Updates run inside `requestAnimationFrame` and write `style.transform/width/height` directly. **No React state on this path**; the store only receives `selectedId` changes and a 100 ms-debounced `hoverPath` for the status bar.

### 4.3 Smart Target Resolver (`src/engine/canvas/targetResolver.ts`)
Input: pointer point, `doc.elementsFromPoint(x, y)` stack (topmost first), modifiers.
1. Drop `html`, `body` unless the stack is otherwise empty; drop `#uim-*` artifacts; treat any element inside an `svg` as its outermost `svg`.
2. `Alt` → return stack[0].
3. `Cmd/Ctrl` on repeated clicks at the same point (±2 px) → cycle `stack[i]`.
4. Among `stack[0..2]`: if any is `img`, `svg`, `video`, `picture`, `input`, `textarea`, `select`, `button` → return the first such.
5. If `stack[0]` is `kind === 'text'` → return it; else if any of `stack[0..2]` is text → return the closest one.
6. Otherwise return the element in `stack[0..2]` with the smallest area ≥ 4 px².
7. Double-click on a container → resolve again with `stack.slice(stack.indexOf(current) − 1)` (drill one level toward the pointer). Double-click on a text element → text edit.
Framer note: full-bleed transparent `<a>` overlays and `data-framer-background-image-wrapper` elements are common; rule 4 (media first) and rule 6 (smallest area) are what make selection feel right there. Webflow note: `.w-embed` wrappers around SVGs — rule 1 returns the `svg`, `Shift+Enter` gets the wrapper.

---

## 5. State, persistence, performance-critical wiring

- **Zustand** stores: `projectStore` (meta, ledger facade, save status), `editorStore` (mode, viewportWidth, zoom, selectedIds, expandedIds, leftTab, scope, textEditingId), `senseStore` (detector results with `stale` flags). Selectors are fine-grained; panels subscribe to slices only.
- **Persistence**: `idb-keyval` with keys `uim:index` (array of `ProjectSummary`) and `uim:project:{id}` (`Project`). Autosave debounce 800 ms after ledger change; status shown in StatusBar. Open = freeze(sourceHtml) → mount → replay. Store `sourceHtml` once; never store the frozen HTML (derivable).
- **Large inputs**: Framer pages are commonly 1–6 MB and 5–15 k elements. Freeze must stay under budget (§9); the import textarea should accept 10 MB; show a non-blocking progress line ("Freezing… internalizing 3 stylesheets").

---

## 6. Tech stack (exact) and repository layout

- Vite 5+ · React 18 · TypeScript 5 (strict + flags in `CLAUDE.md §4`) · Tailwind CSS · **zustand** · **idb-keyval** · **@tanstack/react-virtual** · **culori** (color parsing/ΔE) · **nanoid** (project ids only) · **lucide-react** · **fast-check** (property tests) · **vitest** + **jsdom** + **@testing-library/react** · **@playwright/test** (Chromium + WebKit) · eslint (`typescript-eslint`, `react-hooks`) · prettier.
- No other runtime dependency without a `DECISIONS.md` entry.
- Scripts: `dev`, `build`, `typecheck` (`tsc --noEmit`), `lint`, `test` (`vitest run`), `e2e` (`playwright test`), `check:tokens` (greps forbidden tokens from `CLAUDE.md §2.1` in `src/`), `verify` = `typecheck && lint && test && check:tokens && build`.

```
src/
  app/            App.tsx, router (Home, Import, Editor), providers
  engine/
    freeze/       detectPlatform.ts collectFromScripts.ts resolveBaseUrl.ts stripExecutables.ts injectCsp.ts
                  internalizeStylesheets.ts absolutizeUrls.ts srcset.ts rescueFonts.ts neutralizeMotion.ts
                  markBadges.ts finalize.ts index.ts (+ *.test.ts each)
    identity/     assignIds.ts nodeIndex.ts byId.ts
    sense/        scheduler.ts fontInventory.ts fontOf.ts cascadeTracer.ts extractPalette.ts detectLogo.ts
                  detectBadges.ts detectIcons.ts detectInvisible.ts imageInventory.ts linkInventory.ts
    ops/          types.ts apply.ts revert.ts ledger.ts cssSync.ts scope.ts (override ladder) text.ts image.ts
    export/       clean.ts serialize.ts inlineImages.ts patch.ts
    canvas/       CanvasHost.ts Overlay.ts targetResolver.ts measure.ts keyboard.ts
    css/          specificity.ts parseFontFamily.ts googleFonts.ts (curated list + css2 URL builder) color.ts
    util/         result.ts hash.ts dom.ts
  store/          projectStore.ts editorStore.ts senseStore.ts
  persistence/    db.ts
  ui/             TopBar/ LeftPanel/{Layers,Assets,Palette,Fonts,Issues} Canvas/ Inspector/{sections} CommandPalette/ StatusBar/ primitives/
fixtures/         framer-min.html webflow-min.html
tests/            unit/ (fuzz.test.ts, roundtrip.test.ts) e2e/ (spike-iframe-listeners, import, select, edit, export …)
docs/             LIMITATIONS.md  ARCHITECTURE.md
DECISIONS.md
```

---

## 7. Platform signatures (confidence-labelled)

| Platform | Signature | Confidence | Used by |
|----------|-----------|------------|---------|
| Framer | `#__framer-badge-container`, `a.__framer-badge` ("Made in Framer") | VERIFIED | F10, detectBadges |
| Framer | Assets on `framerusercontent.com` (fonts under `/assets/`, images under `/images/`, site script under `/sites/…/script_main.*.mjs`) | VERIFIED | provider mapping, stripExecutables |
| Framer | `data-framer-name` (design layer names), `data-framer-component-type` (`RichTextContainer`, `Text`, `Image`, `SVG`…), `.framer-text` | VERIFIED | NodeMeta names, kinds |
| Framer | `data-framer-appear-id` with inline `opacity:0.001` / `transform:perspective(…)` starting states | VERIFY on a real template | F9 |
| Framer | `<meta name="generator" content="Framer …">`, `#main[data-framer-hydrate-v2]` | VERIFY | F1 |
| Framer | CSS custom properties named `--token-<uuid>` for color styles; scoped classes `.framer-<hash>`; breakpoint classes `.framer-72rtr7` style with media queries | VERIFY | palette variables, names |
| Framer | Fallback families `"<Family> Placeholder"` in font stacks | VERIFY | fontOf |
| Webflow | `<html data-wf-page data-wf-site>`, `<meta content="Webflow" name="generator">`, `<!-- This site was created in Webflow -->` | VERIFIED | F1 |
| Webflow | `.w-nav`, `.w-nav-brand`, `.w-nav-menu`, `.w-nav-link`, `.w-nav-button`, `.w-container`, `.w-button`, `.w-embed`, `.w-richtext`, `.w-slider`, `.w-form`, `.w-dyn-list`, `.w--current` | VERIFIED | names, kinds, detectLogo, Issues |
| Webflow | `.w-webflow-badge` anchor to `https://webflow.com?utm_campaign=brandjs`, **injected at runtime by webflow.js** (absent in Ctrl+U, present in DevTools copies) | VERIFIED | F10 kill-rule + marker |
| Webflow | `WebFont.load({ google: { families: ["Inter:regular,500,600,700"] } })` inline script + `webfont.js` | VERIFIED | F2/F8 |
| Webflow | `data-w-id` elements with inline `opacity:0` / transform initial states for IX2 | VERIFY | F9 |
| Webflow | Inline `w-mod-js` / `w-mod-touch` class-adding script; CSS breakpoints 991 / 767 / 479 (+1280/1440/1920) | VERIFIED | presets; do **not** add `w-mod-js` yourself (legacy IX1 rules can hide content under it) |
| Webflow | Asset hosts `cdn.prod.website-files.com`, `assets.website-files.com`, `uploads-ssl.webflow.com`, `d3e54v103j8qbb.cloudfront.net` | VERIFIED | provider mapping |
| Both | CORS availability of CSS on the above CDNs | UNKNOWN — measure per fetch, never assume | F6 |

---

## 8. Truthful UX rules
- Every detector result shows its `basis`. Nothing is labelled "loaded", "internalized", "removed", or "replaced everywhere" unless it was measured.
- Failures are surfaced where they happen (inline in the panel) and aggregated in Issues; the editor never blocks on them.
- The export dialog lists what is included (internalized sheets, override rules, inline images) and what is not (original scripts, external sheets still linked, links pointing to the original site).

---

## 9. Performance budgets (measured with `performance.now()`, logged in dev console and asserted in tests where possible)
| Operation | Budget |
|-----------|--------|
| FREEZE of a 3 MB / 12 k-element document (excluding network for F6) | ≤ 1 500 ms |
| Hover → overlay update | ≤ 1 frame; zero React commits |
| Layers tree first paint with 15 k nodes | ≤ 100 ms (virtualized; flatten only expanded rows) |
| Full SENSE pass on 15 k nodes | ≤ 2 000 ms total, never blocking input > 50 ms |
| Op apply/revert (non-batch) | ≤ 16 ms |
| Autosave of a 6 MB project | off the main thread's critical path (debounced; `structuredClone` cost measured) |
| Memory | one source string + one live iframe; no retained `DOMParser` documents |

---

## 10. Acceptance scenarios (must pass as e2e on both fixtures unless noted)
1. Paste fixture → Freeze → summary shows platform, node count, scripts removed, badge found, (Webflow) 1 external sheet + fonts rescued `Inter, Lora` → Open editor renders without a blank canvas; no `<script>` in the iframe document.
2. Hover the logo → overlay chip shows the tag/name and size; click → Inspector shows kind `svg` (Framer) / `image` (Webflow) and the Assets tab lists it as **Primary logo** with a basis string.
3. Replace the logo via URL → all instances change; undo restores `src`, `srcset`, and `sizes` exactly.
4. Hover the hero heading → Typography shows `Inter` (Framer: provider Framer-hosted or system if not loaded, with truthful status) / `Lora` (Webflow: Google, loaded after font rescue) with weight/size/line-height; change color at scope *Same rule* → all matching elements update; Source shows the edited rule.
5. Palette lists the accent color (`#7c5cff` Framer / `#e8562a` Webflow); replacing it Everywhere updates the CTA button and icons; Framer path goes through `setCssVariable` on the `--token-*` definition (assert one op, not N).
6. Badge: Framer badge removed automatically at import (History shows a `removeNode` op; undo brings it back); Webflow fixture badge removed; kill-rule present in editor CSS; exported HTML contains neither `__framer-badge` nor `w-webflow-badge`.
7. Invisible content: Framer `data-framer-appear-id` heading and Webflow `data-w-id` heading are visible after freeze (F9); Issues lists 0 invisible items; disabling F9 in a test shows them and *Force visible* fixes them. Additionally, a synthetic template with (a) a CSS-rule-hidden appear wrapper, (b) a `position:fixed` opaque preloader covering the viewport, and (c) a `display:none` variant section must, after the F9b sweep, show (a) and hide (b) as two undoable ops with reasons in the Report, and list (c) with a working *Reveal* button; one ⌘Z restores the preloader exactly.
8. Double-click heading → type → blur → text updated, inline children kept; undo restores.
9. Delete a feature card → Layers updates; undo restores at the same index.
10. Switch viewport to 390 → Framer `.framer-links` hidden (media query works without scripts); overlay coordinates remain correct at 50 % zoom.
11. Export → file has no `data-uim-*`, `uim-editor-css`, or `uimaster-frozen`; contains the edits; overrides converted to `.uim-n` classes; re-import yields the same node count ± overrides style; Patch JSON replays onto a fresh import to an identical export.
12. Reload the app → project reopens with all edits (replay), cursor and redo stack intact.
13. Fuzz: 200 random HTML documents freeze without throwing; every op type passes the apply/revert property test.
14. WebKit: e2e 2, 8 pass in the Playwright WebKit project (proves the no-sandbox decision).
15. Stuck first frame: a template whose hero carries `filter: blur(8px)` (inline and via CSS on a wrapper) plus a `paused` keyframe animation renders **crisp** after the sweep; the Report shows the reason breakdown (`blur: 1, paused-animation: 1`); one ⌘Z brings the blur back byte-identically. An element with a *running* CSS entrance animation keeps animating (not flagged). In Preview mode a `:hover` transition on a button visibly animates; switching back to Edit freezes transitions again (`getComputedStyle` transition-duration `0s`).
16. Preview navigation & workspace: clicking a `#features` link smooth-scrolls inside the frame; clicking a same-origin link either freezes the fetched page in-canvas (page chip updates, **Back** restores the previous projection with edits intact) or, when CORS blocks the read, opens a new tab **and** toasts the hostname — never a dead click; clicking a script-only button toasts the JS limitation. `F` enters fullscreen (editor root fills the screen, layout intact), `[` and `]` give the canvas the full width; exiting restores both panels.

---

## Appendix A — Shared types (`src/engine/types.ts`)
```ts
export type Platform = 'framer' | 'webflow' | 'unknown';
export type Result<T, E = UimError> = { ok: true; value: T } | { ok: false; error: E };
export interface UimError { code: string; message: string; cause?: unknown }
export interface Point { x: number; y: number }
export interface Modifiers { alt: boolean; meta: boolean; shift: boolean }
export type Unsubscribe = () => void;

export type NodeKind = 'text' | 'image' | 'svg' | 'video' | 'link' | 'container' | 'badge' | 'style' | 'head' | 'other';
export interface NodeMeta { id: string; tag: string; name: string; kind: NodeKind; classes: string[]; parentId: string | null; childIds: string[]; depth: number }

export interface Project {
  id: string; name: string; createdAt: number; updatedAt: number;
  platform: Platform; baseUrl: string | null; sourceHtml: string;
  ops: Op[]; cursor: number; idCounter: number;
  settings: { autoRemoveBadges: boolean; internalizeCss: boolean };
}
export interface ProjectSummary { id: string; name: string; platform: Platform; nodeCount: number; updatedAt: number }

export interface ResolvedFont { stack: string[]; resolvedFamily: string; provider: FontProvider; loaded: boolean; weight: string; size: string; lineHeight: string; letterSpacing: string; transform: string; color: string }
export type FontProvider = 'google' | 'framer' | 'webflow' | 'adobe' | 'custom' | 'system';
export interface FontEntry { family: string; weights: number[]; styles: ('normal' | 'italic')[]; status: 'loaded' | 'loading' | 'unloaded' | 'error' | 'unknown'; provider: FontProvider; sources: string[]; usageCount: number }

export interface CascadeHit { sheetId: string | 'inline' | 'unreadable'; rulePath: number[]; selector: string; specificity: [number, number, number]; important: boolean; value: string; media: string | null; readable: boolean }
export interface RuleRef { sheetId: string; rulePath: number[]; selector: string; prop: string }
export interface VarRef { sheetId: string; rulePath: number[]; selector: string; name: string }
export interface PaletteEntry { hex: string; usage: { text: number; bg: number; border: number; svg: number; shadow: number }; areaWeight: number; sources: { variables: VarRef[]; rules: RuleRef[]; inline: number }; cluster: string[] }
export interface LogoCandidate { id: string; score: number; basis: string[]; assetKey: string }
export interface BadgeHit { id: string; platform: 'framer' | 'webflow'; basis: string[] }
export interface IconGroup { hash: string; ids: string[]; sample: string }
export interface InvisibleHit { id: string; reason: 'opacity' | 'visibility' | 'transform-offscreen' }
export interface ImageAsset { assetKey: string; ids: string[]; src: string; naturalW: number | null; naturalH: number | null; renderedW: number; renderedH: number; kind: 'img' | 'picture' | 'bg' | 'poster'; broken: boolean }
export interface LinkGroup { href: string; ids: string[] }
```

## Appendix B — Selection & naming examples
- Framer nav logo: `a.framer-logo[data-framer-name="Logo"] > svg` → click resolves to `svg` (rule 4), name shown "Logo › svg", Assets: Primary logo, basis: `inside a[href="./"] in [data-framer-name*="nav"]; data-framer-name contains "logo"`.
- Webflow nav logo: `a.w-nav-brand > img.logo` → resolves to `img`, basis: `inside .w-nav-brand; alt contains "logo"`.
- Framer heading: `div[data-framer-component-type="RichTextContainer"] > h1.framer-text` → resolves to `h1` (rule 5); font resolved from `Inter` after skipping `Inter Placeholder`.
