// Artwork: links rewritten to the hub, pictures scaled to the screen width (same proportions,
// transparency kept, small ones untouched), signed links, cache, inline pictures, fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { Artwork } from "../hub/src/artwork.js";
const sharp = createRequire(import.meta.url)("../hub/node_modules/sharp");

const noise = (w, h, ch = 3) => sharp(Buffer.from(Array.from({ length: w * h * ch }, () => Math.random() * 255)), { raw: { width: w, height: h, channels: ch } });
const big = await noise(1000, 1500).jpeg({ quality: 90 }).toBuffer();
const logo = await noise(800, 800, 4).png().toBuffer();
const small = await noise(200, 200).jpeg().toBuffer();
const files = { "/big.jpg": [big, "image/jpeg"], "/logo.png": [logo, "image/png"], "/small.jpg": [small, "image/jpeg"] };
let hits = 0;
const src = http.createServer((q, r) => { hits++; const f = files[q.url.split("?")[0]]; if (!f) return r.writeHead(404).end(); r.writeHead(200, { "Content-Type": f[1] }).end(f[0]); });
await new Promise((r) => src.listen(0, "127.0.0.1", r));
const S = `http://127.0.0.1:${src.address().port}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-art-"));
const store = { dataDir, hub: {}, saveHub() {} };
const art = new Artwork({ store });
const hubSrv = http.createServer((q, r) => { const u = new URL(q.url, "http://x"); if (u.pathname.startsWith("/img/")) return art.serve(q, r, u.pathname.slice(5).split("/")); r.writeHead(404).end(); });
await new Promise((r) => hubSrv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${hubSrv.address().port}`;

// ---- links in messages
const ev = Buffer.from(JSON.stringify({ kind: "event", msg: "entity_change", msg_data: { entity_id: "mp", attributes: { state: "PLAYING", media_image_url: `${S}/big.jpg?X-Plex-Token=abc`, media_title: "http://not-a-picture" } } }));
const out = JSON.parse((await art.rewrite(ev, base)).toString());
const link = out.msg_data.attributes.media_image_url;
assert.ok(link.startsWith(base + "/img/"), link);
assert.equal(out.msg_data.attributes.media_title, "http://not-a-picture", "only picture fields change");
const browse = Buffer.from(JSON.stringify({ kind: "resp", req_id: 3, msg: "media_browse", msg_data: { media: { thumbnail: `${S}/small.jpg`, items: [{ thumbnail: `${S}/logo.png` }, { thumbnail: null }] } } }));
const bo = JSON.parse((await art.rewrite(browse, base)).toString());
assert.ok(bo.msg_data.media.items[0].thumbnail.startsWith(base));
const plain = Buffer.from('{"kind":"event","msg":"entity_change","msg_data":{"entity_id":"x","attributes":{"state":"ON"}}}');
assert.equal(await art.rewrite(plain, base), plain, "untouched messages are passed as they are");
assert.equal((await art.rewrite(Buffer.from(JSON.stringify(out)), base)).toString(), JSON.stringify(out), "hub links aren't wrapped twice");
console.log("  ✓ picture links in updates and browse results point at the hub; other fields and messages untouched");

// ---- serving
const get = async (u) => { const r = await fetch(u, { redirect: "manual" }); return { r, buf: Buffer.from(await r.arrayBuffer()) }; };
let { r, buf } = await get(link);
assert.equal(r.status, 200);
let m = await sharp(buf).metadata();
assert.deepEqual([m.width, m.height, m.format], [480, 720, "jpeg"], "poster scaled to the screen width, same proportions");
assert.ok(buf.length < big.length / 3, `${big.length} -> ${buf.length}`);
console.log(`  ✓ 1000×1500 poster served as 480×720 (${Math.round(big.length / 1024)} KB -> ${Math.round(buf.length / 1024)} KB)`);
({ r, buf } = await get(bo.msg_data.media.items[0].thumbnail));
m = await sharp(buf).metadata();
assert.deepEqual([m.width, m.height, m.format, m.hasAlpha], [480, 480, "png", true], "transparency kept");
({ r, buf } = await get(bo.msg_data.media.thumbnail));
assert.ok(buf.equals(small), "small pictures are sent as they are");
console.log("  ✓ transparent logo stays PNG with transparency; small pictures untouched");
const before = hits;
({ r } = await get(link));
assert.equal(r.status, 200);
assert.equal(hits, before, "second request served from the cache");
assert.equal(art.stats.cacheHits, 1);
const [, , sig, enc] = new URL(link).pathname.split("/");
assert.equal((await get(`${base}/img/${sig}x/${enc}`)).r.status, 403, "tampered link refused");
assert.equal((await get(`${base}/img/${sig}/${Buffer.from(S + "/other.jpg").toString("base64url")}`)).r.status, 403, "can't reuse a signature for another picture");
const missing = art.linkFor(`${S}/gone.jpg`, base);
const g = await get(missing);
assert.equal(g.r.status, 302);
assert.equal(g.r.headers.get("location"), `${S}/gone.jpg`, "falls back to the original");
console.log("  ✓ cached after the first request; unsigned or altered links refused; a failure falls back to the original");

// ---- inline pictures
const inlineSrc = await noise(1200, 900).jpeg({ quality: 92 }).toBuffer();
const inl = Buffer.from(JSON.stringify({ kind: "event", msg: "entity_change", msg_data: { entity_id: "mp", attributes: { media_image_url: "data:image/jpeg;base64," + inlineSrc.toString("base64") } } }));
const io = JSON.parse((await art.rewrite(inl, base)).toString()).msg_data.attributes.media_image_url;
const ib = Buffer.from(io.split(",")[1], "base64");
m = await sharp(ib).metadata();
assert.deepEqual([m.width, m.height], [480, 360]);
console.log(`  ✓ inline picture 1200×900 scaled in place to 480×360 (${Math.round(inlineSrc.length / 1024)} KB -> ${Math.round(ib.length / 1024)} KB)`);

// ---- settings
art.setSettings({ maxPx: 300 });
art.clearCache();
({ buf } = await get(link));
m = await sharp(buf).metadata();
assert.deepEqual([m.width, m.height], [300, 450]);
art.setSettings({ enabled: false });
assert.equal(await art.rewrite(ev, base), ev, "off: nothing rewritten");
const sum = art.summary();
assert.ok(sum.stats.served >= 5 && sum.stats.originalBytes > sum.stats.sentBytes);
console.log("  ✓ maximum size setting applies; switched off, links are left alone");
src.close(); hubSrv.close();
console.log("artwork-test: ok");
