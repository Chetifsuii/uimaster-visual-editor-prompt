import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { BROWSER_HEADERS, RELAY_PATH, normalizeSiteUrl } from "./src/playground/importer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Dev-only page-source relay for the playground's "Site URL" import.
 *
 * A page-context fetch of https://midu.design/ is blocked by CORS — publishers do not send
 * Access-Control-Allow-Origin for documents — so the request is made here, server-side, with the
 * same headers a browser navigation sends. That is what makes URL import return the same bytes as
 * Ctrl+U rather than a bot-flavoured variant.
 *
 * Deliberately NOT a general proxy:
 *   · GET only, http/https only, public hostnames only (normalizeSiteUrl rejects the rest).
 *   · No Access-Control-Allow-Origin, so only the app itself can read a response.
 *   · Response is served as text/plain to keep the bytes intact and unrenderable.
 *   · Never present in `vite build` output — apply: "serve".
 */
function pageSourceRelay(): Plugin {
  return {
    name: "uim-page-source-relay",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(RELAY_PATH, async (req, res) => {
        const send = (status: number, body: string, headers: Record<string, string> = {}) => {
          res.statusCode = status;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.end(body);
        };
        if (req.method !== "GET") return send(405, "Relay accepts GET only.");
        const asked = new URL(req.url ?? "", "http://localhost").searchParams.get("url");
        if (!asked) return send(400, "Missing ?url=");

        let target: string;
        try {
          target = normalizeSiteUrl(asked);
        } catch (e) {
          return send(400, e instanceof Error ? e.message : String(e));
        }

        const started = Date.now();
        try {
          const upstream = await fetch(target, { headers: BROWSER_HEADERS, redirect: "follow" });
          const body = await upstream.text();
          server.config.logger.info(
            `[uim-relay] ${upstream.status} ${target} → ${body.length.toLocaleString()} bytes in ${Date.now() - started} ms`,
          );
          if (!upstream.ok) return send(502, `Upstream answered ${upstream.status} ${upstream.statusText}.`);
          return send(200, body, {
            "x-uim-final-url": upstream.url || target,
            "x-uim-upstream-status": String(upstream.status),
            "x-uim-upstream-content-type": upstream.headers.get("content-type") ?? "",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          server.config.logger.warn(`[uim-relay] failed ${target}: ${msg}`);
          return send(502, `Fetching ${target} failed: ${msg}`);
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), pageSourceRelay()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
