import { useEffect, useState } from "react";
import { Check, Copy, FileCode2, FileText, FlaskConical, Home, Moon, PanelLeftClose, PanelLeftOpen, Rocket, Sun } from "lucide-react";
import { buildMegaPrompt, docs } from "@/content";
import { cn } from "@/utils/cn";
import { DocView } from "@/components/DocView";
import { Overview } from "@/components/Overview";
import { Playground } from "@/playground/Playground";

type View = "overview" | "playground" | (typeof docs)[number]["id"];
type Theme = "ivory" | "slate";

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [copied, setCopied] = useState(false);
  const [navOpen, setNavOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  // index.html has already applied the stored theme before first paint; read it back rather than
  // assuming a default, or the toggle's first click would appear to do nothing.
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "slate" ? "slate" : "ivory"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("uim-theme", theme);
    } catch {
      // Private-mode storage denial is not worth surfacing; the theme still applies for this session.
    }
  }, [theme]);

  // The editor needs every pixel it can get: under 1024 the 248 px nav overlays instead of holding a column.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => {
      setNarrow(mq.matches);
      setNavOpen(!mq.matches);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const copyAll = () => {
    void navigator.clipboard.writeText(buildMegaPrompt()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const go = (v: View) => {
    setView(v);
    if (narrow) setNavOpen(false);
  };

  const activeDoc = docs.find((d) => d.id === view);

  return (
    <div className="relative flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {!navOpen && (
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          title="Show navigation"
          className="fixed left-2 top-2 z-50 flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/95 px-2 py-1.5 text-[11.5px] text-zinc-300 shadow-lg backdrop-blur hover:text-ink"
        >
          <PanelLeftOpen size={14} /> Menu
        </button>
      )}
      {narrow && navOpen && (
        <button type="button" aria-label="Close navigation" onClick={() => setNavOpen(false)} className="fixed inset-0 z-30 cursor-default bg-black/50" />
      )}
      <nav
        className={cn(
          "flex w-[248px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-925",
          !navOpen && "hidden",
          narrow && "fixed inset-y-0 left-0 z-40 shadow-2xl shadow-black/70",
        )}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[13px] font-bold text-white">U</div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight text-ink font-display">UIMaster</div>
            <div className="text-[10.5px] text-zinc-500">Claude Code prompt pack</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setTheme(theme === "ivory" ? "slate" : "ivory")}
              title={theme === "ivory" ? "Switch to slate" : "Switch to ivory"}
              aria-label={theme === "ivory" ? "Switch to slate theme" : "Switch to ivory theme"}
              className="text-zinc-500 hover:text-zinc-200"
            >
              {theme === "ivory" ? <Moon size={15} /> : <Sun size={15} />}
            </button>
            <button type="button" onClick={() => setNavOpen(false)} title="Hide navigation" className="text-zinc-500 hover:text-zinc-200">
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <NavItem active={view === "overview"} onClick={() => go("overview")} icon={<Home size={14} />} label="Overview" />
          <div className="mt-3 px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Documents</div>
          {docs
            .filter((d) => d.kind === "markdown")
            .map((d) => (
              <NavItem key={d.id} active={view === d.id} onClick={() => go(d.id)} icon={d.id === "kickoff" ? <Rocket size={14} /> : <FileText size={14} />} label={d.title} />
            ))}
          <div className="mt-3 px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Fixtures</div>
          {docs
            .filter((d) => d.kind === "html")
            .map((d) => (
              <NavItem key={d.id} active={view === d.id} onClick={() => go(d.id)} icon={<FileCode2 size={14} />} label={d.fileName} mono />
            ))}
          <div className="mt-3 px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Proof</div>
          <NavItem active={view === "playground"} onClick={() => go("playground")} icon={<FlaskConical size={14} />} label="Live engine playground" accent />
        </div>
        <div className="border-t border-zinc-800 p-2">
          <button type="button" onClick={copyAll} className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-indigo-500">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy all as one prompt"}
          </button>
          <p className="mt-2 px-1 text-center text-[10.5px] leading-4 text-zinc-500">Kickoff + CLAUDE.md + SPEC.md + PLAN.md + fixtures with file markers.</p>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {view === "overview" && <Overview onNavigate={(id) => setView(id as View)} />}
        {view === "playground" && (
          <div className="h-full">
            <Playground />
          </div>
        )}
        {activeDoc && <DocView key={activeDoc.id} doc={activeDoc} />}
      </main>
    </div>
  );
}

function NavItem({ active, onClick, icon, label, mono, accent }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; mono?: boolean; accent?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
        active ? "bg-zinc-800 text-ink" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
        accent && !active && "text-emerald-300",
        mono && "font-mono text-[11.5px]",
      )}
    >
      <span className={cn("shrink-0", active ? "text-indigo-300" : "text-zinc-500", accent && "text-emerald-400")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
