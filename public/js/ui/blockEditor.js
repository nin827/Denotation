import { detectShortcut, toggleMarker, scanTokens } from "../blocks/inline.js";
import {
  isTexty,
  normColor,
  normBg,
  normalizeBlocks,
  isFoldable,
  numbering,
  newBlock,
  find,
  convert,
  hasChildren,
  canConvert,
  insertAfter,
  outdent,
  indent,
  remove,
  walk,
  cloneBlock,
  moveUp,
  moveDown,
  columnsSetCount,
  move
} from "../blocks/model.js";
import { markdownToBlocks, blocksToMarkdown } from "../blocks/markdown.js";
import { h } from "./dom.js";
import { ico, iconNode, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { toast } from "./dialogs.js";
import { parseArgs, filterCatalog, labelFor } from "../blocks/catalog.js";
import { renderInline } from "./inlineView.js";
import { specialBody, shrink } from "./blockTypes.js";
import { openBlockMenu } from "./blockMenu.js";
import { pickEmoji } from "./emoji.js";
import { openInlinePicker, inlineResolver, blockTexts } from "./inlineChips.js";

let drag = null;
const clip = { mode: null, block: null };
const fit = (el) => {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
};
const listLike = (b) => ["bullet", "numbered", "todo"].includes(b.type);
const focusable = (b) => isTexty(b) || b.type === "code";
const colorOf = (b) => {
  const c = normColor(b.color);
  const bg = normBg(b.bg);
  return { cls: `${c !== null ? " has-color" : ""}${bg !== null ? " has-bg" : ""}${bg === "grey" ? " bg-grey" : ""}`, c, bg };
};
const applyHues = (el, { c, bg }) => {
  if (c !== null) el.style.setProperty("--blk-h", c);
  if (typeof bg === "number") el.style.setProperty("--blk-bg-h", bg);
};
const PLACEHOLDER = { h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", quote: "Quote", callout: "Type something\u2026", code: "Code", bullet: "List", numbered: "List", todo: "To-do", toggle: "Toggle" };
const handleIcon = () => h("span", { class: "handle-icon" }, ico("menu"));
export function createBlockEditor(container, ctx) {
  container.blocks = normalizeBlocks(container.blocks);
  const root = h("div", { class: "blocks" });
  const inst = { container, ctx, root, redraw, focusBlock, save, api: null };
  let slash = null;
  function save() {
    ctx.persist(container);
    ctx.changed();
  }
  function redraw(focus) {
    closeSlash();
    root.replaceChildren(...renderList(container.blocks, null));
    if (focus) focusBlock(focus.id, focus.pos);
  }
  function focusBlock(id, pos = 0) {
    const ta = root.querySelector(`textarea[data-id="${id}"]`);
    if (!ta) return;
    ta.closest(".blk-content")?.classList.add("editing");
    ta.focus();
    const p = pos === "end" ? ta.value.length : Math.min(pos, ta.value.length);
    ta.setSelectionRange(p, p);
  }
  const order = () => {
    const out = [];
    const walkVisible = (list) => {
      for (const b of list) {
        out.push(b);
        if (b.children?.length && (!isFoldable(b) || b.open)) walkVisible(b.children);
      }
    };
    walkVisible(container.blocks);
    return out;
  };
  const neighbor = (b, dir) => {
    const o = order();
    for (let i = o.indexOf(b) + dir; i >= 0 && i < o.length; i += dir) if (focusable(o[i])) return o[i];
    return null;
  };
  function renderList(list, parent) {
    const nums = numbering(list);
    return list.map((b) => blockEl(b, parent, nums));
  }
  inst.renderList = renderList;
  function blockEl(b, parent, nums) {
    const wrap = h("div", { class: "blk-wrap", "data-id": b.id });
    const col = colorOf(b);
    const row = h("div", { class: `blk-row t-${b.type}${col.cls}` });
    applyHues(row, col);
    if (!ctx.locked) {
      const handle = h("div", {
        class: "gutter",
        role: "button",
        tabindex: 0,
        draggable: "true",
        title: matchMedia("(hover: none)").matches ? "Tap for options (move, copy, delete...)" : "Drag to move, click for options",
        "aria-label": "Block options",
        onClick: () => openBlockMenu(handle, b, inst, actions),
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openBlockMenu(handle, b, inst, actions);
          }
        },
        onDragstart: (e) => {
          drag = { id: b.id, inst };
          e.dataTransfer.setData("text/plain", b.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setDragImage?.(row, 0, 0);
        },
        onDragend: () => {
          drag = null;
          clearDrop();
        }
      }, handleIcon());
      row.append(handle);
      wireDrop(row, b);
    }
    row.append(bodyFor(b, parent, nums));
    wrap.append(row);
    const showKids = b.children?.length && b.type !== "columns" && b.type !== "column" && (!isFoldable(b) || b.open);
    if (showKids) wrap.append(h("div", { class: "blk-children" }, renderList(b.children, b)));
    else if (isFoldable(b) && b.open && !b.children?.length && !ctx.locked) {
      wrap.append(h("div", { class: "blk-children" }, h("button", {
        class: "empty-toggle",
        onClick: () => {
          const nb = newBlock("p");
          (b.children ?? (b.children = [])).push(nb);
          save();
          redraw({ id: nb.id });
        }
      }, "Empty. Click to add a block inside.")));
    }
    return wrap;
  }
  function bodyFor(b, parent, nums) {
    if (isTexty(b) || b.type === "code") return textBody(b, parent, nums);
    return specialBody(b, inst, actions) ?? h("div", {}, "");
  }
  function textBody(b, parent, nums) {
    const isCode = b.type === "code";
    const content = h("div", { class: `blk-content${isCode ? " editing" : ""}` });
    const view = h("div", { class: "rendered" });
    const ta = h("textarea", {
      class: "blk-ta",
      rows: 1,
      "data-id": b.id,
      value: b.text ?? "",
      placeholder: PLACEHOLDER[b.type] ?? "Type '/' for commands",
      spellcheck: isCode ? "false" : null,
      readonly: ctx.locked,
      "aria-label": "Block text",
      onInput: (e) => onInput(e, b, ta),
      onKeydown: (e) => onKeydown(e, b, ta),
      onPaste: (e) => onPaste(e, b, ta),
      onFocus: () => {
        content.classList.add("editing");
        fit(ta);
      },
      onBlur: () => {
        closeSlash();
        if (!isCode) {
          content.classList.remove("editing");
          view.replaceChildren(...renderInline(b.text, ctx));
        }
      }
    });
    if (!isCode) {
      view.replaceChildren(...renderInline(b.text, ctx));
      view.tabIndex = 0;
      view.addEventListener("focus", () => {
        content.classList.add("editing");
        ta.focus();
      });
      view.addEventListener("mousedown", (e) => {
        const a = e.target.closest("a");
        if (a) return;
        e.preventDefault();
        if (e.button !== 0) return; // right-click: no focus, no edit mode, so the block menu can open
        content.classList.add("editing");
        fit(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      view.addEventListener("click", (e) => {
        const chip = e.target.closest("a.ichip");
        if (chip) {
          e.preventDefault();
          Promise.resolve(ctx.flush?.()).finally(() => {
            location.hash = chip.getAttribute("href");
          });
          return;
        }
        const a = e.target.closest("a.mention");
        if (a) {
          e.preventDefault();
          ctx.openPage(a.getAttribute("href").replace(/^#(page|row)-/, ""));
        }
      });
      content.append(view);
    }
    content.append(ta);
    requestAnimationFrame(() => fit(ta));
    const main = h("div", { class: "blk-main" }, marker(b, nums, ta), content);
    if (isCode) return codeBox(b, main, ta);
    return main;
  }
  function marker(b, nums, ta) {
    if (b.type === "bullet") return h("span", { class: "marker" }, "\u2022");
    if (b.type === "numbered") return h("span", { class: "marker" }, `${nums.get(b.id)}.`);
    if (b.type === "todo") {
      return h("input", {
        type: "checkbox",
        class: "marker check",
        checked: b.checked,
        disabled: ctx.locked,
        "aria-label": "Done",
        onChange: (e) => {
          b.checked = e.target.checked;
          ta.closest(".blk-row").classList.toggle("done", b.checked);
          save();
        }
      });
    }
    if (isFoldable(b)) {
      return h("button", {
        class: `caret${b.open ? " open" : ""}`,
        "aria-label": b.open ? "Collapse" : "Expand",
        "aria-expanded": String(!!b.open),
        onClick: () => {
          b.open = !b.open;
          save();
          redraw();
        }
      }, ico("chevron-right"));
    }
    if (b.type === "callout") {
      return h("button", {
        class: "callout-icon",
        "aria-label": "Change icon",
        disabled: ctx.locked,
        onClick: (e) => pickEmoji(e.currentTarget, (em) => {
          b.icon = em || "icon:lightbulb";
          save();
          redraw();
        }, { removable: false })
      }, iconNode(b.icon, "icon:lightbulb"));
    }
    return null;
  }
  function codeBox(b, main, ta) {
    const langs = ["plain", "js", "ts", "python", "json", "html", "css", "bash", "sql", "java", "c", "go", "rust", "markdown"];
    if (b.lang && !langs.includes(b.lang)) langs.push(b.lang);
    const select = h("select", {
      class: "code-lang",
      "aria-label": "Language",
      disabled: ctx.locked,
      value: b.lang || "plain",
      onChange: (e) => {
        b.lang = e.target.value;
        save();
      }
    }, langs.map((l) => h("option", { value: l }, l)));
    const copy = h("button", {
      class: "icon code-copy",
      type: "button",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(b.text);
          toast("Copied");
        } catch {
          ta.select();
          toast("Press Ctrl/Cmd+C to copy", "info");
        }
      }
    }, "Copy");
    return h("div", { class: "code-box" }, h("div", { class: "code-tools" }, select, copy), main);
  }
  function onInput(e, b, ta) {
    b.text = ta.value;
    fit(ta);
    if (b.type === "p" && !e.isComposing) {
      const s = detectShortcut(b.text);
      if (s) {
        applyShortcut(b, s);
        return;
      }
    }
    updateTrigger(b, ta);
    save();
  }
  function applyShortcut(b, s) {
    if (s.type === "divider") {
      const r = find(container.blocks, b.id);
      const div = newBlock("divider");
      r.list.splice(r.index, 1, div);
      let next = r.list[r.index + 1];
      if (!next || !focusable(next)) {
        next = newBlock("p");
        r.list.splice(r.index + 1, 0, next);
      }
      save();
      redraw({ id: next.id });
      return;
    }
    convert(b, s.type, s.props);
    b.text = s.rest;
    save();
    redraw({ id: b.id, pos: "end" });
  }
  function closeSlash() {
    const s = slash;
    slash = null;
    s?.menu.close();
  }
  function updateTrigger(b, ta) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    if (b.type !== "code" && before.endsWith("{{")) {
      closeSlash();
      return openPicker(b, ta, "value", caret - 2, caret);
    }
    let m = /(?:^|\s)\/([^\n/]{0,24})$/.exec(before);
    if (m && b.type !== "code") return openSlashMenu(b, ta, m, caret, "slash");
    m = /(?:^|\s)@([^\n@]{0,24})$/.exec(before);
    if (m && b.type !== "code") return openSlashMenu(b, ta, m, caret, "mention");
    closeSlash();
  }
  function slashItems(b, ta, q, start, kind) {
    const caret = ta.selectionStart;
    if (kind === "mention") {
      const query = q.trim().toLowerCase();
      return ctx.livePages().filter((p) => !query || (p.title || "Untitled").toLowerCase().includes(query)).slice(0, 8).map((p) => ({
        label: p.title || "Untitled",
        icon: pageIcon(p),
        onSelect: () => {
          const link = `[${p.title || "Untitled"}](#page-${p.id}) `;
          b.text = ta.value.slice(0, start) + link + ta.value.slice(caret);
          ta.value = b.text;
          const pos = start + link.length;
          ta.focus();
          ta.setSelectionRange(pos, pos);
          fit(ta);
          save();
        }
      }));
    }
    const args = parseArgs(q);
    return filterCatalog(q).filter((e) => !(e.inline && b.type === "code")).map((entry) => entry.inline ? {
      label: entry.label,
      icon: ico(entry.icon),
      hint: entry.group,
      onSelect: () => openPicker(b, ta, entry.inline, start, caret)
    } : ({
      label: labelFor(entry, args),
      icon: ico(entry.icon),
      hint: entry.group,
      onSelect: () => insertEntry(b, ta, entry, args, start, caret)
    }));
  }
  // Open the inline picker and put the chosen token in place of text[start, end).
  function openPicker(b, ta, kind, start, end) {
    const id = b.id;
    const refocus = (pos) => {
      const el = root.querySelector(`textarea[data-id="${id}"]`);
      if (!el) return;
      el.closest(".blk-content")?.classList.add("editing");
      el.focus();
      el.setSelectionRange(pos, pos);
      fit(el);
    };
    openInlinePicker(kind, ctx, {
      onPick: (token) => {
        const cur = b.text ?? "";
        b.text = cur.slice(0, start) + token + cur.slice(end);
        const el = root.querySelector(`textarea[data-id="${id}"]`);
        if (el) el.value = b.text;
        save();
        refocus(start + token.length);
      },
      onCancel: () => refocus(Math.min(end, (b.text ?? "").length))
    });
  }
  function openSlashMenu(b, ta, m, caret, kind) {
    const start = caret - m[0].replace(/^\s/, "").length;
    const items = slashItems(b, ta, m[1], start, kind);
    if (!items.length) {
      if (m[1].length > 1) closeSlash();
      else if (slash) slash.menu.update([]);
      return;
    }
    if (slash && slash.kind === kind && slash.blockId === b.id) {
      slash.menu.update(items);
      return;
    }
    closeSlash();
    const menu = openMenu(ta, items, { width: 260, onClose: () => {
      if (slash?.menu === menu) slash = null;
    } });
    slash = { menu, kind, blockId: b.id };
  }
  async function insertEntry(b, ta, entry, args, start, caret) {
    const rest = ta.value.slice(0, start) + ta.value.slice(caret);
    const empty = rest.trim() === "" && !hasChildren(b);
    let nb = entry.make(args);
    if (entry.needs === "sync") nb.ref = (await ctx.createSync()).page.id;
    if (entry.needs === "page") {
      const page = await ctx.createChildPage(entry.pageType);
      nb.ref = page.id;
    }
    b.text = rest;
    const r = find(container.blocks, b.id);
    const canConvert2 = empty && canConvert(b, nb.type) && isTexty(nb);
    if (canConvert2) {
      convert(b, nb.type, { ...entry.props || {}, ...nb.fold ? { fold: true } : {} });
      b.text = "";
      nb = b;
    } else if (empty) {
      r.list.splice(r.index, 1, nb);
    } else {
      r.list.splice(r.index + 1, 0, nb);
    }
    const after = find(container.blocks, nb.id);
    let focus = nb;
    if (!focusable(nb)) {
      focus = after.list[after.index + 1];
      if (!focus || !focusable(focus)) {
        focus = newBlock("p");
        after.list.splice(after.index + 1, 0, focus);
      }
    }
    save();
    redraw({ id: focus.id });
    if (entry.needs === "page") {
      await ctx.flush();
      ctx.openPage(nb.ref);
    }
  }
  function setText(b, ta, { text, start: start, end }) {
    ta.value = text;
    b.text = text;
    ta.setSelectionRange(start, end);
    fit(ta);
    save();
  }
  function onKeydown(e, b, ta) {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const collapsed = ta.selectionStart === ta.selectionEnd;
    const isCode = b.type === "code";
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !isCode && (key === "b" || key === "i" || key === "e")) {
      e.preventDefault();
      return setText(b, ta, toggleMarker(ta.value, ta.selectionStart, ta.selectionEnd, { b: "**", i: "*", e: "`" }[key]));
    }
    if (mod && !e.shiftKey && !isCode && key === "k") {
      e.preventDefault();
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const label = ta.value.slice(s, en) || "link";
      const text = `${ta.value.slice(0, s)}[${label}](url)${ta.value.slice(en)}`;
      const urlStart = s + label.length + 3;
      return setText(b, ta, { text, start: urlStart, end: urlStart + 3 });
    }
    if (mod && key === "d") {
      e.preventDefault();
      return actions.duplicate(b);
    }
    if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      return actions.move(b, e.key === "ArrowUp" ? -1 : 1);
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      if (b.type === "todo") {
        b.checked = !b.checked;
        save();
        return redraw({ id: b.id, pos: ta.selectionStart });
      }
      if (isFoldable(b)) {
        b.open = !b.open;
        save();
        return redraw({ id: b.id, pos: ta.selectionStart });
      }
      if (isCode) {
        const nb = newBlock("p");
        insertAfter(container.blocks, b.id, nb);
        save();
        return redraw({ id: nb.id });
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (isCode) {
        if (!e.shiftKey) setText(b, ta, { text: `${ta.value.slice(0, ta.selectionStart)}  ${ta.value.slice(ta.selectionEnd)}`, start: ta.selectionStart + 2, end: ta.selectionStart + 2 });
        return;
      }
      const pos = ta.selectionStart;
      const ok = e.shiftKey ? outdent(container.blocks, b.id) : indent(container.blocks, b.id);
      if (ok) {
        save();
        redraw({ id: b.id, pos });
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !isCode) {
      e.preventDefault();
      return split(b, ta);
    }
    if ((e.key === "Backspace" || e.key === "Delete") && collapsed && !isCode && ta.value.includes("{{")) {
      const pos = ta.selectionStart;
      const t = scanTokens(ta.value).find((x) => e.key === "Backspace" ? x.end === pos : x.start === pos);
      if (t) {
        e.preventDefault();
        return setText(b, ta, { text: ta.value.slice(0, t.start) + ta.value.slice(t.end), start: t.start, end: t.start });
      }
    }
    if (e.key === "Backspace" && collapsed && ta.selectionStart === 0) return backspace(e, b, ta);
    if (e.key === "Delete" && collapsed && ta.selectionStart === ta.value.length && !isCode) {
      const next = neighbor(b, 1);
      if (next && isTexty(next) && !hasChildren(next) && isTexty(b)) {
        e.preventDefault();
        const pos = b.text.length;
        b.text += next.text;
        remove(container.blocks, next.id);
        save();
        redraw({ id: b.id, pos });
      }
      return;
    }
    if (e.key === "ArrowUp" && collapsed && ta.selectionStart === 0 && !mod) {
      const p = neighbor(b, -1);
      if (p) {
        e.preventDefault();
        focusBlock(p.id, "end");
      }
    } else if (e.key === "ArrowDown" && collapsed && ta.selectionStart === ta.value.length && !mod) {
      const n = neighbor(b, 1);
      if (n) {
        e.preventDefault();
        focusBlock(n.id, 0);
      }
    }
  }
  function split(b, ta) {
    const text = ta.value;
    const pos = ta.selectionStart;
    if (text === "" && listLike(b)) {
      const r = find(container.blocks, b.id);
      if (r.parent && r.parent.type !== "column") outdent(container.blocks, b.id);
      else convert(b, "p");
      save();
      return redraw({ id: b.id });
    }
    const before = text.slice(0, pos);
    const after = text.slice(ta.selectionEnd);
    b.text = before;
    const type = listLike(b) ? b.type : "p";
    const nb = newBlock(type, { text: after });
    if (isFoldable(b) && b.open) (b.children ?? (b.children = [])).unshift(nb);
    else insertAfter(container.blocks, b.id, nb);
    save();
    redraw({ id: nb.id });
  }
  function backspace(e, b, ta) {
    if (b.type === "code") {
      if (b.text === "") {
        e.preventDefault();
        convert(b, "p");
        save();
        redraw({ id: b.id });
      }
      return;
    }
    if (b.type !== "p") {
      e.preventDefault();
      convert(b, "p");
      save();
      return redraw({ id: b.id });
    }
    if (hasChildren(b)) return;
    const o = order();
    const i = o.indexOf(b);
    const prev = o[i - 1];
    if (!prev) return;
    e.preventDefault();
    if (!isTexty(prev)) {
      if (prev.type === "column" || prev.type === "columns") return;
      if (b.text === "" || prev.type === "divider") {
        remove(container.blocks, prev.id);
        save();
        redraw({ id: b.id });
      } else focusableBefore(b, o, i);
      return;
    }
    const pos = prev.text.length;
    prev.text += b.text;
    remove(container.blocks, b.id);
    save();
    redraw({ id: prev.id, pos });
  }
  function focusableBefore(b, o, i) {
    for (let j = i - 1; j >= 0; j--) if (focusable(o[j])) return focusBlock(o[j].id, "end");
  }
  async function pasteImage(file, b, ta) {
    try {
      const src = await shrink(file);
      const blk = newBlock("image", { src });
      const r = find(container.blocks, b.id);
      const empty = ta.value === "" && b.type === "p" && !hasChildren(b);
      if (empty) r.list.splice(r.index, 1, blk);
      else r.list.splice(r.index + 1, 0, blk);
      save();
      redraw();
    } catch (err) {
      toast(err.message, "error");
    }
  }
  function onPaste(e, b, ta) {
    if (b.type === "code" || ctx.locked) return;
    const img = [...e.clipboardData?.files ?? []].find((f) => f.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      pasteImage(img, b, ta);
      return;
    }
    const t = e.clipboardData?.getData("text/plain") ?? "";
    if (!t.trim().includes("\n")) return;
    e.preventDefault();
    const blocks = markdownToBlocks(t);
    const text = ta.value.slice(0, ta.selectionStart) + ta.value.slice(ta.selectionEnd);
    const r = find(container.blocks, b.id);
    if (text === "" && b.type === "p" && !hasChildren(b)) r.list.splice(r.index, 1, ...blocks);
    else {
      b.text = text;
      r.list.splice(r.index + 1, 0, ...blocks);
    }
    save();
    redraw({ id: blocks[blocks.length - 1].id, pos: "end" });
  }
  const mdCtx = { pageTitle: (id) => ctx.pageInfo(id).title, syncBlocks: () => [] };
  const subtreeRefs = (b) => {
    const refs = [];
    walk([b], (x) => {
      if (x.type === "page" && x.ref) refs.push(x);
    });
    return refs;
  };
  const actions = {
    save,
    redraw,
    turnInto(b, entry) {
      if (!convert(b, entry.type || entry.id, entry.props || {})) return toast("That block can't be converted.", "error");
      save();
      redraw({ id: b.id, pos: "end" });
    },
    setColor(b, key, value) {
      if (value === "default") delete b[key];
      else b[key] = value;
      save();
      redraw();
    },
    async duplicate(b) {
      const copy = cloneBlock(b);
      for (const pb of subtreeRefs(copy)) pb.ref = (await ctx.duplicateRef(pb.ref))?.id ?? pb.ref;
      insertAfter(container.blocks, b.id, copy);
      save();
      redraw({ id: copy.id, pos: "end" });
    },
    move(b, delta) {
      if (!(delta < 0 ? moveUp(container.blocks, b.id) : moveDown(container.blocks, b.id))) return;
      save();
      redraw({ id: b.id, pos: "end" });
    },
    async remove(b) {
      for (const pb of subtreeRefs(b)) await ctx.trashRef(pb.ref);
      const o = order();
      const prev = o[o.indexOf(b) - 1] ?? o[o.indexOf(b) + 1];
      remove(container.blocks, b.id);
      save();
      redraw(prev && prev.id !== b.id ? { id: prev.id, pos: "end" } : null);
    },
    async copy(b, cut = false) {
      clip.mode = cut ? "cut" : "copy";
      clip.block = JSON.parse(JSON.stringify(b));
      try {
        const inline = await inlineResolver(ctx, blockTexts([b]));
        await navigator.clipboard.writeText(blocksToMarkdown([b], { ...mdCtx, inline }));
      } catch {
      }
      if (cut) await actions.remove(b);
      else toast("Block copied");
    },
    async paste(b) {
      if (!clip.block) return toast("Nothing copied yet. Use Copy or Cut on a block first.");
      const nb = cloneBlock(clip.block);
      for (const pb of subtreeRefs(nb)) {
        if (clip.mode === "cut") await ctx.restoreRef(pb.ref);
        else pb.ref = (await ctx.duplicateRef(pb.ref))?.id ?? pb.ref;
      }
      if (clip.mode === "cut") clip.block = null;
      insertAfter(container.blocks, b.id, nb);
      save();
      redraw({ id: focusable(nb) ? nb.id : b.id });
    },
    async moveToPage(b, pageId) {
      const target = await ctx.ws.getPage(pageId);
      if (!target) return toast("That page no longer exists.", "error");
      target.blocks = normalizeBlocks(target.blocks);
      const moved = remove(container.blocks, b.id);
      const last = target.blocks[target.blocks.length - 1];
      if (last && last.type === "p" && !last.text && target.blocks.length === 1) target.blocks.splice(0, 1, moved);
      else target.blocks.push(moved);
      await ctx.ws.savePage(target);
      for (const pb of subtreeRefs(moved)) await ctx.ws.movePage(pb.ref, target.id);
      save();
      redraw();
      toast(`Moved to "${target.title || "Untitled"}"`);
    },
    async copyLink(b) {
      const text = b.type === "page" && b.ref ? `[${ctx.pageInfo(b.ref).title}](#page-${b.ref})` : `[${ctx.pageInfo(ctx.pageId).title}](#page-${ctx.pageId})`;
      try {
        await navigator.clipboard.writeText(text);
        toast("Link copied");
      } catch {
        toast(text);
      }
    },
    async makeSynced(b) {
      const rec = await ctx.createSync([cloneBlock(b)]);
      const sb = newBlock("synced", { ref: rec.page.id });
      const r = find(container.blocks, b.id);
      r.list.splice(r.index, 1, sb);
      save();
      redraw();
    },
    async unsync(b) {
      const rec = await ctx.getSync(b.ref);
      const copies = (rec?.page.blocks || []).map(cloneBlock);
      const r = find(container.blocks, b.id);
      r.list.splice(r.index, 1, ...copies.length ? copies : [newBlock("p")]);
      save();
      redraw();
    },
    setColumns(b, n) {
      columnsSetCount(b, n);
      save();
      redraw();
    },
    setFold(b, on) {
      if (on) {
        b.fold = true;
        b.open = true;
      } else {
        delete b.fold;
        delete b.open;
      }
      save();
      redraw();
    }
  };
  const clearDrop = () => document.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  function wireDrop(row, b) {
    row.addEventListener("dragover", (e) => {
      if (!drag || drag.id === b.id) return;
      e.preventDefault();
      e.stopPropagation();
      const r = row.getBoundingClientRect();
      const pos = e.clientY < r.top + r.height / 2 ? "before" : "after";
      clearDrop();
      row.classList.add(`drop-${pos}`);
    });
    row.addEventListener("drop", (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = row.classList.contains("drop-before") ? "before" : "after";
      const from = drag;
      drag = null;
      clearDrop();
      dropBlock(from, b, pos);
    });
  }
  function dropBlock(from, target, pos) {
    if (from.inst === inst) {
      if (move(container.blocks, from.id, target.id, pos)) {
        save();
        redraw();
      }
      return;
    }
    const src = find(from.inst.container.blocks, from.id);
    if (!src) return;
    if (src.block.type === "synced" && src.block.ref === container.id) return toast("A synced block can't contain itself.", "error");
    if (src.block.type === "column") return;
    remove(from.inst.container.blocks, from.id);
    const r = find(container.blocks, target.id);
    r.list.splice(r.index + (pos === "after" ? 1 : 0), 0, src.block);
    from.inst.save();
    from.inst.redraw();
    save();
    redraw();
  }
  wireBlockContextMenu();
  /**
   * Right-click, long-press and Shift+F10 / ContextMenu key open the block handle's menu.
   * Local on purpose: ui/contextMenu.js (bindContextMenu) can replace this later, keeping the same native-menu rules.
   */
  function wireBlockContextMenu() {
    const NATIVE = "input,textarea,select,[contenteditable],a[href]";
    const LONG_MS = 520;
    const rowOf = (t) => t?.closest?.(".blk-row");
    const blockOf = (row) => {
      const id = row?.closest(".blk-wrap")?.dataset.id;
      return id ? find(container.blocks, id)?.block ?? null : null;
    };
    const selected = () => {
      try {
        return !!window.getSelection?.()?.toString().trim();
      } catch {
        return false;
      }
    };
    const open = (row, anchor) => {
      const b = blockOf(row);
      if (!b || ctx.locked) return false;
      openBlockMenu(anchor, b, inst, actions);
      return true;
    };
    // native menu stays on text fields, edit mode, links and selected text (the handle always gets the block menu)
    const native = (t, sel = selected()) => !t.closest(".gutter") && (!!t.closest(NATIVE) || !!t.closest(".blk-content.editing") || sel);
    let press = null;
    let swallow = 0;
    const cancel = () => {
      clearTimeout(press?.timer);
      press = null;
    };
    root.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented) return;
      const longTouch = press !== null; // the browser's own long-press menu beat our timer
      cancel();
      if (longTouch) swallow = Date.now() + 700;
      const row = rowOf(e.target);
      // a touch long-press selects a word by itself; that selection is not a reason to keep the native menu
      if (!row || native(e.target, longTouch ? false : selected()) || !open(row, { x: e.clientX, y: e.clientY })) return;
      if (longTouch) window.getSelection?.()?.removeAllRanges();
      e.preventDefault();
      e.stopPropagation();
    });
    root.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || !(e.key === "ContextMenu" || e.key === "F10" && e.shiftKey)) return;
      const t = e.target;
      if (t.closest?.("input,select,[contenteditable]") || t.closest?.("textarea:not(.blk-ta)")) return;
      const row = rowOf(t);
      if (!row) return;
      const r = row.getBoundingClientRect();
      if (open(row, { x: r.left + 24, y: Math.min(r.bottom, r.top + 28) })) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    root.addEventListener("pointerdown", (e) => {
      cancel();
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      const row = rowOf(e.target);
      if (!row || e.target.closest(NATIVE) || e.target.closest(".blk-content.editing")) return;
      const start = { x: e.clientX, y: e.clientY };
      press = {
        start,
        timer: setTimeout(() => {
          press = null;
          swallow = Date.now() + 700;
          if (open(row, start)) {
            window.getSelection?.()?.removeAllRanges();
            // cancelling touchend stops the emulated mousedown/click that would close the menu again
            document.addEventListener("touchend", (ev) => ev.cancelable && ev.preventDefault(), { once: true, capture: true });
          }
        }, LONG_MS)
      };
    });
    root.addEventListener("pointermove", (e) => {
      if (press && Math.hypot(e.clientX - press.start.x, e.clientY - press.start.y) > 8) cancel();
    });
    for (const t of ["pointerup", "pointercancel", "scroll"]) root.addEventListener(t, cancel, true);
    // the click / mousedown that follows a long-press must not start editing
    for (const t of ["mousedown", "click"]) {
      root.addEventListener(t, (e) => {
        if (Date.now() < swallow) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    }
  }
  redraw();
  return { el: root, root, redraw, focusBlock, container, inst };
}
