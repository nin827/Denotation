import { isTrashed } from "../workspace.js";
import { ico } from "../icons/index.js";

const sourceDatabases = (pages) => pages.filter((p) => p.type === "database" && !p.sourceId && !isTrashed(pages, p));
export function newItems({ pages: pages, parentId, onCreate, onImportCsv, repoLevel = true }) {
  const sources = sourceDatabases(pages);
  const ok = !!parentId;
  const from = (label, icon, viewType) => ({
    label,
    icon: ico(icon),
    disabled: !ok || !sources.length,
    items: sources.map((d) => ({ label: d.title || "Untitled", icon: ico("database"), onSelect: () => onCreate("database", parentId, { sourceId: d.id, viewType }) }))
  });
  return [
    { label: "Page", icon: ico("file-text"), disabled: !ok, onSelect: () => onCreate("doc", parentId) },
    ...repoLevel ? [
      { header: true, label: "Original source" },
      { label: "Database", icon: ico("database"), disabled: !ok, onSelect: () => onCreate("database", parentId) },
      { label: "Sheet", icon: ico("sheet"), disabled: !ok, onSelect: () => onCreate("database", parentId, { viewType: "sheet" }) },
      ...onImportCsv ? [{ label: "Database from CSV\u2026", icon: ico("file-spreadsheet"), disabled: !ok, onSelect: () => onImportCsv(parentId) }] : [],
      { header: true, label: "View of an existing source" },
      from("Database view of\u2026", "link-2", "table"),
      from("Sheet view of\u2026", "sheet", "sheet")
    ] : []
  ];
}
