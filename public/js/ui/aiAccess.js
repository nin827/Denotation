// AI access settings UI (owned by the AI-connection work). Contract used by the sidebar:
//   openAiAccess(env)            -> opens the workspace-wide (broad) permissions dialog
//   openPageAiAccess(env, page)  -> opens the granular permissions dialog for one repo/page/database
// `env` is the same object the sidebar menus already receive from app.js.
import { toast } from "./dialogs.js";

export function openAiAccess(env) {
  toast("AI access is coming soon.");
}

export function openPageAiAccess(env, page) {
  toast("AI access is coming soon.");
}
