// The one-line patches the math feature needs in files this change does not own (blocks/inline.js, blocks/model.js,
// blocks/markdown.js, app.js, index.html). They are listed here as exact [from, to] replacements so the unit test and the
// e2e can apply them to copies and the owner can apply the same text. Once a file already contains its marker it is left alone.
// Each entry: { file (under source/app), marker (text that is present once patched), edits: [[from, to], ...] }.
module.exports = [
  {
    file: "js/blocks/inline.js",
    marker: 'kind === "math"',
    edits: [
      ['"img", "term"];', '"img", "term", "math"];'],
      ["const IMG_TOKEN_MAX = 300400;", "const MATH_TOKEN_MAX = 1400; // {{math:<latex>}}: up to 400 characters of LaTeX, every one escaped\nconst IMG_TOKEN_MAX = 300400;"],
      [
        '  if (kind === "formula") {\n    const e = args.length',
        '  if (kind === "math") {\n    const l = args.length === 1 ? String(args[0]).trim() : "";\n    return l && l.length <= 400 && !/[\\r\\n]/.test(l) ? { t: "inline", kind, args: [l] } : null;\n  }\n  if (kind === "formula") {\n    const e = args.length'
      ],
      [
        'i + (s.startsWith("{{img:", i) ? IMG_TOKEN_MAX : TOKEN_MAX)',
        'i + (s.startsWith("{{img:", i) ? IMG_TOKEN_MAX : s.startsWith("{{math:", i) ? MATH_TOKEN_MAX : TOKEN_MAX)'
      ],
      ['if (c === "|" && kind !== null && kind !== "formula") {', 'if (c === "|" && kind !== null && kind !== "formula" && kind !== "math") {'],
      ['    case "term": return "Term";', '    case "term": return "Term";\n    case "math": return `$${n.args[0]}$`;']
    ]
  },
  {
    file: "js/blocks/model.js",
    marker: '"math"',
    edits: [
      ['  "flow"\n];', '  "flow",\n  "math"\n];'],
      [
        '      if (b.type === "pivot") {',
        '      if (b.type === "math") b.text = typeof b.text === "string" ? b.text.slice(0, 4000) : "";\n      if (b.type === "pivot") {'
      ]
    ]
  },
  {
    file: "js/blocks/markdown.js",
    marker: "convertDollars",
    edits: [
      ['import { cleanFlow, parseFlow, serializeFlow } from "../flow/layout.js";', 'import { cleanFlow, parseFlow, serializeFlow } from "../flow/layout.js";\nimport { blockToMarkdown as mathBlockToMarkdown, parseMathBlock, convertDollars } from "../math/latex.js";'],
      ['      case "divider":\n        text = "---";', '      case "math":\n        text = mathBlockToMarkdown(b.text);\n        break;\n      case "divider":\n        text = "---";'],
      ['    if (m = /^```(\\w*)\\s*$/.exec(line.trim())) {', '    const mb = parseMathBlock(lines, i);\n    if (mb) {\n      push(newBlock("math", { text: mb.text }));\n      i = mb.end;\n      continue;\n    }\n    if (m = /^```(\\w*)\\s*$/.exec(line.trim())) {'],
      ["  return normalizeBlocks(root);\n}", "  return normalizeBlocks(convertDollars(root));\n}"]
    ]
  },
  {
    file: "js/app.js",
    marker: "plugins/math.js",
    edits: [['import "./ui/plugins/flowchart.js";', 'import "./ui/plugins/flowchart.js";\nimport "./ui/plugins/math.js";']]
  }
];
