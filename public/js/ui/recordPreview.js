// Record preview block: previews database rows looked up by primary key. See preview.js for the logic.
import { h } from "./dom.js";
import { CLOSE_EVENT } from "./popover.js";
import { ico } from "../icons/index.js";
import { confirmDialog, toast } from "./dialogs.js";
import { formulaCell } from "./cellEditors.js";
import { summarize } from "../schema.js";
import { columnDisplay, sectionColumns, headerRows, OBFUSCATED } from "../columns.js";
import { cellText, jsonIssues, watchMarquee } from "./cellEditors.js";
import { toText } from "../dbviews.js";
import { sourceList, sourceLabel, isTableSourceId, findTableSource } from "../sources.js";
import {
  cleanKeys, splitKeys, primaryKeyCol, rowKey, matchKeys, resolveConfig, columnSelection, toggleColumn, moveColumn,
  patchColumn, alignOf, layoutOf, labelOf, newPreset, cleanPresets, presetNameTaken, countPresetUsers,
  WIDTH_MIN, WIDTH_MAX
} from "../preview.js";

const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
let uid = 0;

/** Read-only value, formatted like the database table cells, following the column's display (ticket 012). */
function valueNode(col, value, rowId = "") {
  if (!col) return h("span", {});
  const mode = columnDisplay(col);
  if (mode === "hide") return h("span", { class: "rp-hidden", title: "Hidden: open the record to see it" });
  if (mode === "obfuscate") return h("span", { class: "rp-obf", title: "Hidden: open the record to see it" }, cellText(col, value) ? OBFUSCATED : "");
  if (mode === "marquee") return watchMarquee(h("span", { class: "rp-mq" }, h("span", { class: "mq-text" }, cellText(col, value))));
  if (col.type === "json") {
    const bad = jsonIssues(col, value).length;
    return h("span", { class: `rp-struct${bad ? " invalid" : ""}`, title: bad ? "Does not match the type" : null }, bad ? h("span", { class: "je-bad" }, ico("triangle-exclamation-point"), h("span", { class: "sr-only" }, "Does not match the type: ")) : null, summarize(col, value));
  }
  if (col.type === "formula") return formulaCell(col, value, "");
  if (col.type === "checkbox") {
    return value ? h("span", { class: "rp-check" }, ico("check"), " Yes") : h("span", { class: "rp-check off" }, "No");
  }
  if (col.type === "select") return value ? h("span", { class: "rp-tag" }, String(value)) : h("span", {});
  if (col.type === "array" || col.type === "dictionary") return h("span", { class: "rp-struct" }, summarize(col, value));
  return h("span", {}, toText(col, value));
}

export function recordPreviewBody(b, inst, a) {
  const { ctx } = inst;
  const locked = ctx.locked;
  const box = h("div", { class: "rp" });
  const results = h("div", { class: "rp-results" });
  let cur = { data: null, rows: [] };
  let pop = null;
  const lookup = (id) => ctx.livePages().find((p) => p.id === id) ?? null;

  const openRow = async (id) => {
    await ctx.flush?.();
    // a table-block source has no row pages: open the page that holds the table
    location.hash = cur.data?.virtual ? `#page-${cur.data.pageId}` : `#row-${id}`;
  };

  // ----- data -----
  async function load() {
    if (isTableSourceId(b.dbId)) {
      const t = findTableSource(ctx.livePages(), b.dbId);
      return t ? { data: t, rows: t.rows, missing: false } : { data: null, rows: [], missing: true };
    }
    const src = b.dbId ? lookup(b.dbId) : null;
    const data = src?.sourceId ? lookup(src.sourceId) : src;
    if (!data || data.type !== "database") return { data: null, rows: [], missing: !!b.dbId };
    return { data, rows: await ctx.ws.listRows(data.id), missing: false };
  }
  const saveDb = async (data) => {
    data.previewPresets = cleanPresets(data.previewPresets, data.columns);
    if (!data.previewPresets.length) delete data.previewPresets;
    await ctx.ws.savePage(data);
  };
  const savePrimaryKey = async (data, id) => {
    if (id && id !== data.columns[0]?.id) data.primaryKey = id;
    else delete data.primaryKey;
    await ctx.ws.savePage(data);
  };

  // ----- results -----
  async function render() {
    cur = await load();
    const { data, rows, missing } = cur;
    drawHead();
    if (!b.dbId || missing) {
      const msg = missing ? "Database not found" : "Choose a database to preview records.";
      results.replaceChildren(h(
        "div",
        { class: `rp-empty${missing ? " gone" : ""}` },
        missing ? ico("info") : null,
        missing ? " " : null,
        msg,
        locked ? null : h("button", { class: "rp-link", onClick: () => openSettings() }, missing ? "Choose another" : "Choose database…")
      ));
      return;
    }
    const res = resolveConfig(b, data);
    if (!locked) {
      let dirty = false;
      if (res.orphan) {
        b.config = clone(res.config);
        b.presetId = null;
        b.snapshot = null;
        dirty = true;
      } else if (res.source === "preset" && JSON.stringify(b.snapshot) !== JSON.stringify(res.config)) {
        b.snapshot = clone(res.config);
        dirty = true;
      }
      if (dirty) a.save();
    }
    const keyCol = primaryKeyCol(data);
    const keys = cleanKeys(b.keys);
    if (!keys.length) {
      results.replaceChildren(h("div", { class: "rp-empty" }, `Add one or more keys to look up rows by ${keyCol?.name || "primary key"}.`));
      return;
    }
    const sel = columnSelection(res.config, data.columns).filter((s) => s.shown && s.col);
    const matches = matchKeys(data, rows, keys);
    const layout = layoutOf(res.config, keys.length);
    const dupBadge = (m) => m.duplicate ? h("span", { class: "rp-dup", title: `${m.rows.length} rows share this key` }, ico("copy"), " duplicate key") : null;
    const miss = (m) => h("div", { class: "rp-miss" }, ico("search"), " ", `No row with key ${m.key}`);
    const openBtn = (r, key) => h("button", {
      class: "icon rp-open",
      "aria-label": `Open record ${key}`,
      title: "Open as page",
      onClick: (e) => {
        e.stopPropagation();
        openRow(r.id);
      }
    }, ico("external-link"));
    const rowOpen = (r) => ({
      onClick: (e) => {
        if (e.target.closest("button,a,input,select")) return;
        openRow(r.id);
      }
    });
    // card rows under their column-group headings (ticket 011), in the preview's own column order
    const cardRows = (list, row) => {
      const groups = data.columnGroups || [];
      if (!groups.length) return list.map(row);
      const byCol = new Map(list.map((s) => [s.col.id, s]));
      const secs = sectionColumns(list.map((s) => s.col), groups);
      return secs.flatMap((sec) => [
        sec.group ? h("div", { class: "rp-group-head", role: "presentation" }, sec.group.label, sec.sub ? ` \u203a ${sec.sub.label}` : "") : null,
        ...sec.cols.map((c) => row(byCol.get(c.id)))
      ]).filter(Boolean);
    };
    const nodes = [];
    if (layout === "card") {
      for (const m of matches) {
        if (m.missing) {
          nodes.push(miss(m));
          continue;
        }
        for (const r of m.rows) {
          nodes.push(h(
            "article",
            { class: "rp-card", ...rowOpen(r) },
            h("div", { class: "rp-card-top" }, dupBadge(m), openBtn(r, m.key)),
            h("dl", { class: "rp-dl" }, cardRows(sel, (s) => {
              const al = alignOf(s, s.col);
              const wrap = s.wrap || columnDisplay(s.col) === "wrap";
              return h(
                "div",
                { class: "rp-dl-row" },
                h("dt", {}, labelOf(s, s.col)),
                h("dd", { class: `${al === "right" ? "r" : ""}${wrap ? "" : " nowrap"}`, style: s.width ? `max-width:${s.width}px` : null }, valueNode(s.col, r.values?.[s.col.id]))
              );
            }))
          ));
        }
      }
    } else {
      const found = matches.filter((m) => !m.missing);
      if (found.length) {
        nodes.push(h("div", { class: "rp-wrap" }, h(
          "table",
          { class: "rp-table" },
          h("thead", {}, headerRows(sel.map((s) => s.col), data.columnGroups || []).map((cells) => h("tr", { class: "rp-grp-row" }, cells.map((c) => h("th", { colspan: c.span, scope: c.group ? "colgroup" : null, class: c.group ? "rp-grp" : "rp-grp empty" }, c.group?.label ?? "")), h("th", { class: "rp-act" }))), h("tr", {}, sel.map((s) => h("th", { class: alignOf(s, s.col) === "right" ? "r" : "", style: s.width ? `width:${s.width}px;min-width:${s.width}px;max-width:${s.width}px` : null }, labelOf(s, s.col))), h("th", { class: "rp-act" }, h("span", { class: "sr-only" }, "Actions")))),
          h("tbody", {}, found.flatMap((m) => m.rows.map((r) => h(
            "tr",
            { class: "rp-row", ...rowOpen(r) },
            sel.map((s) => h(
              "td",
              {
                class: `${alignOf(s, s.col) === "right" ? "r" : ""}${s.wrap || columnDisplay(s.col) === "wrap" ? " wrap" : " nowrap"}`,
                style: s.width ? `width:${s.width}px;min-width:${s.width}px;max-width:${s.width}px` : null
              },
              valueNode(s.col, r.values?.[s.col.id])
            )),
            h("td", { class: "rp-act" }, dupBadge(m), openBtn(r, m.key))
          ))))
        )));
      }
      for (const m of matches) if (m.missing) nodes.push(miss(m));
    }
    results.replaceChildren(...nodes);
  }

  // ----- keys (chips input) -----
  const head = h("div", { class: "rp-head" });
  const listId = `rp-keys-${++uid}`;
  function drawHead() {
    const keyCol = cur.data ? primaryKeyCol(cur.data) : null;
    const setKeys = (keys) => {
      b.keys = cleanKeys(keys);
      a.save();
      render().catch(() => {});
    };
    const input = h("input", {
      type: "text",
      class: "rp-key-input",
      placeholder: b.keys.length ? "Add key…" : keyCol ? `Key (${keyCol.name})…` : "Key…",
      "aria-label": "Add a key",
      list: listId,
      autocomplete: "off",
      disabled: locked || !cur.data,
      onKeydown: (e) => {
        if ((e.key === "Enter" || e.key === ",") && !e.isComposing) {
          e.preventDefault();
          add();
        } else if (e.key === "Backspace" && !input.value && b.keys.length) setKeys(b.keys.slice(0, -1));
      },
      onBlur: () => add(),
      onPaste: (e) => {
        const t = e.clipboardData?.getData("text/plain") ?? "";
        if (!/[,;\n\t]/.test(t)) return;
        e.preventDefault();
        input.value = "";
        setKeys([...b.keys, ...splitKeys(t)]);
      }
    });
    function add() {
      const parts = splitKeys(input.value);
      input.value = "";
      if (parts.length) {
        setKeys([...b.keys, ...parts]);
        requestAnimationFrame(() => head.querySelector(".rp-key-input")?.focus());
      }
    }
    const suggest = cur.data && !locked ? h("datalist", { id: listId }, [...new Set(cur.rows.map((r) => rowKey(cur.data, r)).filter(Boolean))].slice(0, 200).map((v) => h("option", { value: v }))) : null;
    const chips = h(
      "div",
      { class: "rp-keys", onClick: (e) => {
        if (e.target === e.currentTarget) input.focus();
      } },
      b.keys.map((k) => h(
        "span",
        { class: "rp-chip" },
        k,
        locked ? null : h("button", { class: "icon", "aria-label": `Remove key ${k}`, title: "Remove key", onClick: () => setKeys(b.keys.filter((x) => x !== k)) }, ico("x"))
      )),
      locked ? null : input,
      suggest
    );
    const gear = locked ? null : h("button", {
      class: "icon rp-gear",
      "aria-label": "Record preview settings",
      "aria-haspopup": "dialog",
      "aria-expanded": pop ? "true" : "false",
      title: "Settings",
      onClick: () => pop ? closePop() : openSettings()
    }, ico("settings"));
    head.replaceChildren(...[chips, gear].filter(Boolean));
  }

  // ----- settings popover -----
  const state = { editPreset: false, naming: null, nameError: "" };
  function closePop() {
    pop?.close();
  }
  function openSettings() {
    if (pop || locked) return;
    const panel = h("div", { class: "rp-pop", role: "dialog", "aria-label": "Record preview settings" });
    state.editPreset = false;
    state.naming = null;
    state.nameError = "";
    const place = () => {
      const r = (head.querySelector(".rp-gear") ?? box).getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const w = Math.min(360, vw - 16);
      const left = Math.max(8, Math.min(r.right - w, vw - w - 8));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      panel.style.maxHeight = "none";
      const hgt = panel.scrollHeight + 2;
      const useBelow = hgt <= below || (hgt > above && below >= above);
      const room = Math.max(160, useBelow ? below : above);
      const top = useBelow ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(hgt, room));
      panel.style.maxHeight = `${room}px`;
      panel.style.setProperty("--rp-left", `${left}px`);
      panel.style.setProperty("--rp-top", `${top}px`);
      panel.style.setProperty("--rp-w", `${w}px`);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".modal-overlay")) {
        e.preventDefault();
        e.stopPropagation();
        closePop();
      }
    };
    const onDown = (e) => {
      if (panel.contains(e.target) || e.target.closest?.(".modal-overlay") || head.querySelector(".rp-gear")?.contains(e.target)) return;
      pop?.close(false);
    };
    const onRouteChange = () => pop?.close(false);
    const close = (refocus = true) => {
      if (!pop) return;
      pop = null;
      document.removeEventListener(CLOSE_EVENT, onRouteChange);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      panel.remove();
      drawHead();
      if (refocus === true) head.querySelector(".rp-gear")?.focus();
    };
    pop = { close, redraw: () => draw() };
    document.body.append(panel);
    document.addEventListener(CLOSE_EVENT, onRouteChange);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);

    function draw() {
      const fid = document.activeElement?.dataset?.fid;
      const scroll = panel.scrollTop;
      const { data } = cur;
      const sections = [h(
        "div",
        { class: "rp-pop-head" },
        h("strong", {}, "Record preview"),
        h("button", { class: "icon", "aria-label": "Close settings", onClick: closePop }, ico("x"))
      )];
      sections.push(sourceSection());
      if (data?.virtual) sections.push(h("p", { class: "rp-note" }, ico("info"), " Read-only table. Its key column is set in the table's data source settings."), displaySection(data));
      else if (data) sections.push(keySection(data), presetSection(data), displaySection(data));
      panel.replaceChildren(...sections);
      panel.scrollTop = scroll;
      if (fid) panel.querySelector(`[data-fid="${fid}"]`)?.focus();
      place();
    }
    const sourceSection = () => {
      const dbs = sourceList(ctx.livePages(), { linked: true }); // data sources first
      return field("Database", h(
        "select",
        { "data-fid": "db", onChange: async (e) => {
          Object.assign(b, { dbId: e.target.value || null, presetId: null, config: null, snapshot: null });
          a.save();
          await render();
          draw();
        } },
        h("option", { value: "" }, "Choose…"),
        dbs.map((p) => h("option", { value: p.id, selected: p.id === b.dbId }, sourceLabel(p)))
      ));
    };
    const keySection = (data) => {
      const col = primaryKeyCol(data);
      return h(
        "div",
        { class: "rp-sec" },
        field("Primary key column", h(
          "select",
          { "data-fid": "pk", onChange: async (e) => {
            await savePrimaryKey(data, e.target.value);
            await render();
            draw();
          } },
          data.columns.map((c) => h("option", { value: c.id, selected: c.id === col?.id }, c.name))
        )),
        h("p", { class: "rp-note" }, ico("info"), " This changes the primary key of the database itself, everywhere it is used.")
      );
    };
    const presetOf = (data) => resolveConfig(b, data);
    const applyCfg = async (data, cfg) => {
      const res = presetOf(data);
      if (res.source === "preset") {
        Object.assign(res.preset, { layout: cfg.layout, columns: cfg.columns });
        b.snapshot = clone(cfg);
        a.save();
        await saveDb(data);
      } else {
        b.config = clone(cfg);
        a.save();
      }
      await render();
      draw();
    };
    const displaySection = (data) => {
      const res = presetOf(data);
      const usingPreset = res.source === "preset";
      const editable = !usingPreset || state.editPreset;
      const cfg = res.config;
      const keys = cleanKeys(b.keys);
      const effective = layoutOf(cfg, keys.length);
      const seg = (id, label) => h("button", {
        type: "button",
        class: `rp-seg${(cfg.layout ?? "auto") === id ? " on" : ""}`,
        "aria-pressed": (cfg.layout ?? "auto") === id ? "true" : "false",
        disabled: !editable,
        onClick: () => applyCfg(data, { ...cfg, layout: id === "auto" ? null : id })
      }, (cfg.layout ?? "auto") === id ? ico("check") : null, label);
      const sel = columnSelection(cfg, data.columns);
      const lastShown = sel.filter((s) => s.shown).length;
      const colRow = (s, i) => {
        const id = s.col.id;
        const top = h(
          "div",
          { class: "rp-col-top" },
          h("label", { class: "rp-check-label" }, h("input", {
            type: "checkbox",
            "data-fid": `show-${id}`,
            checked: s.shown,
            disabled: !editable || s.shown && lastShown === 1,
            onChange: (e) => applyCfg(data, toggleColumn(cfg, id, e.target.checked))
          }), s.col.name),
          s.shown ? h(
            "span",
            { class: "rp-moves" },
            h("button", { class: "icon", "aria-label": `Move ${s.col.name} up`, title: "Move up", disabled: !editable || i === 0, "data-fid": `up-${id}`, onClick: () => applyCfg(data, moveColumn(cfg, id, -1)) }, ico("arrow-up")),
            h("button", { class: "icon", "aria-label": `Move ${s.col.name} down`, title: "Move down", disabled: !editable || i === lastShown - 1, "data-fid": `down-${id}`, onClick: () => applyCfg(data, moveColumn(cfg, id, 1)) }, ico("arrow-down"))
          ) : null
        );
        if (!s.shown) return h("div", { class: "rp-col" }, top);
        const patch = (p) => applyCfg(data, patchColumn(cfg, id, p));
        return h(
          "div",
          { class: "rp-col" },
          top,
          h(
            "div",
            { class: "rp-col-opts" },
            h("label", {}, "Width", h("input", {
              type: "number",
              min: WIDTH_MIN,
              max: WIDTH_MAX,
              step: 10,
              placeholder: "auto",
              "aria-label": `${s.col.name} width in pixels, empty for auto`,
              "data-fid": `w-${id}`,
              value: s.width ?? "",
              disabled: !editable,
              onChange: (e) => patch({ width: e.target.value === "" ? null : Number(e.target.value) })
            }), h("span", { class: "rp-unit" }, "px")),
            h("label", { class: "rp-check-label" }, h("input", { type: "checkbox", "data-fid": `wrap-${id}`, checked: s.wrap, disabled: !editable, onChange: (e) => patch({ wrap: e.target.checked }) }), "Wrap"),
            h(
              "label",
              {},
              "Align",
              h(
                "select",
                { "data-fid": `al-${id}`, disabled: !editable, onChange: (e) => patch({ align: e.target.value || null }) },
                h("option", { value: "", selected: !s.align }, s.col.type === "number" ? "Auto: right" : "Auto: left"),
                h("option", { value: "left", selected: s.align === "left" }, "Left"),
                h("option", { value: "right", selected: s.align === "right" }, "Right")
              )
            ),
            h("label", { class: "rp-label" }, "Label", h("input", {
              type: "text",
              maxlength: 60,
              placeholder: s.col.name,
              "data-fid": `lb-${id}`,
              value: s.label,
              disabled: !editable,
              onChange: (e) => patch({ label: e.target.value })
            }))
          )
        );
      };
      let shownIndex = -1;
      return h(
        "div",
        { class: "rp-sec" },
        h("div", { class: "rp-sec-title" }, "Display"),
        usingPreset && !editable ? h("p", { class: "rp-note" }, ico("info"), ` Using preset “${res.preset.name}”. Choose Edit preset to change it, or Detach to customise only this block.`) : null,
        h("div", { class: "rp-segs", role: "group", "aria-label": "Layout" }, seg("auto", `Auto (${effective})`), seg("table", "Table"), seg("card", "Card")),
        h("div", { class: "rp-cols" }, sel.map((s) => colRow(s, s.shown ? ++shownIndex : -1)))
      );
    };
    const nameForm = (data, { initial, onSave, label }) => {
      const presets = data.previewPresets ?? [];
      const input = h("input", { type: "text", maxlength: 80, value: initial, "aria-label": "Preset name", placeholder: "Preset name", "data-fid": "preset-name" });
      const go = async () => {
        const name = input.value.trim();
        if (!name) {
          state.nameError = "Enter a name.";
          return draw();
        }
        if (presetNameTaken(presets, name, state.naming?.id ?? null)) {
          state.nameError = "A preset with that name already exists.";
          return draw();
        }
        state.naming = null;
        state.nameError = "";
        await onSave(name);
        draw();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          go();
        }
      });
      queueMicrotask(() => input.focus());
      return h(
        "div",
        { class: "rp-name-form" },
        input,
        h("button", { class: "primary", onClick: go }, label),
        h("button", { onClick: () => {
          state.naming = null;
          state.nameError = "";
          draw();
        } }, "Cancel"),
        state.nameError ? h("div", { class: "rp-error", role: "alert" }, ico("info"), " ", state.nameError) : null
      );
    };
    const presetSection = (data) => {
      const res = presetOf(data);
      const presets = data.previewPresets ?? [];
      const usingPreset = res.source === "preset";
      const pick = (e) => {
        const p = presets.find((x) => x.id === e.target.value);
        if (p) Object.assign(b, { presetId: p.id, snapshot: clone(resolveConfig({ presetId: p.id }, data).config), config: null });
        else Object.assign(b, { presetId: null, config: clone(res.config), snapshot: null });
        state.editPreset = false;
        a.save();
        render().then(draw);
      };
      const select = presets.length ? field("Use preset", h(
        "select",
        { "data-fid": "preset", onChange: pick },
        h("option", { value: "" }, usingPreset ? "None (own settings)" : "Choose…"),
        presets.map((p) => h("option", { value: p.id, selected: usingPreset && p.id === res.preset.id }, p.name))
      )) : h("p", { class: "rp-note" }, "No presets for this database yet. Save this display as one to reuse it on other blocks.");
      const out = [h("div", { class: "rp-sec-title" }, "Presets"), select];
      if (state.naming?.kind === "save") {
        out.push(nameForm(data, {
          initial: "",
          label: "Save",
          onSave: async (name) => {
            const p = newPreset(name, res.config, data.columns);
            data.previewPresets = [...presets, p];
            Object.assign(b, { presetId: p.id, snapshot: clone(res.config), config: null });
            a.save();
            await saveDb(data);
            await render();
          }
        }));
      } else if (state.naming?.kind === "rename" && usingPreset) {
        state.naming.id = res.preset.id;
        out.push(nameForm(data, {
          initial: res.preset.name,
          label: "Rename",
          onSave: async (name) => {
            res.preset.name = name;
            await saveDb(data);
            await render();
          }
        }));
      } else if (!usingPreset) {
        out.push(h("div", { class: "rp-btns" }, h("button", { onClick: () => {
          state.naming = { kind: "save" };
          state.nameError = "";
          draw();
        } }, ico("plus"), "Save as preset…")));
      } else {
        const n = countPresetUsers(ctx.livePages().map((p) => p.blocks), res.preset.id);
        out.push(h(
          "div",
          { class: "rp-btns" },
          h("button", { "aria-pressed": state.editPreset ? "true" : "false", class: state.editPreset ? "on" : "", onClick: () => {
            state.editPreset = !state.editPreset;
            draw();
          } }, ico(state.editPreset ? "check" : "pencil"), state.editPreset ? "Done editing" : "Edit preset"),
          h("button", { onClick: () => applyDetach(data, res) }, ico("unlink"), "Detach (copy to this block)"),
          h("button", { onClick: () => {
            state.naming = { kind: "rename", id: res.preset.id };
            state.nameError = "";
            draw();
          } }, "Rename…"),
          h("button", { class: "danger", onClick: () => deletePreset(data, res) }, ico("trash"), "Delete preset")
        ));
        if (state.editPreset) out.push(h("p", { class: "rp-note strong" }, ico("info"), ` Changes apply to ${n} block${n === 1 ? "" : "s"} on pages, and to any other block using this preset.`));
      }
      return h("div", { class: "rp-sec" }, out);
    };
    const applyDetach = async (data, res) => {
      Object.assign(b, { config: clone(res.config), presetId: null, snapshot: null });
      state.editPreset = false;
      a.save();
      await render();
      draw();
    };
    const deletePreset = async (data, res) => {
      const ok = await confirmDialog(`Delete the preset “${res.preset.name}”? Blocks using it keep their current display as their own settings.`, { title: "Delete preset", confirmLabel: "Delete" });
      if (!ok) return;
      data.previewPresets = (data.previewPresets ?? []).filter((p) => p.id !== res.preset.id);
      Object.assign(b, { config: clone(res.config), presetId: null, snapshot: null });
      state.editPreset = false;
      a.save();
      await saveDb(data);
      await render();
      draw();
      toast("Preset deleted.");
    };
    draw();
    (panel.querySelector("select, input, button") ?? panel).focus();
  }
  function field(label, control) {
    return h("label", { class: "rp-field" }, h("span", {}, label), control);
  }

  box.append(head, results);
  drawHead();
  let timer = null;
  const stop = ctx.ws.onDataChange?.(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!box.isConnected) return stop?.();
      if (results.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
      render().catch(() => {});
    }, 250);
  });
  render().catch((e) => results.replaceChildren(h("div", { class: "img-fail" }, e.message)));
  return box;
}
