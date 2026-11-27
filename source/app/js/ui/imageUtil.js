// Image sources shared by the image block and the inline image chip: what is allowed, and shrinking an upload.
export const MAX_EMBED_BYTES = 15e4;
export const safeSrc = (s) => /^(data:image\/(png|jpe?g|gif|webp|svg\+xml);|https?:\/\/)/i.test(s || "");

// ---------- linked (remote) pictures: load automatically or on a click (prefs.remoteImages) ----------
/** The http(s) URL of a picture on another site, or null (data:, blob:, same-origin, relative and bad URLs). */
export function remoteImageUrl(src, pageOrigin = globalThis.location?.origin ?? "") {
  if (typeof src !== "string" || !/^https?:\/\//i.test(src)) return null;
  let u;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return pageOrigin && u.origin === pageOrigin ? null : u;
}
/** True when `src` must wait for a click: mode "click" and a picture on another site. */
export const deferImage = (src, mode, pageOrigin) => mode === "click" && remoteImageUrl(src, pageOrigin) !== null;
/** The site a linked picture comes from ("example.com"), or "" for anything that isn't one. */
export const imageHost = (src, pageOrigin) => remoteImageUrl(src, pageOrigin)?.hostname ?? "";
const readDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});
export async function shrink(file, maxBytes = MAX_EMBED_BYTES) {
  if (file.type === "image/svg+xml" || file.type === "image/gif") {
    const url = await readDataUrl(file);
    if (url.length > maxBytes) throw new Error("That file is too large to embed. Use an image URL instead.");
    return url;
  }
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.65, 0.5]) {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
      const url = blob && await readDataUrl(blob);
      if (url && url.length <= maxBytes) return url;
    }
  }
  throw new Error("Could not shrink that picture enough to embed it.");
}
