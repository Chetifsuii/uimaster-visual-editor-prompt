import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerUpLeft,
  Download,
  Eye,
  EyeOff,
  Focus,
  Layers,
  Maximize,
  Minimize,
  Monitor,
  MousePointer2,
  Palette,
  PanelLeft,
  PanelRight,
  RefreshCw,
  ScrollText,
  Trash2,
  Undo2,
  Sparkles,
  ShieldOff,
} from "lucide-react";
import { cn } from "@/utils/cn";
import {
  applyHide,
  applyReveal,
  byId,
  detectHidden,
  detectHiddenContainers,
  detectLogo,
  detectOpaqueCovers,
  exportHtml,
  extractPalette,
  freeze,
  fontOf,
  kindOf,
  nameOf,
  outermostSvg,
  replaceColorEverywhere,
  resolveTarget,
  type CoverHit,
  type FreezeResult,
  type HiddenHit,
  type LogoCandidate,
  type PaletteEntry,
  type SuspiciousHidden,
} from "./engine";

import { Btn, Chip, ColorPicker, CommitInput, Row, Section, Segmented, inputCls } from "./ui";

interface HistoryEntry {
  label: string;
  revert: () => void;
}

type Mode = "edit" | "preview";
type LeftTab = "palette" | "assets" | "report";

const VIEWPORTS: { label: string; width: number }[] = [
  { label: "Fit", width: 0 },
  { label: "1440", width: 1440 },
  { label: "1280", width: 1280 },
  { label: "1024", width: 1024 },
  { label: "810", width: 810 },
  { label: "390", width: 390 },
];

/**
 * Below this editor width the two `shrink-0` panels stop sharing the row with the canvas and become
 * overlay drawers. Measured at a 548 px pane: 264 + 320 px of panels plus the app nav left the canvas
 * 2 px wide, so nothing could be inspected at all.
 */
const COMPACT_AT = 1100;

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Editor({ frozen, onBack }: { frozen: FreezeResult; onBack: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hoverBoxRef = useRef<HTMLDivElement>(null);
  const hoverChipRef = useRef<HTMLDivElement>(null);
  const selBoxRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const docRef = useRef<Document | null>(null);
  const winRef = useRef<Window | null>(null);
  const hoverElRef = useRef<Element | null>(null);
  const rafRef = useRef<number | null>(null);
  const editingRef = useRef<{ el: HTMLElement; before: string } | null>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const idCounterRef = useRef(frozen.report.nodeCount + 1);
  const modeRef = useRef<Mode>("edit");
  const selectedIdRef = useRef<string | null>(null);

  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [historyLen, setHistoryLen] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [mode, setModeState] = useState<Mode>("edit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [pageHtml, setPageHtml] = useState(frozen.html);
  const [pageLabel, setPageLabel] = useState(() => {
    try {
      return frozen.report.baseUrl ? new URL(frozen.report.baseUrl).pathname : "pasted page";
    } catch {
      return "pasted page";
    }
  });
  const [navStack, setNavStack] = useState<{ html: string; label: string }[]>([]);
  const [leftTab, setLeftTab] = useState<LeftTab>("palette");
  const [showStatus, setShowStatus] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [leftW, setLeftW] = useState(264);
  const [rightW, setRightW] = useState(320);
  const [dragging, setDragging] = useState<null | "left" | "right">(null);
  const [frameW, setFrameW] = useState(0);
  const [rootW, setRootW] = useState(0);
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<PaletteEntry[]>([]);
  const [logos, setLogos] = useState<LogoCandidate[]>([]);
  const [badgeCount, setBadgeCount] = useState(0);
  const [sweep, setSweep] = useState<{ appliedHidden: HiddenHit[]; appliedCovers: CoverHit[]; pendingHidden: HiddenHit[]; pendingCovers: CoverHit[]; suspects: SuspiciousHidden[] }>({ appliedHidden: [], appliedCovers: [], pendingHidden: [], pendingCovers: [], suspects: [] });
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const setSelectedId = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedIdState(id);
  }, []);

  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    hoverElRef.current = null;
    // Edit mode freezes transitions (stable dragging); preview mode lets the template's CSS motion play.
    docRef.current?.documentElement.setAttribute("data-uim-mode", m);
  }, []);

  // ---------- fullscreen ----------
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => showToast("Fullscreen was blocked by the browser"));
  }, [showToast]);

  // ---------- preview navigation (hash scroll → same-origin freeze-swap → new tab) ----------
  const navigateTo = useCallback(
    async (href: string) => {
      const base = frozen.report.baseUrl;
      let url: URL;
      try {
        url = new URL(href, base ?? undefined);
      } catch {
        showToast(`Cannot resolve link: ${href}`);
        return;
      }
      let sameOrigin = false;
      try {
        sameOrigin = base !== null && url.origin === new URL(base).origin;
      } catch {
        sameOrigin = false;
      }
      if (sameOrigin) {
        try {
          const res = await fetch(url.toString(), { signal: AbortSignal.timeout(7000) });
          const ctype = res.headers.get("content-type") ?? "";
          if (res.ok && /html/i.test(ctype)) {
            const text = await res.text();
            const next = freeze(text, base ?? "");
            const cur = docRef.current;
            setNavStack((s) => [...s, { html: cur ? `<!DOCTYPE html>\n${cur.documentElement.outerHTML}` : pageHtml, label: pageLabel }]);
            setPageHtml(next.html);
            setPageLabel(url.pathname + url.hash);
            setSelectedId(null);
            showToast(`Navigated to ${url.pathname} — froze ${next.report.nodeCount.toLocaleString()} nodes`);
            return;
          }
        } catch {
          // CORS or network: fall through to opening the real page
        }
      }
      window.open(url.toString(), "_blank", "noopener");
      showToast(sameOrigin ? "Site blocks in-frame reading — opened the real page in a new tab" : `External link opened in a new tab: ${url.hostname}`);
    },
    [frozen.report.baseUrl, pageHtml, pageLabel, setSelectedId, showToast],
  );

  const goBack = useCallback(() => {
    if (navStack.length === 0) return;
    const last = navStack[navStack.length - 1];
    if (!last) return;
    setNavStack(navStack.slice(0, -1));
    setPageHtml(last.html);
    setPageLabel(last.label);
    setSelectedId(null);
    showToast(`Back to ${last.label}`);
  }, [navStack, setSelectedId, showToast]);

  // ---------- panel resize (drag edges, double-click resets) ----------
  useEffect(() => {
    if (!dragging) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      if (dragging === "left") setLeftW(Math.round(Math.min(440, Math.max(200, e.clientX - rect.left))));
      else setRightW(Math.round(Math.min(520, Math.max(260, rect.right - e.clientX))));
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging]);

  // live frame width (fluid viewport) for the breakpoint readout
  useEffect(() => {
    const el = frameWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setFrameW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewport, focusMode, showLeft, showRight, leftW, rightW]);

  // live editor width — decides whether the panels share the row or overlay the canvas
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setRootW(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const compact = rootW > 0 && rootW < COMPACT_AT;
  /** A drawer must never be wider than the window it floats in. */
  const drawerW = (w: number) => (compact ? Math.min(w, Math.max(240, rootW - 56)) : w);

  // Entering compact collapses both panels so the canvas keeps the full width; leaving restores them.
  const wasCompactRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (rootW === 0 || wasCompactRef.current === compact) return;
    wasCompactRef.current = compact;
    setShowLeft(!compact);
    setShowRight(!compact);
  }, [compact, rootW]);

  const bpLabel = useMemo(() => {
    const w = viewport === 0 ? frameW : viewport;
    if (!w) return "";
    if (frozen.report.platform === "webflow") return w >= 992 ? "Desktop" : w >= 768 ? "Tablet" : "Phone";
    return w >= 1200 ? "Desktop" : w >= 810 ? "Tablet" : "Phone";
  }, [viewport, frameW, frozen.report.platform]);

  // ---------- overlay (imperative, no React state on the hover path) ----------
  const layout = useCallback(() => {
    rafRef.current = null;
    const doc = docRef.current;
    const place = (box: HTMLDivElement | null, el: Element | null) => {
      if (!box) return;
      if (!el || !el.isConnected || modeRef.current !== "edit") {
        box.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.transform = `translate(${r.left}px, ${r.top}px)`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      return r;
    };
    if (!doc) return;
    const hovered = hoverElRef.current;
    const r = place(hoverBoxRef.current, hovered);
    if (hovered && r && hoverChipRef.current) {
      const cls = Array.from(hovered.classList).slice(0, 2).map((c) => `.${c}`).join("");
      hoverChipRef.current.textContent = `${hovered.tagName.toLowerCase()}${cls} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      hoverChipRef.current.style.top = r.top < 26 ? "2px" : "-22px";
    }
    place(selBoxRef.current, selectedIdRef.current ? byId(doc, selectedIdRef.current) : null);
    if (statusRef.current) {
      const path: string[] = [];
      let cur: Element | null = hovered;
      while (cur && cur.tagName.toLowerCase() !== "body" && path.length < 4) {
        path.unshift(`${cur.tagName.toLowerCase()}${cur.classList[0] ? `.${cur.classList[0]}` : ""}`);
        cur = cur.parentElement;
      }
      statusRef.current.textContent = path.length ? path.join(" › ") : "";
    }
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(layout);
  }, [layout]);

  // ---------- sense ----------
  // Declared before the history section so undo() can re-derive it: badge/palette/logo counts are
  // measured from the document, and a revert changes the document.
  const runSense = useCallback(() => {
    const doc = docRef.current;
    const win = winRef.current;
    if (!doc || !win) return;
    setPalette(extractPalette(doc, win, 12));
    setLogos(detectLogo(doc, win, frozen.report.baseUrl));
    setBadgeCount(doc.querySelectorAll('[data-uim-role="badge"]').length);
  }, [frozen.report.baseUrl]);

  // ---------- history (preview / commit semantics, SPEC §2.4.2) ----------
  const previewRevertRef = useRef<(() => void) | null>(null);

  const cancelPreview = useCallback(() => {
    if (previewRevertRef.current) {
      previewRevertRef.current();
      previewRevertRef.current = null;
    }
  }, []);

  /** Apply without recording; the next preview or commit reverts it first. */
  const preview = useCallback(
    (run: () => () => void) => {
      cancelPreview();
      previewRevertRef.current = run();
      schedule();
    },
    [cancelPreview, schedule],
  );

  const commit = useCallback(
    (label: string, run: () => () => void) => {
      cancelPreview();
      const revert = run();
      historyRef.current.push({ label, revert });
      setHistoryLen(historyRef.current.length);
      bump();
      schedule();
    },
    [bump, cancelPreview, schedule],
  );

  const undo = useCallback(() => {
    const entry = historyRef.current.pop();
    if (!entry) return;
    entry.revert();
    setHistoryLen(historyRef.current.length);
    // Counts derived from the document (badges above all) go stale after a revert unless re-measured:
    // "Remove badge" set badgeCount to 0 imperatively, so undoing it would leave the button hidden.
    runSense();
    bump();
    schedule();
    showToast(`Undid: ${entry.label}`);
  }, [bump, runSense, schedule, showToast]);

  // ---------- text editing ----------
  const commitTextEdit = useCallback(() => {
    const s = editingRef.current;
    if (!s) return;
    editingRef.current = null;
    s.el.removeAttribute("contenteditable");
    s.el.removeAttribute("data-uim-editing");
    setEditing(false);
    const after = s.el.innerHTML;
    if (after !== s.before) {
      const el = s.el;
      const before = s.before;
      historyRef.current.push({ label: "Edit text", revert: () => { el.innerHTML = before; } });
      setHistoryLen(historyRef.current.length);
    }
    bump();
    schedule();
  }, [bump, schedule]);

  const startTextEdit = useCallback(
    (el: HTMLElement) => {
      if (editingRef.current) commitTextEdit();
      editingRef.current = { el, before: el.innerHTML };
      el.setAttribute("contenteditable", "plaintext-only");
      if (!el.isContentEditable) el.setAttribute("contenteditable", "true");
      el.setAttribute("data-uim-editing", "1");
      el.focus();
      setEditing(true);
      el.addEventListener("blur", () => commitTextEdit(), { once: true });
    },
    [commitTextEdit],
  );

  // ---------- visibility sweep (appears, preloaders, cookie walls) ----------
  const runSweep = useCallback(
    (auto: boolean) => {
      const d = docRef.current;
      const w = winRef.current;
      if (!d || !w) return;
      const hidden = detectHidden(d, w);
      const covers = detectOpaqueCovers(d, w);
      const suspects = detectHiddenContainers(d, w);
      if (auto) {
        if (hidden.length > 0) commit(`Reveal ${hidden.length} hidden element(s)`, () => applyReveal(d, hidden.map((h) => h.id)));
        if (covers.length > 0) commit(`Hide ${covers.length} opaque overlay(s)`, () => applyHide(d, covers.map((c) => c.id)));
        if (hidden.length + covers.length > 0) showToast(`Visibility sweep: revealed ${hidden.length} element(s), hid ${covers.length} overlay(s) — ⌘Z reverts`);
      }
      setSweep((prev) => ({
        appliedHidden: auto ? [...prev.appliedHidden, ...hidden] : prev.appliedHidden,
        appliedCovers: auto ? [...prev.appliedCovers, ...covers] : prev.appliedCovers,
        pendingHidden: auto ? [] : hidden,
        pendingCovers: auto ? [] : covers,
        suspects,
      }));
      runSense();
      schedule();
    },
    [commit, runSense, schedule, showToast],
  );

  const revealPending = useCallback(() => {
    const d = docRef.current;
    if (!d || sweep.pendingHidden.length === 0) return;
    const ids = sweep.pendingHidden.map((h) => h.id);
    commit(`Reveal ${ids.length} hidden element(s)`, () => applyReveal(d, ids));
    setSweep((prev) => ({ ...prev, appliedHidden: [...prev.appliedHidden, ...prev.pendingHidden], pendingHidden: [] }));
  }, [commit, sweep.pendingHidden]);

  const hidePendingCovers = useCallback(() => {
    const d = docRef.current;
    if (!d || sweep.pendingCovers.length === 0) return;
    const ids = sweep.pendingCovers.map((c) => c.id);
    commit(`Hide ${ids.length} opaque overlay(s)`, () => applyHide(d, ids));
    setSweep((prev) => ({ ...prev, appliedCovers: [...prev.appliedCovers, ...prev.pendingCovers], pendingCovers: [] }));
  }, [commit, sweep.pendingCovers]);

  const revealSuspect = useCallback(
    (id: string) => {
      const d = docRef.current;
      if (!d) return;
      commit("Reveal hidden container", () => applyReveal(d, [id]));
      setSweep((prev) => ({ ...prev, suspects: prev.suspects.filter((s) => s.id !== id), appliedHidden: [...prev.appliedHidden, { id, reason: "visibility" as const }] }));
    },
    [commit],
  );

  // ---------- keyboard ----------
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape" && editingRef.current) {
          e.preventDefault();
          commitTextEdit();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape") {
        setSelectedId(null);
        schedule();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        e.preventDefault();
        const doc = docRef.current;
        const el = doc && selectedIdRef.current ? byId(doc, selectedIdRef.current) : null;
        if (el) {
          removeElement(el);
        }
      } else if (e.key === "Enter" && e.shiftKey && selectedIdRef.current) {
        const doc = docRef.current;
        const el = doc && selectedIdRef.current ? byId(doc, selectedIdRef.current) : null;
        const parent = el?.parentElement;
        if (parent && parent.tagName.toLowerCase() !== "body") {
          setSelectedId(parent.getAttribute("data-uim-id"));
          schedule();
        }
      } else if (e.key.toLowerCase() === "v") setMode("edit");
      else if (e.key.toLowerCase() === "p") setMode("preview");
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
      else if (e.key === "[") setShowLeft((v) => !v);
      else if (e.key === "]") setShowRight((v) => !v);
      else if (e.key === "`") setShowStatus((v) => !v);
      else if (e.key === "\\") setFocusMode((v) => !v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitTextEdit, schedule, setMode, setSelectedId, toggleFullscreen, undo],
  );

  // ---------- canvas host ----------
  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument ?? null;
    const win = iframe?.contentWindow ?? null;
    if (!doc || !win) return;
    docRef.current = doc;
    winRef.current = win;
    doc.documentElement.setAttribute("data-uim-mode", modeRef.current);

    const onMove = (e: MouseEvent) => {
      if (modeRef.current !== "edit" || editingRef.current) return;
      const t = e.target as Element | null;
      if (!t || t.nodeType !== 1) return;
      const tag = t.tagName.toLowerCase();
      hoverElRef.current = tag === "html" || tag === "body" ? null : outermostSvg(t);
      schedule();
    };
    const onLeave = () => {
      hoverElRef.current = null;
      schedule();
    };
    const onDown = (e: MouseEvent) => {
      if (modeRef.current !== "edit") return;
      const s = editingRef.current;
      if (s && s.el.contains(e.target as Node)) return;
      e.preventDefault();
      // preventDefault keeps focus where it was — release any focused inspector input so its blur-commit runs.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (modeRef.current === "preview") {
        const a = target.closest("a[href]");
        if (a) {
          const href = a.getAttribute("href") ?? "";
          // Hash links scroll inside the frame (smooth via the preview-mode CSS rule).
          if (!href || href.startsWith("#")) return;
          e.preventDefault();
          void navigateTo(href);
          return;
        }
        if (target.closest("button, [role='button'], input[type='submit']")) {
          showToast("This button needs the template's JavaScript (stripped at freeze) — the full app lists it under Issues");
        }
        return;
      }
      const s = editingRef.current;
      if (s && s.el.contains(target)) return;
      if (s) commitTextEdit();
      e.preventDefault();
      e.stopPropagation();
      const stack = doc.elementsFromPoint(e.clientX, e.clientY);
      const el = resolveTarget(stack, e.altKey);
      setSelectedId(el ? el.getAttribute("data-uim-id") : null);
      schedule();
    };
    const onDbl = (e: MouseEvent) => {
      if (modeRef.current !== "edit") return;
      const stack = doc.elementsFromPoint(e.clientX, e.clientY);
      const el = resolveTarget(stack, e.altKey);
      const W = win as Window & typeof globalThis;
      if (el && kindOf(el) === "text" && el instanceof W.HTMLElement) {
        e.preventDefault();
        setSelectedId(el.getAttribute("data-uim-id"));
        startTextEdit(el);
      }
    };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseleave", onLeave, true);
    doc.addEventListener("mousedown", onDown, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("dblclick", onDbl, true);
    doc.addEventListener("scroll", schedule, true);
    doc.addEventListener("keydown", handleKey);
    win.addEventListener("resize", schedule);

    window.setTimeout(runSense, 60);
    // The sweep needs a settled layout (webfonts + images shift boxes), so it runs after a tick.
    window.setTimeout(() => runSweep(true), 450);
    void doc.fonts.ready.then(() => {
      bump();
      // Webfonts can shift layout and reveal new appear-wrapped nodes; auto-apply again (idempotent).
      window.setTimeout(() => runSweep(true), 120);
    });
    bump();
  }, [bump, commitTextEdit, handleKey, navigateTo, runSense, runSweep, schedule, setSelectedId, showToast, startTextEdit]);

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  useEffect(() => {
    schedule();
  }, [viewport, mode, schedule]);

  /**
   * Re-sweep when the rendered breakpoint changes. A Framer page ships one `ssr-variant` subtree per
   * breakpoint and gates the others with `display:none`, so the first sweep can only measure the
   * variant that was live at load. Measured on midu.design: switching Fit → 1440 swapped in a subtree
   * that still had 35 blurred and 61 invisible nodes, hero words included, because a `display:none`
   * element has no box for detectHidden to measure.
   */
  const sweptBucketRef = useRef<string | null>(null);
  useEffect(() => {
    const w = viewport === 0 ? frameW : viewport;
    if (!docRef.current || !w || !bpLabel) return;
    const bucket = `${viewport}/${bpLabel}`;
    if (sweptBucketRef.current === null) {
      // handleLoad's own sweep covers the bucket the document loaded in.
      sweptBucketRef.current = bucket;
      return;
    }
    if (sweptBucketRef.current === bucket) return;
    sweptBucketRef.current = bucket;
    const t = window.setTimeout(() => runSweep(true), 260);
    return () => window.clearTimeout(t);
  }, [viewport, frameW, bpLabel, runSweep]);

  // ---------- ops used by the inspector ----------
  const setInline = useCallback(
    (el: Element, prop: string, value: string, label?: string) => {
      const style = (el as HTMLElement).style;
      commit(label ?? `Set ${prop}`, () => {
        const before = style.getPropertyValue(prop);
        if (value.trim() === "") style.removeProperty(prop);
        else style.setProperty(prop, value);
        return () => (before ? style.setProperty(prop, before) : style.removeProperty(prop));
      });
    },
    [commit],
  );

  const previewInline = useCallback(
    (el: Element, prop: string, value: string) => {
      const style = (el as HTMLElement).style;
      preview(() => {
        const before = style.getPropertyValue(prop);
        style.setProperty(prop, value);
        return () => (before ? style.setProperty(prop, before) : style.removeProperty(prop));
      });
    },
    [preview],
  );

  const setAttr = useCallback(
    (el: Element, name: string, value: string | null) => {
      commit(`Set ${name}`, () => {
        // Snapshot the whole attribute set, not just this one. The DOM cannot reinsert an attribute at
        // an index, so removing `dir` and re-adding it on revert lands it at the end of the list and
        // changes outerHTML even though the element is semantically unchanged. The ledger promises
        // byte-exact reversal, so restore every attribute in its original order.
        const snap = Array.from(el.attributes).map((a) => [a.name, a.value] as [string, string]);
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
        return () => {
          while (el.attributes.length > 0) el.removeAttribute(el.attributes[0]!.name);
          for (const [n, v] of snap) el.setAttribute(n, v);
        };
      });
    },
    [commit],
  );

  function removeElement(el: Element) {
    const parent = el.parentNode;
    const next = el.nextSibling;
    if (!parent) return;
    commit(`Delete ${nameOf(el)}`, () => {
      el.remove();
      return () => parent.insertBefore(el, next);
    });
    setSelectedId(null);
    window.setTimeout(runSense, 30);
  }

  const duplicateElement = useCallback(
    (el: Element) => {
      const clone = el.cloneNode(true) as Element;
      clone.setAttribute("data-uim-id", String(idCounterRef.current++));
      clone.querySelectorAll("*").forEach((c) => c.setAttribute("data-uim-id", String(idCounterRef.current++)));
      commit(`Duplicate ${nameOf(el)}`, () => {
        el.after(clone);
        return () => clone.remove();
      });
      setSelectedId(clone.getAttribute("data-uim-id"));
    },
    [commit, setSelectedId],
  );

  const forceVisible = useCallback(
    (el: Element) => {
      const style = (el as HTMLElement).style;
      commit("Force visible", () => {
        const before = style.cssText;
        style.setProperty("opacity", "1", "important");
        style.setProperty("transform", "none", "important");
        style.setProperty("visibility", "visible", "important");
        return () => {
          style.cssText = before;
        };
      });
    },
    [commit],
  );

  const replaceImage = useCallback(
    (img: HTMLImageElement, src: string) => {
      commit("Replace image", () => {
        const before = { src: img.getAttribute("src"), srcset: img.getAttribute("srcset"), sizes: img.getAttribute("sizes") };
        const picture = img.parentElement?.tagName.toLowerCase() === "picture" ? img.parentElement : null;
        const sources = picture ? Array.from(picture.querySelectorAll("source")) : [];
        sources.forEach((s) => s.remove());
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.setAttribute("src", src);
        return () => {
          if (before.src !== null) img.setAttribute("src", before.src);
          if (before.srcset !== null) img.setAttribute("srcset", before.srcset);
          if (before.sizes !== null) img.setAttribute("sizes", before.sizes);
          if (picture) sources.forEach((s) => picture.prepend(s));
        };
      });
      window.setTimeout(runSense, 30);
    },
    [commit, runSense],
  );

  const removeBadges = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    const badges = Array.from(doc.querySelectorAll('[data-uim-role="badge"]'));
    if (badges.length === 0) return;
    commit(`Remove ${badges.length} platform badge(s)`, () => {
      const restore = badges.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
      badges.forEach((el) => el.remove());
      return () => restore.forEach(({ el, parent, next }) => parent?.insertBefore(el, next));
    });
    setBadgeCount(0);
    showToast(`Removed ${badges.length} badge(s) — undo with ⌘Z`);
  }, [commit, showToast]);

  const recolor = useCallback(
    (fromHex: string, toHex: string) => {
      const doc = docRef.current;
      const win = winRef.current;
      if (!doc || !win) return;
      let summary = "";
      commit(`Recolor ${fromHex} → ${toHex}`, () => {
        const res = replaceColorEverywhere(doc, win, fromHex, toHex);
        summary = res.varsChanged > 0 ? `${res.varsChanged} CSS variable(s) + ${res.inlined} element(s)` : `${res.inlined} element(s) (no variable source found)`;
        return res.revert;
      });
      showToast(`Recolored via ${summary}`);
      window.setTimeout(runSense, 30);
    },
    [commit, runSense, showToast],
  );

  const doExport = useCallback(
    (copy: boolean) => {
      const doc = docRef.current;
      if (!doc) return;
      if (editingRef.current) commitTextEdit();
      const html = exportHtml(doc);
      if (copy) {
        void navigator.clipboard.writeText(html).then(() => showToast(`Copied ${(html.length / 1024).toFixed(0)} KB of clean HTML`));
      } else {
        download(`uimaster-${frozen.report.platform}.html`, html);
        showToast("Exported standalone HTML");
      }
    },
    [commitTextEdit, frozen.report.platform, showToast],
  );

  // ---------- derived selection ----------
  const doc = docRef.current;
  const win = winRef.current;
  const sel = useMemo(() => (doc && selectedId ? byId(doc, selectedId) : null), [doc, selectedId, tick]);
  const cs = sel && win ? win.getComputedStyle(sel) : null;
  const kind = sel ? kindOf(sel) : null;
  const font = sel && doc && win && kind === "text" ? fontOf(sel, doc, win) : null;
  const rect = sel ? sel.getBoundingClientRect() : null;
  const ancestors: Element[] = [];
  if (sel) {
    let cur = sel.parentElement;
    while (cur && cur.tagName.toLowerCase() !== "html") {
      ancestors.unshift(cur);
      cur = cur.parentElement;
    }
  }
  const linkEl = sel?.closest("a[href]") ?? null;
  const sameHrefCount = linkEl && doc ? doc.querySelectorAll(`a[href="${CSS.escape(linkEl.getAttribute("href") ?? "")}"]`).length : 0;
  const isHidden = cs?.display === "none";
  const badgeSel = sel?.closest('[data-uim-role="badge"]') ?? null;
  const lastLabel = historyRef.current[historyRef.current.length - 1]?.label;

  const px = (v: string | undefined) => (v ? v.replace(/px$/, "") : "");

  return (
    <div ref={rootRef} className="uim-editor-root flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-zinc-800 bg-zinc-925 px-2">
        <Btn variant="ghost" onClick={onBack} title="Back to import">
          <ArrowLeft size={14} /> Import
        </Btn>
        <Chip tone={frozen.report.platform === "framer" ? "indigo" : frozen.report.platform === "webflow" ? "sky" : "zinc"}>{frozen.report.platform}</Chip>
        <span className="hidden text-[11px] text-zinc-500 xl:inline">{frozen.report.nodeCount.toLocaleString()} nodes</span>
        {navStack.length > 0 ? (
          <Btn variant="ghost" onClick={goBack} title="Back in preview history">
            <CornerUpLeft size={14} /> Back
          </Btn>
        ) : null}
        <span className="max-w-[150px] truncate font-mono text-[11px] text-zinc-400" title={pageLabel}>
          {pageLabel}
        </span>
        <div className="mx-2 h-5 w-px bg-zinc-800" />
        <div className="flex items-center gap-1">
          {VIEWPORTS.map((v) => (
            <button
              key={v.label}
              type="button"
              onClick={() => setViewport(v.width)}
              className={cn("rounded px-2 py-0.5 text-[11.5px]", viewport === v.width ? "bg-zinc-700 text-ink" : "text-zinc-400 hover:text-zinc-200")}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="mx-2 h-5 w-px bg-zinc-800" />
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "edit", label: "Edit (V)" },
            { value: "preview", label: "Preview (P)" },
          ]}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Btn variant="ghost" onClick={() => setShowLeft((v) => !v)} title="Toggle left panels ( [ )" className={showLeft ? "" : "opacity-50"}>
            <PanelLeft size={14} />
            <span className="hidden 2xl:inline">Panels</span>
          </Btn>
          <Btn variant="ghost" onClick={() => setShowRight((v) => !v)} title="Toggle inspector ( ] )" className={showRight ? "" : "opacity-50"}>
            <PanelRight size={14} />
            <span className="hidden 2xl:inline">Inspector</span>
          </Btn>
          <Btn variant="ghost" onClick={toggleFullscreen} title="Fullscreen ( F )">
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            <span className="hidden 2xl:inline">{isFullscreen ? "Exit full" : "Full screen"}</span>
          </Btn>
          <Btn variant="ghost" onClick={() => setFocusMode((v) => !v)} title="Focus mode — hide panels & status bar, canvas gets everything ( \ )" className={focusMode ? "border-indigo-600 bg-indigo-950/60 text-indigo-200" : ""}>
            <Focus size={14} />
            <span className="hidden 2xl:inline">Focus</span>
          </Btn>
          <div className="mx-0.5 h-5 w-px bg-zinc-800" />
          <Btn onClick={undo} disabled={historyLen === 0} title={lastLabel ? `Undo: ${lastLabel}` : "Nothing to undo"}>
            <Undo2 size={14} /> Undo{historyLen > 0 ? ` (${historyLen})` : ""}
          </Btn>
          {badgeCount > 0 ? (
            <Btn variant="danger" onClick={removeBadges} title="Remove Made-in-Framer / Made-in-Webflow badge">
              <ShieldOff size={14} /> Remove badge{badgeCount > 1 ? "s" : ""}
            </Btn>
          ) : null}
          <Btn onClick={() => doExport(true)}>
            <Copy size={14} /> Copy HTML
          </Btn>
          <Btn variant="primary" onClick={() => doExport(false)}>
            <Download size={14} /> Export
          </Btn>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Left panel */}
        {!focusMode && showLeft && (
        <aside
          style={{ width: drawerW(leftW) }}
          className={cn(
            "flex shrink-0 flex-col overflow-hidden border-r border-zinc-800 bg-zinc-925",
            dragging !== "left" && "transition-[width] duration-200 ease-out",
            compact && "absolute inset-y-0 left-0 z-30 shadow-2xl shadow-black/70",
          )}
        >
          <div className="flex border-b border-zinc-800 text-[11.5px]">
            {(
              [
                ["palette", "Palette", Palette],
                ["assets", "Assets", Layers],
                ["report", "Report", ScrollText],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLeftTab(id)}
                className={cn("flex flex-1 items-center justify-center gap-1.5 py-2", leftTab === id ? "border-b-2 border-indigo-500 text-ink" : "text-zinc-400 hover:text-zinc-200")}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {leftTab === "palette" && (
              <div className="p-3">
                <p className="mb-3 text-[11px] leading-5 text-zinc-500">
                  Extracted from <span className="text-zinc-300">computed styles</span>, weighted by area / text length. Pick a swatch to recolor <em>everywhere</em>: CSS variables first (Framer <code className="text-zinc-300">--token-*</code>), then computed-matched elements.
                </p>
                {palette.length === 0 ? <p className="text-[12px] text-zinc-500">Scanning…</p> : null}
                <div className="space-y-1.5">
                  {palette.map((p) => (
                    <div key={p.hex} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
                      <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded border border-zinc-700" style={{ background: p.hex }} title="Click to pick a replacement (live preview, one undo step)">
                        <ColorPicker
                          value={p.hex}
                          onPreview={(to) => {
                            const d = docRef.current;
                            const w = winRef.current;
                            if (!d || !w) return;
                            preview(() => replaceColorEverywhere(d, w, p.hex, to).revert);
                          }}
                          onCommit={(to) => {
                            if (to.toLowerCase() !== p.hex.toLowerCase()) recolor(p.hex, to);
                            else cancelPreview();
                          }}
                        />
                      </label>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11.5px] text-zinc-200">{p.hex}</div>
                        <div className="truncate text-[10.5px] text-zinc-500">
                          {p.usage.text ? `${p.usage.text} text · ` : ""}
                          {p.usage.bg ? `${p.usage.bg} bg · ` : ""}
                          {p.usage.border ? `${p.usage.border} border · ` : ""}
                          {p.usage.svg ? `${p.usage.svg} svg` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {leftTab === "assets" && (
              <div className="p-3">
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Logo candidates</h4>
                <p className="mb-3 text-[11px] leading-5 text-zinc-500">Scored by geometry + link target + naming. Every pick shows its basis — nothing is assumed.</p>
                {logos.length === 0 ? <p className="text-[12px] text-zinc-500">No obvious logo — click any image and edit it directly.</p> : null}
                <div className="space-y-1.5">
                  {logos.map((l, i) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(l.id);
                        schedule();
                      }}
                      className={cn("w-full rounded-md border p-2 text-left", selectedId === l.id ? "border-indigo-500 bg-indigo-950/30" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600")}
                    >
                      <div className="flex items-center gap-2">
                        <Chip tone={i === 0 ? "green" : "zinc"}>{i === 0 ? "Primary logo" : `Candidate ${i + 1}`}</Chip>
                        <span className="font-mono text-[11px] text-zinc-400">
                          {l.tag} · score {l.score}
                        </span>
                      </div>
                      <ul className="mt-1.5 space-y-0.5 text-[10.5px] text-zinc-500">
                        {l.basis.map((b) => (
                          <li key={b}>• {b}</li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {leftTab === "report" && (
              <div className="space-y-3 p-3 text-[12px]">
                <ReportLine label="Platform" value={`${frozen.report.platform} (${frozen.report.evidence.join("; ")})`} />
                <ReportLine label="Nodes mapped" value={String(frozen.report.nodeCount)} />
                <ReportLine label="Scripts removed" value={String(frozen.report.scriptsRemoved)} />
                <ReportLine label="Inline handlers / javascript: removed" value={String(frozen.report.inlineHandlersRemoved)} />
                <ReportLine label="noscript removed" value={String(frozen.report.noscriptRemoved)} />
                <ReportLine label="Fonts rescued (WebFont.load → <link>)" value={frozen.report.fontsRescued.length ? frozen.report.fontsRescued.join(", ") : "none needed"} />
                <ReportLine label="Motion starting states neutralized" value={String(frozen.report.motionNeutralized)} />
                <ReportLine label="Badges marked" value={String(frozen.report.badges)} />
                <ReportLine label="Base URL" value={frozen.report.baseUrl ?? "none"} />
                <ReportLine label="Freeze time" value={`${frozen.report.durationMs} ms`} />

                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <EyeOff size={12} className="text-amber-300" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Visibility sweep</span>
                    <button type="button" onClick={() => runSweep(false)} title="Re-measure the canvas" className="ml-auto text-zinc-500 hover:text-zinc-200">
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <p className="mb-2 text-[10.5px] leading-4 text-zinc-500">
                    Framer/Webflow pages keep content invisible until their own scripts run: appear wrappers (`opacity`, `visibility`, off-screen transforms), stuck first frames (`filter: blur(…)`), keyframes held at frame 0 (`animation-play-state: paused`), preloaders and cookie walls. The sweep measures all of it and fixes each kind as an undoable history entry. Edit mode freezes transitions for stable dragging; switch to <span className="text-zinc-200">Preview (P)</span> to play the template's own CSS animations and hover transitions.
                  </p>
                  <ul className="space-y-1 text-[11px] text-zinc-300">
                    <li>
                      revealed first-frame / hidden states: <b className="text-ink">{sweep.appliedHidden.length}</b>
                      {sweep.pendingHidden.length > 0 && <span className="text-amber-300"> · {sweep.pendingHidden.length} new</span>}
                    </li>
                    {Object.entries(
                      sweep.appliedHidden.reduce<Record<string, number>>((m, h) => {
                        m[h.reason] = (m[h.reason] ?? 0) + 1;
                        return m;
                      }, {}),
                    ).map(([reason, n]) => (
                      <li key={reason} className="pl-3 text-[10.5px] text-zinc-500">
                        {reason}: <span className="text-zinc-300">{n}</span>
                        {reason === "blur" && " (stuck blurred first frame — blur() stripped, other filter functions kept)"}
                        {reason === "paused-animation" && " (keyframes held at frame 0 — play-state set to running)"}
                      </li>
                    ))}
                    <li>
                      opaque overlays hidden: <b className="text-ink">{sweep.appliedCovers.length}</b>
                      {sweep.pendingCovers.length > 0 && <span className="text-amber-300"> · {sweep.pendingCovers.length} new</span>}
                    </li>
                  </ul>
                  {sweep.appliedCovers.map((c) => (
                    <div key={`c-${c.id}`} className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/60 p-1.5 text-[10.5px] leading-4 text-zinc-400">
                      {c.reason}
                    </div>
                  ))}
                  {sweep.suspects.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-[10.5px] text-amber-300">display:none containers still hiding content — reveal manually:</div>
                      <ul className="space-y-1">
                        {sweep.suspects.map((s) => (
                          <li key={s.id} className="flex items-center gap-2 rounded border border-amber-900/40 bg-amber-950/20 p-1.5 text-[10.5px] text-amber-100">
                            <span className="min-w-0 flex-1 truncate">
                              {s.name} <span className="text-amber-300/70">({s.contentDescendants} content nodes)</span>
                            </span>
                            <button type="button" onClick={() => revealSuspect(s.id)} className="rounded border border-amber-700/60 bg-amber-900/40 px-1.5 py-0.5 text-[10px] hover:bg-amber-800/50">
                              Reveal
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2 flex gap-1.5">
                    {sweep.pendingHidden.length > 0 && (
                      <Btn onClick={revealPending}>
                        <EyeOff size={12} /> Reveal {sweep.pendingHidden.length}
                      </Btn>
                    )}
                    {sweep.pendingCovers.length > 0 && (
                      <Btn onClick={hidePendingCovers}>
                        <ShieldOff size={12} /> Hide {sweep.pendingCovers.length} overlay{sweep.pendingCovers.length > 1 ? "s" : ""}
                      </Btn>
                    )}
                  </div>
                </div>

                {frozen.report.warnings.length > 0 ? (
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300">Issues</div>
                    <ul className="space-y-1 text-[11px] text-amber-200/80">
                      {frozen.report.warnings.map((w) => (
                        <li key={w} className="rounded border border-amber-900/50 bg-amber-950/30 p-1.5">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </aside>
        )}
        {!focusMode && showLeft && !compact && (
          <div
            onMouseDown={() => setDragging("left")}
            onDoubleClick={() => setLeftW(264)}
            title="Drag to resize panels · double-click to reset"
            className={cn("group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-500/70", dragging === "left" && "bg-indigo-500")}
          >
            <span className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-700 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        )}

        {/* Drawer backdrop — tapping outside closes the overlaid panels */}
        {compact && !focusMode && (showLeft || showRight) && (
          <button
            type="button"
            aria-label="Close panels"
            onClick={() => {
              setShowLeft(false);
              setShowRight(false);
            }}
            className="absolute inset-0 z-20 cursor-default bg-black/50"
          />
        )}

        {/* Canvas */}
        <main className={cn("relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,#27272a_1px,transparent_0)] bg-[length:16px_16px] transition-[padding] duration-200", focusMode ? "p-2" : "p-4 xl:p-6")}>
          <div className="pointer-events-none sticky top-0 z-10 mb-2 flex justify-center">
            <div className="flex items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-900/95 px-2.5 py-1 font-mono text-[10.5px] text-zinc-300 shadow-lg">
              <Monitor size={11} className="text-indigo-300" />
              {viewport === 0 ? `fluid${frameW ? ` · ${frameW}px` : ""}` : `${viewport}px`}
              <span className="text-zinc-600">·</span>
              <span className="text-indigo-200">{bpLabel || "…"}</span>
              <span className="text-zinc-600">·</span>
              <span>{frozen.report.platform}</span>
            </div>
          </div>
          <div ref={frameWrapRef} className="relative mx-auto overflow-hidden rounded-lg border border-zinc-800 bg-white shadow-2xl" style={{ width: viewport === 0 ? "100%" : viewport, minWidth: viewport === 0 ? undefined : viewport, height: "calc(100% - 34px)" }}>
            <iframe ref={iframeRef} title="UIMaster canvas" srcDoc={pageHtml} onLoad={handleLoad} className="block h-full w-full border-0" />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div ref={hoverBoxRef} className="absolute left-0 top-0 hidden outline outline-1 outline-sky-400" style={{ willChange: "transform" }}>
                <div ref={hoverChipRef} className="absolute left-0 whitespace-nowrap rounded bg-sky-500 px-1.5 py-0.5 font-mono text-[10.5px] text-white shadow" />
              </div>
              <div ref={selBoxRef} className={cn("absolute left-0 top-0 hidden outline outline-2", editing ? "outline-dashed outline-amber-400" : "outline-indigo-500")} style={{ willChange: "transform" }}>
                {!editing && (
                  <>
                    <i className="absolute -left-1 -top-1 h-2 w-2 bg-white outline outline-1 outline-indigo-500" />
                    <i className="absolute -right-1 -top-1 h-2 w-2 bg-white outline outline-1 outline-indigo-500" />
                    <i className="absolute -bottom-1 -left-1 h-2 w-2 bg-white outline outline-1 outline-indigo-500" />
                    <i className="absolute -bottom-1 -right-1 h-2 w-2 bg-white outline outline-1 outline-indigo-500" />
                  </>
                )}
              </div>
            </div>
          </div>
          {(!showStatus || focusMode) && (
            <div className="fixed bottom-3 right-3 z-30 flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/95 px-2 py-1 shadow-2xl backdrop-blur">
              <span className="pl-1 font-mono text-[10.5px] text-zinc-400">{mode === "edit" ? "edit" : "preview"}</span>
              <button type="button" onClick={() => setMode(mode === "edit" ? "preview" : "edit")} title="Switch mode ( V / P )" className="rounded-full px-2 py-0.5 text-[10.5px] font-medium text-zinc-100 transition-colors hover:bg-zinc-700">
                swap
              </button>
              <button type="button" onClick={undo} disabled={historyLen === 0} title="Undo (⌘Z)" className="rounded-full p-1 text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-40">
                <Undo2 size={12} />
              </button>
              {focusMode && (
                <button type="button" onClick={() => setFocusMode(false)} title="Exit focus mode ( \ )" className="rounded-full p-1 text-indigo-300 transition-colors hover:bg-zinc-700">
                  <Focus size={12} />
                </button>
              )}
              {!showStatus && (
                <button type="button" onClick={() => setShowStatus(true)} title="Show status bar ( ` )" className="rounded-full p-1 text-zinc-300 transition-colors hover:bg-zinc-700">
                  <ChevronUp size={12} />
                </button>
              )}
            </div>
          )}
          {toast ? <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-100 shadow-xl">{toast}</div> : null}
        </main>

        {/* Inspector */}
        {!focusMode && showRight && !compact && (
          <div
            onMouseDown={() => setDragging("right")}
            onDoubleClick={() => setRightW(320)}
            title="Drag to resize inspector · double-click to reset"
            className={cn("group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-500/70", dragging === "right" && "bg-indigo-500")}
          >
            <span className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-700 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        )}
        {!focusMode && showRight && (
        <aside
          style={{ width: drawerW(rightW) }}
          className={cn(
            "flex shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-925",
            dragging !== "right" && "transition-[width] duration-200 ease-out",
            compact && "absolute inset-y-0 right-0 z-30 shadow-2xl shadow-black/70",
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!sel || !cs ? (
              <div className="p-4 text-[12px] leading-6 text-zinc-500">
                <div className="mb-2 flex items-center gap-2 text-zinc-300">
                  <MousePointer2 size={14} /> Nothing selected
                </div>
                Hover anything on the canvas to inspect it. <span className="text-zinc-300">Click</span> selects (media and text first, then smallest box), <span className="text-zinc-300">Alt+click</span> picks the raw deepest element, <span className="text-zinc-300">double-click</span> edits text in place, <span className="text-zinc-300">Shift+Enter</span> selects the parent, <span className="text-zinc-300">Delete</span> removes, <span className="text-zinc-300">⌘Z</span> undoes.
              </div>
            ) : (
              <>
                <div className="border-b border-zinc-800 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone="indigo">{kind}</Chip>
                    <span className="text-[13px] font-semibold text-zinc-100">{nameOf(sel)}</span>
                    <span className="font-mono text-[11px] text-zinc-500">&lt;{sel.tagName.toLowerCase()}&gt;</span>
                    {rect ? (
                      <span className="ml-auto font-mono text-[11px] text-zinc-500">
                        {Math.round(rect.width)}×{Math.round(rect.height)}
                      </span>
                    ) : null}
                  </div>
                  {sel.classList.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from(sel.classList).slice(0, 6).map((c) => (
                        <span key={c} className="rounded bg-zinc-800 px-1 font-mono text-[10.5px] text-zinc-400">
                          .{c}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-x-1 text-[10.5px] text-zinc-500">
                    {ancestors.slice(-4).map((a) => (
                      <button
                        key={a.getAttribute("data-uim-id") ?? nameOf(a)}
                        type="button"
                        className="hover:text-zinc-200"
                        onClick={() => {
                          setSelectedId(a.getAttribute("data-uim-id"));
                          schedule();
                        }}
                      >
                        {nameOf(a)} ›
                      </button>
                    ))}
                    <span className="text-zinc-300">{nameOf(sel)}</span>
                  </div>
                </div>

                {kind === "text" && (
                  <Section title="Text" hint={sel.children.length > 0 ? "has inline formatting" : undefined}>
                    {sel.children.length === 0 ? (
                      <TextEditor key={`${selectedId}-${tick}`} value={sel.textContent ?? ""} onCommit={(v) => commit("Edit text", () => { const before = sel.innerHTML; sel.textContent = v; return () => { sel.innerHTML = before; }; })} />
                    ) : (
                      <p className="text-[11.5px] leading-5 text-zinc-500">
                        This element contains inline children (spans, links, breaks). <span className="text-zinc-300">Double-click it on the canvas</span> to edit in place without losing formatting.
                      </p>
                    )}
                  </Section>
                )}

                {font && (
                  <Section title="Typography">
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold">{font.resolvedFamily}</span>
                        <Chip tone={font.loaded ? "green" : "amber"}>{font.loaded ? "loaded" : "not loaded → fallback"}</Chip>
                        <Chip tone="zinc">{font.provider}</Chip>
                      </div>
                      <div className="mt-1 truncate font-mono text-[10.5px] text-zinc-500" title={font.stack.join(", ")}>
                        stack: {font.stack.join(", ")}
                      </div>
                      <div className="mt-1 text-[10.5px] text-zinc-500">status from document.fonts, provider from @font-face src / &lt;link&gt; host</div>
                    </div>
                    <Row label="Size">
                      <CommitInput value={px(cs.fontSize)} onCommit={(v) => setInline(sel, "font-size", v ? `${v}px` : "")} />
                    </Row>
                    <Row label="Weight">
                      <select className={inputCls} value={cs.fontWeight} onChange={(e) => setInline(sel, "font-weight", e.target.value)}>
                        {["100", "200", "300", "400", "500", "600", "700", "800", "900"].map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </Row>
                    <Row label="Line height">
                      <CommitInput value={cs.lineHeight} onCommit={(v) => setInline(sel, "line-height", v)} />
                    </Row>
                    <Row label="Tracking">
                      <CommitInput value={cs.letterSpacing} onCommit={(v) => setInline(sel, "letter-spacing", v)} />
                    </Row>
                    <Row label="Align">
                      <select className={inputCls} value={cs.textAlign} onChange={(e) => setInline(sel, "text-align", e.target.value)}>
                        {["start", "left", "center", "right", "justify"].map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </Row>
                    <Row label="Color">
                      <ColorField value={cs.color} onPreview={(v) => previewInline(sel, "color", v)} onCommit={(v) => setInline(sel, "color", v)} />
                    </Row>
                  </Section>
                )}

                <Section title="Fill & border">
                  <Row label="Background">
                    <ColorField value={cs.backgroundColor} onPreview={(v) => previewInline(sel, "background-color", v)} onCommit={(v) => setInline(sel, "background-color", v)} />
                  </Row>
                  <Row label="Opacity">
                    <CommitInput value={cs.opacity} onCommit={(v) => setInline(sel, "opacity", v)} />
                  </Row>
                  <Row label="Radius">
                    <CommitInput value={cs.borderRadius} onCommit={(v) => setInline(sel, "border-radius", v)} />
                  </Row>
                  <Row label="Border">
                    <CommitInput value={cs.borderTopStyle === "none" ? "" : `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`} placeholder="1px solid #000" onCommit={(v) => setInline(sel, "border", v)} />
                  </Row>
                </Section>

                <Section title="Layout & spacing" hint="px">
                  <Row label="Size">
                    <div className="grid grid-cols-2 gap-1">
                      <CommitInput value={px(cs.width)} onCommit={(v) => setInline(sel, "width", v ? `${v}px` : "")} placeholder="W" />
                      <CommitInput value={px(cs.height)} onCommit={(v) => setInline(sel, "height", v ? `${v}px` : "")} placeholder="H" />
                    </div>
                  </Row>
                  <Row label="Padding">
                    <div className="grid grid-cols-4 gap-1">
                      {(["top", "right", "bottom", "left"] as const).map((side) => (
                        <CommitInput key={side} value={px(cs.getPropertyValue(`padding-${side}`))} onCommit={(v) => setInline(sel, `padding-${side}`, v ? `${v}px` : "")} placeholder={side[0]?.toUpperCase()} />
                      ))}
                    </div>
                  </Row>
                  <Row label="Margin">
                    <div className="grid grid-cols-4 gap-1">
                      {(["top", "right", "bottom", "left"] as const).map((side) => (
                        <CommitInput key={side} value={px(cs.getPropertyValue(`margin-${side}`))} onCommit={(v) => setInline(sel, `margin-${side}`, v ? `${v}px` : "")} placeholder={side[0]?.toUpperCase()} />
                      ))}
                    </div>
                  </Row>
                  <Row label="Display">
                    <CommitInput value={cs.display} onCommit={(v) => setInline(sel, "display", v)} />
                  </Row>
                  {(cs.display.includes("flex") || cs.display.includes("grid")) && (
                    <Row label="Gap">
                      <CommitInput value={cs.gap} onCommit={(v) => setInline(sel, "gap", v)} />
                    </Row>
                  )}
                </Section>

                {sel instanceof (win as Window & typeof globalThis).HTMLImageElement && (
                  <Section title="Image">
                    <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                      <img src={sel.currentSrc || sel.src} alt="" className="h-12 w-12 rounded object-contain" style={{ background: "repeating-conic-gradient(#3f3f46 0 25%, #27272a 0 50%) 0 0/8px 8px" }} />
                      <div className="text-[10.5px] text-zinc-500">
                        natural {sel.naturalWidth}×{sel.naturalHeight}
                        <br />
                        rendered {Math.round(sel.width)}×{Math.round(sel.height)}
                        <br />
                        {sel.hasAttribute("srcset") ? "responsive srcset (removed on replace)" : "single source"}
                      </div>
                    </div>
                    <Row label="Source">
                      <CommitInput mono value={sel.getAttribute("src") ?? ""} onCommit={(v) => replaceImage(sel, v)} placeholder="https://… or data:" />
                    </Row>
                    <Row label="Upload">
                      <input
                        type="file"
                        accept="image/*"
                        className="block w-full text-[11px] text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-[11px] file:text-ink"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            if (typeof reader.result === "string") replaceImage(sel, reader.result);
                          };
                          reader.readAsDataURL(f);
                        }}
                      />
                    </Row>
                    <Row label="Alt">
                      <CommitInput value={sel.getAttribute("alt") ?? ""} onCommit={(v) => setAttr(sel, "alt", v)} />
                    </Row>
                    <Row label="Fit">
                      <select className={inputCls} value={cs.objectFit} onChange={(e) => setInline(sel, "object-fit", e.target.value)}>
                        {["fill", "contain", "cover", "none", "scale-down"].map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </Row>
                  </Section>
                )}

                {linkEl && (
                  <Section title="Link" hint={sameHrefCount > 1 ? `${sameHrefCount} links share this href` : undefined}>
                    <Row label="href">
                      <CommitInput mono value={linkEl.getAttribute("href") ?? ""} onCommit={(v) => setAttr(linkEl, "href", v)} />
                    </Row>
                    <Row label="target">
                      <select className={inputCls} value={linkEl.getAttribute("target") ?? ""} onChange={(e) => setAttr(linkEl, "target", e.target.value || null)}>
                        <option value="">same tab</option>
                        <option value="_blank">_blank</option>
                      </select>
                    </Row>
                    {sameHrefCount > 1 && doc ? (
                      <Btn
                        onClick={() => {
                          const href = linkEl.getAttribute("href") ?? "";
                          const next = window.prompt(`New href for all ${sameHrefCount} links`, href);
                          if (next === null || next === href) return;
                          const links = Array.from(doc.querySelectorAll(`a[href="${CSS.escape(href)}"]`));
                          commit(`Retarget ${links.length} links`, () => {
                            links.forEach((a) => a.setAttribute("href", next));
                            return () => links.forEach((a) => a.setAttribute("href", href));
                          });
                        }}
                      >
                        Apply to all {sameHrefCount}
                      </Btn>
                    ) : null}
                  </Section>
                )}

                <Section title="Attributes">
                  <div className="space-y-1">
                    {Array.from(sel.attributes)
                      .filter((a) => !a.name.startsWith("data-uim-") && a.name !== "contenteditable")
                      .slice(0, 12)
                      .map((a) => (
                        <div key={a.name} className="flex items-center gap-1 font-mono text-[10.5px]">
                          <span className="w-24 shrink-0 truncate text-zinc-400" title={a.name}>
                            {a.name}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-zinc-200" title={a.value}>
                            {a.value || '""'}
                          </span>
                          <button type="button" className="text-zinc-600 hover:text-red-300" title="Remove attribute" onClick={() => setAttr(sel, a.name, null)}>
                            ✕
                          </button>
                        </div>
                      ))}
                  </div>
                </Section>

                <Section title="Actions">
                  <div className="flex flex-wrap gap-1.5">
                    <Btn onClick={() => setInline(sel, "display", isHidden ? "" : "none", isHidden ? "Show" : "Hide")}>
                      {isHidden ? <Eye size={13} /> : <EyeOff size={13} />} {isHidden ? "Show" : "Hide"}
                    </Btn>
                    <Btn onClick={() => duplicateElement(sel)}>
                      <Copy size={13} /> Duplicate
                    </Btn>
                    <Btn onClick={() => forceVisible(sel)} title="opacity:1; transform:none; visibility:visible">
                      <Sparkles size={13} /> Force visible
                    </Btn>
                    {badgeSel ? (
                      <Btn variant="danger" onClick={removeBadges}>
                        <ShieldOff size={13} /> Remove badge
                      </Btn>
                    ) : null}
                    <Btn variant="danger" onClick={() => removeElement(sel)}>
                      <Trash2 size={13} /> Delete
                    </Btn>
                  </div>
                  <p className="text-[10.5px] leading-4 text-zinc-500">Every action is recorded with its inverse; ⌘Z reverts it exactly. In the full spec, these are serializable ops replayed on reopen.</p>
                </Section>
              </>
            )}
          </div>
        </aside>
        )}
      </div>

      {/* Status bar (collapsible — ` or the chevron) */}
      {showStatus && !focusMode && (
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-zinc-800 bg-zinc-925 px-3 font-mono text-[10.5px] text-zinc-500">
        <span className="truncate">
          hover: <span ref={statusRef} className="text-zinc-300" />
        </span>
        <span className="ml-auto truncate">{lastLabel ? `last: ${lastLabel}` : "no edits yet"}</span>
        <span>{mode === "edit" ? "edit mode · motion frozen for stable editing" : "preview mode · animations & hover live · links navigate (same-origin freezes in-canvas, others open in a tab)"}</span>
        <span className="hidden lg:inline">[ ] panels · F fullscreen · \ focus · ` status</span>
        <button type="button" onClick={() => setShowStatus(false)} title="Hide this bar for more room ( ` )" className="ml-1 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200">
          <ChevronDown size={13} />
        </button>
      </div>
      )}
    </div>
  );
}

function ReportLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="break-words text-zinc-200">{value}</div>
    </div>
  );
}

function TextEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-1.5">
      <textarea className={cn(inputCls, "min-h-[64px] resize-y leading-5")} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <Btn variant="primary" disabled={draft === value} onClick={() => onCommit(draft)}>
        Apply text
      </Btn>
    </div>
  );
}

function toHexOrEmpty(rgb: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(rgb);
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return "";
  const h = (n: string | undefined) => Number(n ?? 0).toString(16).padStart(2, "0");
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

function ColorField({ value, onPreview, onCommit }: { value: string; onPreview?: (v: string) => void; onCommit: (v: string) => void }) {
  const hex = toHexOrEmpty(value);
  return (
    <div className="flex items-center gap-1.5">
      <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded border border-zinc-700" style={{ background: hex || "repeating-conic-gradient(#3f3f46 0 25%, #27272a 0 50%) 0 0/6px 6px" }}>
        <ColorPicker key={hex} value={hex || "#000000"} onPreview={onPreview} onCommit={onCommit} />
      </label>
      <CommitInput mono value={hex || (value === "rgba(0, 0, 0, 0)" ? "transparent" : value)} onCommit={onCommit} />
    </div>
  );
}
