// "File feedback" dialog: kind + title + the app's own block editor, so feedback is written exactly like a page.
// The draft lives only in the dialog; nothing is stored until "File feedback" is pressed.
import { h } from "./dom.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { createBlockEditor } from "./blockEditor.js";
import { isTrashed, isHidden } from "../workspace.js";

// Stored values stay "Feedback" / "Request" (compatible with earlier tickets); only the labels differ.
const KINDS = [
  { value: "Feedback", label: "Feedback", hint: "Something to improve or fix" },
  { value: "Request", label: "Feature request", hint: "Something new you would like" }
];
const unavailable = () => {
  throw new Error("Not available while writing feedback. File it first, then edit the page.");
};

export function openFeedback({ env, onFile, onOpen }) {
  let kind = "Feedback";
  const draft = { id: "feedback-draft", blocks: [] };
  const kinds = h("div", { class: "feedback-kinds", role: "radiogroup", "aria-label": "Kind of feedback" });
  const drawKinds = () => kinds.replaceChildren(...KINDS.map((k) => h("button", {
    type: "button",
    class: `feedback-kind${k.value === kind ? " on" : ""}`,
    role: "radio",
    title: k.hint,
    "aria-checked": String(k.value === kind),
    onClick: () => {
      kind = k.value;
      drawKinds();
    }
  }, k.value === kind ? "✓ " : "", k.label)));
  drawKinds();
  const title = h("input", { type: "text", class: "feedback-title", maxlength: 120, placeholder: "Short summary", "aria-label": "Title" });
  const ctx = {
    ws: env.ws,
    locked: false,
    pageId: null,
    persist() {},
    flush: () => Promise.resolve(),
    changed() {},
    onChange() {},
    pageInfo(id) {
      const p = env.pages().find((x) => x.id === id);
      return p ? { id, title: p.title, icon: p.icon, type: p.type, state: isTrashed(env.pages(), p) ? "trashed" : isHidden(env.pages(), p) ? "archived" : "ok" } : { id, state: "missing", title: "" };
    },
    livePages: () => env.pages().filter((p) => p.type !== "sync" && !isHidden(env.pages(), p)),
    breadcrumbs: () => [],
    openPage() {},
    createChildPage: unavailable,
    createSync: unavailable,
    getSync: () => Promise.resolve(null),
    trashRef: unavailable,
    restoreRef: unavailable,
    duplicateRef: unavailable
  };
  const editor = createBlockEditor(draft, ctx);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.focusBlock(draft.blocks[0].id);
    }
  });
  openModal({
    title: "File feedback",
    content: h(
      "div",
      { class: "feedback-form" },
      kinds,
      title,
      h("div", { class: "feedback-editor", "aria-label": "Details" }, editor.el),
      h("div", { class: "hint" }, "Write it like a page: type / for blocks, paste or drop pictures.")
    ),
    actions: [{ label: "Cancel" }, {
      label: "File feedback",
      class: "primary",
      run: async () => {
        const { db } = await onFile({ kind, title: title.value, blocks: draft.blocks });
        toast(`${kind === "Request" ? "Feature request" : "Feedback"} filed in "${db.title}".`);
        onOpen?.(db.id);
      }
    }]
  });
  title.focus();
}
