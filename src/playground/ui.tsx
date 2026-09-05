import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="border-b border-zinc-800/80 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h3>
        {hint ? <span className="text-[10px] text-zinc-500">{hint}</span> : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[76px_1fr] items-center gap-2 text-[12px]">
      <span className="truncate text-zinc-400">{label}</span>
      <div className="min-w-0">{children}</div>
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-zinc-700/80 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500";

/** Text input that commits on blur / Enter and resets when `value` changes from outside. */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  mono,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className={cn(inputCls, mono && "font-mono", className)}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
    />
  );
}

export function Btn({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40",
        variant === "default" && "border-zinc-700 bg-zinc-800/80 text-zinc-100 hover:bg-zinc-700",
        variant === "primary" && "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-500",
        variant === "danger" && "border-red-900/60 bg-red-950/50 text-red-200 hover:bg-red-900/60",
        variant === "ghost" && "border-transparent bg-transparent text-zinc-300 hover:bg-zinc-800",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Chip({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "indigo" | "green" | "amber" | "red" | "sky" | "violet" }) {
  const tones: Record<string, string> = {
    zinc: "bg-zinc-800 text-zinc-300 border-zinc-700",
    indigo: "bg-indigo-950/60 text-indigo-200 border-indigo-800",
    green: "bg-emerald-950/60 text-emerald-200 border-emerald-800",
    amber: "bg-amber-950/60 text-amber-200 border-amber-800",
    red: "bg-red-950/60 text-red-200 border-red-800",
    sky: "bg-sky-950/60 text-sky-200 border-sky-800",
    // The builder verdict sits next to the channel chip; a separate hue keeps "what published this"
    // from reading as another property of "how the bytes arrived".
    violet: "bg-violet-950/60 text-violet-200 border-violet-800",
  };
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium leading-none", tones[tone])}>{children}</span>;
}

/**
 * Color input with SPEC-style preview/commit semantics: `onPreview` fires continuously while the
 * native picker is open (input events), `onCommit` fires once when it closes (native change event).
 */
export function ColorPicker({ value, onPreview, onCommit, className }: { value: string; onPreview?: (hex: string) => void; onCommit: (hex: string) => void; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => onCommit(el.value);
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, [onCommit]);
  return <input ref={ref} type="color" defaultValue={value} onInput={(e) => onPreview?.(e.currentTarget.value)} className={cn("absolute inset-0 h-full w-full cursor-pointer opacity-0", className)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 py-0.5 text-[11.5px] font-medium",
            o.value === value ? "bg-zinc-700 text-ink" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
