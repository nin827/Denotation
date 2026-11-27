# 004: Deletes don't reach other devices through a synced folder

Status: resolved
Raised: 2026-11-27

With "Connect folder", a record deleted on device A is written back by device B (which still has it) on B's next
merge. Delete markers (tombstones) are kept only in the browser cache.

Options:
1. **Recommended:** write tombstones to the folder (`tombstones/<id>.json` with `deletedAt`), honour them on merge,
   prune after ~90 days. Same mechanism later serves Drive/OneDrive sync.
2. Leave as is and document it.

## Resolution

Resolved 2026-11-27 with option 1: tombstones are written to `tombstones/<id>.json` (`{ id, collection, deletedAt }`),
honoured by merge, pull and push (`js/sync.js`), pruned after 90 days. The MCP server writes them too; the legacy
`rows/.deleted.json` is still read.
