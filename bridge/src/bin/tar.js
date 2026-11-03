// Minimal tar.gz writer and reader (ustar), enough for custom-integration archives.
// The remote has no tar command, so the Bridge builds the stand-in's archive itself.

import zlib from "node:zlib";

const BLOCK = 512;

function header(name, size, mode, type) {
  const h = Buffer.alloc(BLOCK, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii"); // uid
  h.write("0000000\0", 116, 8, "ascii"); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** entries: [{ name: "bin/driver.js", data: Buffer|string, mode?: 0o644 }] (folders are added automatically) */
export function createTarGz(entries) {
  const parts = [];
  const dirs = new Set();
  for (const e of entries) {
    const segs = e.name.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/") + "/";
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(d, 0, 0o755, "5"));
      }
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    parts.push(header(e.name, data.length, e.mode || 0o644, "0"), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Returns [{ name, data, type }] ("0" file, "5" folder). */
export function readTarGz(buf) {
  const raw = zlib.gunzipSync(buf);
  const out = [];
  let off = 0;
  while (off + BLOCK <= raw.length) {
    const h = raw.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const prefix = str(345, 500);
    const name = (prefix ? prefix + "/" : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = str(156, 157) || "0";
    off += BLOCK;
    out.push({ name: name.replace(/^\.\//, ""), data: raw.subarray(off, off + size), type });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
