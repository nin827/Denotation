# 003: What does "ignore" mean in AI access permissions?

Status: resolved
Raised: 2026-11-27

AI access has broad (workspace) and granular (repository/page/database) permissions per action (read, create, edit,
delete), each set to ✗ no, ✓ yes or – ignore. Granular overrides broad when it is set.

Default in use: **ignore = not set, inherit from the nearest ancestor, then broad. Ignore at broad level = no.**

Options:
1. **Recommended (current default):** ignore = inherit; broad ignore = no.
2. Ignore = hidden: the AI can't even see that the page exists (no title in listings), stronger than ✗ no, which still
   shows the title but blocks the action.
3. Broad ignore = ask each time (needs a live approval prompt in the app, so the app must be open).

## Owner decision
Option 1 (already implemented): ignore = inherit from the nearest ancestor, then broad; broad ignore = no.
