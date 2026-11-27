// The /image block. Stored: src, caption, width?, height? ("320px" / "20em" / { const: id }), align? ("center" | "right"; left is the default).
import { IMAGE_ALIGNS } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { toast } from "./dialogs.js";
import { shrink, safeSrc } from "./imageUtil.js";
import { resolveSize, normSize, SIZE_RANGES } from "../sizes.js";
import { constantsFor, onConstantsChange, openSizeDialog, dragHandle } from "./sizing.js";

const ALIGN_LABEL = { left: "Left", center: "Centre", right: "Right" };
const ALIGN_ICON = { left: "text-align-start", center: "text-align-center", right: "text-align-end" };
export const alignOf = (b) => IMAGE_ALIGNS.includes(b.align) ? b.align : "left";

/** The image size dialog (width and height as a size or a repository constant name). Used by the block and its menu. */
export function openImageSizeDialog(b, inst, a) {
  const constants = constantsFor(inst.ctx);
  return openSizeDialog({
    title: "Image size",
    constants,
    hint: `Use px, em or rem (a bare number means px), or the name of a repository constant${constants.length ? "" : " (this repository has none yet)"}. A constant holding a number (px) or text like 20em resizes every image that uses it. Width alone keeps the aspect ratio.`,
    fields: [
      { key: "width", label: "Width", value: b.width ?? null, allowConst: true },
      { key: "height", label: "Height", value: b.height ?? null, allowConst: true }
    ],
    onSave: ({ width, height }) => {
      for (const [k, v] of [["width", width], ["height", height]]) {
        if (v === null) delete b[k];
        else b[k] = v;
      }
      a.save();
      a.redraw();
    },
    onReset: () => {
      delete b.width;
      delete b.height;
      a.save();
      a.redraw();
    }
  });
}
export function setImageAlign(b, align, a) {
  if (align === "left") delete b.align;
  else b.align = align;
  a.save();
  a.redraw();
}

export function imageBody(b, inst, a) {
  const locked = inst.ctx.locked;
  const box = h("div", { class: "img-box" });
  const note = h("div", { class: "img-size-note", role: "note", hidden: true });
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
  let img = null;
  /** Put the stored width / height on the picture; say why when a constant cannot be used as a size. */
  const applySize = () => {
    if (!img) return;
    const constants = constantsFor(inst.ctx);
    const reasons = [];
    for (const k of ["width", "height"]) {
      const r = resolveSize(b[k], constants, SIZE_RANGES.image);
      img.style[k] = r.css ?? "";
      if (r.reason) reasons.push(`${k === "width" ? "Width" : "Height"}: ${r.reason}.`);
    }
    img.classList.toggle("stretch", !!(img.style.width && img.style.height));
    note.replaceChildren(...reasons.length ? [ico("info"), h("span", {}, ` ${reasons.join(" ")} Showing the automatic size.`)] : []);
    note.hidden = !reasons.length;
  };
  if (b.src && safeSrc(b.src)) {
    img = h("img", { src: b.src, alt: b.caption || "", class: "img" });
    img.addEventListener("error", () => {
      img = null;
      box.replaceChildren(h("div", { class: "img-fail" }, "This image can't load here. Claude artifacts block images from other websites. Upload the file instead to embed it."));
    });
    box.append(img);
    if (!locked) {
      const grip = (kind, label) => {
        const el = h("span", { class: `img-grip ${kind}`, "aria-hidden": "true", title: label });
        dragHandle(el, {
          begin: () => {
            const r = img.getBoundingClientRect();
            return { w0: r.width, h0: r.height, hadH: !!b.height };
          },
          move: (st, dx, dy) => {
            if (kind !== "s") {
              const w = normSize(st.w0 + dx, SIZE_RANGES.image);
              if (w) b.width = w;
              if (kind === "se" && st.hadH && w) b.height = normSize(st.h0 * (parseFloat(w) / st.w0), SIZE_RANGES.image);
            } else {
              const v = normSize(st.h0 + dy, SIZE_RANGES.image);
              if (v) b.height = v;
            }
            applySize();
          },
          end: (_st, moved) => moved && a.save()
        });
        return el;
      };
      box.append(grip("e", "Drag to change the width"), grip("s", "Drag to change the height"), grip("se", "Drag to resize (keeps the proportions)"));
    }
  } else if (!locked) {
    const url = h("input", { type: "url", placeholder: "Paste an image URL…", onKeydown: (e) => {
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
      if (img) img.alt = b.caption || "";
    }
  });
  const align = alignOf(b);
  const tools = b.src && !locked ? h(
    "div",
    { class: "img-tools", role: "toolbar", "aria-label": "Image options" },
    h("button", { class: "icon img-replace", onClick: () => picker.click() }, "Replace"),
    h("button", { class: "icon img-size-btn", title: "Width and height", onClick: () => openImageSizeDialog(b, inst, a) }, ico("ruler"), " Size"),
    h("span", { class: "img-aligns", role: "group", "aria-label": "Alignment" }, IMAGE_ALIGNS.map((k) => h("button", {
      class: `icon img-align${k === align ? " on" : ""}`,
      "aria-pressed": String(k === align),
      title: `Align ${ALIGN_LABEL[k].toLowerCase()}`,
      onClick: () => setImageAlign(b, k, a)
    }, ico(ALIGN_ICON[k]), h("span", { class: "img-align-label" }, ` ${ALIGN_LABEL[k]}`))))
  ) : null;
  const wrap = h("div", { class: "img-wrap", "data-align": align }, tools, box, note, b.src || !locked ? caption : null, picker);
  applySize();
  if (img) onConstantsChange(wrap, applySize);
  return wrap;
}
