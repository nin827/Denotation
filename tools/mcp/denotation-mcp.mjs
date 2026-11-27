#!/usr/bin/env node
// Denotation MCP server: lets AI assistants (Claude Code and other MCP clients) read and edit a
// Denotation workspace stored in a connected local folder, within the permissions set in the app.
// Model Context Protocol, JSON-RPC 2.0, newline-delimited over stdio. Node built-ins only.
//
//   node tools/mcp/denotation-mcp.mjs --folder <workspace folder> [--read-only] [--permissions <file>]
//
// stdout carries protocol messages only; logs go to stderr.
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FolderStore } from "./folder-store.mjs";
import { listTools, callTool } from "./tools.mjs";

export const SERVER_INFO = { name: "denotation", title: "Denotation", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LINE_MAX = 8 * 1024 * 1024;
const INSTRUCTIONS = "Denotation is a personal notes workspace (repositories > pages, databases with rows). " +
  "Start with list_pages or search. What you can read, create, edit and delete is set by the owner in the app " +
  "(AI access); a 'permission denied' result means the owner has not allowed that action, so do not retry it. " +
  "Changes appear in the app on its next folder sync (it also syncs when its window regains focus).";

const log = (...a) => process.stderr.write(`[denotation-mcp] ${a.join(" ")}\n`);

function parseArgs(argv) {
  const opts = { folder: process.env.DENOTATION_FOLDER || null, readOnly: false, permissions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder") opts.folder = argv[++i];
    else if (a.startsWith("--folder=")) opts.folder = a.slice(9);
    else if (a === "--read-only") opts.readOnly = true;
    else if (a === "--permissions") opts.permissions = argv[++i];
    else if (a.startsWith("--permissions=")) opts.permissions = a.slice(14);
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

export function createServer(store) {
  let initialized = false;
  const result = (id, r) => ({ jsonrpc: "2.0", id, result: r });
  const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  /** Handle one parsed message; returns a response object or null (notifications). */
  async function handle(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return error(msg?.id ?? null, -32600, "Invalid request");
    }
    const { id, method, params } = msg;
    const isNote = id === undefined;
    if (isNote) {
      if (method === "notifications/initialized") initialized = true;
      return null; // notifications/cancelled and others: nothing to do (calls are short)
    }
    if (typeof id !== "string" && typeof id !== "number") return error(null, -32600, "Invalid request id");
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return result(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: listTools(store) });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") return error(id, -32602, "Missing tool name");
        if (store.readOnly && !listTools(store).some((t) => t.name === name)) return error(id, -32602, `Tool not available in read-only mode: ${name}`);
        const r = await callTool(store, name, params?.arguments);
        return r ? result(id, r) : error(id, -32602, `Unknown tool: ${name}`);
      }
      default:
        return error(id, -32601, `Method not found: ${method}`);
    }
  }
  return { handle, get initialized() { return initialized; } };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    log(e.message);
    process.exit(2);
  }
  if (opts.help || !opts.folder) {
    process.stderr.write("Usage: node tools/mcp/denotation-mcp.mjs --folder <workspace folder> [--read-only] [--permissions <file>]\n");
    process.exit(opts.help ? 0 : 2);
  }
  const store = new FolderStore(opts.folder, { readOnly: opts.readOnly, permissionsPath: opts.permissions });
  try {
    await store.init();
  } catch (e) {
    log(e.message);
    process.exit(1);
  }
  log(`serving ${store.root}${store.readOnly ? " (read-only)" : ""}`);
  const server = createServer(store);
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  // Handle messages one at a time, in order, so writes never race each other.
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      if (!line.trim()) return;
      if (line.length > LINE_MAX) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } });
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      try {
        const res = await server.handle(msg);
        if (res) send(res);
      } catch (e) {
        log("internal error:", e?.stack ?? e);
        if (msg && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      }
    });
  });
  rl.on("close", () => queue.then(() => process.exit(0)));
}

const isMain = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) main();
