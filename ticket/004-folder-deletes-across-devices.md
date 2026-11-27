# 004: Deletes don't reach other devices through a synced folder

Status: open
Raised: 2026-11-27

With "Connect folder", a record deleted on device A is written back by device B (which still has it) on B's next
merge. Delete markers (tombstones) are kept only in the browser cache.

Options:
1. **Recommended:** write tombstones to the folder (`tombstones/<id>.json` with `deletedAt`), honour them on merge,
   prune after ~90 days. Same mechanism later serves Drive/OneDrive sync.
2. Leave as is and document it.
