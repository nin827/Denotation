import { ico } from "../icons/index.js";
import { toast, confirmDialog } from "./dialogs.js";
import { bindContextMenu } from "./contextMenu.js";
import { duplicatePatch, rowLink } from "../dbMenuLogic.js";

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(`Could not copy automatically. The link is: ${text}`, "error");
  }
}
/** Context-menu items for one row (shared by every layout). `a` is the db view api. */
export function rowMenuItems(a, row) {
  const locked = !!a.locked;
  return [
    { label: "Open", icon: ico("arrow-up-right"), onSelect: () => a.onOpenRow?.(row.id) },
    { label: "Duplicate", icon: ico("copy"), disabled: locked, onSelect: async () => {
      const { values, blocks } = duplicatePatch(row);
      const made = await a.addRow(values);
      if (blocks) {
        made.blocks = blocks;
        await a.saveRow(made);
      }
      a.redraw();
    } },
    { label: "Copy link", icon: ico("link"), onSelect: () => copyText(rowLink(row), "Link copied.") },
    { separator: true },
    { label: "Delete row", icon: ico("trash"), danger: true, disabled: locked, onSelect: async () => {
      if (!await confirmDialog(`Delete "${a.title(row)}"? This cannot be undone.`, { title: "Delete row" })) return;
      await a.removeRow(row);
      a.redraw();
    } }
  ];
}
export const bindRowMenu = (el, a, row) => bindContextMenu(el, () => rowMenuItems(a, row));
