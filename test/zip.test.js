import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, readZip, crc32 } from "../public/js/zip.js";

const has = (cmd) => spawnSync("which", [cmd]).status === 0;
const text = (u) => new TextDecoder().decode(u);

test("crc32 known values", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

for (const compress of [true, false]) {
  test(`round trip (compress=${compress})`, async () => {
    const bin = new Uint8Array(5000).map((_, i) => (i * 31 + (i >> 3)) & 255);
    const files = [
      { path: "pages/a.json", data: JSON.stringify({ x: "hello ".repeat(500) }) },
      { path: "Notes/Café ☕.md", data: "# Café ☕\n".repeat(50) },
      { path: "empty.txt", data: "" },
      { path: "bin/data.bin", data: bin },
    ];
    const zip = await createZip(files, { compress });
    const back = await readZip(zip);
    assert.equal(back.length, 4);
    assert.deepEqual(back.map((f) => f.path), files.map((f) => f.path));
    assert.equal(text(back[0].data), files[0].data);
    assert.equal(text(back[1].data), files[1].data);
    assert.equal(back[2].data.length, 0);
    assert.deepEqual([...back[3].data], [...bin]);
    // ArrayBuffer input accepted
    const ab = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
    assert.equal((await readZip(ab)).length, 4);
  });
}

test("compression shrinks compressible data", async () => {
  const data = "abc".repeat(10000);
  const a = await createZip([{ path: "a.txt", data }], { compress: true });
  const b = await createZip([{ path: "a.txt", data }], { compress: false });
  assert.ok(a.length < b.length);
});

test("corrupted data is detected via CRC", async () => {
  const zip = await createZip([{ path: "a.txt", data: "hello world, hello world" }], { compress: false });
  const bad = zip.slice();
  bad[30 + 5] ^= 0xff; // first data byte (30-byte header + 5-byte name)
  await assert.rejects(() => readZip(bad), /CRC32 mismatch/);
});

test("zip-slip paths rejected", async () => {
  for (const path of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "..\\evil.txt", "C:/x.txt"]) {
    const zip = await createZip([{ path, data: "x" }], { compress: false });
    await assert.rejects(() => readZip(zip), /Unsafe path/, path);
  }
});

test("backslashes normalised and directory entries skipped", async () => {
  const zip = await createZip([{ path: "dir/", data: "" }, { path: "dir\\f.txt", data: "x" }]);
  const back = await readZip(zip);
  assert.deepEqual(back.map((f) => f.path), ["dir/f.txt"]);
});

test("bad input errors", async () => {
  await assert.rejects(() => readZip(new Uint8Array(10)), /Not a ZIP/);
  await assert.rejects(() => readZip(new Uint8Array(100)), /Not a ZIP/);
});

test("zip comment after EOCD is tolerated", async () => {
  const zip = await createZip([{ path: "a.txt", data: "hi" }]);
  const withComment = new Uint8Array(zip.length + 5);
  withComment.set(zip);
  new DataView(withComment.buffer).setUint16(zip.length - 2, 5, true);
  withComment.set([99, 99, 99, 99, 99], zip.length);
  assert.equal(text((await readZip(withComment))[0].data), "hi");
});

test("encryption flag rejected", async () => {
  const zip = (await createZip([{ path: "a.txt", data: "hi" }])).slice();
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  v.setUint16(cd + 8, v.getUint16(cd + 8, true) | 1, true);
  await assert.rejects(() => readZip(zip), /Encrypted/);
});

test("unsupported method rejected", async () => {
  const zip = (await createZip([{ path: "a.txt", data: "hi" }], { compress: false })).slice();
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  v.setUint16(cd + 10, 12, true);
  await assert.rejects(() => readZip(zip), /Unsupported ZIP compression method/);
});

test("oversized declared total rejected", async () => {
  const zip = (await createZip([{ path: "a.txt", data: "hi" }], { compress: false })).slice();
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  v.setUint32(cd + 24, 600 * 1024 * 1024, true);
  await assert.rejects(() => readZip(zip), /512 MB/);
});

test("interop: unzip -t accepts createZip output", { skip: !has("unzip") }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-"));
  const zip = await createZip([
    { path: "pages/a.json", data: "{}".repeat(2000) },
    { path: "Notes/Café ☕.md", data: "hello" },
    { path: "empty.txt", data: "" },
  ]);
  const f = join(dir, "out.zip");
  writeFileSync(f, zip);
  const r = spawnSync("unzip", ["-t", f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("interop: read zip made by zip CLI", { skip: !has("zip") }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-"));
  const src = join(dir, "src");
  mkdirSync(join(src, "sub"), { recursive: true });
  writeFileSync(join(src, "a.txt"), "hello ".repeat(1000));
  writeFileSync(join(src, "sub", "Café.md"), "# hi");
  writeFileSync(join(src, "empty.txt"), "");
  const out = join(dir, "x.zip");
  const r = spawnSync("zip", ["-r", out, "."], { cwd: src, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const back = await readZip(new Uint8Array(readFileSync(out)));
  const m = Object.fromEntries(back.map((f) => [f.path, text(f.data)]));
  assert.equal(m["a.txt"], "hello ".repeat(1000));
  assert.equal(m["sub/Café.md"], "# hi");
  assert.equal(m["empty.txt"], "");
});
