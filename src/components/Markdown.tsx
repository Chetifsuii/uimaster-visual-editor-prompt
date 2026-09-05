import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-4">
      <button
        type="button"
        onClick={() => {
          const text = preRef.current?.textContent ?? "";
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800/90 px-1.5 py-0.5 text-[10.5px] text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={preRef} className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-925 p-4 text-[12px] leading-5 text-zinc-200 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
        {children}
      </pre>
    </div>
  );
}

// Long-form prose runs in the serif; UI chrome, headings and code stay sans/display/mono.
// Source Serif needs about a point more than Inter to read at the same apparent size, hence 14.5.
const proseCls = "font-serif text-[14.5px] leading-7 text-zinc-300";

const components: Components = {
  h1: ({ children }) => <h1 className="mb-4 mt-2 border-b border-zinc-800 pb-3 text-2xl font-semibold tracking-tight text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 mt-10 text-lg font-semibold tracking-tight text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-7 text-[14.5px] font-semibold text-zinc-100">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-zinc-300">{children}</h4>,
  p: ({ children }) => <p className={`my-3 ${proseCls}`}>{children}</p>,
  ul: ({ children }) => <ul className={`my-3 list-disc space-y-1 pl-5 marker:text-zinc-600 ${proseCls}`}>{children}</ul>,
  ol: ({ children }) => <ol className={`my-3 list-decimal space-y-1 pl-5 marker:text-zinc-500 ${proseCls}`}>{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-indigo-300 underline decoration-indigo-800 underline-offset-2 hover:text-indigo-200">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-zinc-50">{children}</strong>,
  em: ({ children }) => <em className="text-zinc-200">{children}</em>,
  hr: () => <hr className="my-8 border-zinc-800" />,
  blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-indigo-500/70 bg-indigo-950/20 px-4 py-1 text-zinc-300 [&_p]:my-2">{children}</blockquote>,
  code: ({ children, className }) => <code className={`rounded bg-zinc-800/90 px-1 py-0.5 font-mono text-[12px] text-amber-100 ${className ?? ""}`}>{children}</code>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full border-collapse text-left text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-900 text-zinc-200">{children}</thead>,
  th: ({ children }) => <th className="border-b border-zinc-800 px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-800/70 px-3 py-2 align-top leading-5 text-zinc-300">{children}</td>,
  input: ({ checked }) => (
    <span className={`mr-1.5 inline-block h-3 w-3 -translate-y-px rounded-sm border align-middle ${checked ? "border-emerald-500 bg-emerald-500/40" : "border-zinc-600"}`} />
  ),
};

export function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
