// Node styling (pure, no DOM): explicit per-page settings beat rules, the first matching rule wins, and size defaults
// to the link count (sqrt-scaled, clamped) or a fixed size.
//
// Rule: { when, icon?, color?, size? }
//   when: one condition or an array of conditions (all must hold). A condition is
//     { prop: "Status", op, value }                  a page property (props[name]; arrays = multi-select)
//     { field: "type" | "repo" | "db" | "tag" | "links" | "title", op, value }
//   op: is | isNot | contains | notContains | empty | notEmpty | gt | gte | lt | lte | in   (strings compare
//       case-insensitively; for arrays "is"/"contains" mean "any element", "isNot"/"notContains" mean "no element")
//   icon: a Lucide name ("check" or "icon:check") or one short emoji/character
//   color: a palette name (see COLORS), a hue number 0–360, or "#rgb"/"#rrggbb"
//   size: a multiplier (2 = 2×), clamped to 0.25–6
// Explicit per page: page.graph = { icon?, color?, size? } (same formats); each field set overrides the rule's.

/** Named node colours → OKLCH hue (the renderer picks lightness/chroma for the current light/dark theme). */
export const COLORS = Object.freeze({
  red: 25, orange: 55, yellow: 90, lime: 125, green: 145, teal: 185, cyan: 210, blue: 250, indigo: 275,
  purple: 300, magenta: 325, pink: 345, grey: null, gray: null
});

export const SIZE = Object.freeze({ min: 4, max: 22, fixed: 6, perLink: 1.6 });

// String() throws on objects whose toString is not callable (JSON imports); such values read as empty
const safeStr = (v) => {
  try {
    return String(v ?? "");
  } catch {
    return "";
  }
};
const lc = (v) => safeStr(v).toLowerCase();
const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Reads the value a condition looks at. `ctx.degree` is the node's visible link count. */
function fieldValue(node, c, ctx) {
  if (c.prop != null) return node?.props && Object.hasOwn(node.props, c.prop) ? node.props[c.prop] : undefined;
  switch (c.field) {
    case "type": return node?.kind || "page";
    case "repo": return node?.repo;
    case "db": return node?.db;
    case "tag": case "tags": return node?.tags || [];
    case "links": return ctx?.degree ?? 0;
    case "title": return node?.title;
    default: return undefined;
  }
}

function cmp1(v, op, want) {
  switch (op) {
    case "is": case "eq": case "=": return typeof v === "number" && want !== "" && !isNaN(+want) ? v === +want : lc(v) === lc(want);
    case "contains": return lc(v).includes(lc(want));
    case "gt": case "gte": case "lt": case "lte": {
      const a = typeof v === "number" ? v : parseFloat(v), b = parseFloat(want);
      if (isNaN(a) || isNaN(b)) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    case "in": return (Array.isArray(want) ? want : safeStr(want).split(",")).some((w) => lc(w).trim() === lc(v));
    default: return false;
  }
}

/** True when `node` satisfies the condition (or every condition of an array). */
export function matches(node, when, ctx = {}) {
  if (!when) return true;
  if (Array.isArray(when)) return when.every((c) => matches(node, c, ctx));
  const v = fieldValue(node, when, ctx);
  const op = when.op || "is";
  if (op === "empty") return isEmpty(v);
  if (op === "notEmpty") return !isEmpty(v);
  const neg = op === "isNot" || op === "neq" || op === "!=" || op === "notContains";
  const base = op === "isNot" || op === "neq" || op === "!=" ? "is" : op === "notContains" ? "contains" : op;
  const hit = Array.isArray(v) ? v.some((x) => cmp1(x, base, when.value)) : cmp1(v, base, when.value);
  return neg ? !hit : hit;
}

/** Lucide name, or one short text glyph, or null. */
export function normIcon(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (s.startsWith("icon:")) return /^icon:[a-z0-9-]{1,60}$/.test(s) ? s : null;
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length > 2) return "icon:" + s;
  return [...s].length <= 2 ? s : null; // an emoji or a character or two
}

/** Normalised colour: { hue } | { hex } | { grey: true } | null. */
export function normColor(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v)) return { hue: ((v % 360) + 360) % 360 };
  const s = lc(v).trim();
  if (Object.hasOwn(COLORS, s)) return COLORS[s] == null ? { grey: true } : { hue: COLORS[s] };
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return { hex: s };
  if (/^\d+(\.\d+)?$/.test(s)) return { hue: (+s) % 360 };
  return null;
}

const normSize = (v) => {
  const n = typeof v === "number" ? v : parseFloat(safeStr(v).replace(/[x×]$/i, ""));
  return isFinite(n) && n > 0 ? Math.max(0.25, Math.min(6, n)) : null;
};

/** Base radius (world units) from the link count, or fixed. */
export function baseRadius(degree, sizeMode = "links") {
  if (sizeMode === "fixed") return SIZE.fixed;
  return Math.max(SIZE.min, Math.min(SIZE.max, SIZE.min + SIZE.perLink * Math.sqrt(Math.max(0, degree || 0))));
}

/**
 * Resolves one node's style.
 * @param {object} node            page record (see model.js), optionally with node.graph explicit settings
 * @param {object[]} [rules]
 * @param {{ degree?: number, sizeMode?: "links"|"fixed" }} [ctx]
 * @returns {{ icon: string|null, color: {hue?:number,hex?:string,grey?:boolean}|null, size: number, radius: number, rule: number }}
 *   size = multiplier, radius = base × size, rule = index of the matching rule or -1
 */
export function resolveStyle(node, rules = [], ctx = {}) {
  let icon = null, color = null, size = null, rule = -1;
  for (let i = 0; i < (rules?.length || 0); i++) {
    const r = rules[i];
    if (r && matches(node, r.when, ctx)) {
      rule = i;
      icon = normIcon(r.icon); color = normColor(r.color); size = normSize(r.size);
      break;
    }
  }
  const ex = node?.graph;
  if (ex) {
    icon = normIcon(ex.icon) ?? icon;
    color = normColor(ex.color) ?? color;
    size = normSize(ex.size) ?? size;
  }
  const s = size ?? 1;
  return { icon, color, size: s, radius: baseRadius(ctx.degree, ctx.sizeMode) * s, rule };
}

/** Styles every node of a built graph (see model.buildGraph). Returns arrays indexed by node number. */
export function styleGraph(g, rules = [], { sizeMode = "links" } = {}) {
  const n = g.nodes.length;
  const radius = new Float32Array(n), icon = new Array(n), color = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = resolveStyle(g.nodes[i], rules, { degree: g.degree[i], sizeMode });
    radius[i] = s.radius; icon[i] = s.icon; color[i] = s.color;
  }
  return { radius, icon, color };
}
