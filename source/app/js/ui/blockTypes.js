import { tocEntries } from "../blocks/model.js";
import { h } from "./dom.js";
import { iconNode, ico, pageIcon } from "../icons/index.js";
import { toast } from "./dialogs.js";
import { setBlockMenu } from "./blockExtras.js";
import { pivotBody } from "./pivotBlock.js";
import { recordPreviewBody } from "./recordPreview.js";
import { viewBlockBody } from "./viewBlock.js";
import { createBlockEditor } from "./blockEditor.js";
import { tableBody } from "./tableBlock.js";
import { imageBody } from "./imageBlock.js";
export { shrink } from "./imageUtil.js";

// Feature modules (ui/plugins/*.js) register extra block bodies here: fn(b, inst, actions) -> Node.
const PLUGIN_BLOCKS = new Map();
export function registerBlockType(type, fn) {
  PLUGIN_BLOCKS.set(type, fn);
}
export function specialBody(b, inst, a) {
  const plug = PLUGIN_BLOCKS.get(b.type);
  if (plug) return plug(b, inst, a);
  switch (b.type) {
    case "divider":
      return h("hr", { class: "divider" });
    case "table":
      return tableBody(b, inst, a);
    case "columns":
      return h("div", { class: "cols" }, b.children.map((col) => h("div", { class: "col", "data-id": col.id }, inst.renderList(col.children, col))));
    case "image":
      return imageBody(b, inst, a);
    case "bookmark":
      return bookmarkBody(b, inst, a);
    case "toc":
      return tocBody(b, inst);
    case "breadcrumb":
      return breadcrumbBody(inst);
    case "synced":
      return syncedBody(b, inst);
    case "pivot":
      return pivotBody(b, inst, a);
    case "preview":
      return recordPreviewBody(b, inst, a);
    case "dbview":
      return viewBlockBody(b, inst, a);
    case "page":
      return pageBody(b, inst);
    default:
      return null;
  }
}
function bookmarkBody(b, inst, a) {
  const locked = inst.ctx.locked;
  const ok = /^https?:\/\//i.test(b.url);
  if (ok) {
    // editing the link is in the block menu, not a button next to the card
    setBlockMenu(b, () => [
      { header: true, label: "Bookmark" },
      { label: "Open link", icon: ico("external-link"), viewOnly: true, onSelect: () => window.open(b.url, "_blank", "noopener,noreferrer") },
      locked ? null : { label: "Edit link\u2026", icon: ico("pencil"), onSelect: () => {
        b.url = "";
        a.save();
        a.redraw();
      } }
    ].filter(Boolean));
    return h(
      "div",
      { class: "bookmark" },
      h(
        "a",
        { class: "bm-card", href: b.url, target: "_blank", rel: "noopener noreferrer" },
        h("div", { class: "bm-title" }, b.title || b.url),
        h("div", { class: "bm-url" }, b.url)
      )
    );
  }
  const url = h("input", { type: "url", placeholder: "https://\u2026", value: b.url, readonly: locked });
  const title = h("input", { type: "text", placeholder: "Title (optional)", value: b.title, readonly: locked });
  const commit = () => {
    if (!/^https?:\/\//i.test(url.value.trim())) return toast("Enter an http(s) URL.", "error");
    b.url = url.value.trim();
    b.title = title.value.trim();
    a.save();
    a.redraw();
  };
  return h("div", { class: "bookmark editing" }, url, title, locked ? null : h("button", { onClick: commit }, "Save"));
}
function tocBody(b, inst) {
  const box = h("nav", { class: "toc", "aria-label": "Table of contents" });
  const refresh = () => {
    if (!box.isConnected && box._seen) return false;
    box._seen = true;
    const entries = tocEntries(inst.container.blocks);
    box.replaceChildren(...entries.length ? entries.map((e) => h("a", {
      href: "#",
      class: `toc-item l${e.level}`,
      onClick: (ev) => {
        ev.preventDefault();
        inst.root.querySelector(`[data-id="${e.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, e.text || "Untitled")) : [h("div", { class: "hint" }, "Add headings to build a table of contents.")]);
    return true;
  };
  refresh();
  inst.ctx.onChange(refresh);
  return box;
}
function breadcrumbBody(inst) {
  const trail = inst.ctx.breadcrumbs();
  return h("nav", { class: "crumbs inline", "aria-label": "Breadcrumb" }, trail.flatMap((p, i) => [
    i ? h("span", { class: "sep" }, "/") : null,
    h("a", { href: `#page-${p.id}`, onClick: (e) => {
      e.preventDefault();
      inst.ctx.openPage(p.id);
    } }, iconNode(p.icon), " ", p.title || "Untitled")
  ]));
}
function syncedBody(b, inst) {
  const { ctx } = inst;
  const inner = h("div", { class: "synced-body" }, h("div", { class: "hint" }, "Loading\u2026"));
  ctx.getSync(b.ref).then((rec) => {
    if (!rec) return inner.replaceChildren(h("div", { class: "img-fail" }, "The original content of this synced block is missing. Unsync it from the \u2261 menu."));
    let ed;
    const ctx2 = {
      ...ctx,
      persist: (c) => {
        ctx.persist(c);
        for (const o of [...rec.editors]) {
          if (!o.root.isConnected) rec.editors.delete(o);
          else if (o !== ed) o.redraw();
        }
      }
    };
    ed = createBlockEditor(rec.page, ctx2);
    rec.editors.add(ed);
    inner.replaceChildren(ed.el);
  }).catch((e) => inner.replaceChildren(h("div", { class: "img-fail" }, e.message)));
  return h("div", { class: "synced" }, h("div", { class: "synced-label" }, ico("refresh-cw"), " Synced block"), inner);
}
function pageBody(b, inst) {
  const info = b.ref ? inst.ctx.pageInfo(b.ref) : { state: "missing", title: "" };
  const open = (e) => {
    e.preventDefault();
    if (info.state === "ok" || info.state === "archived") inst.ctx.openPage(b.ref);
  };
  return h(
    "a",
    { class: `page-link${info.state === "ok" ? "" : " gone"}`, href: `#page-${b.ref}`, onClick: open },
    h("span", { class: "pl-icon" }, pageIcon(info)),
    h("span", { class: "pl-title" }, info.state === "missing" ? "Page not found" : info.title || "Untitled"),
    info.state === "trashed" ? h("span", { class: "hint" }, "in trash") : info.state === "archived" ? h("span", { class: "hint" }, "archived") : null
  );
}
