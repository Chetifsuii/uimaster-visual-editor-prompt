/**
 * Cloudflare Worker page-source relay — the deployed counterpart of the dev middleware in
 * vite.config.ts. Deploy it once, paste its URL into the playground's "Relay endpoint" field, and
 * Template link import works on the static build.
 *
 *   npx wrangler deploy relay/worker.js --name uim-relay --compatibility-date 2026-01-01
 *
 * Why a server is unavoidable: a browser cannot read a cross-origin document response unless the
 * publisher sends Access-Control-Allow-Origin, and Framer and Webflow do not send it for documents.
 * So the request has to be made somewhere that CORS does not apply, with the headers a browser
 * navigation would send — otherwise the bytes differ from Ctrl+U, which is the whole claim.
 *
 * Deliberately narrow, for the same reasons the dev relay is:
 *   · GET only; http/https only; public hostnames only — private and loopback ranges are refused, so
 *     this cannot be pointed at a metadata service or something inside a network.
 *   · Response is text/plain, so the fetched markup can never render as a page on this origin.
 *   · No cookies forwarded either way, and nothing is stored or logged.
 *
 * ALLOWED_ORIGINS decides who may read a response. Leave it empty and the relay answers any origin,
 * which is the correct posture for a personal relay serving a public page but means anyone who finds
 * the URL can use it as a fetcher. Naming your own origins is the better default.
 */

const ALLOWED_ORIGINS = [
  "https://chetifsuii.github.io",
  "http://localhost:5173",
];

const BROWSER_HEADERS = {
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

/** Mirror of normalizeSiteUrl in src/playground/importer.ts — kept in sync by hand; it is 20 lines. */
function normalizeSiteUrl(input) {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Missing ?url=");
  if (/\s/.test(raw)) throw new Error("That is more than one address.");
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https, not "${url.protocol}".`);
  if (!url.hostname.includes(".")) throw new Error(`"${url.hostname}" is not a public hostname.`);
  if (url.username || url.password) throw new Error("Remove the credentials from the URL.");
  if (PRIVATE_HOST.test(url.hostname)) throw new Error(`${url.hostname} is a private or loopback address.`);
  return url.toString();
}

function corsFor(request) {
  const origin = request.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";
  if (!allow) return null;
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, OPTIONS",
    // Without this the browser hides the three x-uim-* headers and the importer cannot tell a real
    // relay response from a host's fallback page.
    "access-control-expose-headers": "x-uim-final-url, x-uim-upstream-status, x-uim-upstream-content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export default {
  async fetch(request) {
    const cors = corsFor(request);
    const send = (status, body, extra = {}) =>
      new Response(body, {
        status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          ...(cors ?? {}),
          ...extra,
        },
      });

    if (!cors) return send(403, "This relay does not serve that origin. Add it to ALLOWED_ORIGINS.");
    if (request.method === "OPTIONS") return send(204, null);
    if (request.method !== "GET") return send(405, "Relay accepts GET only.");

    let target;
    try {
      target = normalizeSiteUrl(new URL(request.url).searchParams.get("url"));
    } catch (e) {
      return send(400, e.message);
    }

    try {
      const upstream = await fetch(target, { headers: BROWSER_HEADERS, redirect: "follow" });
      const body = await upstream.text();
      if (!upstream.ok) return send(502, `Upstream answered ${upstream.status} ${upstream.statusText}.`);
      return send(200, body, {
        "x-uim-final-url": upstream.url || target,
        "x-uim-upstream-status": String(upstream.status),
        "x-uim-upstream-content-type": upstream.headers.get("content-type") ?? "",
      });
    } catch (e) {
      return send(502, `Fetching ${target} failed: ${e.message}`);
    }
  },
};
