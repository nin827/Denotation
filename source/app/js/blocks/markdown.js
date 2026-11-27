import { previewLine } from "../preview.js";
import { replaceTokens, tokenFallback } from "./inline.js";
import { cleanFlow, parseFlow, serializeFlow } from "../flow/layout.js";
import { numbering, hasChildren, newBlock, normalizeBlocks, flattenBlocks, MAX_DEPTH } from "./model.js";

const indentLines = (s, n) => s.split("\n").map((l) => l ? " ".repeat(n) + l : l).join("\n");
function renderTable(b) {
  const esc = (c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ");
  // Markdown needs a header row: the header row when there is one, else an empty one (the importer drops it again)
  const row = (r) => `| ${r.map(esc).join(" | ")} |`;
  const [head, ...body] = b.headerRow || b.header ? b.cells : [b.cells[0].map(() => ""), ...b.cells];
  return [row(head), `| ${head.map(() => "---").join(" | ")} |`, ...body.map(row)].join("\n");
}
// depth is internal: past MAX_DEPTH the remaining blocks are written flat, so unnormalised deep data cannot overflow the stack
export function blocksToMarkdown(blocks, ctx = {}, depth = 0) {
  if (depth >= MAX_DEPTH) blocks = flattenBlocks(blocks);
  const nums = numbering(blocks);
  // an inline image exports as ![alt](src) with its size dropped (an embedded data URL cannot be written out)
  const inl = (s) => replaceTokens(s ?? "", (n) => n.kind === "img" ? `![${(n.args[3] || "").replace(/[\[\]]/g, "")}](${n.args[0].startsWith("data:") ? "embedded-image" : n.args[0]})` : ctx.inline?.(n) ?? tokenFallback(n));
  const chunks = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    let text;
    let list = false;
    const kids = hasChildren(b) && b.type !== "columns" ? blocksToMarkdown(b.children, ctx, depth + 1) : "";
    const withKids = (head) => kids ? `${head}
${indentLines(kids, 2)}` : head;
    switch (b.type) {
      case "p":
        text = withKids(inl(String(b.text ?? "").split("\n").map(escapeMarker).join("\n")));
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
        text = withKids(`${"#".repeat(Number(b.type[1]))} ${inl(b.text)}`);
        break;
      case "bullet":
        text = withKids(`- ${escapeTask(inl(b.text))}`);
        list = true;
        break;
      case "numbered":
        text = withKids(`${nums.get(b.id)}. ${escapeTask(inl(b.text))}`);
        list = true;
        break;
      case "todo":
        text = withKids(`- [${b.checked ? "x" : " "}] ${inl(b.text)}`);
        list = true;
        break;
      case "toggle":
        text = `<details><summary>${inl(b.text)}</summary>

${kids}

</details>`;
        break;
      case "quote":
        text = withKids(inl(b.text).split("\n").map((l) => `> ${l}`).join("\n"));
        break;
      case "callout":
        text = withKids(`> ${""} ${inl(b.text)}`.trim());
        break;
      case "code":
        text = `\`\`\`${b.lang && b.lang !== "plain" ? b.lang : ""}
${b.text}
\`\`\``;
        break;
      case "flow": {
        // a fenced "flow" block: a settings comment line, then the quick syntax (read back by markdownToBlocks)
        const f = cleanFlow(b);
        text = `\`\`\`flow\n# ${FLOW_KEYS.map((k) => `${k}: ${f[k]}`).join(", ")}\n${serializeFlow(f)}\n\`\`\``;
        break;
      }
      case "divider":
        text = "---";
        break;
      case "table":
        text = renderTable(b);
        break;
      case "columns":
        text = b.children.map((c) => blocksToMarkdown(c.children, ctx, depth + 1)).filter(Boolean).join("\n\n");
        break;
      case "image":
        text = `![${b.caption || ""}](${ctx.imageSrc ? ctx.imageSrc(b) : b.src?.startsWith("data:") ? "embedded-image" : b.src || ""})`;
        break;
      case "bookmark":
        text = b.url ? `[${b.title || b.url}](${b.url})` : "";
        break;
      case "preview":
        text = ctx.recordPreview?.(b) ?? previewLine(ctx.pageTitle?.(b.dbId), b.keys);
        break;
      case "dbview":
        // a live view cannot be exported as data: a link to the source (or its name for a table block)
        text = !b.sourceId ? "" : b.sourceId.startsWith("tbl-") ? "Database view: table data source" : `Database view: ${ctx.pageLink ? ctx.pageLink(b.sourceId) : ctx.pageTitle?.(b.sourceId) || "source"}`;
        break;
      case "synced":
        text = blocksToMarkdown(ctx.syncBlocks?.(b.ref) ?? [], ctx, depth + 1);
        break;
      case "page":
        text = ctx.pageLink ? ctx.pageLink(b.ref) : `\u{1F4C4} ${ctx.pageTitle?.(b.ref) ?? "Untitled"}`;
        break;
      default:
        text = "";
    }
    if (text !== "") chunks.push({ text, list });
  }
  return chunks.map((c, i) => i === 0 ? c.text : `${chunks[i - 1].list && c.list ? "\n" : "\n\n"}${c.text}`).join("");
}
const splitRow = (line) => {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
};
// split on "|" and test each cell: the single big regex backtracked quadratically on long whitespace runs
const isTableSep = (line) => {
  let t = String(line ?? "").trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t !== "" && t.split("|").every((c) => /^:?-{3,}:?$/.test(c.trim()));
};
// a line whose text would import as something other than a paragraph; exported with a leading backslash, removed again on import
const startsBlock = (l) => /^(#{1,4}\s|(?:[-*+]|\d{1,3}\.)\s|>|```|(?:---+|\*\*\*+|___+)\s*$)/.test(l);
const escapeMarker = (l) => {
  const t = l.trim();
  return startsBlock(t.replace(/^\\+/, "")) && t ? `\\${t}` : l;
};
// a bullet whose text starts like "[x] " would import as a to-do item; escape it, and remove the escape on import
const TASK_RE = /^\[( |x|X)\]\s/;
const escapeTask = (t) => (TASK_RE.test(t) ? `\\${t}` : t);
const unescapeTask = (t) => (/^\\/.test(t) && TASK_RE.test(t.slice(1)) ? t.slice(1) : t);
const FLOW_KEYS = ["layout", "dir", "rotate", "turn", "spacing"];
function flowFromText(lines) {
  const opts = {};
  const first = /^#\s*(.*)$/.exec(lines[0]?.trim() ?? "");
  if (first) for (const part of first[1].split(",")) {
    const [k, v] = part.split(":").map((x) => x.trim());
    if (FLOW_KEYS.includes(k)) opts[k] = v;
  }
  const { nodes, edges } = parseFlow(lines.join("\n"));
  const f = cleanFlow({ ...opts, nodes, edges });
  return newBlock("flow", { layout: f.layout, dir: f.dir, rotate: f.rotate, turn: f.turn, spacing: f.spacing, nodes: f.nodes, edges: f.edges });
}
const unescapeMarker = (t) => /^\\/.test(t) && startsBlock(t.replace(/^\\+/, "")) ? t.slice(1) : t;
export function markdownToBlocks(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const root = [];
  let stack = [];
  const push = (b) => {
    root.push(b);
    stack = [];
  };
  const addItem = (indent, b) => {
    var _a;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) ((_a = stack[stack.length - 1].block).children ?? (_a.children = [])).push(b);
    else root.push(b);
    stack.push({ indent: indent, block: b });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) continue;
    if (m = /^```(\w*)\s*$/.exec(line.trim())) {
      const body = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i].trim())) body.push(lines[i]);
      if (m[1] === "flow") push(flowFromText(body));
      else push(newBlock("code", { text: body.join("\n"), lang: m[1] || "plain" }));
      continue;
    }
    if (m = /^(#{1,4})\s+([^\n]*)$/.exec(line)) {
      push(newBlock(`h${m[1].length}`, { text: m[2].trim() }));
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      push(newBlock("divider"));
      continue;
    }
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) rows.push(splitRow(lines[++i]));
      const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
      const t = newBlock("table", { rows: rows.length, cols: width });
      t.cells = rows.map((r) => Array.from({ length: width }, (_, j) => r[j] ?? ""));
      if (t.cells.length > 1 && t.cells[0].every((c) => !c)) {
        t.cells.shift();
        t.headerRow = false;
      }
      push(t);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
      push(newBlock("quote", { text: body.join("\n") }));
      continue;
    }
    if (m = /^(\s*)(?:[-*+]|(\d{1,3})\.)\s+([^\n]*)$/.exec(line)) {
      const indent = m[1].replace(/\t/g, "    ").length;
      const body = m[3];
      const todo = /^\[( |x|X)\]\s+(.*)$/.exec(body);
      if (todo) addItem(indent, newBlock("todo", { text: todo[2], checked: /x/i.test(todo[1]) }));
      else addItem(indent, newBlock(m[2] ? "numbered" : "bullet", { text: unescapeTask(body) }));
      continue;
    }
    if (m = /^!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+)\)$/.exec(line.trim())) {
      push(newBlock("image", { caption: m[1], src: m[2] }));
      continue;
    }
    push(newBlock("p", { text: unescapeMarker(line.trim()) }));
  }
  return normalizeBlocks(root);
}
