# CLAUDE.md — Operating rules for building UIMaster

You are the sole engineer building **UIMaster**: a local-first, browser-only, **no-AI** visual editor for pasted page source (Ctrl+U / View Source / DevTools outerHTML) of published **Framer** and **Webflow** sites. The product spec is in `SPEC.md`, the execution plan in `PLAN.md`, test fixtures in `fixtures/`. Read all three files completely before writing a single line of code. These rules override any habit you have.

---

## 1. Truth discipline (anti-hallucination)

1. **Never invent an API.** Before calling any function, method, or option from a third-party package that you are not 100% certain about, open its type definitions (`node_modules/<pkg>/dist/**/*.d.ts`) or README and quote the signature in your reasoning. If it does not exist, do not use it.
2. **Never assume browser behavior.** If a design depends on a browser behavior you cannot cite (event dispatch in sandboxed iframes, CSSOM access across origins, `document.fonts` semantics, `elementsFromPoint` ordering, CORS on a CDN), write a **spike**: a 20-line Playwright test that proves it, run it, and record the result (date, browser, outcome) in `DECISIONS.md`. Then build on the proven behavior.
3. **Never assume platform markup.** Framer and Webflow signatures listed in `SPEC.md §7` carry a confidence label. Treat `VERIFIED` as fact and `VERIFY` as a hypothesis that must be checked against `fixtures/` **and** be written so that a wrong hypothesis degrades gracefully (a detector returns "not found", it never crashes or corrupts the document).
4. **Detectors are measurement-based, not markup-based, whenever possible.** Prefer `getComputedStyle`, `getBoundingClientRect`, `document.fonts`, and the CSSOM over guessing from class names. Class-name heuristics may only *raise the score* of a candidate, never be the sole source of truth.
5. **Say what you did not verify.** Every phase report ends with two lists: `VERIFIED (ran it)` and `ASSUMED (not run)`. Empty `ASSUMED` is the goal.

## 2. No-shortcut discipline

1. **No placeholders.** Forbidden anywhere in the codebase: `TODO`, `FIXME`, `coming soon`, `not implemented`, `simplified for brevity`, `in a real app`, `mock`, `stub`, `dummy`, empty handlers, `return null // later`. CI (`npm run verify`) greps for these tokens and fails.
2. **No silent scope reduction.** You may not drop a feature from `SPEC.md` because it is hard. If something is genuinely impossible in a browser, stop, write the reason and the evidence in `DECISIONS.md`, implement the closest faithful alternative that `SPEC.md` names as fallback, and surface the limitation to the user in the UI (Issues panel) and in `docs/LIMITATIONS.md`.
3. **Complete files only.** Never write a file with `...` or `// rest unchanged`. Write the whole file.
4. **Every op is invertible; every panel writes ops.** A UI control that mutates the canvas DOM directly without going through the ops ledger is a bug.
5. **Fidelity beats convenience.** When two implementations are possible, choose the one that preserves the original template's rendering and exported HTML more faithfully, even if it is more work.

## 3. Verification gates

- Run `npm run verify` (typecheck + lint + unit tests + forbidden-token grep + build) **before** declaring any phase done. Paste the last 30 lines of its output in the phase report.
- Run `npm run e2e` (Playwright, Chromium + WebKit) at the end of Phases 2, 3, 4, 5, 6, 7, 8.
- Do not edit fixtures to make tests pass. Fixtures change only when `SPEC.md §7` changes.
- A gate that fails means you are still in the phase. Fix it; do not proceed.

## 4. Engineering standards

- TypeScript `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. No `any`. No `@ts-ignore`; a `@ts-expect-error` needs a one-line reason.
- React 18 function components only. **Nothing on the hover path may cause a React commit** (see `SPEC.md §4.3`). Hover/overlay updates are imperative DOM writes from a controller class.
- Pure engine code (`src/engine/**`) has zero React imports and zero global `window`/`document` access; it receives `doc: Document` and `win: Window` as parameters so it is unit-testable in jsdom and reusable inside the iframe realm.
- Every engine module exports named functions with explicit return types and a unit test file next to it.
- Errors are values at boundaries: parsing/freezing returns `{ ok: true, value } | { ok: false, error: UimError }`. UI never shows a blank screen; it shows the error and keeps the pasted text.
- Commit after each phase with a Conventional Commit message (`feat(freeze): ...`, `test(ops): ...`). Keep `DECISIONS.md` and `docs/LIMITATIONS.md` up to date as you go, not at the end.

## 5. Decision policy

- Prefer deciding over asking. If `SPEC.md` is ambiguous, pick the option that maximizes template fidelity, write one paragraph in `DECISIONS.md` (context → options → choice → consequence), and continue.
- Ask the user only when blocked by something outside the repo (credentials, a real template URL for Phase 8) or before a destructive action (deleting user data formats).

## 6. Definition of Done (global)

A feature is done only when all of the following are true:

- [ ] Implemented exactly as described in `SPEC.md` (or a logged, justified fallback).
- [ ] Reads/writes through the ops ledger; undo → redo round-trips to identical `outerHTML`.
- [ ] Works on **both** fixtures and does not crash on arbitrary HTML (fuzz test with the `random-html` generator in `tests/unit/fuzz.test.ts`).
- [ ] Covered by a unit test (engine) and/or an e2e test (UI).
- [ ] Meets the performance budget in `SPEC.md §9` with a logged measurement.
- [ ] Surfaces failures to the user truthfully (Issues panel / inline message), never silently.
- [ ] `npm run verify` and, when applicable, `npm run e2e` are green.
