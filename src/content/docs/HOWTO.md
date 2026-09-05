# HOWTO — Using this prompt pack with Claude Code

## 1. Set up the repository (2 minutes)

```bash
mkdir uimaster && cd uimaster
git init
mkdir fixtures docs
# Paste the four documents from this pack into these files:
#   CLAUDE.md   SPEC.md   PLAN.md
#   fixtures/framer-min.html   fixtures/webflow-min.html
claude
```

Then paste the **Kickoff prompt** as your first message in Claude Code. Claude Code reads `CLAUDE.md` automatically on start; the kickoff makes it read the other two before doing anything.

If you prefer one single message instead of files, use **Copy everything as one prompt** in the top bar — it concatenates Kickoff + CLAUDE.md + SPEC.md + PLAN.md + both fixtures with clear file markers, and tells Claude to write them to disk first.

## 2. How to get the source of a template

**Framer** (published site or template preview):
1. Open the live site in Chrome (for a template, open the *Preview* link — the real `*.framer.website` / `*.framer.app` URL — not the Framer marketplace page).
2. Press `Ctrl+U` (`Cmd+Option+U` on macOS). Select all, copy.
3. In UIMaster's import screen, paste and put the page URL in the **Base URL** field (needed only if the source contains relative URLs — the import summary tells you).

**Webflow**:
1. Open the live site (`*.webflow.io` or the custom domain). Press `Ctrl+U`, copy everything.
2. Note: the "Made in Webflow" badge is injected by JavaScript at runtime, so it is **not** in the Ctrl+U source. UIMaster's freeze step still injects a kill-rule for it so it never appears in an export. If you copy from DevTools instead (`Elements` → right-click `<html>` → *Copy outerHTML*), the badge **is** in the markup and UIMaster marks it so you can remove it with one click.
3. Webflow loads Google Fonts through a `WebFont.load(...)` script. Because UIMaster strips scripts, the freeze step converts that script into a normal `<link>` so the fonts still load ("Font rescue" in the import summary).

Ctrl+U vs DevTools copy: Ctrl+U gives the server HTML (before scripts ran). DevTools gives the DOM after scripts ran (includes injected badges, lazy-loaded classes, and Framer hydration results). Both are supported; DevTools copies are usually the better starting point for Webflow, Ctrl+U for Framer.

## 3. What to check on the first real template (send this list to Claude Code in Phase 8)

- Import summary is truthful: platform, node count, scripts removed, stylesheets internalized vs external, fonts rescued, badge found.
- The canvas is not blank and the hero text is visible (appear animations neutralized).
- Hovering the logo shows a chip; clicking selects the image/SVG; the **Assets** tab lists it as primary logo with the reason.
- Hovering a heading shows the actual font family with a truthful loaded/not-loaded status and its provider.
- Changing a color in **Palette** at *Everywhere* scope updates buttons, icons and text using that color; undo reverts everything with one step.
- Removing the badge is one click and one History entry.
- Export opens in a new tab with no console errors and no `data-uim-` attributes in the source.

## 4. Prompts to use during the build (copy as needed)

- **When Claude claims something works without output:** "Show me the last 30 lines of `npm run verify` and `npm run e2e`. Do not summarize; paste them."
- **When Claude proposes a simplified version:** "Not allowed by CLAUDE.md §2.2. Implement the SPEC behavior or log the impossibility with evidence in DECISIONS.md and implement the named fallback."
- **When Claude guesses about markup:** "That signature is marked VERIFY in SPEC.md §7. Write the detector so a wrong guess degrades to 'not found', and add the fixture assertion."
- **When Claude asks a question the spec answers:** "Read SPEC.md §<n>. Decide, log in DECISIONS.md, continue."
- **When output looks hallucinated (API you do not recognize):** "Open the .d.ts for that package and quote the signature you are calling."
