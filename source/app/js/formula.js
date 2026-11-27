const FormulaError = class extends Error {
  constructor(code, detail) {
    super(detail ? `${code} ${detail}` : code);
    this.code = code;
  }
};
const err = (code, detail) => new FormulaError(code, detail);
const ERROR_CODES = ["#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#N/A", "#REF!", "#ERROR!"];
export const isErrorValue = (v) => typeof v === "string" && ERROR_CODES.includes(v);
function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let v = "";
      for (; ; ) {
        if (j >= s.length) throw err("#ERROR!", "unterminated text");
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += s[j++];
      }
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      const j = s.indexOf("]", i);
      if (j < 0) throw err("#ERROR!", "missing ]");
      out.push({ t: "ref", v: s.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (["<>", "<=", ">=", "!="].includes(two)) {
      out.push({ t: "op", v: two === "!=" ? "<>" : two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),;%.".includes(ch)) {
      out.push({ t: "op", v: ch === ";" ? "," : ch });
      i++;
      continue;
    }
    throw err("#ERROR!", `unexpected "${ch}"`);
  }
  return out;
}
function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const eat = (v) => {
    if (!isOp(v)) throw err("#ERROR!", `expected "${v}"`);
    p++;
  };
  const level = (ops, next, make = (op, a, b) => ({ k: "bin", op, a, b })) => () => {
    let a = next();
    while (peek()?.t === "op" && ops.includes(peek().v)) {
      const op = toks[p++].v;
      a = make(op, a, next());
    }
    return a;
  };
  const primary = () => {
    const t = toks[p++];
    if (!t) throw err("#ERROR!", "unexpected end");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "ref") {
      let node = { k: "ref", name: t.v };
      while (isOp(".") && toks[p + 1]?.t === "id") {
        p++;
        node = { k: "key", a: node, key: toks[p++].v };
      }
      return node;
    }
    if (t.t === "op" && t.v === "(") {
      const e = expr();
      eat(")");
      return e;
    }
    if (t.t === "id") {
      const up = t.v.toUpperCase();
      if (isOp("(")) {
        p++;
        const args = [];
        if (!isOp(")")) {
          for (; ; ) {
            args.push(isOp(",") || isOp(")") ? { k: "blank" } : expr());
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        eat(")");
        return { k: "call", name: up, args };
      }
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
      return { k: "name", name: t.v }; // a bare repository constant (looked up by name, never evaluated)
    }
    throw err("#ERROR!", `unexpected "${t.v}"`);
  };
  const postfix = () => {
    let a = primary();
    while (isOp("%")) {
      p++;
      a = { k: "bin", op: "/", a, b: { k: "num", v: 100 } };
    }
    return a;
  };
  const unary = () => {
    if (isOp("-") || isOp("+")) {
      const op = toks[p++].v;
      const a = unary();
      return op === "-" ? { k: "neg", a } : a;
    }
    return postfix();
  };
  const pow = level(["^"], unary);
  const mul = level(["*", "/"], pow);
  const add = level(["+", "-"], mul);
  const cat = level(["&"], add);
  const expr = level(["=", "<>", "<", ">", "<=", ">="], cat);
  if (!toks.length) throw err("#ERROR!", "empty formula");
  const ast = expr();
  if (p < toks.length) throw err("#ERROR!", `unexpected "${toks[p].v}"`);
  return ast;
}
export function check(src) {
  try {
    return { ok: true, ast: parse(src) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 864e5;
const isDateStr = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(`${v.slice(0, 10)}T00:00:00Z`));
const serial = (s) => {
  const m = ISO.exec(s);
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / DAY + (m[4] ? (+m[4] * 60 + +m[5]) / 1440 : 0);
};
const pad = (n) => String(n).padStart(2, "0");
const fromSerial = (n) => {
  const d = new Date(EPOCH + Math.floor(n) * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const ymd = (v) => {
  const n = toNum(v);
  const d = new Date(EPOCH + Math.floor(n) * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
};
function toNum(v) {
  if (v === null || v === void 0 || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return toNum(v[0]);
  if (typeof v === "string") {
    if (isErrorValue(v)) throw err(v);
    if (isDateStr(v)) return serial(v);
    const n = Number(v.trim().replace(/,/g, ""));
    if (v.trim() !== "" && Number.isFinite(n)) return n;
  }
  throw err("#VALUE!");
}
function toStr(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.map(toStr).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === null || v === void 0 || v === "") return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  throw err("#VALUE!");
}
const flat = (args) => args.flatMap((a) => Array.isArray(a) ? flat(a) : [a]);
const nums = (args) => flat(args).filter((v) => typeof v === "number" && Number.isFinite(v));
const numsStrict = (args) => args.flatMap((a) => Array.isArray(a) ? nums([a]) : [toNum(a)]);
const isBlank = (v) => v === null || v === void 0 || v === "";
function compare(a, b) {
  if (isBlank(a) && isBlank(b)) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (isDateStr(a) && isDateStr(b)) return serial(a) - serial(b);
  if (isBlank(a)) a = typeof b === "number" ? 0 : typeof b === "boolean" ? false : "";
  if (isBlank(b)) b = typeof a === "number" ? 0 : typeof a === "boolean" ? false : "";
  const rank = (v) => typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string") return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  return Number(a) - Number(b);
}
// * and ? wildcards by two-pointer matching (a RegExp with many * backtracks exponentially)
function globMatch(p, s) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && (p[i] === "?" || p[i] === s[j])) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (p[i] === "*") i++;
  return i === p.length;
}
function criteria(c) {
  if (typeof c !== "string") return (v) => compare(v, c) === 0 && typeof v === typeof c;
  const m = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(c);
  const op = m[1] || "=";
  const raw = m[2];
  const val = raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (typeof val === "string" && /[*?]/.test(val) && op === "=") {
    const pat = val.toLowerCase();
    return (v) => globMatch(pat, toStr(v).toLowerCase());
  }
  return (v) => {
    if (typeof val === "number" && typeof v !== "number") return op === "<>";
    const d = compare(v, val);
    return { "=": d === 0, "<>": d !== 0, "<": d < 0, ">": d > 0, "<=": d <= 0, ">=": d >= 0 }[op];
  };
}
const round = (n, digits, mode) => {
  const f = 10 ** digits;
  const x = n * f;
  const r = mode === "up" ? Math.sign(x) * Math.ceil(Math.abs(x) - 1e-9) : mode === "down" ? Math.sign(x) * Math.floor(Math.abs(x) + 1e-9) : Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
  return r / f;
};
const need = (args, min, max = min) => {
  if (args.length < min || args.length > max) throw err("#VALUE!", "wrong number of arguments");
};
function formatText(v, fmt) {
  const f = String(fmt);
  if (isDateStr(v) || /[ymd]{2,}/i.test(f) && typeof v === "number") {
    const { y, m, d } = ymd(v);
    return f.replace(/yyyy/gi, String(y)).replace(/yy/gi, String(y).slice(-2)).replace(/mm/gi, pad(m)).replace(/dd/gi, pad(d));
  }
  const n = toNum(v);
  const pct = f.includes("%");
  const dec = (/\.(0+)/.exec(f)?.[1] || "").length;
  let t = (pct ? n * 100 : n).toFixed(dec);
  if (f.includes(",")) {
    const [a, b] = t.split(".");
    t = a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (b ? `.${b}` : "");
  }
  return t + (pct ? "%" : "");
}
const lazy = new Set(["IF", "IFS", "IFERROR", "IFNA", "SWITCH", "AND", "OR"]);
export const FUNCTIONS = {
  // math
  SUM: (...a) => numsStrict(a).reduce((x, y) => x + y, 0),
  AVERAGE: (...a) => {
    const n = numsStrict(a);
    if (!n.length) throw err("#DIV/0!");
    return n.reduce((x, y) => x + y, 0) / n.length;
  },
  MIN: (...a) => {
    const n = numsStrict(a);
    return n.length ? n.reduce((x, y) => Math.min(x, y), Infinity) : 0;
  },
  MAX: (...a) => {
    const n = numsStrict(a);
    return n.length ? n.reduce((x, y) => Math.max(x, y), -Infinity) : 0;
  },
  COUNT: (...a) => nums(a).length,
  COUNTA: (...a) => flat(a).filter((v) => !isBlank(v)).length,
  COUNTBLANK: (...a) => flat(a).filter(isBlank).length,
  PRODUCT: (...a) => numsStrict(a).reduce((x, y) => x * y, 1),
  MEDIAN: (...a) => {
    const n = numsStrict(a).sort((x, y) => x - y);
    if (!n.length) throw err("#NUM!");
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  LARGE: (r, k) => {
    const n = nums([r]).sort((x, y) => y - x);
    const i = toNum(k) - 1;
    if (!(i >= 0 && i < n.length)) throw err("#NUM!");
    return n[i];
  },
  SMALL: (r, k) => {
    const n = nums([r]).sort((x, y) => x - y);
    const i = toNum(k) - 1;
    if (!(i >= 0 && i < n.length)) throw err("#NUM!");
    return n[i];
  },
  ABS: (x) => Math.abs(toNum(x)),
  ROUND: (x, d = 0) => round(toNum(x), toNum(d)),
  ROUNDUP: (x, d = 0) => round(toNum(x), toNum(d), "up"),
  ROUNDDOWN: (x, d = 0) => round(toNum(x), toNum(d), "down"),
  INT: (x) => Math.floor(toNum(x)),
  TRUNC: (x, d = 0) => round(toNum(x), toNum(d), "down"),
  CEILING: (x, s = 1) => {
    const k = toNum(s);
    if (!k) return 0;
    return Math.ceil(toNum(x) / k - 1e-12) * k;
  },
  FLOOR: (x, s = 1) => {
    const k = toNum(s);
    if (!k) throw err("#DIV/0!");
    return Math.floor(toNum(x) / k + 1e-12) * k;
  },
  MOD: (x, y) => {
    const b = toNum(y);
    if (!b) throw err("#DIV/0!");
    const a = toNum(x);
    return a - b * Math.floor(a / b);
  },
  POWER: (x, y) => toNum(x) ** toNum(y),
  SQRT: (x) => {
    const n = toNum(x);
    if (n < 0) throw err("#NUM!");
    return Math.sqrt(n);
  },
  EXP: (x) => Math.exp(toNum(x)),
  LN: (x) => {
    const n = toNum(x);
    if (n <= 0) throw err("#NUM!");
    return Math.log(n);
  },
  LOG: (x, b = 10) => {
    const n = toNum(x);
    if (n <= 0) throw err("#NUM!");
    return Math.log(n) / Math.log(toNum(b));
  },
  LOG10: (x) => {
    const n = toNum(x);
    if (n <= 0) throw err("#NUM!");
    return Math.log10(n);
  },
  SIGN: (x) => Math.sign(toNum(x)),
  PI: () => Math.PI,
  FACT: (x) => {
    const n = Math.floor(toNum(x));
    if (n < 0 || n > 170) throw err("#NUM!");
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  // logic (IF, IFS, IFERROR, IFNA, SWITCH, AND, OR are lazy: see evalNode)
  NOT: (x) => !toBool(x),
  XOR: (...a) => flat(a).filter((v) => toBool(v)).length % 2 === 1,
  ISBLANK: (x) => isBlank(x),
  ISNUMBER: (x) => typeof x === "number",
  ISTEXT: (x) => typeof x === "string" && !isBlank(x),
  ISERROR: (x) => isErrorValue(x),
  // text
  CONCAT: (...a) => flat(a).map(toStr).join(""),
  CONCATENATE: (...a) => flat(a).map(toStr).join(""),
  TEXTJOIN: (d, skip, ...a) => flat(a).filter((v) => !(toBool(skip) && isBlank(v))).map(toStr).join(toStr(d)),
  LEFT: (s, n = 1) => toStr(s).slice(0, Math.max(0, toNum(n))),
  RIGHT: (s, n = 1) => {
    const t = toStr(s);
    const k = Math.max(0, toNum(n));
    return k ? t.slice(-k) : "";
  },
  MID: (s, st, n) => toStr(s).substr(Math.max(0, toNum(st) - 1), Math.max(0, toNum(n))),
  LEN: (s) => toStr(s).length,
  UPPER: (s) => toStr(s).toUpperCase(),
  LOWER: (s) => toStr(s).toLowerCase(),
  PROPER: (s) => toStr(s).toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, a, b) => a + b.toUpperCase()),
  TRIM: (s) => toStr(s).trim().replace(/\s+/g, " "),
  SUBSTITUTE: (s, a, b, nth) => {
    const t = toStr(s);
    const from = toStr(a);
    if (!from) return t;
    if (nth === void 0) return t.split(from).join(toStr(b));
    let k = 0;
    return t.split(from).reduce((acc, part, i) => i === 0 ? part : acc + (++k === toNum(nth) ? toStr(b) : from) + part, "");
  },
  REPLACE: (s, st, n, r) => {
    const t = toStr(s);
    const i = toNum(st) - 1;
    return t.slice(0, i) + toStr(r) + t.slice(i + toNum(n));
  },
  FIND: (f, s, st = 1) => {
    const i = toStr(s).indexOf(toStr(f), toNum(st) - 1);
    if (i < 0) throw err("#VALUE!");
    return i + 1;
  },
  SEARCH: (f, s, st = 1) => {
    const i = toStr(s).toLowerCase().indexOf(toStr(f).toLowerCase(), toNum(st) - 1);
    if (i < 0) throw err("#VALUE!");
    return i + 1;
  },
  REPT: (s, n) => {
    const k = toNum(n);
    if (k < 0 || k > 1e3) throw err("#VALUE!");
    const str = toStr(s);
    if (str.length * k > 1e6) throw err("#VALUE!", "result too long"); // nested REPT multiplies
    return str.repeat(k);
  },
  EXACT: (a, b) => toStr(a) === toStr(b),
  VALUE: (s) => toNum(s),
  TEXT: (v, f) => formatText(v, f),
  // dates
  TODAY: () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  NOW: () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  DATE: (y, m, d) => {
    const t = new Date(Date.UTC(toNum(y), toNum(m) - 1, toNum(d)));
    return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  },
  YEAR: (d) => ymd(d).y,
  MONTH: (d) => ymd(d).m,
  DAY: (d) => ymd(d).d,
  WEEKDAY: (d, type = 1) => {
    const w = ymd(d).wd;
    return toNum(type) === 2 ? (w + 6) % 7 + 1 : w + 1;
  },
  DAYS: (e, s) => Math.floor(toNum(e)) - Math.floor(toNum(s)),
  EDATE: (d, m) => {
    const { y, m: mo, d: dd } = ymd(d);
    const t = new Date(Date.UTC(y, mo - 1 + toNum(m), 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return FUNCTIONS.DATE(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(dd, last));
  },
  EOMONTH: (d, m = 0) => {
    const { y, m: mo } = ymd(d);
    return fromSerial((Date.UTC(y, mo - 1 + toNum(m) + 1, 0) - EPOCH) / DAY);
  },
  DATEDIF: (s, e, unit) => {
    const a = ymd(s);
    const b = ymd(e);
    const u = toStr(unit).toUpperCase();
    if (toNum(e) < toNum(s)) throw err("#NUM!");
    if (u === "D") return Math.floor(toNum(e)) - Math.floor(toNum(s));
    let months = (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
    if (u === "M") return months;
    if (u === "Y") return Math.floor(months / 12);
    throw err("#NUM!");
  },
  // arrays and rows
  INDEX: (arr, i) => {
    const a = flat([arr]);
    const k = toNum(i);
    if (!(k >= 1 && k <= a.length)) throw err("#REF!");
    return a[k - 1];
  },
  SUMIF: (range, c, sumRange) => {
    const t = criteria(c);
    const r = flat([range]);
    const s = sumRange === void 0 ? r : flat([sumRange]);
    return r.reduce((acc, v, i) => t(v) && typeof s[i] === "number" ? acc + s[i] : acc, 0);
  },
  COUNTIF: (range, c) => {
    const t = criteria(c);
    return flat([range]).filter(t).length;
  },
  AVERAGEIF: (range, c, avgRange) => {
    const t = criteria(c);
    const r = flat([range]);
    const s = avgRange === void 0 ? r : flat([avgRange]);
    const v = r.map((x, i) => t(x) && typeof s[i] === "number" ? s[i] : null).filter((x) => x !== null);
    if (!v.length) throw err("#DIV/0!");
    return v.reduce((a, b) => a + b, 0) / v.length;
  },
  UNIQUE_COUNT: (...a) => new Set(flat(a).filter((v) => !isBlank(v)).map(toStr)).size
};
function evalNode(n, ctx) {
  switch (n.k) {
    case "num":
    case "str":
    case "bool":
      return n.v;
    case "blank":
      return null;
    case "ref":
      return ctx.get(n.name);
    case "name": {
      const v = ctx.constant?.(n.name);
      if (v === void 0) throw err("#NAME?", n.name);
      return v;
    }
    case "key": {
      const o = evalNode(n.a, ctx);
      if (o && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, n.key)) return o[n.key];
      throw err("#REF!", n.key);
    }
    case "neg":
      return -toNum(evalNode(n.a, ctx));
    case "bin":
      return binary(n.op, evalNode(n.a, ctx), evalNode(n.b, ctx));
    case "call":
      return call(n, ctx);
    default:
      throw err("#ERROR!");
  }
}
function binary(op, a, b) {
  switch (op) {
    case "&":
      return toStr(a) + toStr(b);
    case "=":
      return compare(a, b) === 0;
    case "<>":
      return compare(a, b) !== 0;
    case "<":
      return compare(a, b) < 0;
    case ">":
      return compare(a, b) > 0;
    case "<=":
      return compare(a, b) <= 0;
    case ">=":
      return compare(a, b) >= 0;
    default:
      break;
  }
  const dateA = isDateStr(a);
  const dateB = isDateStr(b);
  const x = toNum(a);
  const y = toNum(b);
  switch (op) {
    case "+":
      return dateA && !dateB ? fromSerial(x + y) : dateB && !dateA ? fromSerial(x + y) : x + y;
    case "-":
      return dateA && dateB ? Math.floor(x) - Math.floor(y) : dateA ? fromSerial(x - y) : x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) throw err("#DIV/0!");
      return x / y;
    case "^":
      return x ** y;
    default:
      throw err("#ERROR!");
  }
}
function call(n, ctx) {
  const { name, args } = n;
  const ev = (a) => evalNode(a, ctx);
  if (lazy.has(name)) {
    switch (name) {
      case "IF":
        need(args, 2, 3);
        return toBool(ev(args[0])) ? ev(args[1]) : args[2] ? ev(args[2]) : false;
      case "IFS": {
        for (let i = 0; i + 1 < args.length; i += 2) if (toBool(ev(args[i]))) return ev(args[i + 1]);
        throw err("#N/A");
      }
      case "IFERROR":
        need(args, 2);
        try {
          const v = ev(args[0]);
          return isErrorValue(v) ? ev(args[1]) : v;
        } catch {
          return ev(args[1]);
        }
      case "IFNA":
        need(args, 2);
        try {
          return ev(args[0]);
        } catch (e) {
          if (e.code === "#N/A") return ev(args[1]);
          throw e;
        }
      case "SWITCH": {
        const v = ev(args[0]);
        let i = 1;
        for (; i + 1 < args.length; i += 2) if (compare(v, ev(args[i])) === 0) return ev(args[i + 1]);
        if (i < args.length) return ev(args[i]);
        throw err("#N/A");
      }
      case "AND":
        return args.every((a) => flat([ev(a)]).every((v) => toBool(v)));
      case "OR":
        return args.some((a) => flat([ev(a)]).some((v) => toBool(v)));
      default:
        break;
    }
  }
  if (name === "CONST") {
    // const("name"): a repository constant (typed number / date / text)
    need(args, 1);
    const key = toStr(ev(args[0]));
    const v = ctx.constant?.(key);
    if (v === void 0) throw err("#NAME?", key);
    return v;
  }
  if (name === "VALUE" && args.length === 3) {
    // value("db", "key", "col"): another database's cell, found by primary key (inline formulas); VALUE(text) still converts text to a number
    if (!ctx.lookup) throw err("#NAME?", "value() lookups need an inline formula");
    return ctx.lookup(toStr(ev(args[0])), toStr(ev(args[1])), toStr(ev(args[2])));
  }
  if (name === "PRESET") {
    // preset("name", "key"): a chip preset's column for a row key (inline formulas)
    need(args, 1, 2);
    if (!ctx.preset) throw err("#NAME?", "preset() lookups need an inline formula");
    return ctx.preset(toStr(ev(args[0])), args[1] ? toStr(ev(args[1])) : null);
  }
  if (name === "ALL") {
    need(args, 1);
    if (args[0].k !== "ref") throw err("#VALUE!", "ALL needs a [column]");
    return ctx.all(args[0].name);
  }
  if (name === "ROW") return ctx.row ?? 1;
  if (name === "ROWS") return ctx.rows ?? 1;
  if (name === "PROP") {
    need(args, 1);
    return ctx.get(toStr(ev(args[0])));
  }
  const f = FUNCTIONS[name];
  if (!f) throw err("#NAME?", name);
  const rowFree = (a) => a.k === "num" || a.k === "str" || a.k === "bool" || a.k === "call" && a.name === "ALL";
  if (ctx.memo && args.some((a) => a.k === "call" && a.name === "ALL") && args.every(rowFree)) {
    const key = JSON.stringify(n);
    if (!ctx.memo.has(key)) {
      try {
        ctx.memo.set(key, { v: f(...args.map(ev)) });
      } catch (e) {
        ctx.memo.set(key, { e });
      }
    }
    const hit = ctx.memo.get(key);
    if (hit.e) throw hit.e;
    return hit.v;
  }
  return f(...args.map(ev));
}
function evaluate(ast, ctx) {
  try {
    let v = evalNode(ast, ctx);
    if (Array.isArray(v)) v = v.length === 1 ? v[0] : toStr(v);
    if (v !== null && typeof v === "object") v = toStr(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "#NUM!";
      return Number(v.toPrecision(12));
    }
    return v === void 0 ? null : v;
  } catch (e) {
    return e instanceof FormulaError ? e.code : "#ERROR!";
  }
}
const norm = (s) => String(s).trim().toLowerCase();
function findColumn(columns, name) {
  return columns.find((c) => c.name === name) ?? columns.find((c) => norm(c.name) === norm(name));
}
let constantsProvider = null;
/** Install fn(dbId) -> (name -> value | undefined) | null. Database formulas use it to resolve constants through the database's repository. */
export const setConstantsProvider = (fn) => {
  constantsProvider = typeof fn === "function" ? fn : null;
};
const constantsFor = (rows) => {
  try {
    return constantsProvider?.(rows?.[0]?.dbId) ?? void 0;
  } catch {
    return void 0;
  }
};
function contextFor(columns, rows, index, cache = new Map(), memo = null, constant = constantsFor(rows)) {
  const row = rows[index];
  const col = (name) => {
    const c = findColumn(columns, name);
    if (!c) throw err("#NAME?", `[${name}]`);
    return c;
  };
  const val = (r, c) => {
    const v = r.values?.[c.id];
    return v === void 0 ? null : v;
  };
  return {
    get: (name) => val(row, col(name)),
    all: (name) => {
      const c = col(name);
      if (!cache.has(c.id)) cache.set(c.id, rows.map((r) => {
        const v = val(r, c);
        return v === "" ? null : v;
      }));
      return cache.get(c.id);
    },
    row: index + 1,
    rows: rows.length,
    memo,
    constant
  };
}
export function applyFormulas(columns, rows, opts = {}) {
  const fcols = columns.filter((c) => c.type === "formula");
  if (!fcols.length || !rows.length) return [];
  const parsed = new Map(fcols.map((c) => [c.id, check(c.config?.expr ?? "")]));
  const changed = new Set();
  const memo = new Map();
  const cache = new Map();
  const constant = opts.constants ?? constantsFor(rows);
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const c of fcols) {
      const p = parsed.get(c.id);
      rows.forEach((row, i) => {
        const v = p.ok ? evaluate(p.ast, contextFor(columns, rows, i, cache, memo, constant)) : "#ERROR!";
        const old = row.values[c.id];
        if (old !== v && !(old === void 0 && v === null)) {
          row.values[c.id] = v;
          changed.add(row);
          moved = true;
        }
      });
      cache.delete(c.id);
      memo.clear();
    }
    if (!moved) break;
  }
  return [...changed];
}
export function previewFormula(expr, columns, rows, index = 0) {
  const p = check(expr);
  if (!p.ok) return { ok: false, error: p.error };
  if (!rows.length) return { ok: true, value: null, note: "No rows to preview with yet." };
  return { ok: true, value: evaluate(p.ast, contextFor(columns, rows, index)) };
}
export const formatResult = (v) => v === null || v === void 0 ? "" : typeof v === "boolean" ? v ? "TRUE" : "FALSE" : String(v);
export function renameColumnRefs(expr, oldName, newName) {
  const src = String(expr ?? "");
  const want = norm(oldName);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '"' && src[j + 1] !== '"')) j += src[j] === '"' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      const j = src.indexOf("]", i);
      if (j > 0) {
        out += norm(src.slice(i + 1, j)) === want ? `[${newName}]` : src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------- inline formulas ({{= expr}}): evaluated without a row ----------
/**
 * The lookups an expression makes with literal arguments, so a caller can load the data first:
 * { ok, error?, values: [[db, key, col]], presets: [[name, key|null]], nonLiteral: boolean }.
 */
export function formulaRefs(src) {
  const p = check(src);
  if (!p.ok) return { ok: false, error: p.error, values: [], presets: [], nonLiteral: false };
  const out = { ok: true, values: [], presets: [], nonLiteral: false };
  const walkAst = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.k === "call" && ((n.name === "VALUE" && n.args.length === 3) || n.name === "PRESET")) {
      if (n.args.every((a) => a.k === "str")) {
        const v = n.args.map((a) => a.v);
        if (n.name === "VALUE") out.values.push(v);
        else out.presets.push([v[0], v[1] ?? null]);
      } else out.nonLiteral = true;
    }
    for (const x of [n.a, n.b]) walkAst(x);
    for (const a of n.args ?? []) walkAst(a);
  };
  walkAst(p.ast);
  return out;
}
/**
 * Evaluate an expression with no row. env: { constant(name), value(db, key, col), preset(name, key) }, each synchronous
 * (throw `lookupError("#N/A", "detail")` for a missing item). Returns { ok, value, error, detail }: an error is a code
 * such as "#NAME?" with `detail` giving the message ("#NAME? foundedyear").
 */
export function evalExpression(src, env = {}) {
  const p = check(src);
  if (!p.ok) return { ok: false, value: "#ERROR!", error: "#ERROR!", detail: p.error };
  const ctx = {
    get: (name) => { throw err("#REF!", `[${name}] needs a database row`); },
    all: (name) => { throw err("#REF!", `[${name}] needs a database row`); },
    row: 1,
    rows: 1,
    memo: null,
    constant: env.constant,
    lookup: env.value,
    preset: env.preset
  };
  try {
    let v = evalNode(p.ast, ctx);
    if (Array.isArray(v)) v = v.length === 1 ? v[0] : toStr(v);
    if (v !== null && typeof v === "object") v = toStr(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { ok: false, value: "#NUM!", error: "#NUM!", detail: "#NUM!" };
      v = Number(v.toPrecision(12));
    }
    if (typeof v === "string" && isErrorValue(v)) return { ok: false, value: v, error: v, detail: v };
    return { ok: true, value: v === void 0 ? null : v };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, value: e.code, error: e.code, detail: e.message };
    return { ok: false, value: "#ERROR!", error: "#ERROR!", detail: "#ERROR!" };
  }
}
/** An error for env lookup callbacks to throw: code is one of the "#..." codes. */
export const lookupError = (code, detail) => err(code, detail);

// Trigonometry and friends (numbers in radians; RADIANS / DEGREES convert). NaN results are #NUM!.
const trigArg = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "boolean" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw lookupError("#VALUE!");
  return n;
};
const trigUnit = (fn) => (v) => {
  const r = fn(trigArg(v));
  if (Number.isNaN(r)) throw lookupError("#NUM!");
  return r;
};
const TRIG = {
  SIN: trigUnit(Math.sin), COS: trigUnit(Math.cos), TAN: trigUnit(Math.tan), ASIN: trigUnit(Math.asin), ACOS: trigUnit(Math.acos), ATAN: trigUnit(Math.atan),
  SINH: trigUnit(Math.sinh), COSH: trigUnit(Math.cosh), TANH: trigUnit(Math.tanh), CBRT: trigUnit(Math.cbrt),
  RADIANS: trigUnit((d) => d * Math.PI / 180), DEGREES: trigUnit((r) => r * 180 / Math.PI),
  ATAN2: (y, x) => Math.atan2(trigArg(y), trigArg(x))
};
for (const [name, fn] of Object.entries(TRIG)) if (!Object.hasOwn(FUNCTIONS, name)) FUNCTIONS[name] = fn;
