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
