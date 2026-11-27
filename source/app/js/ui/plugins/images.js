// Plug-in module (images): registers chip kinds (registerChipKind in ../inlineChips.js), slash entries (push onto
// CATALOG in ../../blocks/catalog.js) and block types. Imported once by app.js.
//
// Inline image chip: {{img:<src>|<width>|<height>|<alt>}}. The sizes are "" (auto), a number with px / em / rem
// (a bare number is px) or the name of a repository constant, so changing the constant resizes every image using it.
import { registerChipKind } from "../inlineChips.js";
import { CATALOG } from "../../blocks/catalog.js";
import { buildToken, scanTokens } from "../../blocks/inline.js";
import { h } from "../dom.js";
import { ico } from "../../icons/index.js";
import { openModal } from "../modal.js";
import { toast } from "../dialogs.js";
import { safeSrc, shrink } from "../imageUtil.js";
import { resolveSize, parseSizeField, SIZE_RANGES } from "../../sizes.js";
import { constantsFor, onConstantsChange } from "../sizing.js";

const DATA_OK = /^data:image\/(png|jpeg|gif|webp);base64,/;
const DEFAULT_MAX = "16em"; // an unsized inline image would otherwise take its full pixel size in the middle of a line

function render(n, ctx) {
  const [src, w, ht, alt] = n.args;
  const wrap = h("span", { class: "ichip-img-wrap" });
  const paint = () => {
    if (!safeSrc(src)) return wrap.replaceChildren(h("span", { class: "ichip-img-broken" }, ico("image-off"), h("span", {}, alt || "Image")));
    const constants = constantsFor(ctx);
    const img = h("img", { class: "ichip-img", src, alt: alt || "", loading: "lazy", decoding: "async" });
    const reasons = [];
    for (const [k, v] of [["width", w], ["height", ht]]) {
      const r = resolveSize(v, constants, SIZE_RANGES.image);
      if (r.css) img.style[k] = r.css;
      if (r.reason) reasons.push(`${k === "width" ? "Width" : "Height"}: ${r.reason}.`);
    }
    if (!img.style.width && !img.style.height) img.style.maxHeight = DEFAULT_MAX;
    img.addEventListener("error", () => wrap.replaceChildren(h("span", { class: "ichip-img-broken", title: "This image can't load here" }, ico("image-off"), h("span", {}, alt || "Image"))));
    wrap.replaceChildren(img, ...reasons.length ? [h("span", { class: "ichip-img-note", title: `${reasons.join(" ")} Showing the automatic size.` }, ico("info"), h("span", {}, "size ignored"))] : []);
  };
  paint();
  onConstantsChange(wrap, paint);
  return wrap;
}

function pick(ctx, { onPick, onCancel }) {
  const constants = constantsFor(ctx);
  let src = "";
  let done = false;
  const url = h("input", { type: "url", placeholder: "https://…", "aria-label": "Image URL", autocomplete: "off" });
  const fileInfo = h("span", { class: "hint" }, "");
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: true, onChange: async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = await shrink(f);
      if (!DATA_OK.test(data)) throw new Error("Use a PNG, JPEG, GIF or WebP picture (or an image URL) for an inline image.");
      src = data;
      url.value = "";
      fileInfo.textContent = `Embedded ${f.name || "picture"} (${Math.round(data.length / 1024)} KB)`;
    } catch (err) {
      toast(err.message, "error");
    }
  } });
  const alt = h("input", { type: "text", maxlength: 200, "aria-label": "Alt text", placeholder: "Describe the picture", autocomplete: "off" });
  const listId = `img-size-names-${Date.now()}`;
  const names = constants.length ? h("datalist", { id: listId }, constants.map((c) => h("option", { value: c.name }))) : null;
  const size = (label) => h("input", { type: "text", "aria-label": label, placeholder: "auto", list: constants.length ? listId : null, autocomplete: "off" });
  const width = size("Width");
  const height = size("Height");
  const body = h(
    "div",
    { class: "img-pick" },
    h("label", {}, "Image URL", url),
    h("div", {}, h("button", { type: "button", onClick: () => file.click() }, ico("image-plus"), " Upload a picture"), " ", fileInfo, file),
    h("label", {}, "Alt text (read by screen readers)", alt),
    h("div", { class: "row2" }, h("label", {}, "Width", width), h("label", {}, "Height", height), names),
    h("p", { class: "hint" }, "Sizes use px, em or rem (a bare number is px) or the name of a repository constant. Leave empty for automatic. Uploads are shrunk to about 150 KB.")
  );
  const insert = () => {
    const source = src || url.value.trim();
    if (!source || !(DATA_OK.test(source) || /^https?:\/\//i.test(source))) throw new Error("Enter an http(s) image URL or upload a picture.");
    const args = [source];
    for (const [label, input] of [["Width", width], ["Height", height]]) {
      const r = parseSizeField(input.value, { constants, allowConst: true });
      if (r.error) throw new Error(`${label}: ${r.error}`);
      args.push(r.value === null ? "" : typeof r.value === "string" ? r.value : constants.find((c) => c.id === r.value.const)?.name ?? "");
    }
    args.push(alt.value.trim());
    const token = buildToken("img", args);
    if (!token) throw new Error("That image can't be used here (check the link and the alt text length).");
    const back = scanTokens(token);
    if (back.length !== 1 || back[0].end !== token.length) throw new Error("This picture is too large to place inside text. Use a smaller picture or an image URL.");
    done = true;
    onPick?.(token);
  };
  const modal = openModal({
    title: "Inline image",
    content: body,
    actions: [{ label: "Cancel" }, { label: "Insert", class: "primary", run: insert }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT") {
      e.preventDefault();
      body.closest(".modal-overlay")?.querySelector("button.primary")?.click();
    }
  });
  requestAnimationFrame(() => url.focus());
  return modal;
}

registerChipKind("img", { render, text: (n) => n.args[3] || "Image", pick });

const entry = {
  id: "iimage",
  label: "Inline image",
  group: "Inline",
  keywords: "image picture photo icon inline chip small",
  make: () => null,
  inline: "img",
  icon: "image"
};
if (!CATALOG.some((e) => e.id === entry.id)) CATALOG.push(entry);
