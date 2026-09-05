import kickoff from "./docs/KICKOFF.md?raw";
import claudeMd from "./docs/CLAUDE.md?raw";
import spec from "./docs/SPEC.md?raw";
import plan from "./docs/PLAN.md?raw";
import howto from "./docs/HOWTO.md?raw";
import framerFixture from "./fixtures/framer-min.html?raw";
import webflowFixture from "./fixtures/webflow-min.html?raw";

export type DocKind = "markdown" | "html";

export interface PackDoc {
  id: string;
  title: string;
  fileName: string;
  description: string;
  kind: DocKind;
  content: string;
  /** Included in the concatenated mega prompt */
  inMegaPrompt: boolean;
}

export const docs: PackDoc[] = [
  {
    id: "howto",
    title: "How to use",
    fileName: "HOWTO.md",
    description: "Set-up steps, how to grab Ctrl+U source from Framer/Webflow, what to check, and mid-build correction prompts.",
    kind: "markdown",
    content: howto,
    inMegaPrompt: false,
  },
  {
    id: "kickoff",
    title: "Kickoff prompt",
    fileName: "KICKOFF.md",
    description: "The first message to paste into Claude Code. Points at the three contract files and repeats the hard constraints.",
    kind: "markdown",
    content: kickoff,
    inMegaPrompt: true,
  },
  {
    id: "claude",
    title: "CLAUDE.md",
    fileName: "CLAUDE.md",
    description: "Operating rules: truth discipline, no-shortcut discipline, verification gates, engineering standards, Definition of Done.",
    kind: "markdown",
    content: claudeMd,
    inMegaPrompt: true,
  },
  {
    id: "spec",
    title: "SPEC.md",
    fileName: "SPEC.md",
    description: "Full technical spec: truth model, FREEZE→MAP→SENSE→PATCH→EXPORT pipeline, op contract, Override Ladder, canvas/overlay/targeting, panels, stack, signatures, budgets, acceptance scenarios, types.",
    kind: "markdown",
    content: spec,
    inMegaPrompt: true,
  },
  {
    id: "plan",
    title: "PLAN.md",
    fileName: "PLAN.md",
    description: "Eight phases with tests and hard gates, spike-first policy, and the phase report template.",
    kind: "markdown",
    content: plan,
    inMegaPrompt: true,
  },
  {
    id: "fixture-framer",
    title: "fixtures/framer-min.html",
    fileName: "framer-min.html",
    description: "Realistic Framer SSR-style fixture: tokens, @font-face, appear-id starting state, hydrate attrs, module script, Made-in-Framer badge.",
    kind: "html",
    content: framerFixture,
    inMegaPrompt: true,
  },
  {
    id: "fixture-webflow",
    title: "fixtures/webflow-min.html",
    fileName: "webflow-min.html",
    description: "Realistic Webflow export-style fixture: data-wf-*, WebFont.load script, w-* classes, data-w-id initial state, runtime badge markup, jQuery/webflow.js scripts.",
    kind: "html",
    content: webflowFixture,
    inMegaPrompt: true,
  },
];

export const fixtures = {
  framer: framerFixture,
  webflow: webflowFixture,
};

const fileHeader = (path: string) =>
  `\n\n${"=".repeat(78)}\nFILE: ${path}\n${"=".repeat(78)}\n\n`;

const filePathFor = (doc: PackDoc): string =>
  doc.kind === "html" ? `fixtures/${doc.fileName}` : doc.fileName;

/** Everything Claude Code needs in a single message. */
export function buildMegaPrompt(): string {
  const preamble = [
    "Below is a complete prompt pack for building UIMaster. It contains six files separated by `FILE:` markers.",
    "",
    "FIRST ACTION: write every file below to disk at exactly the path given in its marker (create `fixtures/` if needed), byte-for-byte, before doing anything else. Then follow the instructions in the section titled `FILE: KICKOFF.md` as if it were my first message to you.",
  ].join("\n");

  const body = docs
    .filter((d) => d.inMegaPrompt)
    .map((d) => fileHeader(filePathFor(d)) + d.content.trimEnd())
    .join("\n");

  return `${preamble}${body}\n`;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
