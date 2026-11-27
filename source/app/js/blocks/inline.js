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
// Kinds: value, date, preset, const ({{const:<id>}}), page ({{page:<id>}}), check ({{check:0}} or {{check:1}}),
// status ({{status:<id>}}) and formula ({{= expression}}: the text up to }} is one argument; only \\ and \} need escaping).
// Page links and embeds (stored by id, see js/links.js): {{link:<pageId>}}, {{xlink:<pageId>}} (hidden link: no graph edge),
// {{embed:<pageId>|h|<headingBlockId>}} (a heading section) and {{embed:<pageId>|b|<blockId>,<blockId>,...}} (chosen blocks).
export const TOKEN_KINDS = ["value", "date", "preset", "const", "page", "check", "status", "formula", "link", "xlink", "embed", "img", "term"];
export const EMBED_MAX_BLOCKS = 12;
export const FORMULA_MAX = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_MAX = 600;
const IMG_TOKEN_MAX = 300400; // {{img:…}} may carry a data URL; checkToken caps its src at 300000 characters
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
  if (!node) return null;
  return kind === "formula" ? `{{= ${escArg(node.args[0])}}}` : `{{${kind}:${node.args.map(escArg).join("|")}}}`;
}
function checkToken(kind, args) {
  if (kind === "value") {
    const [db, key, col] = args;
    const k = String(key ?? "").trim();
    if (args.length !== 3 || !isTokenId(db) || !isTokenId(col) || !k || k.length > 200 || /[\r\n]/.test(k)) return null;
    return { t: "inline", kind, args: [db, k, col] };
  }
  if (kind === "preset") {
    // {{preset:<presetId>}} (fixed key) or {{preset:<presetId>|<key>}}
    if (args.length < 1 || args.length > 2 || !isTokenId(args[0])) return null;
    if (args.length === 1) return { t: "inline", kind, args: [args[0]] };
    const k = String(args[1] ?? "").trim();
    if (!k || k.length > 200 || /[\r\n]/.test(k)) return null;
    return { t: "inline", kind, args: [args[0], k] };
  }
  if (kind === "date") {
    return args.length === 1 && isIsoDate(args[0]) ? { t: "inline", kind, args: [args[0]] } : null;
  }
  if (kind === "term") return args.length === 1 && isTokenId(args[0]) ? { t: "inline", kind, args: [args[0]] } : null;
  if (kind === "img") {
    // {{img:<src>|<width>|<height>|<alt>}}: src is http(s) or a data:image URL; sizes are "" | number+unit | constant name.
    if (args.length < 1 || args.length > 4) return null;
    const [src, w = "", ht = "", alt = ""] = args.map((x) => String(x ?? ""));
    const okSrc = /^https?:\/\//i.test(src) ? src.length <= 2048 : /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= 300000;
    const okSize = (v) => v === "" || (v.length <= 40 && /^[\w.-]+$/.test(v));
    if (!okSrc || !okSize(w) || !okSize(ht) || alt.length > 200 || /[\r\n]/.test(alt)) return null;
    return { t: "inline", kind, args: [src, w, ht, alt] };
  }
  if (kind === "const" || kind === "page" || kind === "status" || kind === "link" || kind === "xlink") {
    return args.length === 1 && isTokenId(args[0]) ? { t: "inline", kind, args: [args[0]] } : null;
  }
  if (kind === "check") {
    return args.length === 1 && (args[0] === "0" || args[0] === "1") ? { t: "inline", kind, args: [args[0]] } : null;
  }
  if (kind === "embed") {
    if (args.length !== 3 || !isTokenId(args[0])) return null;
    if (args[1] === "h") return isTokenId(args[2]) ? { t: "inline", kind, args: [args[0], "h", args[2]] } : null;
    if (args[1] !== "b") return null;
    const ids = args[2].split(",");
    if (ids.length > EMBED_MAX_BLOCKS || !ids.every(isTokenId) || new Set(ids).size !== ids.length) return null;
    return { t: "inline", kind, args: [args[0], "b", ids.join(",")] };
  }
  if (kind === "formula") {
    const e = args.length === 1 ? String(args[0]).trim() : "";
    return e && e.length <= FORMULA_MAX && !/[\r\n]/.test(e) ? { t: "inline", kind, args: [e] } : null;
  }
  return null;
}
/** Read a token starting at s[i] ("{{"). Returns { end, node } or null. */
export function readToken(s, i) {
  if (s[i] !== "{" || s[i + 1] !== "{") return null;
  const limit = Math.min(s.length, i + (s.startsWith("{{img:", i) ? IMG_TOKEN_MAX : TOKEN_MAX));
  let j = i + 2;
  const parts = [""];
  let kind = null;
  if (s[j] === "=") {
    kind = "formula";
    j++;
  }
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
      if (!TOKEN_KINDS.includes(kind) || kind === "formula") return null;
      j++;
      continue;
    }
    if (c === "|" && kind !== null && kind !== "formula") {
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
/**
 * Plain text for a token with no database access: dates as ISO, values as their key, presets as key or "Preset",
 * checkboxes as [x] / [ ], formulas as their expression; constants, pages and statuses as a generic word.
 */
export function tokenFallback(n) {
  switch (n.kind) {
    case "date": return n.args[0];
    case "preset": return n.args[1] ?? "Preset";
    case "check": return n.args[0] === "1" ? "[x]" : "[ ]";
    case "formula": return n.args[0];
    case "const": return "Constant";
    case "page": return "Page";
    case "status": return "Status";
    case "link": case "xlink": return "Page";
    case "embed": return "Embed";
    case "term": return "Term";
    case "img": return n.args[3] || "Image";
    default: return n.args[1];
  }
}
/** Replace the index-th (0-based, document order) token of `kind` in raw text with `token`; null when there is none. */
export function replaceNthToken(s, kind, index, token) {
  s = String(s ?? "");
  const hit = scanTokens(s).filter((t) => t.node.kind === kind)[index];
  return hit ? s.slice(0, hit.start) + token + s.slice(hit.end) : null;
}
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
const SPECIAL_CHARS = "\\`{[*_~"; // every character parseInline treats specially; anything else is plain text
const NEXT_SPECIAL = /[\\`{[*_~]/g; // lastIndex is set right before each exec, so sharing it (even recursively) is safe
const LINK_AT = /\[([^\]]+)\]\(([^)\s]+)\)/y;
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
    if (!SPECIAL_CHARS.includes(ch)) {
      // plain run: copy up to the next special character in one go
      NEXT_SPECIAL.lastIndex = i + 1;
      const m = NEXT_SPECIAL.exec(s);
      const end = m ? m.index : s.length;
      buf += s.slice(i, end);
      i = end;
      continue;
    }
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
      LINK_AT.lastIndex = i;
      const m = LINK_AT.exec(s);
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
export function stripInline(s, resolve = null) {
  const flat = (nodes) => nodes.map((n) => n.t === "text" || n.t === "code" ? n.v : n.t === "inline" ? resolve?.(n) ?? tokenFallback(n) : flat(n.children)).join("");
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
