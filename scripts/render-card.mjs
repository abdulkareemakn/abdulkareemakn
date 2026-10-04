#!/usr/bin/env node
// Renders the `abdulkareem` neofetch-style card into an SVG that GitHub will
// display inside a profile README.
//
//   FORCE_COLOR=3 pnpm dlx abdulkareem | node scripts/render-card.mjs profile/card.svg
//
// ANSI arrives on stdin, the SVG path is argv[2]. Each colored run becomes its
// own <text> element positioned by character count, so columns stay aligned
// without depending on the viewer having a specific font installed.
//
// The palette is remapped on the way through: the terminal colors are tuned for
// a light background, and the darker values fall below 3:1 contrast on GitHub's
// dark page background.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { argv, stdin, stdout } from "node:process";

const FONT_SIZE = 13;
const CHAR_W = FONT_SIZE * 0.6;
const LINE_H = 20;
const PAD_X = 18;
const TITLE_BAR_H = 26;
const PAD_TOP = TITLE_BAR_H + 14;
const PAD_BOTTOM = 14;

const BG = "#0d1117";
const BORDER = "#30363d";
const DEFAULT_FG = "#e6edf3";

// Truecolor codes keyed by the raw "r;g;b" the CLI emits.
const TRUECOLOR = {
  // chalk.hex("#953800") on field labels
  "149;56;0": "#ffa657",
  // chalk.hex("#0a3069") on field values
  "10;48;105": "#a5d6ff",
};

const BASIC = {
  31: "#f85149", // red, deletions
  32: "#3fb950", // green, additions
  37: DEFAULT_FG,
  90: "#8b949e", // gray, dot leaders
};

const ANSI = /\x1b\[([0-9;]*)m/g;

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:${FONT_SIZE}px}</style>`,
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
if (!target) {
  stdout.write("usage: render-card.mjs <output.svg>  (reads ANSI from stdin)\n");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${render(parse(chunks.join("")))}\n`);