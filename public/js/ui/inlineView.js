import { isSafeHref, parseInline } from "../blocks/inline.js";
import { h } from "./dom.js";

const TAGS = { b: "strong", i: "em", s: "s" };
function nodeFor(n) {
  if (n.t === "text") return document.createTextNode(n.v);
  if (n.t === "code") return h("code", { class: "inline-code" }, n.v);
  if (n.t === "link") {
    const kids = n.children.map(nodeFor);
    if (!isSafeHref(n.href)) return h("span", {}, kids);
    const internal = n.href.startsWith("#");
    return h("a", { href: n.href.trim(), class: internal ? "mention" : "", ...internal ? {} : { target: "_blank", rel: "noopener noreferrer" } }, kids);
  }
  return h(TAGS[n.t], {}, n.children.map(nodeFor));
}
export const renderInline = (text) => parseInline(text ?? "").map(nodeFor);
