// Proves the parseInline fast path is identical to the original character-by-character parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline } from "../../source/app/js/blocks/inline.js";

const ESCAPABLE = "\\`*_~[]()#>-+!{";
// Reference copy of the parser before the plain-run fast path (uses the same exported helpers via parseInline for tokens).
import * as inl from "../../source/app/js/blocks/inline.js";
const DELIMS = [["**", "b"], ["~~", "s"], ["*", "i"], ["_", "i"]];
const isWord = (ch) => ch !== void 0 && /[A-Za-z0-9]/.test(ch);
function findClose(s, d, from) {
  for (let j = from; j <= s.length - d.length; j++) {
    const c = s[j];
    if (c === "`" && s[j - 1] !== "\\") {
      const e = s.indexOf("`", j + 1);
      if (e > j + 1) { j = e; continue; }
    }
    if (c === "{" && s[j - 1] !== "\\") {
      const tk = inl.readToken(s, j);
      if (tk) { j = tk.end - 1; continue; }
    }
    if (!s.startsWith(d, j) || s[j - 1] === "\\") continue;
    if (d === "*" && (s[j + 1] === "*" || s[j - 1] === "*")) continue;
    if (d === "_" && isWord(s[j + d.length])) continue;
    return j;
  }
  return -1;
}
function reference(s) {
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (ch === "{") {
      const t = inl.readToken(s, i);
      if (t) {
        flush();
        out.push(t.node);
        i = t.end;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: m[2], children: reference(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    let matched = false;
    for (const [d, t] of DELIMS) {
      if (!s.startsWith(d, i)) continue;
      if (d === "_" && isWord(s[i - 1])) continue;
      const j = findClose(s, d, i + d.length);
      const inner = j > i + d.length ? s.slice(i + d.length, j) : "";
      if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
        flush();
        out.push({ t, children: reference(inner) });
        i = j + d.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

test("parseInline equals the reference parser on seeded fuzz", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const atoms = ["a", "bc", " ", "word", "**", "*", "_", "~~", "~", "`", "\\", "{{date:2026-01-02}}", "{{value:db1|k|c1}}", "{", "}}", "[", "](", "x)", "[t](https://e.com/a)", "[b](#page-q)", "\n", "é", "|", "# "];
  for (let n = 0; n < 4000; n++) {
    const len = 1 + Math.floor(rnd() * 14);
    let s = "";
    for (let i = 0; i < len; i++) s += atoms[Math.floor(rnd() * atoms.length)];
    assert.deepEqual(parseInline(s), reference(s), JSON.stringify(s));
  }
});
