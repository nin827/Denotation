import { TABLE_LIMITS, tableResize, tocEntries } from "../blocks/model.js";
import { h } from "./dom.js";
import { iconNode, ico, pageIcon } from "../icons/index.js";
import { toast } from "./dialogs.js";
import { pivotBody } from "./pivotBlock.js";
import { createBlockEditor } from "./blockEditor.js";

const MAX_EMBED_BYTES = 15e4;
const safeSrc = (s) => /^(data:image\/(png|jpe?g|gif|webp|svg\+xml);|https?:\/\/)/i.test(s || "");
export function specialBody(b, inst, a) {
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
    case "page":
      return pageBody(b, inst);
    default:
      return null;
  }
}
function tableBody(b, inst, a) {
  const { ctx } = inst;
  const locked = ctx.locked;
  const cell = (r, c) => {
    const isHead = b.header && r === 0 || b.headerCol && c === 0;
    const input = h("input", {
      type: "text",
      class: `cell${isHead ? " head" : ""}`,
      value: b.cells[r][c],
      readonly: locked,
      "aria-label": `Row ${r + 1}, column ${c + 1}`,
      onInput: (e) => {
        b.cells[r][c] = e.target.value;
        a.save();
      },
      onKeydown: (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          grid.querySelectorAll("tr")[r + 1]?.children[c]?.firstChild?.focus();
        }
      },
      onPaste: (e) => {
        const t = e.clipboardData?.getData("text/plain") ?? "";
        if (!/[\t\n]/.test(t.trim())) return;
        e.preventDefault();
        const rows = t.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("	"));
        const needRows = Math.min(TABLE_LIMITS.maxRows, r + rows.length);
        const needCols = Math.min(TABLE_LIMITS.maxCols, c + Math.max(...rows.map((x) => x.length)));
        tableResize(b, Math.max(needRows, b.cells.length), Math.max(needCols, b.cells[0].length));
        rows.forEach((line, i) => line.forEach((v, j) => {
          if (b.cells[r + i]?.[c + j] !== void 0) b.cells[r + i][c + j] = v;
        }));
        a.save();
        a.redraw();
      }
    });
    return h(isHead ? "th" : "td", {}, input);
  };
  const grid = h("table", { class: "tbl" }, h("tbody", {}, b.cells.map((row, r) => h("tr", {}, row.map((_, c) => cell(r, c))))));
  const num = (label, value, max, onChange) => h(
    "label",
    { class: "tbl-num" },
    label,
    h("input", {
      type: "number",
      min: 1,
      max,
      value,
      disabled: locked,
      onChange: (e) => {
        const n = Math.min(max, Math.max(1, Math.round(Number(e.target.value) || 1)));
        e.target.value = n;
        onChange(n);
      }
    })
  );
  const check = (label, key) => h(
    "label",
    { class: "tbl-check" },
    h("input", { type: "checkbox", checked: b[key], disabled: locked, onChange: (e) => {
      b[key] = e.target.checked;
      a.save();
      a.redraw();
    } }),
    label
  );
  const controls = locked ? null : h(
    "div",
    { class: "tbl-controls" },
    num("Rows", b.cells.length, TABLE_LIMITS.maxRows, (n) => {
      tableResize(b, n, b.cells[0].length);
      a.save();
      a.redraw();
    }),
    num("Columns", b.cells[0].length, TABLE_LIMITS.maxCols, (n) => {
      tableResize(b, b.cells.length, n);
      a.save();
      a.redraw();
    }),
    check("Header row", "header"),
    check("Header column", "headerCol")
  );
  return h("div", { class: "tbl-box" }, h("div", { class: "tbl-wrap" }, grid), controls);
}
const readDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});
export async function shrink(file, maxBytes = MAX_EMBED_BYTES) {
  if (file.type === "image/svg+xml" || file.type === "image/gif") {
    const url = await readDataUrl(file);
    if (url.length > maxBytes) throw new Error("That file is too large to embed. Use an image URL instead.");
    return url;
  }
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.65, 0.5]) {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
      const url = blob && await readDataUrl(blob);
      if (url && url.length <= maxBytes) return url;
    }
  }
  throw new Error("Could not shrink that picture enough to embed it.");
}
function imageBody(b, inst, a) {
  const locked = inst.ctx.locked;
  const box = h("div", { class: "img-box" });
  const picker = h("input", {
    type: "file",
    accept: "image/*",
    hidden: true,
    onChange: async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        b.src = await shrink(f);
        a.save();
        a.redraw();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });
  if (b.src && safeSrc(b.src)) {
    const img = h("img", { src: b.src, alt: b.caption || "", class: "img" });
    img.addEventListener("error", () => {
      img.replaceWith(h("div", { class: "img-fail" }, "This image can't load here. Claude artifacts block images from other websites. Upload the file instead to embed it."));
    });
    box.append(img);
  } else if (!locked) {
    const url = h("input", { type: "url", placeholder: "Paste an image URL\u2026", onKeydown: (e) => {
      if (e.key === "Enter") setUrl();
    } });
    const setUrl = () => {
      const v = url.value.trim();
      if (!safeSrc(v)) return toast("Enter an http(s) image URL.", "error");
      b.src = v;
      a.save();
      a.redraw();
    };
    box.append(h(
      "div",
      { class: "img-empty" },
      h("button", { onClick: () => picker.click() }, "Upload image"),
      h("span", { class: "hint" }, "or"),
      url,
      h("button", { onClick: setUrl }, "Embed link"),
      h("div", { class: "hint" }, "Uploads are shrunk to fit. In Claude artifacts only uploaded images display; pictures from other websites are blocked.")
    ));
  } else box.append(h("div", { class: "img-fail" }, "Empty image"));
  const caption = h("input", {
    class: "caption",
    type: "text",
    value: b.caption,
    placeholder: "Caption",
    readonly: locked,
    onInput: (e) => {
      b.caption = e.target.value;
      a.save();
    }
  });
  const replace = b.src && !locked ? h("button", { class: "icon img-replace", onClick: () => picker.click() }, "Replace") : null;
  return h("div", { class: "img-wrap" }, box, replace, b.src || !locked ? caption : null, picker);
}
function bookmarkBody(b, inst, a) {
  const locked = inst.ctx.locked;
  const ok = /^https?:\/\//i.test(b.url);
  if (ok) {
    return h(
      "div",
      { class: "bookmark" },
      h(
        "a",
        { class: "bm-card", href: b.url, target: "_blank", rel: "noopener noreferrer" },
        h("div", { class: "bm-title" }, b.title || b.url),
        h("div", { class: "bm-url" }, b.url)
      ),
      locked ? null : h("button", { class: "icon", onClick: () => {
        b.url = "";
        a.save();
        a.redraw();
      } }, "Edit")
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
    if (info.state === "ok") inst.ctx.openPage(b.ref);
  };
  return h(
    "a",
    { class: `page-link${info.state === "ok" ? "" : " gone"}`, href: `#page-${b.ref}`, onClick: open },
    h("span", { class: "pl-icon" }, pageIcon(info)),
    h("span", { class: "pl-title" }, info.state === "missing" ? "Page not found" : info.title || "Untitled"),
    info.state === "trashed" ? h("span", { class: "hint" }, "in trash") : null
  );
}
