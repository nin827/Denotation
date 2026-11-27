// Pure math helpers (no DOM, no KaTeX): the {{math:<latex>}} token text, limits, and the Markdown `$...$` / `$$` mapping.
// Node-safe; the token grammar itself lives in blocks/inline.js (kind "math").
import { scanTokens } from "../blocks/inline.js";
import { walk } from "../blocks/model.js";

export const MAX_INLINE_LATEX = 400; // one {{math:…}} token; blocks/inline.js caps a math token at MATH_TOKEN_MAX characters
export const MAX_BLOCK_LATEX = 4000;
export const MATH_TOKEN_MAX = 1400; // worst case: MAX_INLINE_LATEX characters all escaped, plus the wrapper

/** The same escape blocks/inline.js applies to token args: \\, | and } get a backslash, line breaks become spaces. */
export const escapeMathArg = (s) => String(s ?? "").replace(/[\\|}]/g, "\\$&").replace(/\r?\n/g, " ");

/** Trim a LaTeX source and cut it to `max` characters. */
export const cleanLatex = (s, max = MAX_INLINE_LATEX) => String(s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);

/** `{{math:…}}` for a LaTeX source, or null when it is empty. Line breaks inside the source become spaces. */
export function mathToken(latex) {
  const l = cleanLatex(latex).replace(/\s*\n\s*/g, " ");
  return l ? `{{math:${escapeMathArg(l)}}}` : null;
}

/** The math tokens of a text: [{ start, end, latex }] in order. */
export const mathTokens = (text) => scanTokens(text).filter((t) => t.node.kind === "math").map((t) => ({ start: t.start, end: t.end, latex: t.node.args[0] }));

/** Replace the `index`-th math token with `latex` (an empty source removes it). Returns the new text, or null when there is no such token. */
export function replaceNthMath(text, index, latex) {
  text = String(text ?? "");
  const t = mathTokens(text)[index];
  if (!t) return null;
  return text.slice(0, t.start) + (mathToken(latex) ?? "") + text.slice(t.end);
}

/** Plain text of a chip (search, copy, Markdown export). */
export const mathText = (latex) => `$${latex}$`;

/** Markdown for a display block. */
export const blockToMarkdown = (latex) => `$$\n${String(latex ?? "").trim()}\n$$`;

/**
 * A `$$ … $$` display block starting at lines[i]: `$$` alone, the body lines, then `$$` alone; or all on one line
 * (`$$ x^2 $$`). Returns { text, end } (end = index of the last consumed line) or null.
 */
export function parseMathBlock(lines, i) {
  const first = String(lines[i] ?? "").trim();
  if (!first.startsWith("$$")) return null;
  const one = /^\$\$(.+?)\$\$$/.exec(first);
  if (one && one[1].trim()) return { text: cleanLatex(one[1], MAX_BLOCK_LATEX), end: i };
  if (first !== "$$") return null;
  const body = [];
  for (let j = i + 1; j < lines.length && j <= i + 200; j++) {
    if (lines[j].trim() === "$$") return body.length ? { text: cleanLatex(body.join("\n"), MAX_BLOCK_LATEX), end: j } : null;
    body.push(lines[j]);
  }
  return null;
}

/**
 * Turn `$…$` spans of plain text into {{math:…}} tokens. Pandoc's rules keep prices literal: the opening `$` is followed by
 * a non-space, the closing `$` follows a non-space and is not followed by a digit; `\$`, code spans and existing tokens are left alone.
 */
export function dollarsToTokens(text) {
  text = String(text ?? "");
  if (!text.includes("$")) return text;
  let out = "";
  let last = 0;
  for (const t of scanTokens(text)) {
    out += segmentDollars(text.slice(last, t.start)) + text.slice(t.start, t.end);
    last = t.end;
  }
  return out + segmentDollars(text.slice(last));
}
function segmentDollars(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    if (c === "$" && s[i + 1] !== "$" && s[i + 1] !== undefined && !/\s/.test(s[i + 1])) {
      let j = i + 1;
      let close = -1;
      while (j < s.length && j - i <= MAX_INLINE_LATEX + 1) {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$" && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] ?? "")) {
          close = j;
          break;
        }
        j++;
      }
      const tok = close > 0 ? mathToken(s.slice(i + 1, close)) : null;
      if (tok) {
        out += tok;
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const TEXT_TYPES = ["p", "h1", "h2", "h3", "h4", "bullet", "numbered", "todo", "toggle", "quote", "callout"];
/** Convert `$…$` in every text block of an imported tree (in place); returns the tree. Code blocks are not touched. */
export function convertDollars(blocks) {
  walk(blocks, (b) => {
    if (TEXT_TYPES.includes(b.type) && typeof b.text === "string") b.text = dollarsToTokens(b.text);
  });
  return blocks;
}
