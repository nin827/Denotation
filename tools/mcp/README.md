# Denotation MCP server

Lets AI assistants (Claude Code, Claude Desktop and other [Model Context Protocol](https://modelcontextprotocol.io)
clients) read and edit your Denotation workspace, within the permissions you set in the app.

Denotation has no server, so the assistant talks to a small local program instead: `denotation-mcp.mjs` reads and
writes the **connected folder** (the JSON layout the app keeps there: `denotation.json`, `pages/<id>.json`,
`rows/<id>.json`). It needs only Node.js 18+ and has no dependencies.

## 1. Set it up in the app

1. Connect a folder: sidebar **⋯** menu → **Folder → Connect folder…** (Chrome or Edge on a computer).
2. Open **⋯ → AI access…** and choose what assistants may do: Read, Create, Edit, Delete, each
   **Yes**, **No** or **Ignore**. Right-click a repository, page or database → **AI access…** to override it there.
   Everything is **No** until you change it.

The app saves these settings to `permissions.json` in the folder. The server only reads that file.

## 2. Connect Claude Code

```bash
claude mcp add denotation -- node /path/to/Denotation/tools/mcp/denotation-mcp.mjs --folder /path/to/your/folder
```

Add `-s user` to use it in every project. Check it with `claude mcp list` (should say *Connected*), then ask Claude
something like "list my Denotation pages".

### Other MCP clients

Any client that starts stdio servers works. For example, in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "denotation": {
      "command": "node",
      "args": ["/path/to/Denotation/tools/mcp/denotation-mcp.mjs", "--folder", "/path/to/your/folder"]
    }
  }
}
```

### Options

| Option | |
|---|---|
| `--folder <path>` | The workspace folder (or set `DENOTATION_FOLDER`). Required. |
| `--read-only` | Offer only the read tools (`list_pages`, `read_page`, `search`). Use it for an extracted *Denotation JSON* ZIP export. |
| `--permissions <file>` | Read permissions from this file instead of `<folder>/permissions.json` (e.g. for an export, which has none). |

## Tools

| Tool | Needs | What it does |
|---|---|---|
| `list_pages` | read | Tree of readable repositories, pages and databases (id, title, type, parentId, depth, what else is allowed on each). |
| `read_page` | read | A page as Markdown, a database as columns + rows, or a row's values + body. |
| `search` | read | Titles, page text and row values. |
| `create_page` | create on the parent (workspace for a new repository) | New doc page (Markdown body), database (columns) or repository. |
| `update_page` | edit | New title and/or Markdown body (replaces the body). |
| `delete_page` | delete on the page and everything under it | Moves it to the trash, like the app; restore it from the trash. |
| `add_row` | create on the database | New row with values (by column name or id) and an optional Markdown body. |
| `update_row` | edit on the row | Change values and/or the body. |
| `delete_row` | delete on the row | Deletes the row permanently. |

## Permissions

- Each action is **Yes**, **No** or **Ignore** for the whole workspace (*broad*) and optionally per repository, page
  or database (*granular*).
- For a page, the server walks up from the page through its parents to the repository; the first value that is not
  *Ignore* wins. If none is set, the workspace value applies; workspace *Ignore* means **No**.
- Rows follow their database. Creating checks the parent; adding a row checks the database.
- Pages in the trash are never shown. Titles of pages the assistant can't read are never included in results or errors.
- A blocked action returns an error such as `Denotation: permission denied: edit on "Meeting notes"`.
- `permissions.json` is re-read on every call, so changes in the app apply immediately.

## When changes show up in the app

The server writes the same JSON files the app does (each with a new `updatedAt`). The app picks them up on its next
folder sync: **Sync now** / reconnect, or automatically when the app window regains focus. For each page or row the
newer version wins, so an edit you make in the app after the assistant's edit is kept.

Deleted rows are logged in `rows/.deleted.json` so the app removes its cached copy instead of writing it back.

## Security notes and limits

- The server writes only `pages/<id>.json`, `rows/<id>.json` and `rows/.deleted.json`. It never writes
  `permissions.json`, refuses ids that aren't Denotation ids, and doesn't follow symbolic links.
- **The permissions are only enforced by this server.** An assistant that also has general file access to the folder
  (a shell, a file-system MCP server, Claude Code started inside the folder) can read or change the files directly,
  including `permissions.json`. Expose the folder to assistants only through this server, and don't start them with
  the folder as their working directory.
- The folder may sync through Google Drive or OneDrive; the server only sees what is on disk.
- Embedded images appear in Markdown as `![caption](embedded:<block id>)`; keep that line when rewriting a body and
  the image is kept. The server can't add new embedded images.
- Formula columns are recomputed for the row being written; the app recomputes the rest when the database is opened.
