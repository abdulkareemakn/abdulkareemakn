#!/usr/bin/env node
// Renders the `abdulkareem` neofetch-style card into an SVG that GitHub will
// display inside a profile README.
//
//   FORCE_COLOR=3 pnpm dlx abdulkareem | node scripts/render-card.mjs profile/card.svg
//
// ANSI arrives on stdin. Each colored run becomes its own <text> element
// positioned by character cell, so columns stay aligned without depending on
// the viewer having a font installed. IBM Plex Mono is embedded as a subset
// data URI, because GitHub sandboxes README images and will not load an
// external stylesheet.
//
// Two patches are applied on the way through:
//
//   --stats <file>     replaces the GitHub figures with live values, so the
//                      card does not go stale (see fetch-stats.mjs)
//   --overrides <file> replaces any field by key, for content that lives in the
//                      published package and cannot be changed from here
//
// The palette is remapped too: the terminal colors are tuned for a light
// background, and the darker values fall below 3:1 contrast on GitHub's dark
// page background.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, stdin, stdout } from "node:process";

const FONT_SIZE = 13;
// IBM Plex Mono advances 600 units per 1000 upem, so the cell width is exact
// rather than the usual monospace guess.
const CHAR_W = FONT_SIZE * 0.6;
const LINE_H = 20;
const PAD_X = 18;
const TITLE_BAR_H = 26;
const PAD_TOP = TITLE_BAR_H + 14;
const PAD_BOTTOM = 14;
// Must match the CLI's own WIDTH so patched lines line up with untouched ones.
const WIDTH = 62;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = "#0d1117";
const BORDER = "#30363d";
const DEFAULT_FG = "#e6edf3";
const LABEL_FG = "#ffa657";
const VALUE_FG = "#a5d6ff";
const LEADER_FG = "#8b949e";

// Truecolor codes keyed by the raw "r;g;b" the CLI emits.
const TRUECOLOR = {
  // chalk.hex("#953800") on field labels
  "149;56;0": LABEL_FG,
  // chalk.hex("#0a3069") on field values
  "10;48;105": VALUE_FG,
};

const BASIC = {
  31: "#f85149", // red, deletions
  32: "#3fb950", // green, additions
  37: DEFAULT_FG,
  90: LEADER_FG, // gray, dot leaders
};

const ANSI = /\x1b\[([0-9;]*)m/g;

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Reads a --flag value, either inline or as the next argument. */
function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a file path`);
  return value;
}

function readFlagJson(name) {
  const path = flag(name);
  if (!path) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Loads a font subset and inlines it so the SVG is self-contained. */
function fontFace(file, weight) {
  const data = readFileSync(join(ROOT, "profile/fonts", file)).toString("base64");
  return `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2')}`;
}

/** Recomposes a "  Key: ..... value" line with the CLI's own dot-leader rule. */
function fieldLine(key, value) {
  const dots = ".".repeat(Math.max(2, WIDTH - (key.length + value.length + 2)));
  return [
    { text: "  ", color: DEFAULT_FG, bold: false },
    { text: key, color: LABEL_FG, bold: true },
    { text: ": ", color: DEFAULT_FG, bold: false },
    { text: dots, color: LEADER_FG, bold: false },
  ];
}

/**
 * Splits a value on the ++ and -- markers the CLI colours green and red, so
 * patched values keep that emphasis.
 */
function valueRuns(value) {
  return [
    { text: " ", color: DEFAULT_FG, bold: false },
    ...value
      .split(/(\d[\d,]*\+\+|\d[\d,]*--)/)
      .filter(Boolean)
      .map((text) => ({
        text,
        color: /\+\+$/.test(text) ? BASIC[32] : /--$/.test(text) ? BASIC[31] : VALUE_FG,
        bold: false,
      })),
  ];
}

function patchedFieldLine(key, value) {
  return [...fieldLine(key, String(value)), ...valueRuns(String(value))];
}

/**
 * Applies overrides to the parsed card. Keys are matched against the label of
 * a "Key: ..... value" line, so the README keeps whatever the package prints
 * and only the values handed in here change.
 */
function applyPatches(lines, patches) {
  if (Object.keys(patches).length === 0) return lines;

  return lines.map((line) => {
    const text = line.map((run) => run.text).join("");
    // Keys can contain spaces ("Lines of Code on GitHub"), so match lazily up to
    // the colon that precedes the dot leader.
    const match = /^\s*(.+?):\s*\.+\s/.exec(text);
    if (!match) return line;

    const value = patches[match[1]];
    if (value === undefined) return line;

    return patchedFieldLine(match[1], String(value));
  });
}

/** Splits ANSI text into lines of { text, color, bold } runs. */
function parse(input) {
  const lines = [];
  let color = DEFAULT_FG;
  let bold = false;
  let run = []; // runs on the line currently being built
  let cursor = 0;

  const emit = (text) => {
    if (text) run.push({ text, color, bold });
  };
  const endLine = () => {
    lines.push(run);
    run = [];
  };
  const applyCode = (params) => {
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === 38 && params[i + 1] === 2) {
        color = TRUECOLOR[params.slice(i + 2, i + 5).join(";")] ?? DEFAULT_FG;
        i += 4;
      } else if (code === 39) {
        color = DEFAULT_FG;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (BASIC[code]) {
        color = BASIC[code];
      }
    }
  };

  // Text is buffered and only flushed when the color changes or a line ends,
  // so a 60-character line becomes one <text>, not sixty.
  let buffer = "";
  const flush = () => {
    emit(buffer);
    buffer = "";
  };

  // Appends plain text, breaking the line at every newline.
  const pushText = (text) => {
    for (const char of text) {
      if (char === "\n") {
        flush();
        endLine();
      } else {
        buffer += char;
      }
    }
  };

  while (cursor < input.length) {
    ANSI.lastIndex = cursor;
    const next = ANSI.exec(input);

    if (!next) {
      pushText(input.slice(cursor));
      cursor = input.length;
      break;
    }

    pushText(input.slice(cursor, next.index));
    flush();
    applyCode((next[1] || "0").split(";").map(Number));
    cursor = next.index + next[0].length;
  }
  flush();

  if (run.length) endLine();

  // Drop trailing blank lines so the frame hugs the content.
  while (lines.length && lines.at(-1).every((r) => !r.text.trim())) lines.pop();

  return lines;
}

function render(lines) {
  const cols = Math.max(...lines.map((line) => line.reduce((n, r) => n + r.text.length, 0)), 0);
  const width = Math.ceil(PAD_X * 2 + cols * CHAR_W);
  const height = Math.ceil(PAD_TOP + lines.length * LINE_H + PAD_BOTTOM);

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Terminal card: Abdul Kareem, TypeScript and Python developer">`,
  );
  out.push(
    `<style>${fontFace("IBMPlexMono-Regular.woff2", 400)};${fontFace("IBMPlexMono-SemiBold.woff2", 600)};text{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;font-size:${FONT_SIZE}px}</style>`,
  );
  out.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="${BG}" stroke="${BORDER}"/>`);

  // Title bar, so the frame reads as a terminal window.
  out.push(`<path d="M0.5 6.5A6 6 0 0 1 6.5 0.5H${width - 6.5}A6 6 0 0 1 ${width - 0.5} 6.5V${TITLE_BAR_H}H0.5Z" fill="#161b22"/>`);
  out.push(`<line x1="0.5" y1="${TITLE_BAR_H}" x2="${width - 0.5}" y2="${TITLE_BAR_H}" stroke="${BORDER}"/>`);
  for (const [i, fill] of ["#ff5f56", "#ffbd2e", "#27c93f"].entries()) {
    out.push(`<circle cx="${18 + i * 16}" cy="${TITLE_BAR_H / 2}" r="5" fill="${fill}"/>`);
  }

  lines.forEach((line, row) => {
    let col = 0;
    const y = PAD_TOP + row * LINE_H;
    for (const run of line) {
      const x = PAD_X + col * CHAR_W;
      const weight = run.bold ? ' font-weight="600"' : "";
      out.push(
        `<text x="${x.toFixed(2)}" y="${y}" fill="${run.color}" xml:space="preserve"${weight}>${escapeXml(run.text)}</text>`,
      );
      col += run.text.length;
    }
  });

  out.push("</svg>");
  return out.join("\n");
}

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);

if (chunks.length === 0) {
  stdout.write("no ANSI on stdin; pipe the card in first\n");
  process.exit(1);
}

const target = argv[2];
if (!target || target.startsWith("--")) {
  stdout.write(
    "usage: render-card.mjs <output.svg> [--stats <file>] [--overrides <file>]\n",
  );
  process.exit(1);
}

// Overrides are applied first so a live stat wins over a static override.
const patches = { ...readFlagJson("--overrides"), ...readFlagJson("--stats") };

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${render(applyPatches(parse(chunks.join("")), patches))}\n`);