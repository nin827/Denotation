// Accessible fallback for the graph: a keyboard-navigable DOM list of the visible nodes, each with a button that
// opens it and an expandable list of its neighbours. Text is set with textContent only.
// Keys: Up/Down (or Home/End) move between node (and open neighbour) buttons; Right/Left expand/collapse the
// neighbour list; Enter/Space open.

const CHUNK = 200; // node rows rendered at a time ("Show more" adds the next chunk)

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
};
const title = (p) => String(p?.title ?? "").trim() || "Untitled";
const kindLabel = (k) => (k === "row" ? "row" : k === "database" ? "database" : "page");

/**
 * @param {HTMLElement} container
 * @param {{ onOpen?: (i:number)=>void, onFocusNode?: (i:number)=>void }} [opts]
 * @returns {{ setGraph(g), destroy(), element: HTMLElement }}
 */
export function createGraphList(container, opts = {}) {
  const root = el("div", { class: "graph-list" });
  const summary = el("p", { class: "graph-list-summary", "aria-live": "polite" });
  const ul = el("ul", { class: "graph-list-nodes", "aria-label": "Graph nodes" });
  const more = el("button", { type: "button", class: "graph-list-more", onclick: () => renderChunk() });
  root.append(summary, ul, more);
  container.append(root);
  let g = null, shown = 0;

  const neighboursOf = (i) => {
    const out = [];
    const twoWay = new Map();
    for (let e = 0; e < g.edgeCount; e++) {
      if (g.source[e] === i) twoWay.set(g.target[e], g.twoWay[e] ? "both" : "out");
      else if (g.target[e] === i) twoWay.set(g.source[e], g.twoWay[e] ? "both" : "in");
    }
    for (let j = g.adjOffset[i]; j < g.adjOffset[i + 1]; j++) out.push([g.adj[j], twoWay.get(g.adj[j])]);
    return out;
  };
  const dirText = { both: "linked both ways", out: "linked from this page", in: "links to this page" };

  function row(i) {
    const p = g.nodes[i], deg = g.degree[i];
    const open = el("button", { type: "button", class: "graph-list-open", "data-i": String(i), onclick: () => opts.onOpen?.(i), onfocus: () => opts.onFocusNode?.(i) },
      el("span", { class: "graph-list-title", text: title(p) }),
      el("span", { class: "graph-list-meta", text: ` (${kindLabel(p.kind)}, ${deg} link${deg === 1 ? "" : "s"}${i === g.focus ? ", current" : ""})` }));
    const li = el("li", { class: "graph-list-item" }, open);
    if (deg) {
      const sub = el("ul", { class: "graph-list-neighbours", hidden: "" });
      const toggle = el("button", { type: "button", class: "graph-list-toggle", "aria-expanded": "false", text: `Neighbours (${deg})` });
      toggle.addEventListener("click", () => {
        const opening = sub.hidden;
        if (opening && !sub.childElementCount) {
          for (const [j, dir] of neighboursOf(i)) {
            sub.append(el("li", {}, el("button", { type: "button", class: "graph-list-neighbour", onclick: () => opts.onOpen?.(j), onfocus: () => opts.onFocusNode?.(j) },
              el("span", { text: title(g.nodes[j]) }), el("span", { class: "graph-list-meta", text: ` (${dirText[dir] || "linked"})` }))));
          }
        }
        sub.hidden = !opening;
        toggle.setAttribute("aria-expanded", String(opening));
      });
      li.append(" ", toggle, sub);
    }
    return li;
  }
  function renderChunk() {
    const order = sorted();
    const end = Math.min(order.length, shown + CHUNK);
    const frag = document.createDocumentFragment();
    for (let j = shown; j < end; j++) frag.append(row(order[j]));
    ul.append(frag);
    shown = end;
    more.hidden = shown >= order.length;
    more.textContent = `Show more (${order.length - shown} left)`;
  }
  let order = null;
  const sorted = () => order || (order = [...g.nodes.keys()].sort((a, b) => (a === g.focus ? -1 : b === g.focus ? 1 : 0) || g.degree[b] - g.degree[a] || title(g.nodes[a]).localeCompare(title(g.nodes[b]))));

  root.addEventListener("keydown", (e) => {
    // Up/Down walk node and (expanded) neighbour buttons; the Neighbours toggle is reached with Tab or Right/Left
    const btns = [...ul.querySelectorAll(".graph-list-open, .graph-list-neighbour, .graph-list-toggle")]
      .filter((b) => (b === document.activeElement || !b.classList.contains("graph-list-toggle")) && (b.offsetParent !== null || b === document.activeElement));
    const at = btns.indexOf(document.activeElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(btns.length - 1, at + 1);
    else if (e.key === "ArrowUp") to = Math.max(0, at - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = btns.length - 1;
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const t = document.activeElement.closest(".graph-list-item")?.querySelector(".graph-list-toggle");
      if (t && (t.getAttribute("aria-expanded") === "true") !== (e.key === "ArrowRight")) t.click();
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    btns[to].focus();
  });

  return {
    element: root,
    setGraph(graph) {
      g = graph; order = null; shown = 0;
      ul.replaceChildren();
      summary.textContent = `${g.nodes.length} node${g.nodes.length === 1 ? "" : "s"}, ${g.edgeCount} link${g.edgeCount === 1 ? "" : "s"}`;
      renderChunk();
    },
    destroy() { root.remove(); }
  };
}
