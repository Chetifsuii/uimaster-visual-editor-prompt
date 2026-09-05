/**
 * Playground engine — a compact, real implementation of the UIMaster pipeline
 * (FREEZE → MAP → SENSE → EXPORT) used to prove the logic described in SPEC.md.
 * Pure functions: every function receives `doc` / `win` explicitly.
 */

export type Platform = "framer" | "webflow" | "unknown";

export interface FreezeReport {
  platform: Platform;
  evidence: string[];
  nodeCount: number;
  scriptsRemoved: number;
  inlineHandlersRemoved: number;
  noscriptRemoved: number;
  fontsRescued: string[];
  motionNeutralized: number;
  framesNeutralized: number;
  badges: number;
  baseUrl: string | null;
  relativeUrlCount: number;
  warnings: string[];
  durationMs: number;
}

export interface FreezeResult {
  html: string;
  report: FreezeReport;
}

const EXECUTABLE_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "module",
  "text/ecmascript",
  "application/ecmascript",
  "importmap",
]);

// ---------- F1 detectPlatform ----------
export function detectPlatform(doc: Document): { platform: Platform; evidence: string[] } {
  const evidence: string[] = [];
  const html = doc.documentElement;
  if (html.hasAttribute("data-wf-site") || html.hasAttribute("data-wf-page")) evidence.push("html[data-wf-site]/[data-wf-page]");
  const gen = doc.querySelector('meta[name="generator"]')?.getAttribute("content") ?? "";
  if (/webflow/i.test(gen)) evidence.push(`meta generator "${gen}"`);
  if (doc.querySelector(".w-nav, .w-container, .w-button, .w-embed, .w-richtext")) evidence.push("w-* utility classes");
  if (doc.querySelector('link[href*="website-files.com"], script[src*="website-files.com"]')) evidence.push("website-files.com assets");
  if (evidence.length > 0) return { platform: "webflow", evidence };

  if (/framer/i.test(gen)) evidence.push(`meta generator "${gen}"`);
  if (doc.querySelector("[data-framer-name], [data-framer-component-type]")) evidence.push("data-framer-* attributes");
  if (doc.querySelector('[class*="framer-"]')) evidence.push("framer-* classes");
  if (doc.querySelector('[data-framer-hydrate-v2], script[src*="framerusercontent.com"]')) evidence.push("framer hydration / framerusercontent.com");
  if (evidence.length > 0) return { platform: "framer", evidence };

  return { platform: "unknown", evidence: ["no known signatures"] };
}

// ---------- F2 collectFromScripts ----------
export function collectWebFontFamilies(doc: Document): string[] {
  const families: string[] = [];
  doc.querySelectorAll("script").forEach((s) => {
    const text = s.textContent ?? "";
    if (!/WebFont\.load/.test(text)) return;
    const m = /families\s*:\s*\[([^\]]*)\]/.exec(text);
    if (!m || !m[1]) return;
    for (const raw of m[1].split(",")) {
      // families are quoted strings that may themselves contain ":" and ","; re-join tokens that belong together
      const t = raw.trim().replace(/^['"]|['"]$/g, "");
      if (t) families.push(t);
    }
  });
  // Tokens split on "," inside a family spec ("Inter:regular,500") must be merged back: a token without ":" and
  // that looks like a weight belongs to the previous family.
  const merged: string[] = [];
  for (const f of families) {
    const last = merged[merged.length - 1];
    if (last && !f.includes(":") && /^(regular|italic|\d{3}(italic)?)$/.test(f)) merged[merged.length - 1] = `${last},${f}`;
    else merged.push(f);
  }
  return merged;
}

/** Webflow token → Google Fonts CSS2 URL. "Inter:regular,500,600" → family=Inter:wght@400;500;600 */
export function buildGoogleFontsHref(specs: string[]): string | null {
  const params: string[] = [];
  for (const spec of specs) {
    const [familyRaw, variantsRaw] = spec.split(":");
    if (!familyRaw) continue;
    const family = familyRaw.trim().replace(/ /g, "+");
    const variants = (variantsRaw ?? "regular").split(",").map((v) => v.trim()).filter(Boolean);
    const tuples: Array<[number, number]> = [];
    for (const v of variants) {
      if (v === "regular") tuples.push([0, 400]);
      else if (v === "italic") tuples.push([1, 400]);
      else {
        const m = /^(\d{3})(italic)?$/.exec(v);
        if (m && m[1]) tuples.push([m[2] ? 1 : 0, Number(m[1])]);
      }
    }
    if (tuples.length === 0) tuples.push([0, 400]);
    const hasItalic = tuples.some((t) => t[0] === 1);
    const uniq = Array.from(new Map(tuples.map((t) => [`${t[0]},${t[1]}`, t])).values());
    uniq.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const axis = hasItalic ? `ital,wght@${uniq.map((t) => `${t[0]},${t[1]}`).join(";")}` : `wght@${uniq.map((t) => t[1]).join(";")}`;
    params.push(`family=${family}:${axis}`);
  }
  if (params.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

// ---------- F3 resolveBaseUrl ----------
export function resolveBaseUrl(doc: Document, userBase: string): { baseUrl: string | null; relativeUrlCount: number } {
  const fromUser = userBase.trim();
  const candidate =
    fromUser ||
    doc.querySelector("base[href]")?.getAttribute("href") ||
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
    doc.querySelector('meta[property="og:url"]')?.getAttribute("content") ||
    "";
  let baseUrl: string | null = null;
  try {
    if (candidate) baseUrl = new URL(candidate).toString();
  } catch {
    baseUrl = null;
  }
  let relativeUrlCount = 0;
  doc.querySelectorAll("[src], [href], [srcset], [poster]").forEach((el) => {
    for (const attr of ["src", "href", "srcset", "poster"]) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (/^(https?:|data:|blob:|about:|mailto:|tel:|#|javascript:)/i.test(v.trim())) continue;
      if (v.startsWith("//")) continue;
      relativeUrlCount++;
    }
  });
  return { baseUrl, relativeUrlCount };
}

// ---------- F4 stripExecutables ----------
export function stripExecutables(doc: Document): { scripts: number; handlers: number; noscript: number } {
  let scripts = 0;
  doc.querySelectorAll("script").forEach((s) => {
    const type = (s.getAttribute("type") ?? "").trim().toLowerCase();
    if (EXECUTABLE_TYPES.has(type)) {
      s.remove();
      scripts++;
    }
  });
  let noscript = 0;
  doc.querySelectorAll("noscript").forEach((n) => {
    n.remove();
    noscript++;
  });
  let handlers = 0;
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on[a-z]/i.test(attr.name)) {
        el.removeAttribute(attr.name);
        handlers++;
      } else if ((attr.name === "href" || attr.name === "action" || attr.name === "formaction") && /^\s*javascript:/i.test(attr.value)) {
        el.setAttribute(attr.name, "#");
        handlers++;
      }
    }
  });
  doc.querySelectorAll('link[rel="preload"][as="script"], link[rel="modulepreload"], meta[http-equiv="refresh" i]').forEach((l) => l.remove());
  return { scripts, handlers, noscript };
}

// ---------- F5 injectCsp ----------
export function injectCsp(doc: Document): void {
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  // frame-src/child-src: a nested third-party frame runs its own scripts in its own realm, which the
  // page-level script-src does not govern. Measured on midu.design: the hero embeds
  // gradientshader-nine.vercel.app with sandbox="allow-scripts". Without frame-src the script-free
  // invariant would depend on that frame's loading="lazy" never firing.
  meta.setAttribute("content", "script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'");
  doc.head.prepend(meta);
}

/**
 * F5b — neutralize nested browsing contexts. CSP `frame-src 'none'` already blocks the load, but the
 * attribute is also removed so no request is attempted even in a realm that ignores meta CSP.
 * The original URL is parked on `data-uim-frame-src` and restored by exportHtml(), so the exported
 * page keeps its embed.
 */
export function neutralizeFrames(doc: Document): number {
  let count = 0;
  doc.querySelectorAll("iframe[src], frame[src], object[data], embed[src]").forEach((el) => {
    const attr = el.tagName.toLowerCase() === "object" ? "data" : "src";
    const url = el.getAttribute(attr) ?? "";
    if (!url || url === "about:blank") return;
    el.setAttribute("data-uim-frame-src", url);
    el.setAttribute("data-uim-frame-attr", attr);
    el.removeAttribute(attr);
    count++;
  });
  return count;
}

// ---------- F8 rescueFonts ----------
export function rescueFonts(doc: Document, families: string[]): string[] {
  const href = buildGoogleFontsHref(families);
  if (!href) return [];
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", href);
  link.setAttribute("data-uim-rescued-font", "1");
  doc.head.append(link);
  doc.querySelectorAll('link[rel="preload"][as="font"]').forEach((l) => {
    if (!l.hasAttribute("crossorigin")) l.setAttribute("crossorigin", "");
  });
  return families.map((f) => f.split(":")[0] ?? f);
}

// ---------- F9 neutralizeMotion ----------
/**
 * Framer serializes an appear-animation's first frame as a full six-function transform on the child
 * itself, not on the `[data-framer-appear-id]` root. Measured on midu.design: 127 elements carry
 * `opacity:0.001` + that transform and **none** of them has an appear id, so an attribute-only pass
 * misses every per-word reveal. Matching the serialization is what makes those words visible.
 */
const FRAMER_FIRST_FRAME_TRANSFORM = /translateX\([^)]*\)\s*translateY\([^)]*\)\s*scale\([^)]*\)\s*rotate\([^)]*\)\s*skewX\([^)]*\)\s*skewY\([^)]*\)/i;

export function neutralizeMotion(doc: Document): number {
  let count = 0;
  const seen = new Set<Element>();
  const fix = (el: HTMLElement) => {
    if (seen.has(el)) return;
    let touched = false;
    const op = parseFloat(el.style.opacity);
    if (!Number.isNaN(op) && op < 0.05) {
      el.style.removeProperty("opacity");
      touched = true;
    }
    const tf = el.style.transform || el.style.getPropertyValue("-webkit-transform");
    if (tf && /translate|scale|rotate|perspective/i.test(tf)) {
      el.style.removeProperty("transform");
      el.style.removeProperty("-webkit-transform");
      touched = true;
    }
    // Appear animations also start from a blurred frame: inline filter: blur(8px) would otherwise stay forever.
    const fl = el.style.filter || el.style.getPropertyValue("-webkit-filter");
    if (fl && /blur\(/i.test(fl)) {
      el.style.removeProperty("filter");
      el.style.removeProperty("-webkit-filter");
      touched = true;
    }
    if (touched) {
      el.style.removeProperty("will-change");
      el.setAttribute("data-uim-motion", "neutralized");
      seen.add(el);
      count++;
    }
  };
  // Pass 1 — declared animation roots (Framer appear ids, Webflow interaction ids).
  doc.querySelectorAll<HTMLElement>("[data-framer-appear-id], [data-w-id]").forEach(fix);
  // Pass 2 — serialized first frames anywhere in the document, including inside `display:none`
  // breakpoint variants that a runtime sweep cannot see because they are not rendered yet.
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    if (!("style" in el) || typeof el.style?.cssText !== "string") return;
    const opacity = parseFloat(el.style.opacity);
    if (Number.isNaN(opacity) || opacity >= 0.05) return;
    const tf = el.style.transform || el.style.getPropertyValue("-webkit-transform");
    const fl = el.style.filter || el.style.getPropertyValue("-webkit-filter");
    const isFirstFrame = (tf && FRAMER_FIRST_FRAME_TRANSFORM.test(tf)) || (fl && /blur\(/i.test(fl) && tf);
    if (isFirstFrame) fix(el);
  });
  return count;
}

// ---------- F10 markBadges ----------
export function markBadges(doc: Document): number {
  const selectors = [
    "#__framer-badge-container",
    ".__framer-badge",
    ".w-webflow-badge",
    'a[href^="https://webflow.com?utm_campaign=brandjs"]',
  ];
  const found = new Set<Element>();
  selectors.forEach((sel) => doc.querySelectorAll(sel).forEach((el) => found.add(el)));
  doc.querySelectorAll("a").forEach((a) => {
    if (a.children.length <= 2 && /made (in|with) (framer|webflow)/i.test(a.textContent ?? "")) found.add(a);
  });
  // Collapse nested hits to their outermost badge ancestor
  const outer = Array.from(found).filter((el) => !Array.from(found).some((other) => other !== el && other.contains(el)));
  outer.forEach((el) => {
    el.setAttribute("data-uim-role", "badge");
    el.setAttribute("data-uim-badge", el.className.includes("w-webflow") || el.getAttribute("href")?.includes("webflow") ? "webflow" : "framer");
  });
  return outer.length;
}

// ---------- F11 finalize ----------
/** Motion is frozen ONLY in edit mode (stable dragging/overlay). Preview mode plays the template's own CSS animations and transitions. */
export const EDITOR_CSS = `html[data-uim-mode="edit"] *,html[data-uim-mode="edit"] *::before,html[data-uim-mode="edit"] *::after{transition-duration:0s!important;transition-delay:0s!important}
html[data-uim-mode="edit"]{scroll-behavior:auto!important}
html[data-uim-mode="preview"]{scroll-behavior:smooth}
.w-webflow-badge,#__framer-badge-container{display:none!important}
[data-uim-editing="1"]{outline:none!important;cursor:text!important;-webkit-user-modify:read-write-plaintext-only}`;

export function finalize(doc: Document, baseUrl: string | null, needsBase: boolean): void {
  if (!doc.querySelector("meta[charset]")) {
    const m = doc.createElement("meta");
    m.setAttribute("charset", "utf-8");
    doc.head.prepend(m);
  }
  const frozen = doc.createElement("meta");
  frozen.setAttribute("name", "uimaster-frozen");
  frozen.setAttribute("content", "1");
  doc.head.append(frozen);
  const style = doc.createElement("style");
  style.id = "uim-editor-css";
  style.textContent = EDITOR_CSS;
  doc.head.append(style);
  if (needsBase && baseUrl && !doc.querySelector("base")) {
    const base = doc.createElement("base");
    base.setAttribute("href", baseUrl);
    base.setAttribute("data-uim-injected", "1");
    doc.head.prepend(base);
  }
}

// ---------- F12 / MAP assignIds ----------
export function assignIds(doc: Document): number {
  let i = 0;
  doc.querySelectorAll("*").forEach((el) => {
    if (!el.hasAttribute("data-uim-id")) el.setAttribute("data-uim-id", String(i));
    i++;
  });
  return i;
}

// ---------- FREEZE pipeline ----------
export function freeze(rawHtml: string, userBaseUrl = ""): FreezeResult {
  const t0 = performance.now();
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const warnings: string[] = [];

  const { platform, evidence } = detectPlatform(doc);
  const webfontFamilies = collectWebFontFamilies(doc);
  const { baseUrl, relativeUrlCount } = resolveBaseUrl(doc, userBaseUrl);
  if (!baseUrl && relativeUrlCount > 0) warnings.push(`MISSING_BASE_URL: ${relativeUrlCount} relative URL(s) cannot be resolved — add the page URL.`);
  const stripped = stripExecutables(doc);
  injectCsp(doc);
  const framesNeutralized = neutralizeFrames(doc);
  const fontsRescued = rescueFonts(doc, webfontFamilies);
  const motionNeutralized = neutralizeMotion(doc);
  const badges = markBadges(doc);
  if (framesNeutralized > 0)
    warnings.push(`NESTED_FRAMES: ${framesNeutralized} embed(s) parked on data-uim-frame-src so they cannot run scripts in the canvas; export restores them.`);
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
    const href = l.getAttribute("href") ?? "";
    if (/website-files\.com|webflow\.com/.test(href)) warnings.push(`EXTERNAL_SHEET: ${href} — kept as <link>; the full app internalizes it via fetch (CORS permitting).`);
  });
  finalize(doc, baseUrl, relativeUrlCount > 0);
  const nodeCount = assignIds(doc);

  const html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return {
    html,
    report: {
      platform,
      evidence,
      nodeCount,
      scriptsRemoved: stripped.scripts,
      inlineHandlersRemoved: stripped.handlers,
      noscriptRemoved: stripped.noscript,
      fontsRescued,
      motionNeutralized,
      framesNeutralized,
      badges,
      baseUrl,
      relativeUrlCount,
      warnings,
      durationMs: Math.round(performance.now() - t0),
    },
  };
}

// ---------- SENSE helpers ----------
export type NodeKind = "text" | "image" | "svg" | "video" | "link" | "container" | "badge" | "other";

export function hasDirectText(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0);
}

export function kindOf(el: Element): NodeKind {
  if (el.getAttribute("data-uim-role") === "badge") return "badge";
  const tag = el.tagName.toLowerCase();
  if (tag === "svg") return "svg";
  if (tag === "img" || tag === "picture") return "image";
  if (tag === "video") return "video";
  if (hasDirectText(el)) return "text";
  if (tag === "a") return "link";
  if (["div", "section", "header", "footer", "nav", "main", "article", "aside", "ul", "ol", "li", "form"].includes(tag)) return "container";
  return "other";
}

export function nameOf(el: Element): string {
  const framerName = el.getAttribute("data-framer-name");
  if (framerName) return framerName;
  const cls = Array.from(el.classList).find((c) => !c.startsWith("w-") && !c.startsWith("w--") && !c.startsWith("framer-styles"));
  if (cls) return cls;
  if (el.id) return `#${el.id}`;
  return el.tagName.toLowerCase();
}

export function outermostSvg(el: Element): Element {
  let cur: Element = el;
  let out: Element = el;
  while (cur.parentElement) {
    if (cur.tagName.toLowerCase() === "svg") out = cur;
    cur = cur.parentElement;
  }
  return out.tagName.toLowerCase() === "svg" ? out : el;
}

/** Smart Target Resolver (SPEC §4.3, rules 1, 4, 5, 6). */
export function resolveTarget(stack: Element[], alt: boolean): Element | null {
  const filtered = stack
    .filter((el) => {
      const tag = el.tagName.toLowerCase();
      return tag !== "html" && tag !== "body";
    })
    .map((el) => outermostSvg(el));
  const dedup = filtered.filter((el, i) => filtered.indexOf(el) === i);
  if (dedup.length === 0) return stack[0] ?? null;
  if (alt) return dedup[0] ?? null;
  const top3 = dedup.slice(0, 3);
  const media = top3.find((el) => ["img", "svg", "video", "picture", "input", "textarea", "select", "button"].includes(el.tagName.toLowerCase()));
  if (media) return media;
  const first = top3[0];
  if (first && hasDirectText(first)) return first;
  const text = top3.find((el) => hasDirectText(el));
  if (text) return text;
  let best: Element | null = null;
  let bestArea = Infinity;
  for (const el of top3) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area >= 4 && area < bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best ?? first ?? null;
}

export function parseFontFamilyStack(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type FontProvider = "google" | "framer" | "webflow" | "adobe" | "custom" | "system";

export interface ResolvedFont {
  stack: string[];
  resolvedFamily: string;
  loaded: boolean;
  provider: FontProvider;
  weight: string;
  size: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
}

function providerFromUrl(url: string): FontProvider {
  if (/framerusercontent\.com/.test(url)) return "framer";
  if (/fonts\.gstatic\.com|fonts\.googleapis\.com/.test(url)) return "google";
  if (/website-files\.com|webflow\.com/.test(url)) return "webflow";
  if (/typekit\.net/.test(url)) return "adobe";
  if (/local\(/.test(url)) return "system";
  return "custom";
}

function fontFaceSources(doc: Document, family: string): string[] {
  const urls: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const fam = rule.style.getPropertyValue("font-family").replace(/^["']|["']$/g, "").trim();
        if (fam.toLowerCase() === family.toLowerCase()) urls.push(rule.style.getPropertyValue("src"));
      }
    }
  }
  return urls;
}

export function fontOf(el: Element, doc: Document, win: Window): ResolvedFont {
  const cs = win.getComputedStyle(el);
  const stack = parseFontFamilyStack(cs.fontFamily).filter((f) => !/ placeholder$/i.test(f));
  const faces = Array.from(doc.fonts);
  let resolvedFamily = stack[0] ?? cs.fontFamily;
  let loaded = false;
  for (const fam of stack) {
    const match = faces.find((f) => f.family.replace(/^["']|["']$/g, "").toLowerCase() === fam.toLowerCase() && f.status === "loaded");
    if (match) {
      resolvedFamily = fam;
      loaded = true;
      break;
    }
  }
  let provider: FontProvider = "system";
  if (loaded) {
    const srcs = fontFaceSources(doc, resolvedFamily);
    if (srcs.length > 0) provider = providerFromUrl(srcs.join(" "));
    else if (doc.querySelector(`link[href*="fonts.googleapis.com"][href*="${encodeURIComponent(resolvedFamily).replace(/%20/g, "+")}"]`)) provider = "google";
    else provider = "custom";
  }
  return {
    stack,
    resolvedFamily,
    loaded,
    provider,
    weight: cs.fontWeight,
    size: cs.fontSize,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    color: cs.color,
  };
}

// ---------- colors ----------
export function normalizeColor(value: string): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (a === 0) return null;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1] ?? "0")}${hex(m[2] ?? "0")}${hex(m[3] ?? "0")}`;
}

export interface PaletteEntry {
  hex: string;
  weight: number;
  usage: { text: number; bg: number; border: number; svg: number };
}

export function extractPalette(doc: Document, win: Window, limit = 12): PaletteEntry[] {
  const map = new Map<string, PaletteEntry>();
  const bump = (hex: string | null, key: keyof PaletteEntry["usage"], w: number) => {
    if (!hex) return;
    const e = map.get(hex) ?? { hex, weight: 0, usage: { text: 0, bg: 0, border: 0, svg: 0 } };
    e.weight += w;
    e.usage[key] += 1;
    map.set(hex, e);
  };
  const els = Array.from(doc.body.querySelectorAll("*")).slice(0, 6000);
  for (const el of els) {
    if (el.closest("#uim-editor-css")) continue;
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const area = Math.max(1, r.width * r.height);
    if (hasDirectText(el)) bump(normalizeColor(cs.color), "text", Math.max(1, (el.textContent ?? "").length));
    bump(normalizeColor(cs.backgroundColor), "bg", area / 100);
    if (cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0) bump(normalizeColor(cs.borderTopColor), "border", 1);
    if (el.namespaceURI === "http://www.w3.org/2000/svg") {
      bump(normalizeColor(cs.fill), "svg", 2);
      if (cs.strokeWidth !== "0px") bump(normalizeColor(cs.stroke), "svg", 2);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export interface LogoCandidate {
  id: string;
  score: number;
  basis: string[];
  tag: string;
}

export function detectLogo(doc: Document, win: Window, baseUrl: string | null): LogoCandidate[] {
  const vw = win.innerWidth || 1280;
  const zoneSel = 'header, nav, [role="banner"], .w-nav, [data-framer-name*="nav" i], [data-framer-name*="header" i]';
  const candidates: LogoCandidate[] = [];
  const seen = new Set<Element>();
  doc.body.querySelectorAll("img, svg").forEach((raw) => {
    const el = outermostSvg(raw);
    if (seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const inZone = !!el.closest(zoneSel);
    if (!inZone && !(r.top >= 0 && r.top < 160)) return;
    let score = 0;
    const basis: string[] = [];
    const link = el.closest("a[href]");
    if (link) {
      const href = link.getAttribute("href") ?? "";
      const isRoot = href === "/" || href === "./" || href === "index.html" || href === "#" || (baseUrl !== null && href.replace(/\/$/, "") === baseUrl.replace(/\/$/, ""));
      if (isRoot || link.classList.contains("w-nav-brand")) {
        score += 3;
        basis.push(`inside a[href="${href}"]${link.classList.contains("w-nav-brand") ? ".w-nav-brand" : ""}`);
      }
    }
    if (el.closest('[data-framer-name*="logo" i]') || /logo/i.test(el.getAttribute("data-framer-name") ?? "")) {
      score += 3;
      basis.push("data-framer-name contains \"logo\"");
    }
    const haystack = `${el.getAttribute("alt") ?? ""} ${el.className && typeof el.className === "string" ? el.className : el.getAttribute("class") ?? ""} ${el.getAttribute("src") ?? ""} ${el.id}`;
    if (/logo|brand|wordmark/i.test(haystack)) {
      score += 2;
      basis.push("alt/class/src contains logo|brand|wordmark");
    }
    if (r.left < 0.35 * vw) {
      score += 1;
      basis.push("positioned in the left third");
    }
    const area = r.width * r.height;
    if (area >= 400 && area <= 40000) {
      score += 1;
      basis.push(`area ${Math.round(area)}px² fits logo range`);
    }
    if (area > 90000) {
      score -= 2;
      basis.push("area too large");
    }
    if (el.closest("footer")) {
      score -= 3;
      basis.push("inside footer");
    }
    if (el.closest('[data-uim-role="badge"]')) {
      score -= 5;
      basis.push("is a platform badge");
    }
    if (inZone) basis.push("inside header/nav zone");
    candidates.push({ id: el.getAttribute("data-uim-id") ?? "", score, basis, tag: el.tagName.toLowerCase() });
  });
  return candidates.filter((c) => c.score > 2).sort((a, b) => b.score - a.score);
}

// ---------- SENSE: visibility sweep (appears, preloaders, cookie walls) ----------
export interface HiddenHit {
  id: string;
  reason: "opacity" | "visibility" | "transform-offscreen" | "blur" | "paused-animation";
}
export interface CoverHit {
  id: string;
  coverage: number;
  reason: string;
}
export interface SuspiciousHidden {
  id: string;
  name: string;
  contentDescendants: number;
}

const CONTENT_SEL = "img, svg, video";

function alphaOf(color: string): number {
  const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(color);
  return m && m[1] ? parseFloat(m[1]) : 1;
}

/** Elements whose *effective* opacity/visibility hides real content; returns the culprit that sets it. */
export function detectHidden(doc: Document, win: Window, limit = 400): HiddenHit[] {
  const hits: HiddenHit[] = [];
  const seen = new Set<string>();
  const push = (culprit: Element, reason: HiddenHit["reason"], victim: Element) => {
    const id = culprit.getAttribute("data-uim-id");
    if (!id || seen.has(id)) return;
    // Skip hover-sized UI (tooltips, dropdown carets): revealing them would clutter the canvas.
    // Two corrections to a naive area floor, both measured on midu.design:
    //  · Measure the content being hidden, not just the culprit's own box — Framer wraps each nav
    //    link in a per-link container that carries the appear animation's opacity:0.
    //  · A 40x16 nav link is under any sane tooltip floor whichever box you measure, so the floor
    //    cannot be the only test. An *inline* opacity:0 on an element holding text is a first frame
    //    the publisher serialized into the delivered HTML; hover UI keeps its hidden state in a
    //    stylesheet rule (:hover/.open) instead. That inline mark is the discriminator, and being
    //    wrong here only reveals a small element — one entry in the ledger, ⌘Z away.
    const r = culprit.getBoundingClientRect();
    const v = victim.getBoundingClientRect();
    const area = Math.max(r.width * r.height, v.width * v.height);
    const inlineFirstFrame = stylable(culprit) && parseFloat(culprit.style.opacity) < 0.05 && (victim.textContent ?? "").trim().length > 0;
    if (area < 900 && !inlineFirstFrame) return;
    seen.add(id);
    hits.push({ id, reason });
  };
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*")).slice(0, 9000)) {
    if (hits.length >= limit) break;
    if (!(hasDirectText(el) || el.matches(CONTENT_SEL))) continue;
    if (el.closest('[data-uim-role="badge"]')) continue;
    let product = 1;
    let opacityCulprit: HTMLElement | null = null;
    let visibilityCulprit: HTMLElement | null = null;
    let blurCulprit: HTMLElement | null = null;
    let pausedCulprit: HTMLElement | null = null;
    let cur: HTMLElement | null = el;
    while (cur && cur !== doc.documentElement) {
      const cs = win.getComputedStyle(cur);
      const o = parseFloat(cs.opacity);
      if (!Number.isNaN(o)) {
        product *= o;
        if (!opacityCulprit && o < 0.9) opacityCulprit = cur;
      }
      if (!visibilityCulprit && cs.visibility === "hidden") visibilityCulprit = cur;
      // First frame of an appear animation: filter: blur(Npx) the script never clears. A *running* CSS
      // animation resolves on its own, so only flag blur that is stuck (no animation, paused, or faded too).
      if (!blurCulprit && cs.filter && cs.filter !== "none" && /blur\(/i.test(cs.filter) && (cs.animationName === "none" || /paused/.test(cs.animationPlayState) || product < 0.9)) blurCulprit = cur;
      // Keyframes exist but are held at frame 0 until JS flips the play state.
      if (!pausedCulprit && cs.animationName !== "none" && /paused/.test(cs.animationPlayState)) pausedCulprit = cur;
      cur = cur.parentElement;
    }
    if (product < 0.05 && opacityCulprit) {
      push(opacityCulprit, "opacity", el);
      continue;
    }
    if (visibilityCulprit) {
      push(visibilityCulprit, "visibility", el);
      continue;
    }
    if (blurCulprit) {
      push(blurCulprit, "blur", el);
      continue;
    }
    if (pausedCulprit) {
      push(pausedCulprit, "paused-animation", el);
      continue;
    }
    if (win.getComputedStyle(el).transform !== "none") {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > win.innerHeight + 400 || r.right < -100 || r.left > win.innerWidth + 100) push(el, "transform-offscreen", el);
    }
  }
  return hits;
}

/** Opaque fixed/absolute elements covering ≥95% of the viewport with almost no text: preloaders, cookie walls, intro screens that the site's JS dismisses. */
export function detectOpaqueCovers(doc: Document, win: Window, limit = 8): CoverHit[] {
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  if (vw <= 0 || vh <= 0) return [];
  const out: CoverHit[] = [];
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (out.length >= limit) break;
    const cs = win.getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute" && cs.position !== "sticky") continue;
    // Absolute background/hero layers sit *behind* content (z-index auto/0/negative); only raised layers can be covers.
    const zNum = cs.zIndex === "auto" ? 0 : parseInt(cs.zIndex, 10) || 0;
    if (cs.position !== "fixed" && zNum < 1) continue;
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const coverage = (iw * ih) / (vw * vh);
    if (coverage < 0.95) continue;
    const bg = normalizeColor(cs.backgroundColor);
    const opaque = (bg !== null && alphaOf(cs.backgroundColor) > 0.85) || (cs.backgroundImage !== "none" && cs.backgroundImage.includes("gradient"));
    if (!opaque) continue;
    const textLen = (el.textContent ?? "").trim().length;
    if (textLen > 160) continue;
    out.push({
      id: el.getAttribute("data-uim-id") ?? "",
      coverage: Math.round(coverage * 100) / 100,
      reason: `${cs.position} overlay covering ${Math.round(coverage * 100)}% of the viewport, opaque ${bg ?? "gradient"} background, ${textLen} chars of text — a preloader/intro/cookie wall the site's own script would dismiss`,
    });
  }
  // Sampling rule: some templates wrap the opaque layer in a transparent fixed container, so the
  // position/z-index rule above never sees it. Ask the renderer what paints on top at 5 viewport points.
  if (typeof doc.elementsFromPoint === "function" && out.length < limit) {
    const pts: Array<[number, number]> = [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ];
    const tops = pts
      .map(([fx, fy]) => {
        const stack = doc.elementsFromPoint(vw * fx, vh * fy);
        return stack.find((el) => el.tagName.toLowerCase() !== "html" && el.tagName.toLowerCase() !== "body") ?? null;
      })
      .filter((el): el is Element => el !== null);
    if (tops.length === pts.length) {
      // deepest common ancestor-or-self of all five topmost elements
      let common: Element | null = tops[0];
      while (common && !tops.every((t) => common !== null && (t === common || common.contains(t)))) common = common.parentElement;
      const isRootish = (el: Element | null) => el === null || el.tagName.toLowerCase() === "html" || el.tagName.toLowerCase() === "body";
      if (!isRootish(common) && common) {
        const cRect = common.getBoundingClientRect();
        const cCov = (Math.max(0, Math.min(cRect.right, vw) - Math.max(cRect.left, 0)) * Math.max(0, Math.min(cRect.bottom, vh) - Math.max(cRect.top, 0))) / (vw * vh);
        const stack0 = doc.elementsFromPoint(vw * 0.5, vh * 0.5);
        const opaqueEl = stack0.find((el) => {
          if (common !== null && !common.contains(el) && el !== common) return false;
          const s = win.getComputedStyle(el);
          const b = normalizeColor(s.backgroundColor);
          return (b !== null && alphaOf(s.backgroundColor) > 0.85) || (s.backgroundImage !== "none" && s.backgroundImage.includes("gradient"));
        });
        const textLen = (common.textContent ?? "").trim().length;
        const allContent = doc.body.querySelectorAll("p, h1, h2, h3, h4, img, svg, video, a, button").length;
        const insideContent = common.querySelectorAll("p, h1, h2, h3, h4, img, svg, video, a, button").length;
        // A real full-bleed hero shows several visible content leaves; a preloader shows a spinner/logo at most.
        let visibleInside = 0;
        for (const leaf of Array.from(common.querySelectorAll("*")).slice(0, 600)) {
          if (visibleInside > 2) break;
          if (!(hasDirectText(leaf) || leaf.matches(CONTENT_SEL))) continue;
          const ls = win.getComputedStyle(leaf);
          const lr = leaf.getBoundingClientRect();
          if (parseFloat(ls.opacity) > 0.9 && ls.visibility === "visible" && lr.width * lr.height > 400) visibleInside++;
        }
        if (cCov >= 0.95 && opaqueEl && textLen <= 160 && visibleInside <= 2 && allContent - insideContent >= 20) {
          const id = common.getAttribute("data-uim-id") ?? "";
          if (id && !out.some((o) => o.id === id)) {
            out.push({
              id,
              coverage: Math.round(cCov * 100) / 100,
              reason: `topmost paint at all 5 sampled viewport points is one opaque subtree (${Math.round(cCov * 100)}% coverage, ${textLen} chars of text) while ${allContent - insideContent} content elements sit underneath — an intro/preloader/cookie wall the site's own script would dismiss`,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Outermost display:none containers that hold real content (JS-revealed sections). Not auto-fixed: surfaced with a per-item Reveal action. */
export function detectHiddenContainers(doc: Document, win: Window, limit = 12): SuspiciousHidden[] {
  const out: SuspiciousHidden[] = [];
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (out.length >= limit) break;
    if (win.getComputedStyle(el).display !== "none") continue;
    let p = el.parentElement;
    let nested = false;
    while (p && p !== doc.body) {
      if (win.getComputedStyle(p).display === "none") {
        nested = true;
        break;
      }
      p = p.parentElement;
    }
    if (nested) continue;
    let content = 0;
    el.querySelectorAll("*").forEach((c) => {
      if (content > 60) return;
      if (hasDirectText(c) || c.matches(CONTENT_SEL)) content++;
    });
    if (content >= 8) out.push({ id: el.getAttribute("data-uim-id") ?? "", name: nameOf(el), contentDescendants: content });
  }
  return out;
}

/** Cross-realm safe: elements may belong to the iframe realm while this runs in the parent realm, so `instanceof HTMLElement` is wrong. */
function stylable(el: Element | null): el is HTMLElement {
  return el !== null && "style" in el && typeof (el as HTMLElement).style?.cssText === "string";
}

export function applyReveal(doc: Document, ids: string[]): () => void {
  const snaps = ids
    .map((id) => {
      const el = byId(doc, id);
      return stylable(el) ? { el, css: el.style.cssText } : null;
    })
    .filter((s): s is { el: HTMLElement; css: string } => s !== null);
  snaps.forEach(({ el }) => {
    const w = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    const cs = w ? w.getComputedStyle(el) : null;
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("visibility", "visible", "important");
    el.style.setProperty("transform", "none", "important");
    if (cs && cs.filter && cs.filter !== "none" && /blur\(/i.test(cs.filter)) {
      // Strip only the blur() component; keep any other filter functions the design intends.
      const stripped = cs.filter.replace(/blur\([^)]*\)/gi, "").replace(/\s{2,}/g, " ").trim();
      el.style.setProperty("filter", stripped === "" ? "none" : stripped, "important");
    }
    if (cs && cs.animationName !== "none" && /paused/.test(cs.animationPlayState)) {
      el.style.setProperty("animation-play-state", "running", "important");
    }
  });
  return () => snaps.forEach(({ el, css }) => {
    el.style.cssText = css;
  });
}

export function applyHide(doc: Document, ids: string[]): () => void {
  const snaps = ids
    .map((id) => {
      const el = byId(doc, id);
      return stylable(el) ? { el, css: el.style.cssText } : null;
    })
    .filter((s): s is { el: HTMLElement; css: string } => s !== null);
  snaps.forEach(({ el }) => el.style.setProperty("display", "none", "important"));
  return () => snaps.forEach(({ el, css }) => {
    el.style.cssText = css;
  });
}

/**
 * Global recolor — golden path first (CSS custom properties defined in readable sheets),
 * then computed-match inline fallback. Returns a revert closure.
 */
export function replaceColorEverywhere(doc: Document, win: Window, fromHex: string, toHex: string): { varsChanged: number; inlined: number; revert: () => void } {
  const reverts: Array<() => void> = [];
  let varsChanged = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    // CSSOM edits stay live in the projection; exportHtml() re-serializes <style> text from the CSSOM.
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!/^(:root|html|body)$/.test(rule.selectorText.trim())) continue;
      for (const prop of Array.from(rule.style)) {
        if (!prop.startsWith("--")) continue;
        const probe = doc.createElement("span");
        probe.style.color = rule.style.getPropertyValue(prop).trim();
        doc.body.append(probe);
        const computed = normalizeColor(win.getComputedStyle(probe).color);
        probe.remove();
        if (computed === fromHex) {
          const before = rule.style.getPropertyValue(prop);
          rule.style.setProperty(prop, toHex);
          reverts.push(() => rule.style.setProperty(prop, before));
          varsChanged++;
        }
      }
    }
  }
  let inlined = 0;
  const props: Array<{ prop: "color" | "backgroundColor" | "borderColor" | "fill" | "stroke"; css: string }> = [
    { prop: "color", css: "color" },
    { prop: "backgroundColor", css: "background-color" },
    { prop: "borderColor", css: "border-color" },
    { prop: "fill", css: "fill" },
    { prop: "stroke", css: "stroke" },
  ];
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement | SVGElement>("*"))) {
    const cs = win.getComputedStyle(el);
    for (const { prop, css } of props) {
      if (prop === "color" && !hasDirectText(el)) continue;
      if ((prop === "fill" || prop === "stroke") && el.namespaceURI !== "http://www.w3.org/2000/svg") continue;
      if (normalizeColor(cs[prop]) === fromHex) {
        const before = el.style.getPropertyValue(css);
        el.style.setProperty(css, toHex);
        reverts.push(() => (before ? el.style.setProperty(css, before) : el.style.removeProperty(css)));
        inlined++;
      }
    }
  }
  return { varsChanged, inlined, revert: () => reverts.reverse().forEach((r) => r()) };
}

// ---------- EXPORT ----------
export function exportHtml(doc: Document): string {
  // Sync CSSOM edits back into <style> text first so the clone carries them.
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode;
    if (!(owner instanceof HTMLStyleElement) || owner.id === "uim-editor-css") continue;
    try {
      const text = Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
      if (text !== owner.textContent) owner.textContent = text;
    } catch {
      // unreadable sheet: leave as is
    }
  }
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  // Restore nested-frame URLs parked by neutralizeFrames() BEFORE the data-uim-* sweep below removes them.
  clone.querySelectorAll("[data-uim-frame-src]").forEach((el) => {
    const url = el.getAttribute("data-uim-frame-src");
    const attr = el.getAttribute("data-uim-frame-attr") || "src";
    if (url) el.setAttribute(attr, url);
  });
  clone.querySelectorAll('#uim-editor-css, meta[name="uimaster-frozen"], meta[http-equiv="Content-Security-Policy"], base[data-uim-injected]').forEach((n) => n.remove());
  clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  // querySelectorAll returns descendants only — the root <html> element must be cleaned explicitly.
  [clone, ...Array.from(clone.querySelectorAll("*"))].forEach((el) => {
    for (const attr of Array.from(el.attributes)) if (attr.name.startsWith("data-uim-")) el.removeAttribute(attr.name);
  });
  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

export function byId(doc: Document, id: string): Element | null {
  return doc.querySelector(`[data-uim-id="${id}"]`);
}
