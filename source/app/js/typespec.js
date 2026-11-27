// Type text for Custom (JSON) columns: parse, format, validate, clamp, summarise (pure, no DOM).
//
// Grammar (keywords are case-insensitive):
//   type   := alt ("|" alt)*
//   alt    := String | bool | int range? | float range? | any
//           | "(" str ("," str)* ")"                 enum: one of the words
//           | Array ("[" type "]")?                  Array[("a","b")] is an enum list: any of the words
//           | Dictionary ("{" field ("," field)* ","? "}" | "[" type "]")?
//   range  := "(" num? ".." num? ")"
//   field  := key ":" type        key: letters, digits, _ or -, or a quoted string
//
// Specs: { kind: "string" | "bool" | "any" | "dict" }, { kind: "int" | "float", min?, max? }, { kind: "enum" | "enumlist",
// choices }, { kind: "array" | "map", of }, { kind: "struct", keys: [{ key, spec }] }, { kind: "union", alts }.

const ANY = Object.freeze({ kind: "any" });
const KEYWORDS = {
  string: "string", str: "string", text: "string",
  bool: "bool", boolean: "bool",
  int: "int", integer: "int",
  float: "float", number: "float",
  array: "array", list: "array",
  dictionary: "dict", dict: "dict", object: "dict",
  any: "any", json: "any"
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

class TypeError_ extends Error {}

function parser(src) {
  let i = 0;
  const fail = (msg) => {
    throw new TypeError_(`${msg} (at character ${Math.min(i, src.length) + 1})`);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => {
    ws();
    return src[i];
  };
  const eat = (ch) => {
    if (peek() === ch) {
      i++;
      return true;
    }
    return false;
  };
  const expect = (ch, what) => {
    if (!eat(ch)) fail(`Expected "${ch}"${what ? ` ${what}` : ""}${i < src.length ? `, found "${src[i]}"` : ", found the end"}`);
  };
  const quoted = () => {
    ws();
    const q = src[i];
    if (q !== '"' && q !== "'") fail("Expected a quoted word");
    i++;
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\" && i + 1 < src.length) {
        const n = src[i + 1];
        if (n === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[n] ?? n;
        i += 2;
      } else out += src[i++];
    }
    if (src[i] !== q) fail("Unclosed quote");
    i++;
    return out;
  };
  const number = () => {
    ws();
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return Number(m[0]);
  };
  const ident = () => {
    ws();
    const m = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  function union() {
    const alts = [alt()];
    while (eat("|")) alts.push(alt());
    if (alts.length === 1) return alts[0];
    const seen = new Set();
    for (const a of alts) {
      if (a.kind === "union") fail("Unions cannot nest");
      const t = formatType(a);
      if (seen.has(t)) fail(`The union lists ${t} twice`);
      seen.add(t);
    }
    return { kind: "union", alts };
  }
  function range(kind) {
    const spec = { kind };
    if (!eat("(")) return spec;
    const min = number();
    ws();
    if (src.slice(i, i + 2) !== "..") fail('Expected ".." in the range');
    i += 2;
    const max = number();
    expect(")", "to close the range");
    for (const [k, v] of [["min", min], ["max", max]]) {
      if (v === undefined) continue;
      if (kind === "int" && !Number.isInteger(v)) fail(`An int range needs whole numbers, got ${v}`);
      spec[k] = v;
    }
    if (min !== undefined && max !== undefined && min > max) fail(`The range minimum ${min} is above the maximum ${max}`);
    return spec;
  }
  function choices() {
    const out = [quoted()];
    while (eat(",")) {
      if (peek() === ")") break;
      out.push(quoted());
    }
    expect(")", "to close the list of words");
    if (new Set(out).size !== out.length) fail("The list repeats a word");
    return out;
  }
  function fields() {
    const keys = [];
    const seen = new Set();
    while (peek() !== "}") {
      ws();
      let key;
      if (src[i] === '"' || src[i] === "'") key = quoted();
      else {
        const m = /^[\w-]+/.exec(src.slice(i));
        if (!m) fail("Expected a key name");
        key = m[0];
        i += m[0].length;
      }
      if (!key) fail("Keys cannot be empty");
      if (key.includes(".")) fail(`Key "${key}" cannot contain a dot`);
      if (seen.has(key)) fail(`Key "${key}" is listed twice`);
      seen.add(key);
      expect(":", `after key "${key}"`);
      keys.push({ key, spec: union() });
      if (!eat(",")) break;
    }
    expect("}", "to close the Dictionary");
    if (!keys.length) fail("A Dictionary{…} needs at least one key");
    return keys;
  }
  function alt() {
    const c = peek();
    if (c === undefined) fail("Expected a type");
    if (c === "(") {
      i++;
      return { kind: "enum", choices: choices() };
    }
    const at = i;
    const word = ident();
    if (!word) fail(`Unexpected "${src[i]}"`);
    const kind = KEYWORDS[word.toLowerCase()];
    if (!kind) {
      i = at;
      fail(`Unknown type "${word}"`);
    }
    if (kind === "int" || kind === "float") return range(kind);
    if (kind === "array") {
      if (!eat("[")) return { kind: "array", of: ANY };
      const of = union();
      expect("]", "to close the Array");
      return of.kind === "enum" ? { kind: "enumlist", choices: of.choices } : { kind: "array", of };
    }
    if (kind === "dict") {
      if (eat("{")) return { kind: "struct", keys: fields() };
      if (eat("[")) {
        const of = union();
        expect("]", "to close the Dictionary");
        return { kind: "map", of };
      }
      return { kind: "dict" };
    }
    return { kind };
  }
  return () => {
    if (!src.trim()) return ANY;
    const spec = union();
    ws();
    if (i < src.length) fail(`Unexpected "${src[i]}"`);
    return spec;
  };
}

const cache = new Map();
/** Type text -> { ok: true, spec } | { ok: false, error }. Empty text means any JSON value. */
export function parseType(text) {
  const src = String(text ?? "");
  const hit = cache.get(src);
  if (hit) return hit;
  let out;
  try {
    out = { ok: true, spec: parser(src)() };
  } catch (e) {
    if (e instanceof RangeError) out = { ok: false, error: "The type is nested too deeply" }; // stack overflow on e.g. 20000 "Array["
    else if (!(e instanceof TypeError_)) throw e;
    else out = { ok: false, error: e.message };
  }
  if (cache.size > 500) cache.clear();
  cache.set(src, out);
  return out;
}
/** The spec of a type text, or `any` when it does not parse. */
export const specOf = (text) => {
  const r = parseType(text);
  return r.ok ? r.spec : ANY;
};

const word = (s) => JSON.stringify(String(s));
const keyText = (k) => /^[\w-]+$/.test(k) ? k : word(k);
const num = (n) => String(n);
/** Spec -> canonical type text (parseType(formatType(s)) gives back s). */
export function formatType(spec) {
  switch (spec?.kind) {
    case "string": return "String";
    case "bool": return "bool";
    case "int":
    case "float":
      return spec.min === undefined && spec.max === undefined ? spec.kind : `${spec.kind}(${spec.min === undefined ? "" : num(spec.min)}..${spec.max === undefined ? "" : num(spec.max)})`;
    case "enum": return `(${spec.choices.map(word).join(", ")})`;
    case "enumlist": return `Array[(${spec.choices.map(word).join(", ")})]`;
    case "array": return spec.of?.kind === "any" ? "Array" : `Array[${formatType(spec.of)}]`;
    case "struct": return `Dictionary{${spec.keys.map((k) => `${keyText(k.key)}: ${formatType(k.spec)}`).join(", ")}}`;
    case "dict": return "Dictionary";
    case "map": return `Dictionary[${formatType(spec.of)}]`;
    case "union": return spec.alts.map(formatType).join(" | ");
    default: return "any";
  }
}
/** Short label of a spec for shape switches and hints. */
export function shapeLabel(spec) {
  switch (spec.kind) {
    case "string": return "Text";
    case "bool": return "Yes/no";
    case "int": return "Whole number";
    case "float": return "Number";
    case "enum": return "Choice";
    case "enumlist": return "Choices";
    case "array": return "List";
    case "struct": return "Fields";
    case "dict":
    case "map": return "Object";
    default: return "Any";
  }
}

// ---------- values ----------

const kindOf = (v) => v === null ? "null" : Array.isArray(v) ? "a list" : isObj(v) ? "an object" : typeof v === "string" ? "text" : typeof v === "boolean" ? "yes/no" : typeof v === "number" ? "a number" : typeof v;
const join = (path, seg) => path === "" ? String(seg) : `${path}.${seg}`;
const fmtNum = (n) => String(Math.round(n * 1e6) / 1e6);

function check(spec, v, path, out) {
  const bad = (message) => out.push({ path, message });
  switch (spec.kind) {
    case "any":
      return;
    case "string":
      if (typeof v !== "string") bad(`expected text, got ${kindOf(v)}`);
      return;
    case "bool":
      if (typeof v !== "boolean") bad(`expected true or false, got ${kindOf(v)}`);
      return;
    case "int":
    case "float":
      if (typeof v !== "number" || !Number.isFinite(v)) return bad(`expected ${spec.kind === "int" ? "a whole number" : "a number"}, got ${kindOf(v)}`);
      if (spec.kind === "int" && !Number.isInteger(v)) bad(`expected a whole number, got ${fmtNum(v)}`);
      if (spec.min !== undefined && v < spec.min) bad(`${fmtNum(v)} is below the minimum ${spec.min}`);
      if (spec.max !== undefined && v > spec.max) bad(`${fmtNum(v)} is above the maximum ${spec.max}`);
      return;
    case "enum":
      if (!spec.choices.includes(v)) bad(`${typeof v === "string" ? word(v) : kindOf(v)} is not one of ${spec.choices.map(word).join(", ")}`);
      return;
    case "enumlist":
      if (!Array.isArray(v)) return bad(`expected a list of choices, got ${kindOf(v)}`);
      v.forEach((x, n) => {
        if (!spec.choices.includes(x)) out.push({ path: join(path, n), message: `${typeof x === "string" ? word(x) : kindOf(x)} is not one of ${spec.choices.map(word).join(", ")}` });
        else if (v.indexOf(x) !== n) out.push({ path: join(path, n), message: `${word(x)} is listed twice` });
      });
      return;
    case "array":
      if (!Array.isArray(v)) return bad(`expected a list, got ${kindOf(v)}`);
      v.forEach((x, n) => check(spec.of, x, join(path, n), out));
      return;
    case "struct": {
      if (!isObj(v)) return bad(`expected an object, got ${kindOf(v)}`);
      const known = new Set();
      for (const { key, spec: s } of spec.keys) {
        known.add(key);
        if (!Object.hasOwn(v, key)) out.push({ path: join(path, key), message: "missing" });
        else check(s, v[key], join(path, key), out);
      }
      for (const k of Object.keys(v)) if (!known.has(k)) out.push({ path: join(path, k), message: "unknown key" });
      return;
    }
    case "dict":
      if (!isObj(v)) bad(`expected an object, got ${kindOf(v)}`);
      return;
    case "map":
      if (!isObj(v)) return bad(`expected an object, got ${kindOf(v)}`);
      for (const [k, x] of Object.entries(v)) check(spec.of, x, join(path, k), out);
      return;
    case "union": {
      const at = shapeIndex(spec, v);
      if (at < 0) return bad(`expected ${spec.alts.map(shapeLabel).join(" or ").toLowerCase()}, got ${kindOf(v)}`);
      check(spec.alts[at], v, path, out);
      return;
    }
    default:
  }
}
/** Issues of a value against a spec: [{ path, message }] ("" path = the whole value). null/undefined counts as empty, never an issue. */
export function validate(spec, value) {
  if (value == null) return [];
  const out = [];
  check(spec, value, "", out);
  return out;
}
const fitsShape = (spec, v) => {
  switch (spec.kind) {
    case "any": return true;
    case "string": return typeof v === "string";
    case "enum": return typeof v === "string";
    case "bool": return typeof v === "boolean";
    case "int":
    case "float": return typeof v === "number";
    case "array":
    case "enumlist": return Array.isArray(v);
    case "struct":
    case "dict":
    case "map": return isObj(v);
    default: return false;
  }
};
/** Which union alternative a value belongs to: the first it fully matches, else the first of its JSON shape, else -1. */
export function shapeIndex(spec, v) {
  if (spec.kind !== "union") return 0;
  for (let n = 0; n < spec.alts.length; n++) {
    const out = [];
    check(spec.alts[n], v, "", out);
    if (!out.length) return n;
  }
  return spec.alts.findIndex((a) => fitsShape(a, v));
}
const clampNum = (spec, n) => {
  let x = spec.kind === "int" ? Math.round(n) : n;
  if (spec.min !== undefined && x < spec.min) x = spec.min;
  if (spec.max !== undefined && x > spec.max) x = spec.max;
  return x;
};
/** A copy of the value with every number brought into its range (ints rounded). Other mismatches stay as written. */
export function clamp(spec, v) {
  switch (spec.kind) {
    case "int":
    case "float":
      return typeof v === "number" && Number.isFinite(v) ? clampNum(spec, v) : v;
    case "array":
      return Array.isArray(v) ? v.map((x) => clamp(spec.of, x)) : v;
    case "map":
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clamp(spec.of, x)])) : v;
    case "struct": {
      if (!isObj(v)) return v;
      const out = { ...v };
      for (const { key, spec: s } of spec.keys) if (Object.hasOwn(out, key)) out[key] = clamp(s, out[key]);
      return out;
    }
    case "union": {
      const at = shapeIndex(spec, v);
      return at < 0 ? v : clamp(spec.alts[at], v);
    }
    default:
      return v;
  }
}
/** A fresh value that satisfies the spec (first choice, range minimum, every struct key filled). */
export function defaultFor(spec) {
  switch (spec.kind) {
    case "string": return "";
    case "bool": return false;
    case "int":
    case "float": return clampNum(spec, 0);
    case "enum": return spec.choices[0] ?? "";
    case "enumlist":
    case "array": return [];
    case "struct": return Object.fromEntries(spec.keys.map((k) => [k.key, defaultFor(k.spec)]));
    case "dict":
    case "map": return {};
    case "union": return defaultFor(spec.alts[0]);
    default: return null;
  }
}

// ---------- paths ----------

/** The value at a dotted path ("stats.hp", "items.0.name"); undefined when it is not there. "" is the whole value. */
export function getPath(value, path) {
  if (path == null || path === "") return value;
  let v = value;
  for (const seg of String(path).split(".")) {
    if (Array.isArray(v) && /^\d+$/.test(seg)) v = v[Number(seg)];
    else if (isObj(v) && Object.hasOwn(v, seg)) v = v[seg];
    else return undefined;
  }
  return v;
}
/** The spec at a dotted path, or null when the type has no such field. */
export function specAt(spec, path) {
  if (path == null || path === "") return spec;
  let s = spec;
  for (const seg of String(path).split(".")) {
    if (!s) return null;
    if (s.kind === "union") s = s.alts.map((a) => specAt(a, seg)).find(Boolean) ?? null;
    else if (s.kind === "struct") s = s.keys.find((k) => k.key === seg)?.spec ?? null;
    else if ((s.kind === "array") && /^\d+$/.test(seg)) s = s.of;
    else if (s.kind === "enumlist" && /^\d+$/.test(seg)) s = { kind: "enum", choices: s.choices };
    else if (s.kind === "map") s = s.of;
    else if (s.kind === "any" || s.kind === "dict") s = ANY;
    else return null;
  }
  return s;
}
/** Dotted paths of the scalar fields reachable through structs (and unions of them), in key order. */
export function leafPaths(spec, prefix = "", depth = 0, out = []) {
  if (depth > 6) return out;
  const structs = spec.kind === "struct" ? [spec] : spec.kind === "union" ? spec.alts.filter((a) => a.kind === "struct") : [];
  for (const st of structs) {
    for (const { key, spec: s } of st.keys) {
      const p = join(prefix, key);
      if (s.kind === "struct" || s.kind === "union" && s.alts.some((a) => a.kind === "struct")) leafPaths(s, p, depth + 1, out);
      if (s.kind !== "struct" && !out.some((x) => x.path === p)) out.push({ path: p, spec: s });
    }
  }
  return out;
}
/** Plain kind of a sub-spec for filters and sorts: "number" | "checkbox" | "text". */
export function scalarKind(spec) {
  if (!spec) return "text";
  if (spec.kind === "int" || spec.kind === "float") return "number";
  if (spec.kind === "bool") return "checkbox";
  return "text";
}

// ---------- text ----------

const short = (s, n) => s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
function brief(spec, v, depth) {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return depth ? v.replace(/\s+/g, " ") : v;
  if (typeof v !== "object") return String(v);
  if (depth >= 2) return Array.isArray(v) ? `[${v.length}]` : "{…}";
  if (Array.isArray(v)) {
    const of = spec?.kind === "array" ? spec.of : null;
    return `[${v.map((x) => brief(of, x, depth + 1)).join(", ")}]`;
  }
  const st = spec?.kind === "struct" ? spec : spec?.kind === "union" ? spec.alts.find((a) => a.kind === "struct") : null;
  const order = st ? [...st.keys.map((k) => k.key).filter((k) => Object.hasOwn(v, k)), ...Object.keys(v).filter((k) => !st.keys.some((x) => x.key === k))] : Object.keys(v);
  const sub = (k) => st?.keys.find((x) => x.key === k)?.spec ?? (spec?.kind === "map" ? spec.of : null);
  return `{${order.map((k) => `${k}: ${brief(sub(k), v[k], depth + 1)}`).join(", ")}}`;
}
/** Compact one-line text of a value for cells, e.g. `{name: Ava, level: 12, …}`. Empty for null. */
export function summary(spec, value, max = 60) {
  if (value === null || value === undefined) return "";
  const t = brief(spec, value, 0);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 3);
  const at = cut.lastIndexOf(", ");
  return at > max / 2 && /^[{[]/.test(t) ? `${cut.slice(0, at)}, …${t[0] === "{" ? "}" : "]"}` : short(t, max);
}
/** Readable text of one issue. */
export const issueText = (i) => i.path ? `${i.path}: ${i.message}` : i.message[0].toUpperCase() + i.message.slice(1);
