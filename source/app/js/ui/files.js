export async function saveTextFile(filename, text, mime = "application/json") {
  const claude = globalThis.claude;
  if (typeof claude?.use === "function") {
    const downloads = await claude.use("downloads");
    if (downloads) {
      await downloads.save({ filename, data: text });
      return "saved";
    }
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      throw new Error("Downloads are not available in this view.");
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "saved";
}
export async function saveBinaryFile(filename, bytes, mime = "application/zip") {
  if (typeof globalThis.claude?.use === "function") throw new Error("ZIP downloads are not available in this view. Use the JSON file export instead.");
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3e4);
  return "saved";
}
