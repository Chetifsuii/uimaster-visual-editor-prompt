import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ClipboardPaste, Download, FileCode2, Globe, Loader2, Snowflake, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { fixtures } from "@/content";
import { freeze, type FreezeReport, type FreezeResult } from "./engine";
import { guessPlatformFromUrl, importFromUrl, isWrongKindOfAddress, KIND_SUFFIX, RELAY_PATH, type ImportResult } from "./importer";
import { compareFrozen, type CompareResult } from "./compare";
import { Btn, Chip, Segmented, inputCls } from "./ui";
import { Editor } from "./Editor";

type SourceTab = "url" | "paste" | "fixture";

interface Slot {
  label: string;
  origin: string;
  raw: string;
  frozen: string;
  report: FreezeReport;
}

/**
 * Starting points for the link tab. Two published template pages — one per platform — plus the page
 * this build was validated against. Real addresses rather than placeholder text, because the first
 * question anyone has about a URL importer is "what does it accept", and a chip you can click
 * answers it faster than a sentence describing the answer.
 */
const PRESETS: { label: string; url: string; platform: "framer" | "webflow" }[] = [
  { label: "midu.design", url: "https://midu.design/", platform: "framer" },
  { label: "Framer template", url: "https://frameruniversity.framer.website/", platform: "framer" },
  { label: "Webflow template", url: "https://webflow-ecommerce-template.webflow.io/", platform: "webflow" },
];

const PLATFORM_LABEL = { framer: "Framer", webflow: "Webflow", unknown: "unrecognized builder" } as const;

/**
 * Whether a relay is reachable is a property of the deployment, not of the code, so it is a setting
 * rather than a constant. `import.meta.env.DEV` is true only under `vite dev`, where the middleware in
 * vite.config.ts is mounted; a built bundle starts with nothing and says so, and stays useful the
 * moment a relay is pointed at it — no rebuild, because the value lives in localStorage.
 */
const RELAY_STORAGE_KEY = "uim-relay-endpoint";
const RELAY_DEFAULT = import.meta.env.DEV ? RELAY_PATH : "";

function storedRelay(): string {
  try {
    return localStorage.getItem(RELAY_STORAGE_KEY) ?? RELAY_DEFAULT;
  } catch {
    return RELAY_DEFAULT;
  }
}

const VERDICT_TONE = { identical: "green", equivalent: "green", divergent: "red" } as const;
const VERDICT_TEXT = {
  identical: "Byte-for-byte identical sources",
  equivalent: "Equivalent — same frozen document",
  divergent: "Divergent — the frozen documents differ",
} as const;

export function Playground() {
  const [tab, setTab] = useState<SourceTab>("url");
  const [raw, setRaw] = useState("");
  const [origin, setOrigin] = useState("nothing loaded");
  const [baseUrl, setBaseUrl] = useState("");
  const [siteUrl, setSiteUrl] = useState("https://midu.design/");
  const [relayUrl, setRelayUrl] = useState(storedRelay);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [frozen, setFrozen] = useState<FreezeResult | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotA, setSlotA] = useState<Slot | null>(null);
  const [slotB, setSlotB] = useState<Slot | null>(null);
  const [cmp, setCmp] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const kb = useMemo(() => (new Blob([raw]).size / 1024).toFixed(1), [raw]);
  const guess = useMemo(() => guessPlatformFromUrl(siteUrl), [siteUrl]);

  useEffect(() => {
    try {
      localStorage.setItem(RELAY_STORAGE_KEY, relayUrl);
    } catch {
      // Storage denial only costs the setting its memory between reloads; the import still works now.
    }
  }, [relayUrl]);
  /** A pasted address in the source box is a link, not a document — offer the right tab instead of failing. */
  const pastedLooksLikeUrl = useMemo(() => {
    const t = raw.trim();
    return t.length > 0 && t.length < 2048 && !t.includes("<") && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(t);
  }, [raw]);

  const load = (text: string, from: string, base = "") => {
    setRaw(text);
    setOrigin(from);
    setBaseUrl(base);
    setFrozen(null);
    setError(null);
  };

  const doFreeze = useCallback((): FreezeResult | null => {
    setError(null);
    if (raw.trim().length < 40) {
      setError("Load a full HTML document first — paste the Ctrl+U source, import a URL, or load a fixture.");
      return null;
    }
    try {
      const result = freeze(raw, baseUrl);
      setFrozen(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [raw, baseUrl]);

  const doImport = useCallback(
    async (thenEdit = false): Promise<{ result: ImportResult; frozen: FreezeResult } | null> => {
      setError(null);
      setImporting(true);
      try {
        const result = await importFromUrl(siteUrl, { relayUrl });
        setRaw(result.html);
        setOrigin(`${result.finalUrl} · ${result.channel} channel`);
        setBaseUrl(result.finalUrl);
        setImported(result);
        const f = freeze(result.html, result.finalUrl);
        setFrozen(f);
        if (thenEdit) setOpen(true);
        return { result, frozen: f };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setImported(null);
        return null;
      } finally {
        setImporting(false);
      }
    },
    [siteUrl, relayUrl],
  );

  const capture = (which: "A" | "B") => {
    const f = doFreeze();
    if (!f) return;
    const slot: Slot = { label: which, origin, raw, frozen: f.html, report: f.report };
    if (which === "A") setSlotA(slot);
    else setSlotB(slot);
    setCmp(null);
  };

  const runCompare = (a: Slot | null = slotA, b: Slot | null = slotB) => {
    if (!a || !b) {
      setError("Fill both slots first — capture one source into A and the other into B.");
      return;
    }
    setError(null);
    setCmp(compareFrozen(a.raw, b.raw, a.frozen, b.frozen));
  };

  /** The headline comparison the pipeline has to survive: pasted Ctrl+U source vs the same page fetched by URL. */
  const compareBoth = useCallback(async () => {
    if (raw.trim().length < 40) {
      setError("Paste the Ctrl+U source into slot A first, then this button fetches the same URL for slot B.");
      return;
    }
    setBusy("Freezing the pasted source…");
    const pasted = freeze(raw, baseUrl);
    const a: Slot = { label: "A", origin: origin === "nothing loaded" ? "pasted source" : origin, raw, frozen: pasted.html, report: pasted.report };
    setSlotA(a);
    setBusy(`Fetching ${siteUrl}…`);
    const got = await doImport();
    setBusy(null);
    if (!got) return;
    const b: Slot = { label: "B", origin: `${got.result.finalUrl} · ${got.result.channel}`, raw: got.result.html, frozen: got.frozen.html, report: got.frozen.report };
    setSlotB(b);
    runCompare(a, b);
  }, [raw, baseUrl, origin, siteUrl, doImport]);

  // Every hook lives above this line: the editor branch returns early, and a hook after it would be
  // skipped on the render that opens the editor — which React reports as "rendered fewer hooks".
  if (frozen && open) {
    return (
      <Editor
        frozen={frozen}
        onBack={() => {
          setOpen(false);
        }}
      />
    );
  }

  const r = frozen?.report;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
      <header className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Chip tone="green">Live engine demo</Chip>
          <Chip tone="zinc">no AI · no model call · runs in your tab</Chip>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Drop in a Framer or Webflow link, edit the page like Figma</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-6 text-zinc-400">
          A working implementation of the pipeline in <span className="text-zinc-200">SPEC.md</span>: FREEZE (strip scripts, CSP with <code className="text-zinc-300">frame-src 'none'</code>, font rescue, motion neutralizer, badge marking) → MAP (stable <code className="text-zinc-300">data-uim-id</code>) → SENSE (fonts via <code className="text-zinc-300">document.fonts</code>, computed palette, scored logo detection, post-load visibility sweep) → invertible edits → clean EXPORT. Paste a published template's address and it is fetched, identified, frozen and opened in the editor in one step; paste the Ctrl+U source and you get the same document, which the compare card proves rather than promises.
        </p>
      </header>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "url", label: "Template link" },
                { value: "paste", label: "Paste source" },
                { value: "fixture", label: "Fixtures" },
              ]}
            />
            <span className="ml-auto truncate font-mono text-[11px] text-zinc-500" title={origin}>
              {kb} KB · {origin}
            </span>
          </div>
          {tab === "paste" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Btn
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      .readText()
                      .then((t) => load(t, "clipboard paste"))
                      .catch(() => setError("Clipboard read was blocked by the browser — paste into the box manually."));
                  }}
                >
                  <ClipboardPaste size={14} /> Read clipboard
                </Btn>
                <span className="text-[11.5px] text-zinc-500">Ctrl+U on the published page, select all, paste here. ⌘/Ctrl+Enter freezes.</span>
              </div>
              {pastedLooksLikeUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    setSiteUrl(raw.trim());
                    setTab("url");
                    setError(null);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md border border-sky-600/50 bg-sky-500/10 px-2.5 py-1.5 text-left text-[11.5px] text-sky-200 hover:bg-sky-500/20"
                >
                  <Globe size={13} className="shrink-0" /> That is a link, not a document — import <code className="truncate font-mono">{raw.trim()}</code> instead.
                </button>
              ) : null}
              <textarea
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setOrigin("pasted source");
                  setFrozen(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doFreeze();
                }}
                spellCheck={false}
                placeholder={"<!DOCTYPE html>\n<html> … paste the whole view-source output here …"}
                className={`${inputCls} h-[380px] resize-y font-mono text-[11.5px] leading-5`}
              />
            </div>
          ) : null}

          {tab === "url" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] text-zinc-500">Try:</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    onClick={() => {
                      setSiteUrl(p.url);
                      setError(null);
                    }}
                    title={p.url}
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${
                      siteUrl === p.url ? "border-indigo-500 bg-indigo-600/20 text-indigo-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void doImport(true);
                  }}
                  placeholder="https://your-template.framer.website/ or https://your-site.webflow.io/"
                  className={`${inputCls} min-w-0 flex-1 font-mono`}
                />
                <Btn variant="primary" disabled={importing} onClick={() => void doImport(true)}>
                  {importing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} {importing ? "Fetching…" : "Import & edit"}
                </Btn>
                <Btn disabled={importing} onClick={() => void doImport(false)}>
                  <Download size={14} /> Import only
                </Btn>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <Chip tone={guess.platform === "unknown" ? "zinc" : isWrongKindOfAddress(guess.kind) ? "amber" : "green"}>
                  {guess.platform === "unknown" ? "builder unknown" : PLATFORM_LABEL[guess.platform]}
                  {KIND_SUFFIX[guess.kind]}
                </Chip>
                <span className="min-w-0 flex-1 text-zinc-500">{guess.hint}</span>
              </div>
              {isWrongKindOfAddress(guess.kind) && guess.livePreview ? (
                <button
                  type="button"
                  onClick={() => setSiteUrl(guess.livePreview!)}
                  className="flex items-center gap-1.5 rounded-md border border-amber-600/50 bg-amber-500/10 px-2.5 py-1.5 text-left text-[11.5px] text-amber-200 hover:bg-amber-500/20"
                >
                  <Globe size={13} className="shrink-0" /> Use <code className="font-mono">{guess.livePreview}</code> instead — the usual published address for this template (a guess from the slug, not a lookup).
                </button>
              ) : null}
              {relayUrl ? (
                <p className="text-[11.5px] leading-5 text-zinc-500">
                  A page-context <code className="text-zinc-300">fetch</code> is tried first; publishers do not send CORS headers for documents, so it normally falls through to the relay at{" "}
                  <code className="text-zinc-300">{relayUrl}</code>, which requests the page with browser-equivalent headers. That relay is the only network call in the product and it only replaces the paste — freeze, sense, edit and export still run entirely in this tab.
                </p>
              ) : (
                <div className="rounded-lg border border-amber-600/50 bg-amber-500/10 p-3 text-[11.5px] leading-5 text-amber-200">
                  <div className="flex items-start gap-1.5">
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                    <div>
                      <span className="font-medium">This build cannot fetch a link.</span> A page-context <code className="font-mono">fetch</code> of someone else's page is blocked by CORS — Framer and Webflow send no{" "}
                      <code className="font-mono">Access-Control-Allow-Origin</code> for documents — and there is no server here to do it instead. That is a property of static hosting, not a bug to retry.{" "}
                      <span className="text-amber-100">Paste source</span> and <span className="text-amber-100">Fixtures</span> work fully; they were never going to differ, which is what the compare card exists to show.
                    </div>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="uim-relay" className="text-[11px] whitespace-nowrap text-zinc-500">
                  Relay endpoint
                </label>
                <input
                  id="uim-relay"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value.trim())}
                  placeholder={`${RELAY_PATH} in dev, or https://your-relay.workers.dev/fetch`}
                  className={`${inputCls} min-w-0 flex-1 font-mono text-[11px]`}
                />
                {relayUrl !== RELAY_DEFAULT ? (
                  <button type="button" onClick={() => setRelayUrl(RELAY_DEFAULT)} className="text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-300">
                    reset
                  </button>
                ) : null}
              </div>
              <p className="text-[11px] leading-4 text-zinc-600">
                Remembered in this browser. Any endpoint that answers <code className="font-mono">?url=</code> with the page body works; see <code className="font-mono">relay/worker.js</code> in the repo for a
                deployable one. Requests still leave your browser only for the address you type.
              </p>
              {imported ? (
                <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-925 p-3 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={imported.platform === "unknown" ? "zinc" : "violet"}>{PLATFORM_LABEL[imported.platform]}</Chip>
                    <Chip tone={imported.channel === "direct" ? "green" : "sky"}>{imported.channel} channel</Chip>
                    <span className="text-zinc-300">{imported.bytes.toLocaleString()} bytes</span>
                    <span className="font-mono text-[11px] text-zinc-500">{imported.contentType || "no content-type"}</span>
                  </div>
                  <p className="text-[11px] leading-4 text-zinc-500">Identified by {imported.platformEvidence}.</p>
                  <ul className="space-y-0.5 text-[11px] text-zinc-400">
                    {imported.attempts.map((a) => (
                      <li key={a.channel} className="font-mono">
                        {a.ok ? "✓" : "✗"} {a.channel} · {a.detail} · {a.ms} ms
                      </li>
                    ))}
                  </ul>
                  {imported.notes.map((n) => (
                    <p key={n} className="text-[11px] leading-4 text-zinc-500">
                      {n}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "fixture" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Btn onClick={() => load(fixtures.framer, "framer fixture")}>
                  <FileCode2 size={14} /> Load Framer fixture
                </Btn>
                <Btn onClick={() => load(fixtures.webflow, "webflow fixture")}>
                  <FileCode2 size={14} /> Load Webflow fixture
                </Btn>
              </div>
              <p className="text-[11.5px] leading-5 text-zinc-500">
                Small hand-checked documents carrying the signatures the detectors key on — appear animations, interaction ids, a WebFont.load call, both platform badges. Useful for watching one mechanism at a time.
              </p>
              <pre className={`${inputCls} h-[300px] overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap`}>{raw || "— load a fixture —"}</pre>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Asset base URL — optional, auto-detected from canonical / og:url"
              className={`${inputCls} min-w-0 flex-1 font-mono`}
            />
            <Btn variant="primary" onClick={doFreeze}>
              <Snowflake size={14} /> Freeze
            </Btn>
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/40 p-3 text-[12px] leading-5 text-red-200">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          ) : null}
          <section className="rounded-lg border border-zinc-800 bg-zinc-925">
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Compare import channels</h3>
              <Btn variant="primary" className="ml-auto" disabled={busy !== null || importing} onClick={() => void compareBoth()}>
                {busy || importing ? <Loader2 size={14} className="animate-spin" /> : <ArrowLeftRight size={14} />} Ctrl+U ↔ URL
              </Btn>
            </div>
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              {([slotA, slotB] as const).map((slot, i) => {
                const which = i === 0 ? "A" : "B";
                return (
                  <div key={which} className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Chip tone={slot ? "indigo" : "zinc"}>slot {which}</Chip>
                      <Btn variant="ghost" className="ml-auto" onClick={() => capture(which)}>
                        Capture current
                      </Btn>
                    </div>
                    {slot ? (
                      <div className="space-y-0.5 text-[11.5px] text-zinc-400">
                        <div className="truncate font-mono text-[11px] text-zinc-300" title={slot.origin}>
                          {slot.origin}
                        </div>
                        <div>
                          {slot.report.platform} · {slot.report.nodeCount.toLocaleString()} nodes · {new Blob([slot.raw]).size.toLocaleString()} raw bytes
                        </div>
                        <div>
                          {slot.report.scriptsRemoved} scripts · {slot.report.motionNeutralized} first frames · {slot.report.framesNeutralized} embeds
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11.5px] leading-5 text-zinc-500">Empty. Load a source above and press Capture current.</p>
                    )}
                  </div>
                );
              })}
            </div>
            {busy ? <p className="px-3 pb-3 text-[11.5px] text-zinc-400">{busy}</p> : null}
            {cmp ? (
              <div className="space-y-2 border-t border-zinc-800 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={VERDICT_TONE[cmp.verdict]}>{cmp.verdict}</Chip>
                  <span className="text-[12px] text-zinc-200">{VERDICT_TEXT[cmp.verdict]}</span>
                </div>
                <table className="w-full text-left text-[11.5px]">
                  <thead>
                    <tr className="text-zinc-500">
                      <th className="py-1 font-medium">metric</th>
                      <th className="py-1 font-medium">A</th>
                      <th className="py-1 font-medium">B</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {cmp.metrics.map((m) => (
                      <tr key={m.label} className="border-t border-zinc-800/70">
                        <td className="py-1 pr-2 font-sans text-zinc-400">{m.label}</td>
                        <td className={`py-1 pr-2 ${m.same ? "text-zinc-300" : "text-amber-300"}`}>{m.a}</td>
                        <td className={`py-1 ${m.same ? "text-zinc-300" : "text-amber-300"}`}>{m.b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] leading-4 text-zinc-500">
                  {cmp.rawIdentical
                    ? "The two captures are the same bytes, so every downstream stage is trivially identical."
                    : cmp.normalizedIdentical
                      ? `Raw bytes differ only in fields that cannot carry meaning here (${cmp.volatileApplied.join(", ")}); normalise those and the two sources are equal, character for character.`
                      : `Raw bytes differ beyond the volatile fields${cmp.volatileApplied.length ? ` (normalised: ${cmp.volatileApplied.join(", ")})` : ""}. ${cmp.lineCountA.toLocaleString()} vs ${cmp.lineCountB.toLocaleString()} tag-lines.`}
                </p>
                {cmp.hunks.length > 0 ? (
                  <div className="space-y-1">
                    <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">first differing regions</h4>
                    {cmp.hunks.map((h, idx) => (
                      <div key={`${h.line}-${idx}`} className="overflow-hidden rounded border border-zinc-800 bg-zinc-950/60 p-1.5 font-mono text-[10.5px] leading-4">
                        <div className="text-zinc-500">line {h.line.toLocaleString()}</div>
                        <div className="truncate text-emerald-300/80" title={h.a}>
                          A {h.a.slice(0, 220)}
                        </div>
                        <div className="truncate text-sky-300/80" title={h.b}>
                          B {h.b.slice(0, 220)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-925 p-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Freeze report</h3>
            {!r ? (
              <p className="text-[12px] leading-5 text-zinc-500">Load a source, then press Freeze. The report only states what was measured.</p>
            ) : (
              <div className="space-y-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={r.platform === "framer" ? "indigo" : r.platform === "webflow" ? "sky" : "zinc"}>{r.platform}</Chip>
                  <span className="text-zinc-400">{r.durationMs} ms</span>
                </div>
                <ul className="space-y-1 text-zinc-300">
                  <li>
                    <b className="text-ink">{r.nodeCount.toLocaleString()}</b> elements mapped with stable ids
                  </li>
                  <li>
                    <b className="text-ink">{r.scriptsRemoved}</b> executable scripts removed · <b className="text-ink">{r.inlineHandlersRemoved}</b> inline handlers · <b className="text-ink">{r.noscriptRemoved}</b> noscript
                  </li>
                  <li>
                    fonts rescued: <b className="text-ink">{r.fontsRescued.length ? r.fontsRescued.join(", ") : "none needed"}</b>
                  </li>
                  <li>
                    motion first frames neutralized: <b className="text-ink">{r.motionNeutralized}</b>
                  </li>
                  <li>
                    nested embeds parked: <b className="text-ink">{r.framesNeutralized}</b>
                  </li>
                  <li>
                    platform badges marked: <b className="text-ink">{r.badges}</b>
                  </li>
                  <li>
                    base URL: <span className="font-mono text-[11px] text-zinc-400">{r.baseUrl ?? "none"}</span>
                  </li>
                </ul>
                <div className="text-[10.5px] leading-4 text-zinc-500">evidence: {r.evidence.join("; ")}</div>
                {r.warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {r.warnings.map((w) => (
                      <li key={w} className="rounded border border-amber-900/50 bg-amber-950/30 p-1.5 text-[11px] leading-4 text-amber-200/90">
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Btn variant="primary" className="mt-2 w-full justify-center" onClick={() => setOpen(true)}>
                  <Sparkles size={14} /> Open editor
                </Btn>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-925 p-4 text-[11.5px] leading-5 text-zinc-500">
            <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              <Globe size={12} /> Why two channels
            </h3>
            Ctrl+U shows the exact bytes the server sent, which is why paste is the reference path and works in the built single-file bundle with no server at all. URL import is the convenience path: it needs the dev relay because the browser refuses to hand a page cross-origin document bytes. The compare card exists to keep the convenience path honest — if the relay ever returned a bot-flavoured variant, the verdict would say <span className="text-zinc-300">divergent</span> and name the field.
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-925 p-4 text-[11.5px] leading-5 text-zinc-500">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Left to the full build</h3>
            Stylesheet internalization over the network, URL absolutization (the demo injects <code className="text-zinc-300">&lt;base&gt;</code> instead), the cascade tracer + <em>Same rule</em> scope, virtualized Layers tree, serializable ops with IndexedDB replay, and the fuzz/e2e suites — all specified in SPEC.md.
          </div>
        </div>
      </div>
    </div>
  );
}
