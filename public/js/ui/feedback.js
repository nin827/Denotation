import { markdownToBlocks } from "../blocks/markdown.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { renderInline } from "./inlineView.js";
import { shrink } from "./blockTypes.js";

const TICKET_IMAGES = { max: 3, bytes: 7e4 };
function previewNodes(md, images = []) {
  const src = (s) => /^attached:(\d+)$/.exec(s) ? images[Number(RegExp.$1) - 1] ?? "" : s;
  const resolved = String(md).replace(/!\[([^\]]*)\]\(attached:(\d+)\)/g, (m, alt, n) => images[Number(n) - 1] ? `![${alt}](${images[Number(n) - 1]})` : "");
  const render = (blocks) => {
    const out = [];
    let list = null;
    for (const b of blocks) {
      const kids = b.children?.length ? render(b.children) : [];
      const li = b.type === "bullet" || b.type === "numbered" || b.type === "todo";
      if (!li) list = null;
      switch (b.type) {
        case "h1":
        case "h2":
        case "h3":
        case "h4":
          out.push(h(b.type, {}, renderInline(b.text)));
          break;
        case "bullet":
        case "numbered":
        case "todo": {
          const tag = b.type === "numbered" ? "ol" : "ul";
          if (!list || list.tagName.toLowerCase() !== tag) {
            list = h(tag, { class: "md-list" });
            out.push(list);
          }
          list.append(h("li", {}, b.type === "todo" ? h("input", { type: "checkbox", disabled: true, checked: b.checked }) : null, renderInline(b.text), kids.length ? h("div", {}, kids) : null));
          break;
        }
        case "quote":
          out.push(h("blockquote", {}, renderInline(b.text)));
          break;
        case "code":
          out.push(h("pre", { class: "md-code" }, h("code", {}, b.text)));
          break;
        case "divider":
          out.push(h("hr"));
          break;
        case "image":
          out.push(h("img", { class: "img", src: src(b.src), alt: b.caption || "" }));
          break;
        case "table":
          out.push(h("table", { class: "tbl" }, h("tbody", {}, b.cells.map((r, i) => h("tr", {}, r.map((c) => h(i === 0 && b.header ? "th" : "td", {}, renderInline(c))))))));
          break;
        default:
          out.push(h("p", {}, renderInline(b.text)));
      }
    }
    return out;
  };
  return render(markdownToBlocks(resolved));
}
export function openTicket({ onFile, onOpen }) {
  let kind = "Feedback";
  const images = [];
  const kinds = h("div", { class: "ticket-kinds", role: "radiogroup" });
  const drawKinds = () => kinds.replaceChildren(...["Feedback", "Request"].map((k) => h("button", {
    class: `ticket-kind${k === kind ? " on" : ""}`,
    role: "radio",
    "aria-checked": String(k === kind),
    onClick: () => {
      kind = k;
      drawKinds();
    }
  }, k)));
  drawKinds();
  const title = h("input", { type: "text", class: "ticket-title", maxlength: 120, placeholder: "Short summary" });
  const details = h("textarea", {
    class: "ticket-details",
    rows: 6,
    placeholder: "Details. Markdown works: **bold**, `code`, - lists, > quotes. Paste or drop pictures here."
  });
  const preview = h("div", { class: "ticket-preview md", hidden: true });
  const shots = h("div", { class: "ticket-shots" });
  const wrap = (before, after = before, fallback = "text") => () => {
    const { selectionStart: a, selectionEnd: z, value } = details;
    const mid = value.slice(a, z) || fallback;
    details.setRangeText(`${before}${mid}${after}`, a, z, "select");
    details.setSelectionRange(a + before.length, a + before.length + mid.length);
    details.focus();
  };
  const linePrefix = (prefix) => () => {
    const { selectionStart: a, selectionEnd: z, value } = details;
    const start = value.lastIndexOf("\n", a - 1) + 1;
    const block = value.slice(start, z).split("\n").map((l) => prefix + l).join("\n");
    details.setRangeText(block, start, z, "end");
    details.focus();
  };
  async function addImages(files) {
    for (const f of files) {
      if (images.length >= TICKET_IMAGES.max) {
        toast(`A ticket can carry up to ${TICKET_IMAGES.max} pictures.`, "error");
        break;
      }
      try {
        const url = await shrink(f, TICKET_IMAGES.bytes);
        images.push(url);
        const n = images.length;
        details.setRangeText(`${details.value && !/\n$/.test(details.value.slice(0, details.selectionStart)) ? "\n" : ""}![screenshot ${n}](attached:${n})
`, details.selectionStart, details.selectionEnd, "end");
        drawShots();
      } catch (e) {
        toast(e.message, "error");
      }
    }
    details.focus();
  }
  function drawShots() {
    shots.replaceChildren(...images.map((u, i) => h("span", { class: "ticket-shot" }, h("img", { src: u, alt: `screenshot ${i + 1}` }), h("span", {}, `#${i + 1}`))));
  }
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onChange: (e) => {
    const fs = [...e.target.files];
    e.target.value = "";
    addImages(fs);
  } });
  details.addEventListener("paste", (e) => {
    const fs = [...e.clipboardData?.files ?? []].filter((f) => f.type.startsWith("image/"));
    if (fs.length) {
      e.preventDefault();
      addImages(fs);
    }
  });
  details.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer?.types ?? []].includes("Files")) e.preventDefault();
  });
  details.addEventListener("drop", (e) => {
    const fs = [...e.dataTransfer?.files ?? []].filter((f) => f.type.startsWith("image/"));
    if (fs.length) {
      e.preventDefault();
      addImages(fs);
    }
  });
  details.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "b") {
      e.preventDefault();
      wrap("**")();
    } else if (e.key === "i") {
      e.preventDefault();
      wrap("*")();
    }
  });
  const tool = (label, icon, run) => h("button", { type: "button", class: "icon ticket-tool", title: label, "aria-label": label, onClick: run }, icon === "bold" ? h("b", {}, "B") : ico(icon));
  const tabs = { write: null, preview: null };
  const show = (mode) => {
    const p = mode === "preview";
    if (p) preview.replaceChildren(...details.value.trim() ? previewNodes(details.value, images) : [h("p", { class: "hint" }, "Nothing to preview.")]);
    details.hidden = p;
    preview.hidden = !p;
    toolbar.hidden = p;
    tabs.write.classList.toggle("on", !p);
    tabs.preview.classList.toggle("on", p);
  };
  tabs.write = h("button", { type: "button", class: "ticket-tab on", onClick: () => show("write") }, "Write");
  tabs.preview = h("button", { type: "button", class: "ticket-tab", onClick: () => show("preview") }, "Preview");
  const toolbar = h(
    "div",
    { class: "ticket-toolbar" },
    tool("Bold (Ctrl+B)", "bold", wrap("**")),
    tool("Italic (Ctrl+I)", "italic", wrap("*")),
    tool("Code", "code", wrap("`")),
    tool("Bulleted list", "list", linePrefix("- ")),
    tool("Quote", "quote", linePrefix("> ")),
    tool("Link", "link", () => {
      wrap("[", "](https://)", "link text")();
    }),
    tool("Add picture", "image", () => picker.click())
  );
  openModal({
    title: "New ticket",
    content: h(
      "div",
      { class: "ticket-form" },
      kinds,
      h("label", {}, "Title", title),
      h(
        "div",
        { class: "ticket-field" },
        h("div", { class: "ticket-head" }, h("span", {}, "Details"), h("div", { class: "ticket-tabs" }, tabs.write, tabs.preview)),
        toolbar,
        details,
        preview,
        shots,
        picker
      )
    ),
    actions: [{ label: "Cancel" }, {
      label: "File ticket",
      class: "primary",
      run: async () => {
        const { db } = await onFile({ kind, title: title.value, details: details.value, images });
        toast(`${kind} ticket filed.`);
        onOpen?.(db.id);
      }
    }]
  });
  title.focus();
}
