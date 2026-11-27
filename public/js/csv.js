import { fromText, toText } from "./dbviews.js";

const DELIMS = [",", ";", "	", "|"];
function parseDelimited(text, delim) {
  const s = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows = [[]];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === delim) {
      rows[rows.length - 1].push(cell);
      cell = "";
      wasQuoted = false;
    } else if (ch === "\n") {
      rows[rows.length - 1].push(cell);
      cell = "";
      wasQuoted = false;
      rows.push([]);
    } else cell += ch;
  }
  if (cell !== "" || wasQuoted || rows[rows.length - 1].length) rows[rows.length - 1].push(cell);
  if (!rows[rows.length - 1].length) rows.pop();
  return rows;
}
function sniffDelimiter(text) {
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMS) {
    const grid = parseDelimited(String(text).slice(0, 2e4), d).slice(0, 30);
    const width2 = grid[0]?.length ?? 0;
    if (width2 < 2) continue;
    const consistent = grid.filter((r) => r.length === width2).length / grid.length;
    const score = consistent * 1e3 + width2;
    if (consistent >= 0.8 && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}
export const parseCsv = (text, delim) => parseDelimited(text, delim ?? sniffDelimiter(text));
function toCsv(grid, delim = ",") {
  const esc = (c) => {
    const t = c == null ? "" : String(c);
    return t.includes(delim) || /["\r\n]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return grid.map((r) => r.length === 1 && (r[0] == null || r[0] === "") ? '""' : r.map(esc).join(delim)).join("\r\n");
}
const NUM = /^-?(0|[1-9]\d*)(\.\d+)?(e[+-]?\d+)?$/i;
const BOOL = /^(true|false|yes|no)$/i;
const isDate = (t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
function guessType(values) {
  const v = values.map((x) => String(x ?? "").trim()).filter((x) => x !== "");
  if (!v.length) return "text";
  if (v.every((x) => NUM.test(x) && Number.isFinite(Number(x)))) return "number";
  if (v.every((x) => BOOL.test(x))) return "checkbox";
  if (v.every(isDate)) return "date";
  return "text";
}
const cleanNames = (headers) => {
  const seen = new Set();
  return headers.map((h, i) => {
    let name = String(h ?? "").trim() || `Column ${i + 1}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${String(h ?? "").trim() || `Column ${i + 1}`} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
};
const width = (grid) => grid.reduce((m, r) => Math.max(m, r.length), 0);
const fit = (r, w) => Array.from({ length: w }, (_, i) => r[i] ?? "");
const blank = (r) => r.every((c) => String(c).trim() === "");
export function tableFromCsv(grid) {
  const lines = grid.filter((r) => !blank(r));
  if (!lines.length) return { columns: [], rows: [] };
  const w = Math.max(1, width(lines));
  const names = cleanNames(fit(lines[0], w));
  const body = lines.slice(1).map((r) => fit(r, w));
  const columns = names.map((name, i) => ({ name, type: guessType(body.map((r) => r[i])) }));
  const rows = body.map((r) => r.map((t, i) => fromText(columns[i], t)));
  return { columns, rows };
}
export function rowsFromCsv(grid, columns) {
  const lines = grid.filter((r) => !blank(r));
  if (!lines.length) return { rows: [], matched: 0 };
  const heads = lines[0].map((x) => String(x).trim().toLowerCase());
  const map = columns.map((c) => heads.indexOf(String(c.name).trim().toLowerCase()));
  const matched = map.filter((i) => i >= 0).length;
  const positional = matched === 0;
  const body = positional ? lines : lines.slice(1);
  const rows = body.map((r) => {
    const values = {};
    columns.forEach((c, i) => {
      const at = positional ? i : map[i];
      if (at < 0 || at >= r.length || c.type === "formula") return;
      const v = fromText(c, r[at]);
      if (v !== void 0) values[c.id] = v;
    });
    return values;
  });
  return { rows, matched: positional ? Math.min(columns.length, width(lines)) : matched };
}
export function databaseToCsv(columns, rows) {
  return toCsv([columns.map((c) => c.name), ...rows.map((r) => columns.map((c) => toText(c, r.values?.[c.id])))]);
}
