import { useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";
import type { PackDoc } from "@/content";
import { wordCount } from "@/content";
import { Markdown } from "./Markdown";
import { cn } from "@/utils/cn";

function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DocView({ doc }: { doc: PackDoc }) {
  const [raw, setRaw] = useState(doc.kind === "html");
  const [copied, setCopied] = useState(false);
  const words = wordCount(doc.content);

  const copy = () => {
    void navigator.clipboard.writeText(doc.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-925 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText size={15} className="shrink-0 text-indigo-300" />
          <span className="truncate font-mono text-[12.5px] text-zinc-100">{doc.kind === "html" ? `fixtures/${doc.fileName}` : doc.fileName}</span>
        </div>
        <span className="font-mono text-[11px] text-zinc-500">
          {words.toLocaleString()} words · {(doc.content.length / 1024).toFixed(1)} KB
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {doc.kind === "markdown" && (
            <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5 text-[11.5px]">
              <button type="button" onClick={() => setRaw(false)} className={cn("rounded px-2 py-0.5", !raw ? "bg-zinc-700 text-ink" : "text-zinc-400")}>
                Rendered
              </button>
              <button type="button" onClick={() => setRaw(true)} className={cn("rounded px-2 py-0.5", raw ? "bg-zinc-700 text-ink" : "text-zinc-400")}>
                Raw
              </button>
            </div>
          )}
          <button type="button" onClick={() => downloadText(doc.fileName, doc.content)} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[12px] text-zinc-100 hover:bg-zinc-700">
            <Download size={13} /> Download
          </button>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500 bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-500">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy file"}
          </button>
        </div>
      </div>
      <p className="mb-6 text-[13px] leading-6 text-zinc-400">{doc.description}</p>
      {raw ? (
        <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-925 p-4 font-mono text-[11.5px] leading-5 text-zinc-200 whitespace-pre-wrap break-words">{doc.content}</pre>
      ) : (
        <article>
          <Markdown content={doc.content} />
        </article>
      )}
    </div>
  );
}
