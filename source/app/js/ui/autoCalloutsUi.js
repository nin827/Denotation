// Automatic callouts: the generated callouts at the top of a page, and the rules editor. Rules: ../autoCallouts.js.
import { h } from "./dom.js";
import { ico, iconNode } from "../icons/index.js";
import { openModal } from "./modal.js";
import { OPS, needsValue, cleanRules, newRule, matchingCallouts } from "../autoCallouts.js";
import { CALLOUT_PRESETS } from "../blocks/callout-presets.js";
import { presetById } from "../blocks/callout.js";

/** Classes and inline hue variables for a callout look (same CSS as block colours). */
export function lookStyle(look) {
  const cls = `${look.color !== null && look.color !== undefined ? " has-color" : ""}${look.bg !== null && look.bg !== undefined ? " has-bg" : ""}${look.bg === "grey" ? " bg-grey" : ""}`;
  const style = [typeof look.color === "number" ? `--blk-h:${look.color}` : "", typeof look.bg === "number" ? `--blk-bg-h:${look.bg}` : ""].filter(Boolean).join(";");
  return { cls, style: style || null };
}

/**
 * The automatic callouts box. `chain` = rule holders nearest first; `props()` = current property map.
 * `onPin(rule)` turns one into a block (null when the page is read-only). Call `.refresh()` after property changes.
 */
export function autoCalloutsBox({ chain, props, onPin = null, skip = () => new Set() }) {
  const box = h("div", { class: "auto-callouts", "aria-live": "polite" });
  const refresh = () => {
    const pinned = skip();
    const hits = matchingCallouts(chain(), props()).filter(({ rule }) => !pinned.has(rule.id));
    box.hidden = !hits.length;
    box.replaceChildren(...hits.map(({ rule }) => {
      const preset = presetById(rule.preset) ?? CALLOUT_PRESETS[0];
      const look = { color: preset.color, bg: preset.bg };
      const { cls, style } = lookStyle(look);
      return h("div", { class: `auto-callout t-callout${cls}`, style, "data-rule": rule.id, role: "note", "aria-label": `Automatic callout: ${preset.label}` },
        h("span", { class: "callout-icon ac-icon", "aria-hidden": "true" }, iconNode(preset.icon, "icon:info")),
        h("div", { class: "ac-body" },
          h("div", { class: "ac-text rendered" }, rule.text || preset.label),
          h("div", { class: "ac-meta" },
            h("span", { class: "ac-badge" }, ico("wand-sparkles"), " automatic"),
            onPin ? h("button", { type: "button", class: "ac-pin", title: "Turn this into a normal callout block", onClick: () => onPin(rule) }, ico("pin"), " Pin as block") : null)));
    }));
  };
  box.refresh = refresh;
  refresh();
  return box;
}

/**
 * Rules editor. `rules` is the current list; `onSave(list)` stores the cleaned list. `propNames` feed suggestions.
 * `where` explains what the rules apply to.
 */
export function openRulesEditor({ rules = [], onSave, propNames = [], where = "" }) {
  let list = cleanRules(rules).map((r) => ({ ...r, when: { ...r.when } }));
  const dl = `ac-props-${Math.random().toString(36).slice(2, 8)}`;
  const datalist = h("datalist", { id: dl }, [...new Set(propNames)].map((n) => h("option", { value: n })));
  const body = h("div", { class: "rules-list" });
  const draw = () => {
    body.replaceChildren(...(list.length ? list.map((r, i) => {
      const value = h("input", { type: "text", class: "r-value", value: r.when.value, placeholder: "Value (or today)", "aria-label": `Rule ${i + 1} value`, onInput: (e) => (r.when.value = e.target.value) });
      value.hidden = !needsValue(r.when.op);
      const op = h("select", { class: "r-op", "aria-label": `Rule ${i + 1} condition`, onChange: (e) => {
        r.when.op = e.target.value;
        value.hidden = !needsValue(r.when.op);
      } }, OPS.map((o) => h("option", { value: o.id }, o.label)));
      op.value = r.when.op;
      const preset = h("select", { class: "r-preset", "aria-label": `Rule ${i + 1} callout style`, onChange: (e) => (r.preset = e.target.value) }, CALLOUT_PRESETS.map((p) => h("option", { value: p.id }, p.label)));
      preset.value = presetById(r.preset) ? r.preset : CALLOUT_PRESETS[0].id;
      return h("fieldset", { class: "rule" },
        h("legend", {}, `Rule ${i + 1}`),
        h("div", { class: "rule-when" },
          h("span", { class: "rule-word" }, "When"),
          h("input", { type: "text", class: "r-prop", list: dl, value: r.when.prop, placeholder: "Property", "aria-label": `Rule ${i + 1} property`, onInput: (e) => (r.when.prop = e.target.value) }),
          op, value),
        h("div", { class: "rule-then" },
          h("span", { class: "rule-word" }, "show"),
          preset,
          h("input", { type: "text", class: "r-text", value: r.text, placeholder: "Callout text", "aria-label": `Rule ${i + 1} callout text`, onInput: (e) => (r.text = e.target.value) })),
        h("div", { class: "rule-tools" },
          h("button", { type: "button", class: "icon", title: "Move up", "aria-label": `Move rule ${i + 1} up`, disabled: i === 0, onClick: () => {
            [list[i - 1], list[i]] = [list[i], list[i - 1]];
            draw();
          } }, ico("arrow-up")),
          h("button", { type: "button", class: "icon", title: "Move down", "aria-label": `Move rule ${i + 1} down`, disabled: i === list.length - 1, onClick: () => {
            [list[i + 1], list[i]] = [list[i], list[i + 1]];
            draw();
          } }, ico("arrow-down")),
          h("button", { type: "button", class: "icon danger r-del", title: "Remove rule", "aria-label": `Remove rule ${i + 1}`, onClick: () => {
            list.splice(i, 1);
            draw();
          } }, ico("trash"))));
    }) : [h("p", { class: "hint" }, "No rules yet.")]));
  };
  draw();
  const add = h("button", { type: "button", class: "r-add", onClick: () => {
    list.push(newRule(propNames[0] ?? "", "is", "", "info", ""));
    draw();
    body.querySelector(".rule:last-child .r-prop")?.focus();
  } }, ico("plus"), " Add rule");
  openModal({
    title: "Automatic callouts",
    content: h("div", { class: "rules-dialog" },
      h("p", { class: "hint" }, `A callout shows at the top of the page while its rule matches. ${where}`.trim()),
      datalist, body, add),
    actions: [{ label: "Cancel" }, { label: "Save", class: "primary r-save", run: () => onSave(cleanRules(list.filter((r) => r.when.prop.trim()))) }]
  });
}
