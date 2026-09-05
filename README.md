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
  served page. Needs a relay — see below.
- **Paste source** — <kbd>Ctrl</kbd>+<kbd>U</kbd> on the template, paste the whole document.
- **Fixtures** — two bundled sample documents, one Framer-shaped and one Webflow-shaped.

### Template link needs a relay

Publishers do not send `Access-Control-Allow-Origin` for documents, so a page-context fetch of a
template is blocked by CORS. Verified rather than assumed: a request to `https://www.xhulia.com/`
carrying an `Origin` header comes back `200` from `Server: Framer/…` with no `access-control-*` header
at all. Nothing in the browser can read that response, which is why the fetch has to happen
somewhere else.

So the link tab has a **relay endpoint** setting — any URL that answers `?url=` with the page body.
Two are provided:

- **`vite.config.ts`, in dev.** `/__uim/fetch`, the field's default under `npm run dev`. GET only,
  public hosts only, no CORS header of its own, response served as inert `text/plain`, and declared
  `apply: "serve"` so it never reaches a production bundle.
- **`relay/worker.js`, for the deployed build.** The same contract as a Cloudflare Worker, with an
  origin allowlist and `Access-Control-Expose-Headers` so the app can still read `x-uim-final-url`:

  ```bash
  npx wrangler deploy relay/worker.js --name uim-relay --compatibility-date 2026-01-01
  ```

  Paste the resulting `…workers.dev` URL into **Relay endpoint** on the link tab. It is remembered in
  `localStorage`, so this is configuration, not a rebuild.

With no relay configured — the state a fresh static deploy is in — the link tab says so up front and
the failure names the reason instead of suggesting a retry. Paste source and Fixtures are unaffected.

A relay response is only trusted when it carries `x-uim-final-url`. That check is not ceremony: a
static host answering the relay path with its own 404, or with this app via an SPA fallback, produces
something that otherwise looks like a fetched document — and in the SPA case the app would cheerfully
open *itself* in the editor as the imported template. `index.html` carries `data-uim-app` so that
case is caught by name.

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

## Deployment

Live at **https://chetifsuii.github.io/uimaster-visual-editor-prompt/**. The whole app is that one
`dist/index.html`, so there is nothing to route and no asset URLs for a project subpath to break.

Two deploy paths are committed. Only the first is active.

**`gh-pages` branch — active.** Pages is set to *Deploy from a branch* → `gh-pages` → `/`. The branch
holds a prebuilt `index.html` and an empty `.nojekyll`, nothing else. To ship a change, rebuild and
move the branch tip. This writes the built file straight into a commit, so it never touches the
working tree or the `main` history:

```bash
npm run typecheck && npm run build
BLOB=$(git hash-object -w dist/index.html)
NOJ=$(printf '' | git hash-object -w --stdin)
TREE=$(printf "100644 blob $NOJ\t.nojekyll\n100644 blob $BLOB\tindex.html\n" | git mktree)
git push origin "$(git commit-tree $TREE -m 'Publish build')":refs/heads/gh-pages --force
```

**`.github/workflows/deploy.yml` — dormant.** The Actions route (typecheck → build → upload →
`deploy-pages`) is correct but never starts: this account's Actions are billing-locked, and the run
is refused with *"The job was not started because your account is locked due to a billing issue."*
Settle that under Settings → Billing, then switch the Pages source to **GitHub Actions** and every
push to `main` publishes itself — at which point the block above is no longer needed.

## Stack

React 19 · TypeScript (strict) · Tailwind 4 · Vite 7 · `vite-plugin-singlefile`, so `npm run build`
emits one self-contained `dist/index.html`.

There is no test runner; `npm run typecheck` is the gate. The deploy workflow runs it before
building — see Deployment for why that workflow is currently idle.
