# PLAN.md — Execution plan with verification gates

Work strictly in order. A phase is complete only when its **Gate** is green and the phase report (per `CLAUDE.md §1.5`) has been written. Never start Phase N+1 while Gate N is red. Commit at the end of each phase.

Time-boxing is not allowed to reduce scope: if a phase takes longer, it takes longer.

---

## Phase 0 — Scaffold & guardrails
**Build**
- Vite + React 18 + TypeScript (flags from `CLAUDE.md §4`), Tailwind, ESLint (`typescript-eslint` strict, `react-hooks`), Prettier.
- Dependencies from `SPEC.md §6` only. Record each one's purpose in `DECISIONS.md`.
- Vitest (jsdom environment, `setupTests.ts`), fast-check, Playwright with `chromium` and `webkit` projects, `webServer` pointing at `vite preview`.
- `scripts/check-tokens.mjs`: fails when any forbidden token from `CLAUDE.md §2.1` appears in `src/**` (case-insensitive, whole-word; allow-list only this script and docs).
- `npm run verify` = `typecheck && lint && test && check:tokens && build`.
- Copy `fixtures/framer-min.html` and `fixtures/webflow-min.html` from the pack exactly.
- Create `DECISIONS.md`, `docs/LIMITATIONS.md`, `docs/ARCHITECTURE.md` (pipeline diagram from `SPEC.md §2`).

**Gate 0**: `npm run verify` green with one trivial unit test; `npm run e2e` runs a smoke test that loads `/` in Chromium and WebKit.

---

## Phase 1 — FREEZE + MAP (pure engine)
**Build** `src/engine/freeze/*`, `src/engine/identity/*`, `src/engine/css/{specificity,parseFontFamily,googleFonts}.ts`, `src/engine/util/*`.
- Implement F1–F12 exactly in `SPEC.md §2.1` order. F6 network is injected as a `fetchImpl` parameter so tests can stub success/CORS-failure.
- `srcset.ts` implements the HTML spec parsing algorithm (candidates with commas inside URLs must survive).
- `rescueFonts` covers: `regular`, numeric weights, `italic`, `<n>italic`, multiple families, Typekit, and the sorted-tuple requirement of the CSS2 API.

**Tests (unit, jsdom)**
- Each step: fixture in → assertions on the DOM out + report counters (e.g. Framer fixture: 2 executable scripts removed, 0 noscript, badge marked, appear-id heading opacity removed; Webflow fixture: 4 scripts removed, `WebFont` families `Inter, Lora` rescued into one css2 link with correct axis tuples, `data-w-id` heading opacity removed, 1 external sheet recorded when `fetchImpl` rejects).
- `assignIds` idempotence and document-order stability; ids exist on `<style>` and SVG children.
- `absolutizeUrls` on `srcset` with commas, `url()` in inline style and in `<style>`, relative `@import`.
- Specificity: 20 selector cases including `:is()`, `:where()`, `:not(.a,.b)`, attribute selectors, `::before` stripping.
- Fuzz: 200 random documents (`tests/unit/fuzz.test.ts` generator: random nesting, random attributes, random scripts) freeze without throwing; output contains no executable `<script>`.
- Performance: synthetic 12 k-element document freezes ≤ 1 500 ms (assert with margin ×2 in CI).

**Gate 1**: `npm run verify` green; coverage of `src/engine/freeze/**` ≥ 90 % lines.

---

## Phase 2 — Canvas host, overlay, targeting, Layers
**Spike first**: `tests/e2e/spike-iframe-listeners.spec.ts` — mount a `srcdoc` iframe **without** `sandbox`, with the CSP meta, attach a click listener from the parent, dispatch a real click via Playwright, assert it fired in Chromium **and** WebKit. Record in `DECISIONS.md`. If WebKit fails, stop and investigate before building on it.

**Build**
- `CanvasHost`, `Overlay`, `targetResolver`, `measure`, `keyboard` per `SPEC.md §4`.
- Import screen and Editor shell (TopBar with viewport presets + zoom + mode toggle, Canvas, empty right panel, StatusBar).
- Layers tab (virtualized) with hover/selection sync, expand/collapse, context menu items wired to placeholders **is not allowed** — wire only items whose ops exist (Select parent, Copy selector, Copy outerHTML now; the rest arrive in Phase 3 and must be added then).
- `NodeIndex` built in chunks after load.

**Tests**
- Unit: `targetResolver` rules 1–7 with synthetic stacks; `measure` coordinate math at zoom 0.5/1/1.5.
- E2E (both browsers, both fixtures): hover shows chip with correct tag; click on Framer logo selects `svg`; click on Webflow logo selects `img`; `Enter`/`Shift+Enter` drill; Alt+click raw; 390 px viewport hides `.framer-links`; overlay rect equals element rect at 50 % zoom (±1 px).
- Performance: 15 k-node synthetic document — Layers first paint ≤ 100 ms (measure with `performance.mark`); hover produces zero React commits (assert with React Profiler in a dev-only test harness or by counting renders of `Canvas`).

**Gate 2**: verify + e2e green in Chromium and WebKit.

---

## Phase 3 — Ops ledger, undo/redo, persistence
**Build** `src/engine/ops/*`, `src/store/*`, `src/persistence/db.ts`, Home screen (list/open/delete/import bundle), autosave, replay on open, History list in the command palette.
- Implement every op type in `SPEC.md §2.4.1` with `apply`/`revert`, `preview`/`commit` semantics, CSS text sync (§2.4.3), deterministic ids for inserts/duplicates.
- Wire Layers context menu and Actions: Hide/Show, Delete, Duplicate, Move up/down, Select parent.
- Auto-remove badges after load as committed ops when the setting is on.

**Tests**
- Property tests (fast-check) per op type: `apply→revert` identity, `apply→revert→apply` idempotence (compare `outerHTML`).
- Ledger: commit truncates redo; preview never records; replay from persisted `{ops, cursor}` reproduces identical `outerHTML`.
- E2E: delete card → undo → same index; reload page → edits and redo stack restored; badge auto-removal visible in History and undoable.

**Gate 3**: verify + e2e green.

---

## Phase 4 — Inspector (all sections)
**Build** every section in `SPEC.md §3.4` with the Scope Switch and Override Ladder (§2.4.4); text editing on canvas (§2.4.5); image replace (§2.4.6); `cascadeTracer`, `fontOf`, `fontInventory` (needed by Typography/Source).

**Tests**
- Unit: `cascadeTracer` ordering (important > specificity > source order; media matching; unreadable sheet entry), `fontOf` skipping `Placeholder` families and truthful `loaded`, inline-style validation round-trip.
- Unit (visibility sweep, `SPEC.md §2.1 F9b` / `§2.3`): `detectHidden` returns the **culprit**, not the leaf (wrapper with `opacity:0.001` above a text node); effective-opacity product across 3 nested levels; wrapper `filter: blur(8px)` yields reason `blur` and `applyReveal` strips only the `blur()` function while keeping a sibling `drop-shadow()`; `animation-play-state: paused` with `animation-name` set yields `paused-animation` and is set to `running`; an element whose blur comes from a **running** animation is *not* flagged; `detectOpaqueCovers` fires at ≥ 95 % coverage + alpha > 0.85 and stays silent for a transparent nav overlay and for a cookie wall with 400 chars of text; `applyReveal → revert` restores `style.cssText` byte-identically; `detectHiddenContainers` reports only outermost `display:none` containers.
- Unit (mode-scoped motion, `SPEC.md §2.1.1` / `§4.1`): with `html[data-uim-mode="edit"]` present, computed `transition-duration` is `0s`; after removing the attribute (preview), the template's declared transition duration returns and a `:hover` style change animates; the injected stylesheet contains no global `animation-play-state` rule.
- E2E: scenarios 3, 4, 8 of `SPEC.md §10` on both fixtures; Scope *Same rule* changes all matches; unreadable sheet → override rung produces an `injectRule` op.

**Gate 4**: verify + e2e green.

---

## Phase 5 — SENSE detectors + Assets / Palette / Fonts / Issues
**Build** `extractPalette`, `detectLogo`, `detectBadges`, `detectIcons`, `detectInvisible`, `imageInventory`, `linkInventory`, `scheduler`; the four left-panel tabs; global color replace and font replace (composite ops); command palette actions.

**Tests**
- Unit: palette clustering (ΔE), variable-source detection on the Framer fixture (`--token-…`), logo scoring basis strings, icon grouping by hash, invisible detection with F9 disabled.
- E2E: scenarios 2, 5, 6, 7; palette replace on Framer emits a single `setCssVariable` op; Webflow accent replace rewrites rules in the internalized/inline sheet; font replace adds one Google Fonts link and changes every heading.
- Performance: SENSE pass on 15 k nodes ≤ 2 s, longest task ≤ 50 ms (Long Tasks API in a dev harness).

**Gate 5**: verify + e2e green.

---

## Phase 6 — EXPORT & bundles
**Build** `clean`, `serialize`, `inlineImages`, `patch`, export dialog with truthful inclusion list, "Copy HTML", project bundle export/import.

**Tests**
- Unit: output contains zero `data-uim-`, `uimaster-frozen`, `uim-editor-css`; overrides converted to `.uim-n`; inline images fall back per asset on failure.
- E2E: scenario 11 (round-trip and patch replay equality).

**Gate 6**: verify + e2e green.

---

## Phase 7 — Polish, shortcuts, resilience
**Build** full keyboard map (`SPEC.md §3.5`), command palette search, empty states, error boundaries that keep the paste, 10 MB import handling with progress line, zoom/viewport edge cases, preview mode link guarding, `docs/ARCHITECTURE.md` final.

**Tests**: e2e for every shortcut including `F`/`[`/`]`/`` ` ``/`\` (assert `document.fullscreenElement`, panel widths, and that the floating mini-toolbar appears whenever chrome is hidden and can restore it); drag-resize both panels to their limits and double-click-reset; with viewport = Fit, resizing the window changes the width chip and flips the breakpoint label at the platform thresholds; error boundary test (corrupt project record); preview-mode link policy per `SPEC.md §4.1`: hash link scrolls the frame (stub page), same-origin link served by a local test fixture server freezes in-canvas and **Back** restores edits byte-identically, CORS-blocked link opens a new tab (stub `window.open`) plus toast, script-only button toasts; the iframe itself never leaves `about:srcdoc`.

**Gate 7**: verify + e2e green in both browsers; all §10 scenarios pass.

---

## Phase 8 — Real-template hardening
Ask the user for one real Framer and one real Webflow published URL (or pasted sources). Import via Ctrl+U source **and** via DevTools `outerHTML`. For each: record in `docs/LIMITATIONS.md` what worked, what did not, and why (with evidence). Fix generic issues in engine code (never special-case a single template). Re-run the full suite. Update the `VERIFY` rows of `SPEC.md §7` to `VERIFIED` or correct them.

**Gate 8**: both real templates import, render, allow logo/text/color/font edits, badge removal, and export cleanly; `npm run verify` + `npm run e2e` green; `DECISIONS.md` and `docs/LIMITATIONS.md` current.

---

## Phase report template (paste at the end of each phase)
```
## Phase N report
Built: …
VERIFIED (ran it): …
ASSUMED (not run): …
Gate output (last 30 lines of `npm run verify` / `npm run e2e`): …
Decisions logged: DECISIONS.md#…
Limitations logged: docs/LIMITATIONS.md#…
```
