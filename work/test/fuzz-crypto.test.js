// Seeded fuzz: things that must fail closed. Encrypted records (AES-GCM envelopes) under tampering, key files under
// mutation, ZIP reading of corrupt / hostile archives (zip-slip, bombs, wrong passwords) and OAuth responses that
// don't belong to a pending request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, rng, seedFor, record, HEAVY } from "./fixtures/fuzz.js";
import {
  generateDek, encryptText, decryptText, decryptRecord, encryptRecord, isEnvelope, createKeyFile, sanitizeKeyFile,
  unwrapWithPin, unwrapWithRecovery, unwrapWithSecret, parseRecovery, encodeRecovery, toB64, fromB64
} from "../../source/app/js/crypto.js";
import { createZip, readZip, zipNeedsPassword, crc32 } from "../../source/app/js/zip.js";
import { decryptEntry, encryptEntry } from "../../source/app/js/zipcrypto.js";
import { normaliseFiles } from "../../source/app/js/vault.js";
import { config } from "../../source/app/js/config.js";
import { parseRedirect, completeResponse, checkIdToken, decodeJwtPayload, handleRedirect, tokenRecord } from "../../source/app/js/adapters/oauth.js";
import { memoryHandles } from "../../source/app/js/adapters/locations.js";
import { makeFetch, fakeMsIdentity } from "./fixtures/cloud-fakes.js";

const flip = (b64, r) => {
  const bytes = fromB64(b64);
  if (!bytes.length) return b64;
  const i = r.int(0, bytes.length - 1);
  bytes[i] ^= 1 << r.int(0, 7);
  return toB64(bytes);
};

test("AES-GCM envelopes: any tampering, swap of collection/id, truncation or another key fails closed", async () => {
  const dek = await generateDek();
  const other = await generateDek();
  await fuzz("envelope-tamper", 150, async (r) => {
    const col = r.pick(["pages", "rows", "tombstones"]);
    const id = r.id();
    const rec = { id, title: r.nasty(2), n: r.int(0, 1e6) };
    const env = await encryptRecord(dek, "0123456789abcdef", col, id, rec);
    assert.ok(isEnvelope(env));
    assert.deepEqual(await decryptRecord(dek, col, id, env), rec, "round trip");
    const bad = { ...env };
    const how = r.pick(["ct", "iv", "aad-col", "aad-id", "truncate", "extend", "key", "swap-iv", "empty", "kid"]);
    let c = col;
    let i = id;
    let key = dek;
    if (how === "ct") bad.ct = flip(env.ct, r);
    if (how === "iv") bad.iv = flip(env.iv, r);
    if (how === "aad-col") c = col === "pages" ? "rows" : "pages";
    if (how === "aad-id") i = `${id}x`;
    if (how === "truncate") bad.ct = toB64(fromB64(env.ct).subarray(0, r.int(0, fromB64(env.ct).length - 1)));
    if (how === "extend") bad.ct = toB64(new Uint8Array([...fromB64(env.ct), r.int(0, 255)]));
    if (how === "key") key = other;
    if (how === "swap-iv") bad.iv = toB64(new Uint8Array(12));
    if (how === "empty") bad.ct = "";
    if (how === "kid") {
      bad.kid = "ffffffffffffffff"; // the kid is informative: the same key still opens it, any other key can't
      assert.deepEqual(await decryptRecord(dek, col, id, bad), rec);
      await assert.rejects(decryptText(other, col, id, bad));
      return;
    }
    await assert.rejects(decryptText(key, c, i, bad), `${how} must fail`);
  });
});

test("envelopes: malformed shapes are refused before any crypto; locked (no key) says so", async () => {
  const dek = await generateDek();
  await fuzz("envelope-shape", 300, async (r) => {
    const env = r.pick([null, 5, "x", {}, { "denotation-enc": 1 }, { "denotation-enc": 2, iv: "", ct: "" }, { "denotation-enc": 1, iv: 5, ct: "x" }, { "denotation-enc": 1, iv: "!!", ct: "@@" }, { "denotation-enc": 1, iv: toB64(new Uint8Array(r.int(0, 20))), ct: toB64(new Uint8Array(r.int(0, 40))) }]);
    await assert.rejects(decryptText(r.chance(0.2) ? null : dek, "pages", "a", env));
  });
});

test("key files: random mutations are rejected by sanitizeKeyFile or fail to unwrap; never a wrong key", async () => {
  const pin = "4821";
  const { file, dek, recovery } = await createKeyFile({ pin, iterations: 2 });
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", dek));
  const sameKey = async (k) => k && Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", k))).equals(Buffer.from(raw));
  assert.ok(await sameKey(await unwrapWithPin(file, pin)));
  assert.ok(await sameKey(await unwrapWithRecovery(file, recovery)));
  await fuzz("keyfile-mutate", 120, async (r) => {
    const f = JSON.parse(JSON.stringify(file));
    const path = r.pick(["pinWrap.ct", "pinWrap.iv", "recoveryWrap.ct", "recoveryWrap.salt", "kdf.salt", "kdf.iterations", "kid", "v", "alg", "kdf.name"]);
    const [a, b] = path.split(".");
    const tgt = b ? f[a] : f;
    const k = b ?? a;
    tgt[k] = typeof tgt[k] === "string" && /=|^[A-Za-z0-9+/]+$/.test(tgt[k]) && r.chance(0.7) ? flip(tgt[k], r) : r.pick([0, -1, "x", null, 1.5, {}, [], "0".repeat(64), 3]);
    const clean = sanitizeKeyFile(f);
    const byPin = await unwrapWithPin(f, pin);
    const byRec = await unwrapWithRecovery(f, recovery);
    for (const k2 of [byPin, byRec]) if (k2) assert.ok(await sameKey(k2), `a mutated key file (${path}) unwrapped to a different key`);
    if (!clean) assert.equal(byPin, null);
    assert.equal(await unwrapWithSecret(f, r.pick(["0000", "12345", "", "x"])), null, "wrong secret");
  });
});

test("key files: iteration count from the file is trusted as-is (any positive integer)", { todo: "BUG (hardening): sanitizeKeyFile accepts kdf.iterations = 1 (weak) or 1e12 (unlock hangs); clamp to a sane range" }, async () => {
  const { file } = await createKeyFile({ pin: "4821", iterations: 2 });
  for (const iterations of [1, 1e12]) assert.equal(sanitizeKeyFile({ ...file, kdf: { ...file.kdf, iterations } }), null, `iterations ${iterations}`);
});

test("recovery key text: parse(encode(bytes)) round trips; random text is rejected or decodes to 20 bytes", async () => {
  await fuzz("recovery", 2000, (r) => {
    const bytes = new Uint8Array(20).map(() => r.int(0, 255));
    const text = encodeRecovery(bytes);
    assert.deepEqual(parseRecovery(text.toLowerCase().replace(/-/g, r.pick([" ", "-", ""]))), bytes);
    const junk = r.text(40);
    const p = parseRecovery(junk);
    assert.ok(p === null || p.length === 20);
  });
});

// ---------- ZIP ----------
// zip.js pipe() leaves the writer's promise unawaited when inflation fails, so corrupt deflate data also raises an
// unhandled rejection (pinned below). The mutation fuzz wraps DecompressionStream so those don't fail unrelated cases.
function withQuietInflate(fn) {
  const Real = globalThis.DecompressionStream;
  globalThis.DecompressionStream = class extends Real {
    get writable() {
      const w = super.writable;
      const getWriter = w.getWriter.bind(w);
      return Object.assign(Object.create(w), {
        getWriter: () => {
          const wr = getWriter();
          return { write: (b) => wr.write(b).catch(() => {}), close: () => wr.close().catch(() => {}), releaseLock: () => wr.releaseLock() };
        }
      });
    }
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.DecompressionStream = Real; });
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("readZip: mutated archives either throw an Error or return entries with safe paths and verified sizes", async () => {
  const files = [
    { path: "denotation.json", data: '{"app":"denotation","format":"json","version":1}' },
    { path: "pages/a.json", data: JSON.stringify({ id: "a", type: "doc", title: "x".repeat(300) }) },
    { path: "rows/b.json", data: "{}" }
  ];
  const zips = [await createZip(files, { compress: true }), await createZip(files, { compress: false })];
  await withQuietInflate(() => fuzz("zip-mutate", 600, async (r) => {
    const z = r.pick(zips).slice();
    const n = r.int(1, 6);
    for (let k = 0; k < n; k++) {
      const how = r.int(0, 3);
      const i = r.int(0, z.length - 1);
      if (how === 0) z[i] ^= 1 << r.int(0, 7);
      else if (how === 1) z[i] = r.pick([0, 0xff, 0x2e, 0x2f, 0x5c]);
      else if (how === 2) new DataView(z.buffer).setUint32(Math.min(i, z.length - 4), r.pick([0, 0xffffffff, 0x7fffffff, z.length, 1]), true);
      else z[i] = r.int(0, 255);
    }
    const input = r.chance(0.1) ? z.subarray(0, r.int(0, z.length)) : z;
    let out;
    try {
      out = await readZip(input);
    } catch (e) {
      assert.ok(e instanceof Error, `non-Error thrown: ${e}`);
      return;
    }
    for (const f of out) {
      assert.ok(!f.path.startsWith("/") && !/^[A-Za-z]:/.test(f.path), f.path);
      assert.ok(!f.path.replace(/\\/g, "/").split("/").includes(".."), f.path);
      assert.ok(f.data instanceof Uint8Array);
    }
    normaliseFiles(out.map((f) => ({ path: f.path, data: f.data })));
  }));
});

test("readZip: corrupt deflate data raises no unhandled promise rejection", { todo: "BUG: zip.js pipe() never awaits/catches writer.write().then(close) when inflate fails -> unhandledRejection (Z_DATA_ERROR)" }, async () => {
  const zip = await createZip([{ path: "a.txt", data: "hello hello hello hello ".repeat(50) }], { compress: true });
  const z = zip.slice();
  z[35] ^= 0xff; // first bytes of the deflate stream
  z[36] ^= 0xff;
  await readZip(z).catch(() => {});
  await settle(); // the runner fails this (todo) test if a rejection goes unhandled meanwhile
});

test("readZip: random bytes never hang or throw non-Errors", async () => {
  await withQuietInflate(() => fuzz("zip-random", 400, async (r) => {
    const len = r.int(0, 400);
    const z = new Uint8Array(len).map(() => r.int(0, 255));
    if (len >= 22 && r.chance(0.5)) new DataView(z.buffer).setUint32(len - 22, 0x06054b50, true); // a plausible EOCD
    await readZip(z).then(() => {}, (e) => assert.ok(e instanceof Error));
  }));
});

test("readZip: zip-slip names in the central directory are refused whatever the separators", async () => {
  const names = ["../x", "a/../../x", "..\\x", "a\\..\\..\\x", "/etc/passwd", "\\\\server\\share\\x", "C:\\x", "c:x", "./../x", "a/./../../x"];
  await fuzz("zip-slip", 60, async (r) => {
    const name = r.pick(names);
    const zip = await createZip([{ path: r.pick(["ok.txt", "pages/a.json"]), data: "1" }, { path: name, data: "evil" }], { compress: r.chance(0.5) });
    await assert.rejects(readZip(zip), /Unsafe path/, name);
  });
});

test("readZip: declared sizes are enforced; a deflate bomb is rejected (timing printed)", async () => {
  const mb = HEAVY ? 128 : 16;
  const big = new Uint8Array(mb * 1024 * 1024); // zeros: compresses ~1000:1
  const zip = await createZip([{ path: "bomb.bin", data: big }], { compress: true });
  // Lie in the central directory and the local header: declare 10 bytes uncompressed.
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let cd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x02014b50) { cd = i; break; }
  v.setUint32(cd + 24, 10, true);
  v.setUint32(22, 10, true);
  const t0 = performance.now();
  await assert.rejects(readZip(zip), /size mismatch|too large/);
  const ms = performance.now() - t0;
  record(`readZip deflate bomb ${mb} MB (declared 10 B, ${zip.length} B on disk)`, ms);
  // The reader inflates the whole entry before checking the declared size: report it if it is slow.
  assert.ok(ms < 20000, "bomb rejected within 20 s");
});

test("readZip: inflation stops at the declared size (no 512 MB allocation for a 10-byte entry)", { todo: "BUG (hardening): zip.js pipe() caps output at MAX_TOTAL (512 MB) per entry, not at the entry's declared usize" }, async () => {
  const big = new Uint8Array(8 * 1024 * 1024);
  const zip = await createZip([{ path: "b.bin", data: big }], { compress: true });
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let cd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x02014b50) { cd = i; break; }
  v.setUint32(cd + 24, 10, true);
  // Expect an early "too large for its declared size" style error instead of a size mismatch after inflating 8 MB.
  await assert.rejects(readZip(zip), (e) => !/size mismatch/.test(e.message));
});

test("password ZIPs: wrong passwords and tampered entries fail with bad-password / an Error, never wrong data", async () => {
  const data = "secret " + "x".repeat(200);
  const zip = await createZip([{ path: "a.txt", data }], { compress: true, password: "correct horse" });
  assert.equal(await zipNeedsPassword(zip), true);
  await assert.rejects(readZip(zip), (e) => e.code === "password-required");
  await fuzz("zipcrypto", 40, async (r) => {
    const pw = r.chance(0.5) ? r.text(16) : "correct horsf";
    if (pw === "correct horse") return;
    await assert.rejects(readZip(zip, { password: pw }), (e) => e.code === "bad-password" || e instanceof Error);
    const z = zip.slice();
    z[r.int(40, z.length - 60)] ^= 1 << r.int(0, 7);
    try {
      const out = await readZip(z, { password: "correct horse" });
      // a flipped byte outside the entry data (e.g. a timestamp) may still read; the content must then be intact
      for (const f of out) assert.equal(new TextDecoder().decode(f.data), data);
    } catch (e) {
      assert.ok(e instanceof Error);
    }
  });
  const body = await encryptEntry(new TextEncoder().encode("hi"), "pw");
  await assert.rejects(decryptEntry(body.subarray(0, 5), "pw"), (e) => e.code === "corrupt");
  await assert.rejects(decryptEntry(body, "pw", 7), (e) => e.code === "corrupt");
  assert.equal(crc32(new Uint8Array()), 0);
});

// ---------- OAuth ----------

test("parseRedirect: random URLs never throw; only state + code/token/error fragments count; the rest drops the response", async () => {
  await fuzz("oauth-parse", 3000, (r) => {
    const key = () => r.pick(["state", "code", "access_token", "error", "id_token", "token_type", "__proto__", "constructor", "x"]);
    const kv = () => `${key()}=${encodeURIComponent((r.chance(0.5) ? r.id() : r.nasty(1)).toWellFormed())}`;
    const q = Array.from({ length: r.int(0, 5) }, kv).join("&");
    const h = Array.from({ length: r.int(0, 5) }, kv).join("&");
    const href = r.chance(0.1) ? r.nasty(2) : `https://app.example/Denotation/${r.chance(0.5) ? `?${q}` : ""}${r.chance(0.7) ? `#${h}` : ""}`;
    const p = parseRedirect(href);
    if (!p) return;
    assert.ok(typeof p.params.state === "string");
    assert.equal(Object.getPrototypeOf(p.params), Object.prototype);
    assert.ok(!("__proto__" in p.params && Object.hasOwn(p.params, "__proto__")));
    assert.ok(!p.rest.includes("#"), "the fragment is dropped");
    if (p.where === "query") assert.ok(!/(^|[?&])(code|access_token|state)=/.test(p.rest.split("?")[1] ?? ""), `response left in ${p.rest}`);
    for (const v of Object.values(p.params)) assert.ok(v.length <= 8192);
  });
});

test("completeResponse: any state mismatch is refused before any token use or network call", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error("no network in this test");
  };
  await fuzz("oauth-state", 500, async (r) => {
    const state = r.id(30);
    const provider = r.pick(["google", "microsoft"]);
    const req = { provider, state, verifier: "v", nonce: "n", wantScope: "s", clientId: "c", redirectUri: "https://a/" };
    const bad = r.pick([state.slice(1), `${state} `, state.toUpperCase() === state ? `${state}a` : state.toUpperCase(), "", undefined, null, 5, [state]]);
    const params = { state: bad, code: "c", access_token: "t", token_type: "Bearer", scope: "s" };
    await assert.rejects(completeResponse(params, req, { fetch }), (e) => e.code === "state");
  });
  assert.equal(calls, 0);
});

test("checkIdToken: a mutated audience, nonce, issuer or expiry is refused", async () => {
  const good = { aud: "cid", nonce: "n1", exp: 2e9, iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0" };
  assert.ok(checkIdToken(good, { clientId: "cid", nonce: "n1", now: 1.9e12 }));
  await fuzz("oauth-idtoken", 2000, (r) => {
    const p = { ...good };
    const field = r.pick(["aud", "nonce", "exp", "iss"]);
    p[field] = r.pick({
      aud: ["cid ", "CID", "", null, ["cid"], "other"],
      nonce: ["n2", "", null, "N1", ["n1"]],
      exp: [1, 0, "x", null, 1.5e9],
      iss: ["https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0/", "https://evil.example/11111111-2222-3333-4444-555555555555/v2.0", "https://login.microsoftonline.com.evil.example/11111111-2222-3333-4444-555555555555/v2.0", "http://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0", null]
    }[field]);
    assert.throws(() => checkIdToken(p, { clientId: "cid", nonce: "n1", now: 1.9e12 }), (e) => e.code === "bad-id-token", `${field}=${JSON.stringify(p[field])}`);
    assert.equal(decodeJwtPayload(r.text(40)) === null || typeof decodeJwtPayload(r.text(40)) === "object", true);
  });
});

test("tokenRecord: missing tokens, other token types and missing scopes are refused", async () => {
  await fuzz("oauth-tokenrec", 1000, (r) => {
    const res = { access_token: r.pick(["", null, 5, "tok"]), token_type: r.pick(["Bearer", "bearer", "mac", "", undefined]), scope: r.pick(["a b", "", undefined, "x/a"]) };
    let rec = null;
    try {
      rec = tokenRecord(r.pick(["google", "microsoft"]), res, { wantScope: "a", now: 1000 });
    } catch (e) {
      assert.ok(["no-token", "scope"].includes(e.code), e.message);
      return;
    }
    assert.equal(rec.accessToken, "tok");
    assert.ok(!res.token_type || res.token_type.toLowerCase() === "bearer");
    assert.ok(String(res.scope).split(/\s+/).some((s) => s === "a" || s.endsWith("/a")));
  });
});

test("handleRedirect: forged, stale and replayed responses are ignored; only a pending state completes, once", async () => {
  config.oauth.microsoft.clientId = "ms-client-id-123";
  const APP = "https://example.github.io/Denotation/";
  const win = (href) => {
    const w = { location: null, history: { state: null, replaceState(_s, _t, url) { w.location = loc(new URL(url, w.location.href).href); } }, addEventListener() {}, close() {}, document: { body: {} } };
    const loc = (h) => {
      const u = new URL(h);
      return { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
    };
    w.location = loc(href);
    w.parent = w;
    return w;
  };
  const id = fakeMsIdentity();
  const fetch = makeFetch(id);
  const hs = memoryHandles();
  const now = Date.now();
  // A real pending redirect request.
  const state = "S".repeat(24);
  await hs.put(`oauth:${state}`, { provider: "microsoft", state, verifier: "v".repeat(43), nonce: "n", wantScope: "Files.ReadWrite.AppFolder", clientId: "ms-client-id-123", redirectUri: APP, mode: "redirect", createdAt: now, purpose: { kind: "nothing-registered" } });
  await hs.put(`oauth:${"T".repeat(24)}`, { provider: "microsoft", mode: "redirect", createdAt: now - 11 * 60_000 }); // stale
  const r = rng(seedFor("oauth-forged"));
  for (let i = 0; i < 200; i++) {
    const st = r.pick([r.id(r.int(1, 70)), "T".repeat(24), "S".repeat(23), "S".repeat(25), `${"S".repeat(24)}%00`, "../" + "S".repeat(24), "__proto__", "constructor".padEnd(24, "x")]);
    if (st === state) continue;
    const res = await handleRedirect({ win: win(`${APP}#code=forged&state=${encodeURIComponent(st)}`), handles: hs, fetch, now });
    assert.deepEqual(res, { stop: false, handled: false }, st);
  }
  assert.equal(id.stats.code, 0, "no forged code reached the token endpoint");
  assert.ok(await hs.get(`oauth:${state}`), "the real pending request is untouched");
  const first = await handleRedirect({ win: win(`${APP}#code=whatever&state=${state}`), handles: hs, fetch, now });
  assert.equal(first.handled, true);
  assert.equal(await hs.get(`oauth:${state}`), undefined ?? null, "consumed");
  const replay = await handleRedirect({ win: win(`${APP}#code=whatever&state=${state}`), handles: hs, fetch, now });
  assert.deepEqual(replay, { stop: false, handled: false }, "replay ignored");
});
