/**
 * A/B compare — does importing a page by URL give you the same editor as pasting its Ctrl+U source?
 *
 * Raw bytes are the weakest useful question: a Framer page carries per-deploy timestamps
 * (`data-framer-ssr-released-at`, `data-framer-page-optimized-at`) and per-response nonces, so two
 * captures taken minutes apart can differ while describing the identical page. The question that
 * decides whether the two import paths are interchangeable is whether the **frozen documents** are
 * the same: same node count, same tag order, same attributes, same text, same styles.
 *
 * Three verdicts, in order of strength:
 *   identical  — the raw sources are byte-for-byte equal.
 *   equivalent — raw sources differ only in volatile fields; every frozen fingerprint matches, so
 *                the editing surface is the same document.
 *   divergent  — a fingerprint differs; the first differing regions are shown.
 *
 * Pure: DOMParser only, no React, no network.
 */

export interface Fingerprint {
  bytes: number;
  nodes: number;
  tags: string;
  attrs: string;
  text: string;
  styles: string;
  head: string;
}

export type Verdict = "identical" | "equivalent" | "divergent";

export interface MetricRow {
  label: string;
  a: string;
  b: string;
  same: boolean;
}

export interface Hunk {
  line: number;
  a: string;
  b: string;
}

export interface CompareResult {
  verdict: Verdict;
  rawIdentical: boolean;
  normalizedIdentical: boolean;
  /** Volatile patterns that actually fired, so nothing is swept under the rug silently. */
  volatileApplied: string[];
  metrics: MetricRow[];
  hunks: Hunk[];
  lineCountA: number;
  lineCountB: number;
}

/** FNV-1a, 32-bit — a content hash, not a security primitive; sync and fast enough for 700 KB. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface VolatileRule {
  label: string;
  re: RegExp;
  to: string;
}

/**
 * Fields a publisher regenerates per deploy or per response — plus one the *browser* rewrites.
 * Each is named in the report when it fires.
 *
 * Line endings come first, and they are not a publisher quirk: HTML normalises a `<textarea>`
 * value's newlines to LF, so pasting a CRLF document into the paste tab silently drops every CR
 * before the app ever sees it. midu.design ships 137 CRLF pairs, which is the *entire* raw-byte
 * delta between its two import channels. Without this rule the card can only say "differs beyond
 * the volatile fields" and the reader cannot tell a benign line-ending delta from the bot-flavoured
 * variant the card exists to catch. The parser discards CR either way, which is why every frozen
 * fingerprint still matches.
 */
export const VOLATILE_RULES: VolatileRule[] = [
  { label: "line endings (CRLF→LF)", re: /\r\n?/g, to: "\n" },
  { label: "data-framer-ssr-released-at", re: /data-framer-ssr-released-at="[^"]*"/g, to: 'data-framer-ssr-released-at="~"' },
  { label: "data-framer-page-optimized-at", re: /data-framer-page-optimized-at="[^"]*"/g, to: 'data-framer-page-optimized-at="~"' },
  { label: "nonce", re: /\snonce="[^"]*"/g, to: ' nonce="~"' },
  { label: "csrf token", re: /name="csrf[_-]?token"\s+content="[^"]*"/gi, to: 'name="csrf-token" content="~"' },
  { label: "cache-busting ?v=/?t=", re: /([?&](?:v|t|ts|cb)=)[0-9a-f]{6,}/gi, to: "$1~" },
  { label: "trailing whitespace", re: /[ \t]+$/gm, to: "" },
];

export function normalizeVolatile(html: string): { text: string; applied: string[] } {
  let text = html;
  const applied: string[] = [];
  for (const rule of VOLATILE_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      applied.push(rule.label);
      rule.re.lastIndex = 0;
      text = text.replace(rule.re, rule.to);
    }
  }
  return { text, applied };
}

/**
 * Framer ships its markup as a handful of enormous lines, so a line diff on the raw text reports
 * "line 12 differs" and tells you nothing. Breaking before every tag gives a stream of short,
 * meaningful units that both inputs share.
 */
export function toComparableLines(html: string): string[] {
  return html
    .replace(/></g, ">\n<")
    .replace(/(<[a-zA-Z!/][^>]*>)/g, "\n$1")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function fingerprint(html: string): Fingerprint {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tags: string[] = [];
  const attrs: string[] = [];
  let nodes = 0;
  const all = doc.querySelectorAll("*");
  all.forEach((el) => {
    nodes++;
    tags.push(el.tagName.toLowerCase());
    const names = Array.from(el.attributes)
      .map((a) => (a.name === "data-uim-id" ? null : `${a.name}=${a.value}`))
      .filter((v): v is string => v !== null)
      .sort();
    attrs.push(names.join("|"));
  });
  const styles = Array.from(doc.querySelectorAll("style"), (s) => s.textContent ?? "").join("\n");
  return {
    bytes: new Blob([html]).size,
    nodes,
    tags: fnv1a(tags.join(">")),
    attrs: fnv1a(attrs.join("\n")),
    text: fnv1a((doc.body?.textContent ?? "").replace(/\s+/g, " ").trim()),
    styles: fnv1a(styles),
    head: fnv1a(doc.head?.innerHTML ?? ""),
  };
}

/**
 * Bounded resynchronising diff: walk both line streams together, and on a mismatch look ahead up to
 * `window` lines for a common anchor so one inserted block does not report every later line as
 * different. Deterministic and linear — no LCS matrix over 40k lines.
 */
export function diffLines(a: string[], b: string[], maxHunks = 12, window = 40): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && hunks.length < maxHunks) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    hunks.push({ line: i + 1, a: a[i] ?? "", b: b[j] ?? "" });
    let resynced = false;
    for (let k = 1; k <= window && !resynced; k++) {
      if (a[i + k] !== undefined && a[i + k] === b[j]) {
        i += k;
        resynced = true;
      } else if (b[j + k] !== undefined && a[i] === b[j + k]) {
        j += k;
        resynced = true;
      } else if (a[i + k] !== undefined && a[i + k] === b[j + k]) {
        i += k;
        j += k;
        resynced = true;
      }
    }
    if (!resynced) {
      i++;
      j++;
    }
  }
  if (hunks.length < maxHunks && (i < a.length || j < b.length)) {
    hunks.push({ line: i + 1, a: a[i] ?? "(end of A)", b: b[j] ?? "(end of B)" });
  }
  return hunks;
}

export function compareFrozen(rawA: string, rawB: string, frozenA: string, frozenB: string): CompareResult {
  const rawIdentical = rawA === rawB;
  const na = normalizeVolatile(rawA);
  const nb = normalizeVolatile(rawB);
  const normalizedIdentical = na.text === nb.text;
  const fa = fingerprint(frozenA);
  const fb = fingerprint(frozenB);

  const metrics: MetricRow[] = [
    { label: "raw source bytes", a: new Blob([rawA]).size.toLocaleString(), b: new Blob([rawB]).size.toLocaleString(), same: new Blob([rawA]).size === new Blob([rawB]).size },
    { label: "frozen bytes", a: fa.bytes.toLocaleString(), b: fb.bytes.toLocaleString(), same: fa.bytes === fb.bytes },
    { label: "elements mapped", a: fa.nodes.toLocaleString(), b: fb.nodes.toLocaleString(), same: fa.nodes === fb.nodes },
    { label: "tag sequence", a: fa.tags, b: fb.tags, same: fa.tags === fb.tags },
    { label: "attributes", a: fa.attrs, b: fb.attrs, same: fa.attrs === fb.attrs },
    { label: "visible text", a: fa.text, b: fb.text, same: fa.text === fb.text },
    { label: "inline stylesheets", a: fa.styles, b: fb.styles, same: fa.styles === fb.styles },
    { label: "head", a: fa.head, b: fb.head, same: fa.head === fb.head },
  ];

  const structural = metrics.filter((m) => m.label !== "raw source bytes" && m.label !== "frozen bytes");
  const allStructuralSame = structural.every((m) => m.same);
  const verdict: Verdict = rawIdentical ? "identical" : allStructuralSame ? "equivalent" : "divergent";

  const linesA = toComparableLines(na.text);
  const linesB = toComparableLines(nb.text);
  return {
    verdict,
    rawIdentical,
    normalizedIdentical,
    volatileApplied: Array.from(new Set([...na.applied, ...nb.applied])),
    metrics,
    hunks: verdict === "identical" ? [] : diffLines(linesA, linesB),
    lineCountA: linesA.length,
    lineCountB: linesB.length,
  };
}
