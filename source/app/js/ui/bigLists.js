// Keeps very large lists cheap to draw. Small lists are drawn in full, exactly as before.
//  - windowedRows: table / sheet bodies keep only the rows near the viewport in the DOM (spacer rows hold the height).
//  - appendInChunks: card / list layouts draw the first chunk now and the rest as the reader scrolls near the end.

export const WINDOW_MIN_ROWS = 120; // at or below this many items, everything is drawn

// a height-capped view block marks its own scroller with data-vscroll; everything else scrolls with #main
const SCROLLER = "[data-vscroll], #main";
const scrollerOf = (el) => el.closest(SCROLLER) ?? document.scrollingElement ?? document.documentElement;

/**
 * Fills a <tbody> with `count` rows, drawing only the ones near the viewport once there are many.
 *   render(i)  -> <tr> for item i      kind(i) -> 0 | 1 (row height class, e.g. group header rows are 1)
 *   estimate   -> [rowPx, kind1Px] used until a real row has been measured
 *   onRender() runs after the drawn range changed (the sheet repaints its selection there)
 * Returns { windowed, ensureVisible(i), rowAt(i), range() }. ensureVisible draws row i without scrolling to it;
 * rowAt gives the drawn <tr> of item i, or null when it is not drawn.
 */
export function windowedRows(tbody, { count, colSpan, render, kind = () => 0, estimate = [30, 34], overscan = 18, min = WINDOW_MIN_ROWS, onRender = null }) {
  if (count <= min) {
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(render(i));
    tbody.append(...rows);
    onRender?.();
    return { windowed: false, ensureVisible() {}, rowAt: (i) => rows[i] ?? null, range: () => [0, count] };
  }
  // hs[i] is the height of item i: the estimate for its kind until it has been drawn once, then what was measured
  const hs = new Float64Array(count);
  for (let i = 0; i < count; i++) hs[i] = estimate[kind(i)];
  let offs = null; // offs[i] = top of item i, offs[count] = total
  const buildOffsets = () => {
    offs = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) offs[i + 1] = offs[i] + hs[i];
  };
  const indexAt = (y) => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const spacer = () => {
    const td = document.createElement("td");
    td.colSpan = colSpan;
    td.style.cssText = "padding:0;border:0;height:0";
    const tr = document.createElement("tr");
    tr.className = "vspacer";
    tr.setAttribute("aria-hidden", "true");
    tr.append(td);
    return tr;
  };
  const top = spacer();
  const bottom = spacer();
  tbody.append(top, bottom);
  const els = new Map(); // item index -> <tr>, always one contiguous run [start, end)
  let start = 0;
  let end = 0;
  const setSpacers = () => {
    top.firstChild.style.height = `${offs[start]}px`;
    bottom.firstChild.style.height = `${offs[count] - offs[end]}px`;
  };
  const drop = (i) => {
    const el = els.get(i);
    if (el.contains(document.activeElement)) document.activeElement.blur(); // commits an edit in progress
    el.remove();
    els.delete(i);
  };
  const show = (ns, ne) => {
    ns = Math.max(0, ns);
    ne = Math.min(count, ne);
    if (!els.size || ne <= start || ns >= end) {
      for (const i of [...els.keys()]) drop(i);
      start = end = ns;
    }
    while (start < ns) drop(start++);
    while (end > ne) drop(--end);
    if (ns < start) {
      const made = [];
      for (let i = ns; i < start; i++) {
        const el = render(i);
        els.set(i, el);
        made.push(el);
      }
      top.after(...made);
      start = ns;
    }
    if (ne > end) {
      const made = [];
      for (let i = end; i < ne; i++) {
        const el = render(i);
        els.set(i, el);
        made.push(el);
      }
      bottom.before(...made);
      end = ne;
    }
    setSpacers();
    later();
  };
  // Measures every drawn row; true when an estimate was off (offsets were rebuilt).
  const measure = () => {
    let changed = false;
    for (const [i, el] of els) {
      const px = el.getBoundingClientRect().height;
      if (px > 0 && Math.abs(px - hs[i]) > 0.4) {
        hs[i] = px;
        changed = true;
      }
    }
    if (changed) buildOffsets();
    return changed;
  };
  // rows can grow after they are drawn (wrapped text boxes fit themselves a frame later)
  let remeasure = 0;
  const later = () => {
    if (remeasure) return;
    remeasure = requestAnimationFrame(() => {
      remeasure = 0;
      if (tbody.isConnected && measure()) setSpacers();
    });
  };
  const visible = () => {
    const scroller = scrollerOf(tbody);
    const box = scroller === document.scrollingElement || scroller === document.documentElement ? { top: 0, h: window.innerHeight } : { top: scroller.getBoundingClientRect().top, h: scroller.clientHeight };
    const into = box.top - top.getBoundingClientRect().top; // how far the first item is above the viewport
    return [into, into + box.h];
  };
  let busy = false;
  const update = (force = false) => {
    if (busy || !tbody.isConnected) return;
    busy = true;
    let moved = force;
    try {
      for (let pass = 0; pass < 3; pass++) {
        const [y0, y1] = visible();
        const first = indexAt(Math.max(0, y0));
        const last = indexAt(Math.max(0, y1));
        if (!force && first >= start && last < end) break;
        force = false;
        moved = true;
        show(first - overscan, last + 1 + overscan);
        if (!measure()) break; // an estimate was off: offsets changed, look again
        setSpacers();
      }
      if (moved) onRender?.();
    } finally {
      busy = false;
    }
  };
  buildOffsets();
  show(0, Math.min(count, 60));
  const hostOf = () => {
    const s = scrollerOf(tbody);
    return s === document.documentElement || s === document.scrollingElement ? window : s;
  };
  let host = null;
  const onScroll = () => {
    if (!tbody.isConnected) {
      host?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      return;
    }
    update();
  };
  let tries = 0;
  const attach = () => {
    if (!tbody.isConnected) {
      if (++tries < 20) requestAnimationFrame(attach); // the opener is still putting the table into the page
      return;
    }
    host = hostOf();
    host.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update(true);
  };
  requestAnimationFrame(attach);
  return {
    windowed: true,
    rowAt: (i) => els.get(i) ?? null,
    range: () => [start, end],
    ensureVisible(i) {
      if (i >= start && i < end) return;
      show(i - overscan, i + overscan + 30);
      if (measure()) setSpacers();
      onRender?.();
    }
  };
}

/**
 * Appends `items` to `parent` in chunks: `first` now, then `chunk` more each time the last drawn element nears the
 * viewport. parent.append(...elements) is how elements are added, so any container works (ul, grid, plain div).
 */
export function appendInChunks(parent, items, render, { first = 120, chunk = 240, margin = 900 } = {}) {
  let next = 0;
  let io = null;
  const more = (n) => {
    const made = [];
    for (let end = Math.min(items.length, next + n); next < end; next++) made.push(render(items[next], next));
    parent.append(...made);
    return made[made.length - 1];
  };
  let last = more(first);
  if (next >= items.length || typeof IntersectionObserver === "undefined") {
    if (next < items.length) more(items.length);
    return parent;
  }
  io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    if (!parent.isConnected) return;
    io.unobserve(last);
    last = more(chunk);
    if (next < items.length && last) io.observe(last);
    else io.disconnect();
  }, { rootMargin: `${margin}px 0px` });
  io.observe(last);
  return parent;
}
