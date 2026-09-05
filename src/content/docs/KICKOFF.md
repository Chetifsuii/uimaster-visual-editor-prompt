You are building **UIMaster** from scratch in this empty repository.

UIMaster is a local-first, browser-only, **no-AI** visual editor: the user pastes the page source (Ctrl+U / View Source, or DevTools outerHTML) of a published Framer or Webflow site, the app freezes it into a static script-free document, renders it in an in-app canvas, and lets the user hover and click any element to edit it manually like Figma/Framer — text, real detected fonts, colors (element / rule / whole-palette scope), spacing, sizes, images and logos, inline SVG icons, links, attributes, visibility, structure, and one-click removal of the "Made in Framer" / "Made in Webflow" badge — then export a clean standalone HTML file. Every edit is an invertible op with undo/redo, autosave and replay. There is no chat and no model call anywhere in the product.

Three documents in the repo root are the contract:

1. `CLAUDE.md` — your operating rules (truth discipline, no-shortcut discipline, gates, Definition of Done). They override your defaults.
2. `SPEC.md` — the complete technical specification: truth model, the FREEZE → MAP → SENSE → PATCH → EXPORT pipeline, op contract, Scope Switch / Override Ladder, canvas host + overlay + Smart Target Resolver, panels, shortcuts, tech stack, folder layout, confidence-labelled platform signatures, performance budgets, acceptance scenarios, shared types.
3. `PLAN.md` — eight phases, each with a hard verification gate.

Also in the repo: `fixtures/framer-min.html` and `fixtures/webflow-min.html` (do not modify them).

Do this now, in order:

1. Read `CLAUDE.md`, `SPEC.md`, `PLAN.md` and both fixtures completely. Do not write code before you have read every section.
2. Reply with a short plan for Phase 0 only: the exact packages you will install (with the reason for each, from `SPEC.md §6`), the scripts you will add, and the two verification commands. Nothing else.
3. Execute Phase 0. Run `npm run verify` and `npm run e2e`. Paste the last 30 lines of each. Write the Phase 0 report using the template at the end of `PLAN.md`.
4. Continue phase by phase. Never start a phase while the previous gate is red. Never reduce scope silently; log every decision and every limitation where `CLAUDE.md` says to.
5. Before relying on any browser behavior or third-party API you cannot cite, prove it with a spike or by reading the type definitions, and record what you found in `DECISIONS.md`.

Hard constraints, repeated because they are the ones most often broken:
- No placeholders, stubs, mocks, TODOs, "simplified" versions, or "coming soon" UI. Complete files only.
- Nothing on the hover path may trigger a React commit. Overlay updates are imperative.
- Engine code is pure (`doc`, `win` passed in), unit-tested in jsdom, no React imports.
- Every UI control writes through the ops ledger. `apply → revert` must reproduce identical `outerHTML`.
- Do not use the iframe `sandbox` attribute for script blocking (WebKit bug 218086 blocks parent listeners); strip scripts at freeze time and inject the CSP meta, then prove parent listeners fire in WebKit with the Phase 2 spike.
- Detectors are measurement-based (computed styles, `document.fonts`, geometry, CSSOM); class-name heuristics only raise scores.
- Each phase report ends with `VERIFIED (ran it)` and `ASSUMED (not run)` lists. Aim for an empty `ASSUMED`.

Start with step 1.
