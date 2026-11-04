// Artwork at the size the remote shows it. Integrations often hand the remote full-size pictures
// (a Plex poster is ~1000×1500 and a few hundred KB) for a screen about 480 pixels wide. The hub
// rewrites artwork links in what integrations send to a signed link on the hub; when the remote
// asks for it, the hub fetches the original, scales it down to the screen width (same
// proportions, never cropped or enlarged; pictures with transparency stay PNG), keeps it in a
// disk cache and serves that. Pictures sent inline (data: URLs) are scaled down in place.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FIELDS = new Set(["media_image_url", "thumbnail", "image_url", "image", "artwork", "cover"]);
const MAX_SOURCE = 25 * 1024 * 1024;
const CACHE_MAX = 300 * 1024 * 1024;
const DEFAULTS = { enabled: true, maxPx: 480, quality: 82 };

let sharpLib; // loaded on first use (the hub runs without it, just without resizing)
async function sharp() {
  if (sharpLib === undefined) sharpLib = await import("sharp").then((m) => m.default).catch(() => null);
  return sharpLib;
}

export class Artwork {
  constructor({ store, log = () => {} }) {
    this.store = store;
    this.log = log;
    store.hub.artwork = { ...DEFAULTS, ...(store.hub.artwork || {}) };
    if (!store.hub.imageKey) store.hub.imageKey = crypto.randomBytes(24).toString("hex");
    store.saveHub();
    this.dir = path.join(store.dataDir, "cache", "artwork");
    fs.mkdirSync(this.dir, { recursive: true });
    this.stats = { rewritten: 0, served: 0, cacheHits: 0, originalBytes: 0, sentBytes: 0, inline: 0, errors: 0, lastError: null };
    this.inflight = new Map();
    this.cacheBytes = null;
  }

  get settings() {
    return this.store.hub.artwork;
  }

  setSettings({ enabled, maxPx, quality }) {
    const a = this.store.hub.artwork;
    if (typeof enabled === "boolean") a.enabled = enabled;
    if (Number.isFinite(Number(maxPx))) a.maxPx = Math.max(120, Math.min(2048, Math.round(Number(maxPx))));
    if (Number.isFinite(Number(quality))) a.quality = Math.max(50, Math.min(95, Math.round(Number(quality))));
    this.store.saveHub();
    return a;
  }

  #sign(s) {
    return crypto.createHmac("sha256", this.store.hub.imageKey).update(s).digest("base64url").slice(0, 22);
  }

  /** The hub link for an original picture URL. base: "http://<hub address as the remote sees it>:<port>" */
  linkFor(original, base) {
    const enc = Buffer.from(original).toString("base64url");
    return `${base}/img/${this.#sign(enc)}/${enc}`;
  }

  /**
   * Rewrites artwork in one message from an integration (a Buffer of JSON text). Returns the same
   * Buffer when nothing changed, else a new one (possibly after shrinking inline pictures).
   */
  async rewrite(buf, base) {
    if (!this.settings.enabled || !base || buf.length > 8 * 1024 * 1024) return buf;
    // cheap check before parsing
    const head = buf.toString("latin1");
    if (!/"(media_image_url|thumbnail|image_url|image|artwork|cover)"\s*:\s*"(https?:|data:image)/.test(head)) return buf;
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return buf;
    }
    let changed = false;
    const jobs = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && FIELDS.has(k)) {
          if (/^https?:\/\//i.test(v) && !v.startsWith(base + "/img/")) {
            o[k] = this.linkFor(v, base);
            this.stats.rewritten++;
            changed = true;
          } else if (/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(v) && v.length > 60 * 1024) {
            jobs.push(this.#shrinkInline(v).then((nv) => {
              if (nv && nv.length < v.length) {
                o[k] = nv;
                changed = true;
                this.stats.inline++;
              }
            }));
          }
        } else if (v && typeof v === "object") walk(v);
      }
    };
    walk(msg);
    if (jobs.length) await Promise.all(jobs);
    return changed ? Buffer.from(JSON.stringify(msg)) : buf;
  }

  async #shrinkInline(dataUrl) {
    try {
      const comma = dataUrl.indexOf(",");
      const src = Buffer.from(dataUrl.slice(comma + 1), "base64");
      const out = await this.#resize(src);
      if (!out) return null;
      this.stats.originalBytes += src.length;
      this.stats.sentBytes += out.data.length;
      return `data:${out.type};base64,${out.data.toString("base64")}`;
    } catch (e) {
      this.#fail(e);
      return null;
    }
  }

  /** Scales a picture down to the screen width. null when it's already small enough. */
  async #resize(src) {
    const s = await sharp();
    if (!s) return null;
    const img = s(src, { failOn: "none", animated: false });
    const meta = await img.metadata();
    const max = this.settings.maxPx;
    if (meta.pages > 1) return null; // animations stay as they are
    if ((meta.width || 0) <= max && (meta.height || 0) <= max * 2) return null;
    const pipeline = img.rotate().resize({ width: max, height: max * 2, fit: "inside", withoutEnlargement: true });
    const keepAlpha = meta.hasAlpha || meta.format === "png" && meta.channels === 4;
    const data = keepAlpha
      ? await pipeline.png({ compressionLevel: 9, palette: meta.format === "png" }).toBuffer()
      : await pipeline.jpeg({ quality: this.settings.quality, mozjpeg: true }).toBuffer();
    return { data, type: keepAlpha ? "image/png" : "image/jpeg" };
  }

  #fail(e) {
    this.stats.errors++;
    this.stats.lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 200) };
  }

  /** Serves GET /img/<sig>/<b64url>. Returns true when handled. */
  async serve(req, res, parts) {
    const [sig, enc] = parts;
    if (!sig || !enc || this.#sign(enc) !== sig) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("bad link");
      return true;
    }
    const original = Buffer.from(enc, "base64url").toString("utf8");
    if (!/^https?:\/\//i.test(original)) {
      res.writeHead(400).end();
      return true;
    }
    const key = crypto.createHash("sha1").update(`${original}|${this.settings.maxPx}|${this.settings.quality}`).digest("hex");
    const file = path.join(this.dir, key.slice(0, 2), key);
    try {
      let entry = this.#cached(file);
      if (entry) this.stats.cacheHits++;
      else {
        if (!this.inflight.has(key)) this.inflight.set(key, this.#fetchAndStore(original, file).finally(() => this.inflight.delete(key)));
        entry = await this.inflight.get(key);
      }
      this.stats.served++;
      this.stats.sentBytes += entry.data.length;
      this.stats.originalBytes += entry.orig || entry.data.length;
      res.writeHead(200, { "Content-Type": entry.type, "Content-Length": entry.data.length, "Cache-Control": "public, max-age=604800" });
      res.end(entry.data);
    } catch (e) {
      this.#fail(e);
      // the original is better than nothing: send the remote there
      res.writeHead(302, { Location: original });
      res.end();
    }
    return true;
  }

  #cached(file) {
    try {
      const data = fs.readFileSync(file);
      const { type, orig } = JSON.parse(fs.readFileSync(file + ".meta", "utf8"));
      const now = new Date();
      fs.utimesSync(file, now, now);
      return { data, type, orig };
    } catch {
      return null;
    }
  }

  async #fetchAndStore(original, file) {
    const r = await fetch(original, { signal: AbortSignal.timeout(10000), redirect: "follow", headers: { "User-Agent": "pegasis-hub" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} from the artwork source`);
    const type0 = (r.headers.get("content-type") || "").split(";")[0].trim();
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_SOURCE) throw new Error("artwork too large");
    const src = Buffer.from(await r.arrayBuffer());
    if (src.length > MAX_SOURCE) throw new Error("artwork too large");
    let out = null;
    try {
      out = await this.#resize(src);
    } catch (e) {
      this.#fail(e);
    }
    // keep the original when it's already small, or when shrinking didn't make it smaller
    const entry = { ...(out && out.data.length < src.length ? out : { data: src, type: /^image\//.test(type0) ? type0 : "image/jpeg" }), orig: src.length };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".meta", JSON.stringify({ type: entry.type, orig: entry.orig }));
    fs.writeFileSync(file, entry.data);
    this.#trim(entry.data.length);
    return entry;
  }

  /** Keeps the disk cache under its limit (least recently used go first). */
  #trim(added) {
    if (this.cacheBytes == null) this.cacheBytes = this.#scan().reduce((a, f) => a + f.size, 0);
    else this.cacheBytes += added;
    if (this.cacheBytes <= CACHE_MAX) return;
    const files = this.#scan().sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (this.cacheBytes <= CACHE_MAX * 0.8) break;
      try {
        fs.rmSync(f.file);
        fs.rmSync(f.file + ".meta", { force: true });
        this.cacheBytes -= f.size;
      } catch {
        /* next */
      }
    }
  }

  #scan() {
    const out = [];
    for (const sub of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      const d = path.join(this.dir, sub);
      for (const n of fs.readdirSync(d)) {
        if (n.endsWith(".meta")) continue;
        const st = fs.statSync(path.join(d, n));
        out.push({ file: path.join(d, n), size: st.size, at: st.atimeMs || st.mtimeMs });
      }
    }
    return out;
  }

  summary() {
    if (this.cacheBytes == null) this.cacheBytes = this.#scan().reduce((a, f) => a + f.size, 0);
    return { settings: this.settings, stats: this.stats, cacheBytes: this.cacheBytes, available: sharpLib !== null };
  }

  clearCache() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.cacheBytes = 0;
  }
}
