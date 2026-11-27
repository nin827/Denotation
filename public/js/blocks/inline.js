const ESCAPABLE = "\\`*_~[]()#>-+!{";
export const isSafeHref = (href) => /^(https?:\/\/|mailto:|#page-|#row-)/i.test(String(href).trim());
export function detectShortcut(text) {
  let m;
  if (m = /^(#{1,4}) ([\s\S]*)$/.exec(text)) return { type: `h${m[1].length}`, rest: m[2] };
  if (m = /^[-*+] ([\s\S]*)$/.exec(text)) return { type: "bullet", rest: m[1] };
  if (m = /^(\d{1,3})\. ([\s\S]*)$/.exec(text)) return { type: "numbered", rest: m[2] };
  if (m = /^\[( |x|X)?\] ([\s\S]*)$/.exec(text)) return { type: "todo", props: { checked: /x/i.test(m[1] ?? "") }, rest: m[2] };
  if (m = /^> ([\s\S]*)$/.exec(text)) return { type: "toggle", rest: m[1] };
  if (m = /^" ([\s\S]*)$/.exec(text)) return { type: "quote", rest: m[1] };
  if (/^(---|\*\*\*|___)$/.test(text)) return { type: "divider", rest: "" };
  if (m = /^```(\w*)$/.exec(text)) return { type: "code", props: { lang: m[1] || "plain" }, rest: "" };
  return null;
}
// ---------- inline tokens: {{kind:arg|arg|...}} ----------
// Args escape \\, | and } with a backslash. Unknown kinds or invalid args are not tokens (they stay literal text).
export const TOKEN_KINDS = ["value", "date"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_MAX = 600;
export const isTokenId = (s) => typeof s === "string" && ID_RE.test(s);
export function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const escArg = (a) => String(a ?? "").replace(/[\\|}]/g, "\\$&").replace(/\r?\n/g, " ");
/** Build a token string; null when the kind or args are invalid. */
export function buildToken(kind, args) {
  const node = checkToken(kind, (args ?? []).map(String));
  return node ? `{{${kind}:${node.args.map(escArg).join("|")}}}` : null;
}
function checkToken(kind, args) {
  if (kind === "value") {
    const [db, key, col] = args;
    const k = String(key ?? "").trim();
    if (args.length !== 3 || !isTokenId(db) || !isTokenId(col) || !k || k.length > 200 || /[\r\n]/.test(k)) return null;
    return { t: "inline", kind, args: [db, k, col] };
  }
  if (kind === "date") {
    return args.length === 1 && isIsoDate(args[0]) ? { t: "inline", kind, args: [args[0]] } : null;
  }
  return null;
}
/** Read a token starting at s[i] ("{{"). Returns { end, node } or null. */
export function readToken(s, i) {
  if (s[i] !== "{" || s[i + 1] !== "{") return null;
  const limit = Math.min(s.length, i + TOKEN_MAX);
  let j = i + 2;
  const parts = [""];
  let kind = null;
  while (j < limit) {
    const c = s[j];
    if (c === "\n") return null;
    if (c === "\\" && j + 1 < limit) {
      parts[parts.length - 1] += s[j + 1];
      j += 2;
      continue;
    }
    if (c === "}" && s[j + 1] === "}") {
      if (kind === null) return null;
      const node = checkToken(kind, parts);
      return node ? { end: j + 2, node } : null;
    }
    if (c === ":" && kind === null && parts.length === 1) {
      kind = parts[0];
      parts[0] = "";
      if (!TOKEN_KINDS.includes(kind)) return null;
      j++;
      continue;
    }
    if (c === "|" && kind !== null) {
      parts.push("");
      j++;
      continue;
    }
    parts[parts.length - 1] += c;
    j++;
  }
  return null;
}
/** All tokens in raw text (not inside code spans, escapes honoured): [{ start, end, node }]. */
export function scanTokens(s) {
  const out = [];
  s = String(s ?? "");
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        i = j + 1;
        continue;
      }
    }
    if (ch === "{") {
      const t = readToken(s, i);
      if (t) {
        out.push({ start: i, end: t.end, node: t.node });
        i = t.end;
        continue;
      }
    }
    i++;
  }
  return out;
}
/** Replace each token with fn(node) (a string; null keeps the token text). */
export function replaceTokens(s, fn) {
  s = String(s ?? "");
  let out = "";
  let last = 0;
  for (const t of scanTokens(s)) {
    const r = fn(t.node);
    out += s.slice(last, t.start) + (r == null ? s.slice(t.start, t.end) : r);
    last = t.end;
  }
  return out + s.slice(last);
}
/** Plain text for a token with no database access: dates as ISO, values as their key. */
export const tokenFallback = (n) => n.kind === "date" ? n.args[0] : n.args[1];
const DELIMS = [["**", "b"], ["~~", "s"], ["*", "i"], ["_", "i"]];
const isWord = (ch) => ch !== void 0 && /[A-Za-z0-9]/.test(ch);
function findClose(s, d, from) {
  for (let j = from; j <= s.length - d.length; j++) {
    if (!s.startsWith(d, j) || s[j - 1] === "\\") continue;
    if (d === "*" && (s[j + 1] === "*" || s[j - 1] === "*")) continue;
    if (d === "_" && isWord(s[j + d.length])) continue;
    return j;
  }
  return -1;
}
export function parseInline(s) {
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
      const t = readToken(s, i);
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
        out.push({ t: "link", href: m[2], children: parseInline(m[1]) });
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
        out.push({ t, children: parseInline(inner) });
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
export function stripInline(s) {
  const flat = (nodes) => nodes.map((n) => n.t === "text" || n.t === "code" ? n.v : n.t === "inline" ? tokenFallback(n) : flat(n.children)).join("");
  return flat(parseInline(s ?? ""));
}
export function toggleMarker(text, start, end, marker) {
  const before = text.slice(0, start);
  const sel = text.slice(start, end);
  const after = text.slice(end);
  const wrapped = before.endsWith(marker) && after.startsWith(marker) && !(marker === "*" && (before.endsWith("**") || after.startsWith("**")));
  if (wrapped) {
    return {
      text: before.slice(0, -marker.length) + sel + after.slice(marker.length),
      start: start - marker.length,
      end: end - marker.length
    };
  }
  return { text: before + marker + sel + marker + after, start: start + marker.length, end: end + marker.length };
}
