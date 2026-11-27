// Page links and embeds: pure core (no DOM, no storage). Node imports this, so keep it that way.
//
// STORAGE FORMAT (inside a block's `text`, or a table cell), by id so links survive renames and moves:
//   {{link:<pageId>}}                          a link; shown text follows the page's current title
//   {{xlink:<pageId>}}                         the same link, hidden: draws no graph edge
//   {{embed:<pageId>|h|<headingBlockId>}}      a heading section of that page, shown inline (read-only)
//   {{embed:<pageId>|b|<blockId>,<blockId>}}   chosen blocks (1..EMBED_MAX_BLOCKS, order kept as chosen)
// They are ordinary inline tokens (blocks/inline.js grammar, ids match [A-Za-z0-9_-]{1,64}, so UUIDs fit), and
// they coexist with the older forms: `[text](#page-<id>)` markdown links (the `@` mention) and `{{page:<id>}}`
// chips still render as before and still count as normal links in `extractLinks`.
//
// Why tokens and not `[Title](#page-id)`: that form stores the title, which goes stale on rename, and has no room
// for the hidden flag or for embed targets. Reusing the token grammar gives escaping, code-span and `\` handling,
// validation and `replaceNthToken` for free, and `{{` can't collide with markdown.
//
// TYPED SYNTAX (what the user types or sees in raw mode; converted by parseWikiSyntax / toWikiSyntax):
//   [[Title]]  x[[Title]]  ![[Title]] (plain link)  ![[Title][Heading text]]  ![[Title](blockId, blockId)]
// Rules: titles and heading text may not contain  [ ] { } ` \  or a newline (use the picker for those; a stored
// token never has this limit). Matching is case-insensitive, trimmed, inner whitespace collapsed. The `x` must be
// at a word boundary (`box[[A]]` is the word "box" plus a normal link). Typed syntax is ignored in code spans, after
// a backslash (`\[[A]]`) and inside existing tokens. Only call these on inline text (not on code blocks).
import { scanTokens, readToken, buildToken, parseInline, stripInline, isTokenId, EMBED_MAX_BLOCKS } from "./blocks/inline.js";
import { isTexty, find, plainText } from "./blocks/model.js";
import { blocksToMarkdown } from "./blocks/markdown.js";

export { EMBED_MAX_BLOCKS };

// ---------- small helpers ----------
const isObj = (v) => v !== null && typeof v === "object";
const HEADING = /^h([1-4])$/;
/** Case-insensitive, trimmed, inner whitespace collapsed: how titles and heading texts are compared. */
export const normTitle = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** Accepts a function id -> page, a Map, an array of pages or a plain object keyed by id. Returns a getter. */
export function pageGetter(pages) {
  if (typeof pages === "function") return pages;
  if (pages instanceof Map) return (id) => pages.get(id);
  if (Array.isArray(pages)) {
    const idx = new Map();
    for (const p of pages) if (isObj(p) && typeof p.id === "string") idx.set(p.id, p);
    return (id) => idx.get(id);
  }
  if (isObj(pages)) return (id) => (Object.hasOwn(pages, id) ? pages[id] : undefined);
  return () => undefined;
}
/** Null-safe depth-first walk over a block list (document order). fn(block, parentList). */
function eachBlock(blocks, fn) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    fn(b, blocks);
    eachBlock(b.children, fn);
  }
}
/** Inline strings of one block (its own, not its children's): text of text-like blocks and table cells. */
function blockTexts(b) {
  if (isTexty(b)) return typeof b.text === "string" ? [b.text] : [];
  if (b.type === "table" && Array.isArray(b.cells)) return b.cells.flat().filter((c) => typeof c === "string");
  return [];
}
const pageBlocks = (p) => (Array.isArray(p?.blocks) ? p.blocks : []);

// ---------- typed syntax <-> tokens ----------
const T = "[^\\[\\]\\n\\r{}`\\\\]+"; // a title / heading text
const LINK_RE = new RegExp(`\\[\\[(${T})\\]\\]`, "y");
const EMBED_H_RE = new RegExp(`!\\[\\[(${T})\\]\\[(${T})\\]\\]`, "y");
const EMBED_B_RE = new RegExp(`!\\[\\[(${T})\\]\\(([A-Za-z0-9_-]+(?: *, *[A-Za-z0-9_-]+)*)\\)\\]`, "y");
const TITLE_OK = new RegExp(`^${T}$`);
const WORD = /[\p{L}\p{N}_]/u;
const prevChar = (s, i) => {
  if (i <= 0) return "";
  const c = s.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1];
};
const wordBefore = (s, i) => WORD.test(prevChar(s, i));
const blank = (s) => !s.trim();

/** Every typed wiki form in `s` (same skipping rules as scanTokens): [{ start, end, form, title, heading?, refs? }]. */
function scanWiki(s) {
  const out = [];
  let i = 0;
  let m;
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
        i = t.end;
        continue;
      }
    }
    if (ch === "!" && s[i + 1] === "[" && s[i + 2] === "[") {
      EMBED_H_RE.lastIndex = i;
      if ((m = EMBED_H_RE.exec(s)) && !blank(m[1]) && !blank(m[2])) {
        out.push({ start: i, end: i + m[0].length, form: "embed-h", title: m[1].trim(), heading: m[2].trim() });
        i += m[0].length;
        continue;
      }
      EMBED_B_RE.lastIndex = i;
      if ((m = EMBED_B_RE.exec(s)) && !blank(m[1])) {
        out.push({ start: i, end: i + m[0].length, form: "embed-b", title: m[1].trim(), refs: m[2].split(",").map((x) => x.trim()) });
        i += m[0].length;
        continue;
      }
      LINK_RE.lastIndex = i + 1;
      if ((m = LINK_RE.exec(s)) && !blank(m[1])) {
        out.push({ start: i, end: i + 1 + m[0].length, form: "plain", title: m[1].trim() });
        i += 1 + m[0].length;
        continue;
      }
    } else if (ch === "x" && s[i + 1] === "[" && s[i + 2] === "[" && !wordBefore(s, i)) {
      LINK_RE.lastIndex = i + 1;
      if ((m = LINK_RE.exec(s)) && !blank(m[1])) {
        out.push({ start: i, end: i + 1 + m[0].length, form: "xlink", title: m[1].trim() });
        i += 1 + m[0].length;
        continue;
      }
    } else if (ch === "[" && s[i + 1] === "[") {
      LINK_RE.lastIndex = i;
      if ((m = LINK_RE.exec(s)) && !blank(m[1])) {
        out.push({ start: i, end: i + m[0].length, form: "link", title: m[1].trim() });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const headingsOf = (blocks, text) => {
  const want = normTitle(text);
  const hits = [];
  eachBlock(blocks, (b) => {
    if (HEADING.test(b.type) && isTokenId(b.id) && normTitle(stripInline(b.text ?? "")) === want) hits.push(b);
  });
  return hits;
};
/**
 * Build a `resolveTitle(title)` from a page list: returns every page whose normalised title matches, as
 * { id, title, blocks } (blocks are only read). Pages without a valid token id are skipped.
 */
export function makeTitleResolver(pages) {
  const byTitle = new Map();
  for (const p of Array.isArray(pages) ? pages : pages instanceof Map ? pages.values() : []) {
    if (!isObj(p) || !isTokenId(p.id)) continue;
    const k = normTitle(p.title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push({ id: p.id, title: p.title, blocks: p.blocks });
  }
  return (title) => byTitle.get(normTitle(title)) ?? [];
}
/**
 * Convert typed `[[Title]]`, `x[[Title]]`, `![[Title]]`, `![[Title][Heading]]`, `![[Title](blockId,...)]` into stored
 * tokens. `resolveTitle(title)` returns candidate pages ({ id, title, blocks? } or an array of them, or null);
 * embeds need `blocks` to resolve the heading text / check block ids.
 * Anything that does not resolve to exactly one target is left exactly as typed.
 * `opts.choose(entry)` may settle an ambiguity by returning one of `entry.options[].id` (else it stays ambiguous).
 * Returns { text, replaced, ambiguous, unresolved }. Entry positions refer to the returned `text`:
 *   ambiguous: [{ start, end, raw, form, what: "page"|"heading", title, heading?, options: [{ id, title }] }]
 *   unresolved: [{ start, end, raw, form, what: "page"|"heading"|"block" }]
 */
export function parseWikiSyntax(text, resolveTitle, opts = {}) {
  const s = String(text ?? "");
  const res = { text: s, replaced: 0, ambiguous: [], unresolved: [] };
  if (!s.includes("[[")) return res;
  let out = "";
  let last = 0;
  for (const w of scanWiki(s)) {
    out += s.slice(last, w.start);
    last = w.end;
    const raw = s.slice(w.start, w.end);
    const at = out.length;
    const entry = { start: at, end: at + raw.length, raw, form: w.form };
    let cands = asList(resolveTitle?.(w.title)).filter((c) => isObj(c) && isTokenId(c.id));
    let token = null;
    const ambiguous = (what, options, extra = {}) => {
      const pick = opts.choose?.({ ...entry, what, title: w.title, options, ...extra });
      return options.some((o) => o.id === pick) ? pick : (res.ambiguous.push({ ...entry, what, title: w.title, ...extra, options }), null);
    };
    if (cands.length > 1) {
      const pick = ambiguous("page", cands.map((c) => ({ id: c.id, title: c.title ?? "" })), w.heading != null ? { heading: w.heading } : {});
      cands = pick ? cands.filter((c) => c.id === pick).slice(0, 1) : [];
      if (!pick) {
        out += raw;
        continue;
      }
    }
    if (cands.length === 0) {
      res.unresolved.push({ ...entry, what: "page" });
    } else {
      const page = cands[0];
      if (w.form === "link" || w.form === "xlink" || w.form === "plain") {
        token = buildToken(w.form === "xlink" ? "xlink" : "link", [page.id]);
      } else if (w.form === "embed-h") {
        const hits = Array.isArray(page.blocks) ? headingsOf(page.blocks, w.heading) : [];
        let target = hits.length === 1 ? hits[0].id : null;
        if (hits.length > 1) {
          target = ambiguous("heading", hits.map((b) => ({ id: b.id, title: stripInline(b.text ?? "").trim() })), { heading: w.heading });
          if (!target) {
            out += raw;
            continue;
          }
        }
        if (target) token = buildToken("embed", [page.id, "h", target]);
        else res.unresolved.push({ ...entry, what: "heading" });
      } else {
        const have = new Set();
        eachBlock(page.blocks, (b) => have.add(b.id));
        const ids = [...new Set(w.refs)];
        if (ids.length <= EMBED_MAX_BLOCKS && ids.every((id) => have.has(id))) token = buildToken("embed", [page.id, "b", ids.join(",")]);
        else res.unresolved.push({ ...entry, what: "block" });
      }
    }
    if (token) {
      out += token;
      res.replaced++;
    } else out += raw;
  }
  res.text = out + s.slice(last);
  return res;
}
/**
 * Show stored tokens as typed syntax with current titles. `pageInfo` is a function id -> { title, blocks }, a Map,
 * an array of pages or an object keyed by id. A token is left as is when it cannot be written safely: unknown
 * page, a title/heading with forbidden characters, neighbouring text that would change its meaning (`!` or a
 * word-boundary `x` before a plain link, a word character before an x-link), or, when `resolveTitle` is given,
 * a title that does not resolve to exactly that page (or heading). With `resolveTitle` the whole result is also
 * verified: unless `parseWikiSyntax(result)` gives back the input exactly, the input is returned unchanged.
 */
export function toWikiSyntax(text, pageInfo, resolveTitle = null) {
  const s = String(text ?? "");
  if (!s.includes("{{")) return s;
  const get = pageGetter(pageInfo);
  const titleOf = (id) => {
    const p = get(id);
    const t = typeof p?.title === "string" ? p.title.trim() : "";
    if (!p || !t || !TITLE_OK.test(t)) return null;
    if (resolveTitle) {
      const c = asList(resolveTitle(t)).filter((x) => isObj(x) && isTokenId(x.id));
      if (c.length !== 1 || c[0].id !== id) return null;
    }
    return t;
  };
  let out = "";
  let last = 0;
  for (const t of scanTokens(s)) {
    const n = t.node;
    if (n.kind !== "link" && n.kind !== "xlink" && n.kind !== "embed") continue;
    const title = titleOf(n.args[0]);
    if (title === null) continue;
    let typed = null;
    if (n.kind === "link") {
      const prev = prevChar(s, t.start);
      const xBoundary = prev === "x" && !wordBefore(s, t.start - 1);
      if (prev !== "!" && !xBoundary) typed = `[[${title}]]`;
    } else if (n.kind === "xlink") {
      if (!wordBefore(s, t.start)) typed = `x[[${title}]]`;
    } else if (n.args[1] === "h") {
      const root = pageBlocks(get(n.args[0]));
      const b = find(root, n.args[2])?.block;
      const ht = b && HEADING.test(b.type) ? stripInline(b.text ?? "").trim() : "";
      if (ht && TITLE_OK.test(ht)) {
        const same = headingsOf(root, ht);
        if (same.length === 1 && same[0].id === b.id) typed = `![[${title}][${ht}]]`;
      }
    } else {
      const blocks = pageBlocks(get(n.args[0]));
      if (n.args[2].split(",").every((id) => find(blocks, id))) typed = `![[${title}](${n.args[2]})]`;
    }
    if (typed === null) continue;
    out += s.slice(last, t.start) + typed;
    last = t.end;
  }
  const result = out + s.slice(last);
  if (resolveTitle && result !== s && parseWikiSyntax(result, resolveTitle).text !== s) return s;
  return result;
}

// ---------- link extraction (graph feed) ----------
const PAGE_HREF = /^#page-([A-Za-z0-9_-]{1,64})$/;
/**
 * Every page reference in one page, per page (cheap to call on save): [{ from, to, hidden, kind, blockId, via }].
 * kind "link" | "embed"; hidden is true only for `{{xlink:}}`; via is "link" | "xlink" | "embed" | "chip" | "md".
 * Counts `{{link}}`, `{{xlink}}`, `{{embed}}`, `{{page:id}}` chips and `[text](#page-id)` markdown links, in the text of
 * every block at any depth (children, toggles, callouts, columns) and in table cells. One entry per occurrence; use
 * `uniqueEdges` to collapse. Sub-page blocks (`type: "page"`) and `#row-` links are not included.
 */
export function extractLinks(page) {
  const out = [];
  if (!isObj(page) || typeof page.id !== "string") return out;
  const from = page.id;
  eachBlock(page.blocks, (b) => {
    for (const text of blockTexts(b)) {
      if (!text.includes("{{") && !text.includes("#page-")) continue;
      for (const { node } of scanTokens(text)) {
        const k = node.kind;
        if (k === "link" || k === "xlink") out.push({ from, to: node.args[0], hidden: k === "xlink", kind: "link", blockId: b.id, via: k });
        else if (k === "embed") out.push({ from, to: node.args[0], hidden: false, kind: "embed", blockId: b.id, via: "embed" });
        else if (k === "page") out.push({ from, to: node.args[0], hidden: false, kind: "link", blockId: b.id, via: "chip" });
      }
      if (text.includes("](#page-")) {
        const visit = (nodes) => {
          for (const n of nodes) {
            if (n.t === "link") {
              const m = PAGE_HREF.exec(String(n.href).trim());
              if (m) out.push({ from, to: m[1], hidden: false, kind: "link", blockId: b.id, via: "md" });
            }
            if (n.children) visit(n.children);
          }
        };
        visit(parseInline(text));
      }
    }
  });
  return out;
}
/** Collapse occurrences to one edge per (from, to, kind): hidden only when every occurrence is hidden. */
export function uniqueEdges(links) {
  const m = new Map();
  for (const l of links) {
    const key = `${l.from}\u0000${l.to}\u0000${l.kind}`;
    const e = m.get(key);
    if (!e) m.set(key, { from: l.from, to: l.to, kind: l.kind, hidden: l.hidden, count: 1 });
    else {
      e.hidden = e.hidden && l.hidden;
      e.count++;
    }
  }
  return [...m.values()];
}

// ---------- embeds ----------
/** Normalise an embed token (inline node, `{ kind, args }`, token string or an already normalised embed) to { pageId, mode, id | ids }, or null. */
export function parseEmbed(token) {
  let n = token;
  if (typeof token === "string") {
    const r = readToken(token.trim(), 0);
    n = r && r.end === token.trim().length ? r.node : null;
  }
  if (isObj(n) && n.kind === undefined && typeof n.pageId === "string") {
    // an already normalised embed ({ pageId, mode, id | ids }, e.g. a unit from embedChain)
    n = { kind: "embed", args: [n.pageId, n.mode, n.mode === "h" ? n.id : Array.isArray(n.ids) ? n.ids.join(",") : ""] };
  }
  if (!isObj(n) || n.kind !== "embed" || !Array.isArray(n.args) || n.args.length !== 3) return null;
  const [pageId, mode, ref] = n.args;
  if (!isTokenId(pageId) || typeof ref !== "string") return null;
  if (mode === "h") return isTokenId(ref) ? { pageId, mode, id: ref } : null;
  if (mode !== "b") return null;
  const ids = ref.split(",");
  return ids.length >= 1 && ids.length <= EMBED_MAX_BLOCKS && ids.every(isTokenId) ? { pageId, mode, ids } : null;
}
/** Stable identity of an embedded unit (what is shown), used for loop detection and as a render-stack key. */
export const embedKey = (e) => (e.mode === "h" ? `${e.pageId}|h|${e.id}` : `${e.pageId}|b|${e.ids.join(",")}`);
const err = (code, message, extra = {}) => ({ code, message, ...extra });
function resolveWith(get, e) {
  if (!e) return { ok: false, blocks: [], error: err("bad-token", "Not a valid embed"), mode: null };
  const page = get(e.pageId);
  if (!isObj(page)) return { ok: false, blocks: [], error: err("no-page", "The embedded page no longer exists", { pageId: e.pageId }), mode: e.mode };
  const root = pageBlocks(page);
  if (e.mode === "h") {
    const r = find(root, e.id);
    if (!r) return { ok: false, blocks: [], error: err("no-heading", "The embedded heading no longer exists", { pageId: e.pageId, blockId: e.id }), mode: "h" };
    const level = HEADING.exec(r.block.type)?.[1];
    if (!level) return { ok: false, blocks: [], error: err("not-heading", "The embedded block is not a heading", { pageId: e.pageId, blockId: e.id }), mode: "h" };
    const blocks = [r.block];
    for (let i = r.index + 1; i < r.list.length; i++) {
      const b = r.list[i];
      const l = isObj(b) ? HEADING.exec(b.type)?.[1] : null;
      if (l && Number(l) <= Number(level)) break;
      if (isObj(b)) blocks.push(b);
    }
    return { ok: true, blocks, error: null, mode: "h" };
  }
  const blocks = [];
  const missing = [];
  for (const id of e.ids) {
    const r = find(root, id);
    if (r) blocks.push(r.block);
    else missing.push(id);
  }
  if (missing.length) return { ok: false, blocks, error: err("no-block", "Some embedded blocks no longer exist", { pageId: e.pageId, missing }), mode: "b" };
  return { ok: true, blocks, error: null, mode: "b" };
}
/**
 * Resolve an embed token to the blocks it shows (the block objects themselves: do not mutate them).
 * Heading section: the heading block (with its own children when it is a toggle heading) plus the following
 * sibling blocks until a heading of the same or a higher level. Chosen blocks: in the order chosen.
 * Returns { ok, blocks, error, mode }. error: null or { code: "bad-token"|"no-page"|"no-heading"|"not-heading"|
 * "no-block", message, pageId?, blockId?, missing? }. With "no-block", `blocks` holds the ones that were found.
 */
export function resolveEmbed(pages, token) {
  return resolveWith(pageGetter(pages), parseEmbed(token));
}
function embedsIn(blocks) {
  const out = [];
  eachBlock(blocks, (b) => {
    for (const text of blockTexts(b)) {
      if (!text.includes("{{embed:")) continue;
      for (const { node } of scanTokens(text)) {
        if (node.kind !== "embed") continue;
        const e = parseEmbed(node);
        if (e) out.push({ ...e, key: embedKey(e) });
      }
    }
  });
  return out;
}
const unitOf = (e) => ({ ...e, key: embedKey(e) });
function explore(get, roots, firstOnly) {
  const state = new Map(); // key -> 1 (on the path) | 2 (done)
  const cache = new Map();
  const cycles = [];
  const errors = [];
  const units = [];
  const seenCycle = new Set();
  const kids = (u) => {
    let c = cache.get(u.key);
    if (!c) {
      const r = resolveWith(get, u);
      if (!r.ok) errors.push({ unit: u, error: r.error });
      c = embedsIn(r.blocks);
      cache.set(u.key, c);
    }
    return c;
  };
  for (const root of roots) {
    if (state.has(root.key)) continue;
    state.set(root.key, 1);
    units.push(root);
    const path = [root];
    const stack = [{ i: 0, kids: kids(root), u: root }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i >= f.kids.length) {
        state.set(f.u.key, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const c = f.kids[f.i++];
      const st = state.get(c.key);
      if (st === 1) {
        const loop = path.slice(path.findIndex((x) => x.key === c.key));
        const keys = loop.map((x) => x.key);
        const rot = keys.indexOf([...keys].sort()[0]);
        const id = [...keys.slice(rot), ...keys.slice(0, rot)].join(">");
        if (!seenCycle.has(id)) {
          seenCycle.add(id);
          cycles.push([...loop, c]);
          if (firstOnly) return { cycles, errors, units };
        }
      } else if (!st) {
        state.set(c.key, 1);
        units.push(c);
        path.push(c);
        stack.push({ i: 0, kids: kids(c), u: c });
      }
    }
  }
  return { cycles, errors, units };
}
const closeLoop = (cycle) => ({ cycle, pageIds: cycle.map((u) => u.pageId), keys: cycle.map((u) => u.key) });
/**
 * Follow every embed on a page (the whole page is shown) through the embedded content, recursively. Returns
 * { units, cycles, errors }: all distinct embedded units reached, every loop found (each a closed list of units,
 * first == last, with { key, pageId, mode, id|ids }), and targets that could not be resolved. Always terminates:
 * the walk is memoised per unit, so shared (diamond) embeds are expanded once.
 */
export function embedChain(pages, startPageId) {
  const get = pageGetter(pages);
  const page = get(startPageId);
  const r = explore(get, embedsIn(pageBlocks(page)), false);
  return { units: r.units, cycles: r.cycles, errors: r.errors };
}
/** The first embed loop reachable from a page, or null: { cycle, pageIds, keys } (see embedChain). */
export function detectCycle(pages, startPageId) {
  const get = pageGetter(pages);
  const r = explore(get, embedsIn(pageBlocks(get(startPageId))), true);
  return r.cycles.length ? closeLoop(r.cycles[0]) : null;
}
/**
 * Would rendering this embed token recurse into itself? The loop through that embed's own unit, or null.
 * (The renderer can equally keep a stack of `embedKey`s and stop when a key repeats: same answer.)
 */
export function embedCycleFrom(pages, token) {
  const e = parseEmbed(token);
  if (!e) return null;
  const root = unitOf(e);
  const r = explore(pageGetter(pages), [root], false);
  const c = r.cycles.find((x) => x[0].key === root.key);
  return c ? closeLoop(c) : null;
}

// ---------- markdown export ----------
const safeTitle = (t) => String(t ?? "").replace(/[[\]{}`\\\r\n]/g, "").trim() || "Untitled";
/**
 * An `inline(node)` callback for blocksToMarkdown's ctx handling link, xlink and embed tokens (other kinds go to
 * `ctx.inline`, or null for the default fallback).
 *   links: with ctx.pageLink(id) (the vault export's relative-link function) the result is its string; with
 *   opts.style === "wiki", or when ctx has no pageLink, `[[Title]]` (`x[[Title]]` for hidden links, so a round
 *   trip keeps the flag; relative links lose it). A page that no longer exists exports as "(deleted page)".
 *   embeds: the embedded blocks flattened to markdown (headings keep their level; the text is spliced where the
 *   token stood, so put the embed alone in its block for clean output). Embeds that loop, or whose target is gone,
 *   export as a short bracketed note.
 */
export function exportInline(pages, ctx = {}, opts = {}) {
  const get = pageGetter(pages);
  const wiki = opts.style === "wiki" || typeof ctx.pageLink !== "function";
  const make = (stack) => (n) => {
    if (n.kind === "link" || n.kind === "xlink") {
      const p = get(n.args[0]);
      if (!isObj(p)) return "(deleted page)";
      if (!wiki) return ctx.pageLink(n.args[0]);
      return `${n.kind === "xlink" ? "x" : ""}[[${safeTitle(p.title)}]]`;
    }
    if (n.kind === "embed") {
      const e = parseEmbed(n);
      const r = resolveWith(get, e);
      if (!r.ok && !r.blocks.length) return "(embedded content unavailable)";
      const key = embedKey(e);
      if (stack.includes(key)) return "(recursive embed omitted)";
      return blocksToMarkdown(r.blocks, { ...ctx, inline: make([...stack, key]) });
    }
    return ctx.inline?.(n) ?? null;
  };
  return make([]);
}
/** ctx for blocksToMarkdown with link/embed support merged in: `blocksToMarkdown(blocks, exportCtx(pages, ctx))`. */
export const exportCtx = (pages, ctx = {}, opts = {}) => ({ ...ctx, inline: exportInline(pages, ctx, opts) });
/** Markdown of what an embed token shows (empty string when the target is gone). */
export function embedMarkdown(pages, token, ctx = {}, opts = {}) {
  const e = parseEmbed(token);
  const r = resolveWith(pageGetter(pages), e);
  return r.blocks.length ? blocksToMarkdown(r.blocks, exportCtx(pages, ctx, opts)) : "";
}
/** Plain text of what an embed token shows (search / previews). */
export function embedPlainText(pages, token) {
  return plainText(resolveWith(pageGetter(pages), parseEmbed(token)).blocks);
}
/** The text a link token exports as in wiki style, or null when `token` is not a link: `[[Title]]` / `x[[Title]]`. */
export function linkMarkdown(pages, token, ctx = {}) {
  const r = typeof token === "string" ? readToken(token.trim(), 0) : { node: token };
  const n = r?.node;
  if (!n || (n.kind !== "link" && n.kind !== "xlink")) return null;
  return exportInline(pages, ctx, { style: "wiki" })(n);
}
