const ESCAPABLE = "\\`*_~[]()#>-+!";
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
  const flat = (nodes) => nodes.map((n) => n.t === "text" || n.t === "code" ? n.v : flat(n.children)).join("");
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
