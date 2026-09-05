# UIMaster — Claude Code prompt pack

A browsable, copyable brief for building **UIMaster**: a no-AI, Figma-style editor for pasted
Framer and Webflow page source. The site presents the pack (kickoff prompt, `CLAUDE.md`, `SPEC.md`,
`PLAN.md`, plus two HTML fixtures) and ships a **working implementation of the engine** so the
claims in the spec can be checked rather than taken on trust.

## The engine, in five stages

| Stage | What it does |
| --- | --- |
| **FREEZE** | Strips executables, injects CSP, internalizes CSS, absolutizes URLs, rescues `WebFont.load` fonts, neutralizes appear-states, marks platform badges. |
| **MAP** | Assigns a stable `data-uim-id` to every element in document order and builds a NodeIndex with Framer/Webflow-aware names and kinds. |
| **SENSE** | Measurement-based detectors: `document.fonts`, a cascade tracer, computed palette with CSS-variable sources, geometry-scored logo, icons, invisible content. |
| **PATCH** | Every edit is an invertible, JSON-serializable op — preview/commit, undo/redo, deterministic replay, Scope Switch and Override Ladder. |
| **EXPORT** | Clone, strip editor artifacts, convert overrides to classes, serialize. Round-trip tested; zero `data-uim-*` in the output. |

`Truth = sourceHtml + ops[]` · `Projection = freeze(source) + apply(ops)` · `Export = clean(serialize(projection))`

## Running it locally

```bash
npm install
npm run dev
```

Then open the printed URL and pick **Live engine playground**.

## Importing a template

Three ways in, on the playground's source tabs:

- **Template link** — paste a published Framer or Webflow address. The app identifies the builder
  from the markup (not the hostname, so a Framer site on a custom domain still resolves correctly)
  and warns when the address is a marketplace listing or a signed builder preview rather than a
  served page.
- **Paste source** — <kbd>Ctrl</kbd>+<kbd>U</kbd> on the template, paste the whole document.
- **Fixtures** — two bundled sample documents, one Framer-shaped and one Webflow-shaped.

### Template link needs the dev server

Publishers do not send `Access-Control-Allow-Origin` for documents, so a page-context fetch of a
template is blocked by CORS. The fix is a small **dev-only** relay in `vite.config.ts` that makes the
request server-side with browser-equivalent headers — GET only, public hosts only, no CORS header of
its own, response served as inert `text/plain`. It is declared `apply: "serve"`, so it never reaches
a production bundle.

On the deployed build there is no server, so **Template link cannot fetch** and the app says so in
its error text. Paste source and Fixtures work fully. To exercise link import, run it locally.

## Theme

Two palettes, switched by the sun/moon control in the sidebar and remembered in `localStorage`:
**ivory** (default) and **slate**. Both are Anthropic-inspired — clay accent, olive for live states,
kraft for cautions.

The whole theme is one variable table in `src/index.css`. Tailwind 4's `@theme inline` compiles
`bg-zinc-950` to `var(--t-n-950)` rather than a literal, so flipping `data-theme` on `<html>`
repaints everything without touching a single utility class. In the ivory palette every ramp runs
backwards on purpose: the components were written dark-first, so inverting the ramp keeps
`bg-zinc-950 text-zinc-100` reading as page-on-ink in a light theme.

Typography pairs Space Grotesk (display), Inter (UI), Source Serif 4 (prose) and IBM Plex Mono
(source views) — open-licensed stand-ins for Anthropic's licensed Styrene and Tiempos.

## Stack

React 19 · TypeScript (strict) · Tailwind 4 · Vite 7 · `vite-plugin-singlefile`, so `npm run build`
emits one self-contained `dist/index.html`.

There is no test runner; `npm run typecheck` is the gate, and CI runs it before every deploy.
