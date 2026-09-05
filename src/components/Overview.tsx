import { ArrowRight, BookOpenCheck, Check, Copy, FlaskConical, ShieldCheck, Workflow } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { buildMegaPrompt, docs, wordCount } from "@/content";
import { cn } from "@/utils/cn";

/** Scroll reveal: sections fade/slide in once when they enter the viewport. */
function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn("transition-all duration-700 ease-out", shown ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0", className)}
    >
      {children}
    </div>
  );
}

const stages = [
  { name: "FREEZE", desc: "Strip executables, inject CSP, internalize CSS, absolutize URLs, rescue WebFont.load fonts, neutralize appear-states, mark badges." },
  { name: "MAP", desc: "Stable data-uim-id per element in document order; NodeIndex with Framer/Webflow-aware names and kinds." },
  { name: "SENSE", desc: "Measurement-based detectors: document.fonts, cascade tracer, computed palette (+ CSS variable sources), scored logo, icons, invisible content." },
  { name: "PATCH", desc: "Every edit is an invertible, JSON-serializable op. preview/commit, undo/redo, deterministic replay, Scope Switch + Override Ladder." },
  { name: "EXPORT", desc: "Clone → strip editor artifacts → convert overrides to classes → serialize. Round-trip tested; zero data-uim-* in output." },
];

const guards = [
  ["Truth discipline", "No API may be used without quoting its .d.ts; no browser behavior may be relied on without a Playwright spike recorded in DECISIONS.md."],
  ["Confidence-labelled signatures", "Every Framer/Webflow markup assumption is marked VERIFIED or VERIFY, and detectors must degrade to 'not found' when a guess is wrong."],
  ["Forbidden tokens in CI", "TODO, stub, mock, 'simplified', 'coming soon' fail the build. Complete files only. No silent scope reduction."],
  ["Hard gates per phase", "Eight phases; each ends with npm run verify + Playwright (Chromium and WebKit) and a report listing VERIFIED vs ASSUMED."],
  ["Known traps pre-empted", "WebKit bug 218086 (sandboxed srcdoc blocks parent listeners), Webflow badge injected at runtime, Framer 'Placeholder' font families, srcset commas, CSS url() relative to the sheet."],
  ["Measurement over guessing", "Fonts from document.fonts, colors from computed styles, logo from geometry + link target, invisibility from opacity/visibility/transform."],
];

export function Overview({ onNavigate }: { onNavigate: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const total = docs.filter((d) => d.inMegaPrompt).reduce((n, d) => n + wordCount(d.content), 0);

  const copyAll = () => {
    void navigator.clipboard.writeText(buildMegaPrompt()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="mb-8 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-indigo-300">
        <span className="rounded border border-indigo-800 bg-indigo-950/50 px-1.5 py-0.5">Claude Code prompt pack</span>
        <span className="text-zinc-500">·</span>
        <span className="text-zinc-400">{total.toLocaleString()} words across 6 files</span>
      </div>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-ink">
        UIMaster — a no-AI, Figma-style editor for pasted Framer &amp; Webflow source.
      </h1>
      <p className="mt-4 max-w-3xl font-serif text-[17px] leading-8 text-zinc-400">
        You paste the Ctrl+U source of a template preview. UIMaster freezes it, renders it, and lets you hover anything, detect its real font, swap the logo, recolor the palette, edit text in place, strip the platform badge, and export clean HTML — all by hand, like Figma, with no model in the loop. This pack is the complete, technical, anti-hallucination brief that makes Claude Code build exactly that.
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        <button type="button" onClick={copyAll} className="inline-flex items-center gap-2 rounded-lg border border-indigo-500 bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white shadow-lg shadow-indigo-950/50 hover:bg-indigo-500">
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied — paste into Claude Code" : "Copy everything as one prompt"}
        </button>
        <button type="button" onClick={() => onNavigate("howto")} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-[13px] font-medium text-zinc-100 hover:bg-zinc-700">
          <BookOpenCheck size={15} /> How to use (file-by-file)
        </button>
        <button type="button" onClick={() => onNavigate("playground")} className="inline-flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950/50 px-4 py-2 text-[13px] font-medium text-emerald-100 hover:bg-emerald-900/50">
          <FlaskConical size={15} /> Try the live engine demo
        </button>
      </div>

      <Reveal>
        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-zinc-400">
            <Workflow size={14} /> The invented architecture: F-M-S-P-E
          </h2>
          <div className="grid grid-cols-5 gap-2">
            {stages.map((s, i) => (
              <div key={s.name} className="group relative rounded-lg border border-zinc-800 bg-zinc-925 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-700/70 hover:bg-zinc-900">
                <div className="mb-1 flex items-center gap-1 font-mono text-[12px] font-semibold text-indigo-300">
                  {s.name}
                  {i < stages.length - 1 && <ArrowRight size={12} className="ml-auto text-zinc-600 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-indigo-400" />}
                </div>
                <p className="text-[11.5px] leading-5 text-zinc-400">{s.desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 font-mono text-[11.5px] text-zinc-500">
            Truth = sourceHtml + ops[] · Projection = freeze(source) + apply(ops) · Export = clean(serialize(projection))
          </p>
        </section>
      </Reveal>

      <Reveal delay={60}>
        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-zinc-400">
            <ShieldCheck size={14} /> How the pack stops hallucination and shortcuts
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {guards.map(([t, d]) => (
              <div key={t} className="rounded-lg border border-zinc-800 bg-zinc-925 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-800/70 hover:bg-zinc-900">
                <div className="mb-1 text-[13px] font-semibold text-zinc-100">{t}</div>
                <p className="text-[12.5px] leading-5 text-zinc-400">{d}</p>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      <Reveal delay={100}>
        <section className="mt-12">
          <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-zinc-400">Files in this pack</h2>
          <div className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
            {docs.map((d) => (
              <button key={d.id} type="button" onClick={() => onNavigate(d.id)} className="group flex w-full items-start gap-4 bg-zinc-925 px-4 py-3 text-left transition-colors hover:bg-zinc-900">
                <span className="w-56 shrink-0 font-mono text-[12px] text-indigo-200 transition-colors group-hover:text-indigo-100">{d.kind === "html" ? `fixtures/${d.fileName}` : d.fileName}</span>
                <span className="flex-1 text-[12.5px] leading-5 text-zinc-400">{d.description}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-zinc-600">
                  {wordCount(d.content).toLocaleString()} w
                  <ArrowRight size={12} className="opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </Reveal>
    </div>
  );
}
