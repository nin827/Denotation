export function pickCsv() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? { name: f.name.replace(/\.[^.]+$/, ""), text: await f.text() } : null);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}
