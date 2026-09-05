/**
 * URL import — fetch a published Framer/Webflow page's source instead of pasting it.
 *
 * Ctrl+U gives the browser the exact bytes the server sent. To match that from inside the app the
 * request has to look like a browser navigation, which a page-context `fetch` cannot do: it is
 * subject to CORS, and Framer/Webflow do not send `Access-Control-Allow-Origin` for documents.
 * So two channels are tried in order and the one that served the bytes is reported:
 *
 *   1. `direct`  — page-context fetch. Zero infrastructure, works only for permissive origins.
 *   2. `relay`   — the dev server's `/__uim/fetch` middleware performs the request server-side with
 *                  browser-equivalent headers. Same origin as the app, so no CORS involved.
 *
 * This is the one place in the product that touches the network, and it exists only to obtain the
 * source the user would otherwise paste. Everything after it (FREEZE → MAP → SENSE → PATCH →
 * EXPORT) still runs entirely in the tab.
 */

export type ImportChannel = "direct" | "relay";

export interface ImportAttempt {
  channel: ImportChannel;
  ok: boolean;
  status: number | null;
  detail: string;
  ms: number;
}

export interface ImportResult {
  html: string;
  bytes: number;
  requestedUrl: string;
  /** URL after redirects, as reported by the channel that served the bytes. */
  finalUrl: string;
  channel: ImportChannel;
  contentType: string;
  attempts: ImportAttempt[];
  notes: string[];
  /** Which builder published the page, decided from the markup once it arrives. */
  platform: Platform;
  /** The signature that decided it, so the claim is checkable rather than asserted. */
  platformEvidence: string;
}

export type Platform = "framer" | "webflow" | "unknown";

export interface PlatformGuess {
  platform: Platform;
  /**
   * `published` — the address serves the rendered page, which is what the pipeline needs.
   * `gallery`   — a store listing *about* a template; its markup is the shop, not the template.
   * `signed-preview` — a builder's own preview URL, bound to a session rather than served to anyone.
   * `custom-domain` — unknowable from the host alone; the markup decides after the fetch.
   */
  kind: "published" | "gallery" | "signed-preview" | "custom-domain";
  hint: string;
  /** For gallery links, the address that usually serves the real page. A guess, and labelled as one. */
  livePreview?: string;
}

/** True when the address is not expected to serve the page itself, so the UI can say so up front. */
export function isWrongKindOfAddress(kind: PlatformGuess["kind"]): boolean {
  return kind === "gallery" || kind === "signed-preview";
}

/** Short suffix for the platform chip, so "Webflow" alone never implies an importable page. */
export const KIND_SUFFIX: Record<PlatformGuess["kind"], string> = {
  published: "",
  gallery: " listing",
  "signed-preview": " preview link",
  "custom-domain": "",
};

/**
 * What the address alone can tell you, before any bytes move.
 *
 * Worth doing separately from the markup check because the two answer different questions. The
 * markup tells you what a page *is*; the host tells you whether fetching it is even the right move.
 * The trap this exists to catch: a template's marketplace listing looks like the obvious thing to
 * paste — it is the page you were just reading — but its HTML is the store's own Framer/Webflow
 * site, so the import "succeeds" and hands you a shop page to edit. Naming that before the fetch
 * costs nothing and saves the confused round trip.
 */
export function guessPlatformFromUrl(input: string): PlatformGuess {
  let host = "";
  let path = "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return { platform: "unknown", kind: "custom-domain", hint: "" };
  }

  const slug = (re: RegExp) => path.match(re)?.[1]?.replace(/\/$/, "") ?? "";

  if (/(^|\.)framer\.(website|app|media)$/.test(host)) {
    return { platform: "framer", kind: "published", hint: "Framer free-subdomain page — this is the published document." };
  }
  if (/(^|\.)framer\.com$/.test(host)) {
    const s = slug(/\/(?:marketplace\/)?templates?\/([^/]+)/i);
    return {
      platform: "framer",
      kind: "gallery",
      hint: "This is the Framer marketplace listing, not the template. Open its Preview and import that address instead.",
      livePreview: s ? `https://${s}.framer.website/` : undefined,
    };
  }
  if (/(^|\.)webflow\.io$/.test(host)) {
    return { platform: "webflow", kind: "published", hint: "Webflow staging domain — this is the published document." };
  }
  if (host === "preview.webflow.com") {
    return {
      platform: "webflow",
      kind: "signed-preview",
      hint: "A Webflow designer preview is a signed, session-bound URL that does not serve the page to a plain request. Use the site's .webflow.io address or its custom domain.",
    };
  }
  if (/(^|\.)webflow\.com$/.test(host)) {
    const s = slug(/\/templates?\/(?:html\/)?([^/]+)/i);
    return {
      platform: "webflow",
      kind: "gallery",
      hint: "This is the Webflow template listing, not the template. Open its live preview and import that address instead.",
      livePreview: s ? `https://${s}.webflow.io/` : undefined,
    };
  }
  return { platform: "unknown", kind: "custom-domain", hint: "Custom domain — the builder is identified from the markup once the page arrives." };
}

/**
 * Decide the builder from the delivered document. Both platforms brand their output heavily, so this
 * is signature matching rather than inference: Framer namespaces attributes and serves assets from
 * framerusercontent.com, Webflow stamps `data-wf-page`/`data-wf-site` on `<html>` and serves from
 * website-files.com. Checked in descending order of how hard the signature is to fake, and the
 * winning signature is returned so the UI can show *why* rather than just asserting a logo.
 */
export function detectPlatformFromHtml(html: string): { platform: Platform; evidence: string } {
  const head = html.slice(0, 200_000);
  const tests: [Platform, string, RegExp][] = [
    ["framer", "data-framer-* attributes", /\sdata-framer-[a-z-]+=/i],
    ["webflow", "data-wf-page / data-wf-site on <html>", /\sdata-wf-(?:page|site)=/i],
    ["framer", 'meta generator "Framer"', /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*framer/i],
    ["webflow", 'meta generator "Webflow"', /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*webflow/i],
    ["framer", "framerusercontent.com assets", /framerusercontent\.com/i],
    ["webflow", "website-files.com assets", /(?:assets|cdn\.prod)\.website-files\.com/i],
    ["webflow", "w-* utility classes", /class=["'][^"']*\bw-(?:container|row|col|nav|slider)\b/i],
  ];
  for (const [platform, evidence, re] of tests) {
    if (re.test(head)) return { platform, evidence };
  }
  return { platform: "unknown", evidence: "no Framer or Webflow signature found — imported as generic HTML" };
}

export const RELAY_PATH = "/__uim/fetch";

/** Browser-equivalent request headers — what makes a relayed fetch return the same SSR output as Ctrl+U. */
export const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

const PRIVATE_HOST =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|169\.254(\.\d+){2}|.*\.local)$/i;

/**
 * Accept what a user actually types ("midu.design", "https://midu.design/", a URL with tracking
 * params) and return an absolute http(s) URL, or throw with the reason.
 */
export function normalizeSiteUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter the address of a published Framer or Webflow page.");
  if (/\s/.test(raw)) throw new Error("That looks like more than one address — paste a single page URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a URL. Expected something like https://midu.design/`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https can be imported — "${url.protocol}" cannot.`);
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    throw new Error(`"${url.hostname || raw}" is not a public hostname.`);
  }
  if (url.username || url.password) throw new Error("Remove the credentials from the URL before importing.");
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`${url.hostname} is a private or loopback address — import published pages only.`);
  }
  return url.toString();
}

/** True when the payload is an HTML document rather than JSON/an image/a redirect stub. */
export function looksLikeHtmlDocument(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}

/** What a channel can know on its own: the platform verdict needs the body, so it is added afterwards. */
type ChannelResult = Omit<ImportResult, "platform" | "platformEvidence">;

async function tryDirect(url: string, fetchImpl: typeof fetch): Promise<ChannelResult | ImportAttempt> {
  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, { redirect: "follow", credentials: "omit", headers: { accept: BROWSER_HEADERS.accept } });
    if (!res.ok) {
      return { channel: "direct", ok: false, status: res.status, detail: `${res.status} ${res.statusText}`, ms: ms(t0) };
    }
    const html = await res.text();
    return {
      html,
      bytes: new Blob([html]).size,
      requestedUrl: url,
      finalUrl: res.url || url,
      channel: "direct",
      contentType: res.headers.get("content-type") ?? "",
      attempts: [{ channel: "direct", ok: true, status: res.status, detail: `${res.status} ${res.statusText}`, ms: ms(t0) }],
      notes: [],
    };
  } catch (e) {
    // A CORS rejection is indistinguishable from a network failure by design — both land here.
    return { channel: "direct", ok: false, status: null, detail: e instanceof Error ? e.message : String(e), ms: ms(t0) };
  }
}

async function tryRelay(url: string, fetchImpl: typeof fetch): Promise<ChannelResult | ImportAttempt> {
  const t0 = performance.now();
  try {
    const res = await fetchImpl(`${RELAY_PATH}?url=${encodeURIComponent(url)}`, { credentials: "omit" });
    const html = await res.text();
    if (!res.ok) {
      const detail = html.slice(0, 300) || `${res.status} ${res.statusText}`;
      return { channel: "relay", ok: false, status: res.status, detail, ms: ms(t0) };
    }
    const upstream = Number(res.headers.get("x-uim-upstream-status") ?? "0");
    return {
      html,
      bytes: new Blob([html]).size,
      requestedUrl: url,
      finalUrl: res.headers.get("x-uim-final-url") || url,
      channel: "relay",
      contentType: res.headers.get("x-uim-upstream-content-type") ?? "",
      attempts: [{ channel: "relay", ok: true, status: upstream || res.status, detail: `upstream ${upstream || res.status}`, ms: ms(t0) }],
      notes: [],
    };
  } catch (e) {
    return { channel: "relay", ok: false, status: null, detail: e instanceof Error ? e.message : String(e), ms: ms(t0) };
  }
}

function isResult(v: ChannelResult | ImportAttempt): v is ChannelResult {
  return "html" in v;
}

export async function importFromUrl(input: string, fetchImpl: typeof fetch = fetch): Promise<ImportResult> {
  const url = normalizeSiteUrl(input);
  const guess = guessPlatformFromUrl(url);
  const attempts: ImportAttempt[] = [];

  for (const run of [tryDirect, tryRelay]) {
    const out = await run(url, fetchImpl);
    if (isResult(out)) {
      const notes: string[] = [];
      if (out.channel === "relay") {
        notes.push("Served by the dev-server relay: the browser cannot read a cross-origin document response, so the request was made server-side with browser-equivalent headers.");
      }
      if (attempts.length > 0) notes.push(`Direct fetch failed first (${attempts[0]?.detail ?? "unknown"}).`);
      if (out.finalUrl !== out.requestedUrl) notes.push(`Redirected to ${out.finalUrl} — that URL is used as the asset base.`);
      if (!looksLikeHtmlDocument(out.html)) {
        throw new Error(`${out.finalUrl} returned ${out.bytes.toLocaleString()} bytes of ${out.contentType || "unknown content"}, not an HTML document.`);
      }
      // The markup outranks the hostname: a Framer site on a custom domain is still a Framer site,
      // and a marketplace listing is still a shop page no matter how template-shaped its URL looked.
      const { platform, evidence } = detectPlatformFromHtml(out.html);
      if (isWrongKindOfAddress(guess.kind)) notes.push(`Heads up: ${guess.hint}`);
      return { ...out, attempts: [...attempts, ...out.attempts], notes, platform, platformEvidence: evidence };
    }
    attempts.push(out);
  }

  const lines = attempts.map((a) => `${a.channel}: ${a.detail}`).join(" · ");
  throw new Error(
    `Could not fetch ${url}. ${lines}.${guess.hint ? ` ${guess.hint}` : ""} The relay only exists while the dev server is running; in a built single-file bundle use Ctrl+U and paste.`,
  );
}
