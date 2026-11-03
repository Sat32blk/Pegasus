// What the Bridge does on the remote for a move: list integrations, snapshot every place an
// integration's entities are used, put those references back, check them, install archives.
//
// Deleting an integration driver makes the remote remove every reference to its entities
// (activity entities, sequences, buttons, pages, macros, home screen). A move has to delete the
// installed copy to free its slot, so everything that refers to it is saved first and restored
// afterwards, and the result is checked against the saved copy.

const LIMIT = 100;

export class RemoteOps {
  constructor(core, log = () => {}) {
    this.core = core;
    this.log = log;
  }

  /** All items of a paged list endpoint. */
  async all(path) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const part = await this.core.get(`${path}${path.includes("?") ? "&" : "?"}limit=${LIMIT}&page=${page}`);
      const list = Array.isArray(part) ? part : [];
      out.push(...list);
      if (list.length < LIMIT) break;
    }
    return out;
  }

  async getOrNull(path) {
    try {
      return await this.core.get(path);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** Installed integrations with their instance (for the hub's list). */
  async integrations() {
    const drivers = await this.all("/intg/drivers");
    const instances = await this.all("/intg/instances");
    // the list is a summary without home pages (firmware 2.x): read installed ones in full
    const full = new Map(
      await Promise.all(
        drivers.filter((d) => d.driver_type === "CUSTOM" && !d.home_page).map(async (d) => [d.driver_id, await this.driver(d.driver_id).catch(() => null)])
      )
    );
    return drivers.map((d0) => {
      const d = { ...d0, ...(full.get(d0.driver_id) || {}) };
      const inst = instances.find((i) => i.driver_id === d.driver_id) || null;
      return {
        driver_id: d.driver_id,
        name: text(d.name) || d.driver_id,
        version: d.version || "",
        type: d.driver_type || "",
        state: d.driver_state || "",
        developer: d.developer?.name || (typeof d.developer === "string" ? d.developer : "") || d.developer_name || "",
        home_page: d.home_page || d.developer?.url || "",
        instance: inst ? { integration_id: inst.integration_id, name: text(inst.name), state: inst.device_state || "" } : null
      };
    });
  }

  async driver(id) {
    return this.getOrNull(`/intg/drivers/${enc(id)}`);
  }

  async instancesOf(driverId) {
    return (await this.all("/intg/instances")).filter((i) => i.driver_id === driverId);
  }

  /**
   * Everything that refers to the entities of one integration instance:
   * the instance itself, its configured entities (with names and icons), and the activities,
   * macros, home-screen pages and groups that use them (as the remote returns them).
   */
  async snapshot(instanceId) {
    const prefix = instanceId + ".";
    const uses = (o) => JSON.stringify(o).includes(prefix);
    const snap = { kind: "pegasis-move-snapshot", format: 1, created: new Date().toISOString(), instanceId };
    snap.instance = await this.getOrNull(`/intg/instances/${enc(instanceId)}`);
    snap.configured = (await this.all(`/intg/instances/${enc(instanceId)}/entities?filter=CONFIGURED`).catch(() => []))
      .map((e) => e.entity_id)
      .filter(Boolean);
    snap.entities = (await this.all("/entities"))
      .filter((e) => e.integration_id === instanceId || String(e.entity_id || "").startsWith(prefix))
      .map((e) => ({ entity_id: e.entity_id, name: e.name, icon: e.icon }));
    snap.activities = [];
    for (const a of await this.all("/activities")) {
      const full = (await this.getOrNull(`/activities/${enc(a.entity_id)}`)) || a;
      if (uses(full)) snap.activities.push(full);
    }
    snap.macros = [];
    for (const m of await this.all("/macros")) {
      const full = (await this.getOrNull(`/macros/${enc(m.entity_id)}`)) || m;
      if (uses(full)) snap.macros.push(full);
    }
    snap.profilePages = [];
    snap.profileGroups = [];
    const profiles = await this.core.get("/profiles").catch(() => []);
    for (const p of Array.isArray(profiles) ? profiles : profiles?.profiles || []) {
      const pid = p.profile_id || p.id;
      if (!pid) continue;
      for (const page of (await this.core.get(`/profiles/${enc(pid)}/pages`).catch(() => [])) || []) if (uses(page)) snap.profilePages.push({ profileId: pid, page });
      for (const group of (await this.core.get(`/profiles/${enc(pid)}/groups`).catch(() => [])) || []) if (uses(group)) snap.profileGroups.push({ profileId: pid, group });
    }
    snap.references = countRefs(snap, prefix);
    return snap;
  }

  /**
   * Puts the snapshot's references back. If the instance got a different ID, every reference is
   * rewritten from the old ID to the new one first. Only the parts that refer to the integration
   * are written. Returns a list of what was done.
   */
  async restore(snapshot, newInstanceId = snapshot.instanceId) {
    const oldP = snapshot.instanceId + ".";
    const newP = newInstanceId + ".";
    const snap = oldP === newP ? snapshot : JSON.parse(JSON.stringify(snapshot).split(oldP).join(newP));
    const uses = (o) => JSON.stringify(o ?? null).includes(newP);
    const done = [];

    for (const e of snap.entities || []) {
      const cur = await this.getOrNull(`/entities/${enc(e.entity_id)}`);
      if (!cur) continue;
      const body = {};
      if (e.name && JSON.stringify(e.name) !== JSON.stringify(cur.name)) body.name = e.name;
      if (e.icon && e.icon !== cur.icon) body.icon = e.icon;
      if (Object.keys(body).length) {
        await this.core.patch(`/entities/${enc(e.entity_id)}`, body);
        done.push(`entity ${e.entity_id}: name/icon`);
      }
    }

    for (const a of snap.activities || []) {
      const id = a.entity_id;
      const o = a.options || {};
      const opts = {};
      if (o.included_entities) opts.entity_ids = o.included_entities.map((x) => x.entity_id).filter(Boolean);
      if (o.sequences && uses(o.sequences)) opts.sequences = o.sequences;
      if (o.touch_slider && uses(o.touch_slider)) opts.touch_slider = o.touch_slider;
      if (o.voice_assistant && uses(o.voice_assistant)) opts.voice_assistant = o.voice_assistant;
      if (Object.keys(opts).length) {
        await this.core.patch(`/activities/${enc(id)}`, { options: opts });
        done.push(`activity ${text(a.name) || id}: entities${opts.sequences ? ", sequences" : ""}`);
      }
      for (const m of o.button_mapping || []) {
        for (const press of ["short_press", "long_press"]) {
          if (m[press] && uses(m[press])) {
            await this.core.patch(`/activities/${enc(id)}/buttons/${enc(m.button)}`, { [press]: m[press] });
            done.push(`activity ${text(a.name) || id}: ${m.button} ${press.replace("_", " ")}`);
          }
        }
      }
      for (const page of o.user_interface?.pages || []) {
        if (!uses(page.items)) continue;
        try {
          await this.core.patch(`/activities/${enc(id)}/ui/pages/${enc(page.page_id)}`, { items: page.items });
        } catch (e) {
          if (e.status !== 404) throw e;
          await this.core.post(`/activities/${enc(id)}/ui/pages`, { name: page.name, grid: page.grid, items: page.items });
        }
        done.push(`activity ${text(a.name) || id}: page ${page.name || page.page_id}`);
      }
    }

    for (const m of snap.macros || []) {
      const o = m.options || {};
      const opts = {};
      if (o.included_entities) opts.entity_ids = o.included_entities.map((x) => x.entity_id).filter(Boolean);
      if (o.sequence) opts.sequence = o.sequence;
      await this.core.patch(`/macros/${enc(m.entity_id)}`, { options: opts });
      done.push(`macro ${text(m.name) || m.entity_id}`);
    }

    for (const { profileId, page } of snap.profilePages || []) {
      const items = (page.items || []).map((i) => (i.entity_id ? { entity_id: i.entity_id } : { group_id: i.group_id }));
      await this.core.patch(`/profiles/${enc(profileId)}/pages/${enc(page.page_id)}`, { items });
      done.push(`home page ${page.name || page.page_id}`);
    }
    for (const { profileId, group } of snap.profileGroups || []) {
      await this.core.patch(`/profiles/${enc(profileId)}/groups/${enc(group.group_id)}`, { entities: group.entities || [] });
      done.push(`home group ${group.name || group.group_id}`);
    }
    return done;
  }

  /** Compares the references now on the remote with the snapshot. Returns what is missing. */
  async verify(snapshot, newInstanceId = snapshot.instanceId) {
    const now = await this.snapshot(newInstanceId);
    const want = snapshot.instanceId === newInstanceId ? snapshot.references : JSON.parse(JSON.stringify(snapshot.references).split(snapshot.instanceId + ".").join(newInstanceId + "."));
    const missing = [];
    for (const [where, n] of Object.entries(want)) {
      const have = now.references[where] || 0;
      if (have < n) missing.push(`${where}: ${n - have} of ${n} missing`);
    }
    return { ok: missing.length === 0, missing, references: now.references };
  }

  /** Creates the instance of a (re)registered driver and selects its entities again. */
  async recreateInstance(driverId, snapshot) {
    let inst = (await this.instancesOf(driverId))[0];
    if (!inst) {
      const body = {};
      if (snapshot.instance?.name) body.name = snapshot.instance.name;
      if (snapshot.instance?.icon) body.icon = snapshot.instance.icon;
      inst = await this.core.post(`/intg/drivers/${enc(driverId)}`, body);
      if (!inst?.integration_id) inst = (await this.instancesOf(driverId))[0];
    }
    if (!inst?.integration_id) throw new Error(`the remote did not create an instance for ${driverId}`);
    const ids = snapshot.configured || [];
    if (ids.length) {
      const prefix = snapshot.instanceId + ".";
      // the endpoint takes the integration's own entity IDs; accept full IDs from older snapshots too
      const own = ids.map((x) => (x.startsWith(prefix) ? x.slice(prefix.length) : x));
      await this.core.post(`/intg/instances/${enc(inst.integration_id)}/entities`, own);
    }
    return inst.integration_id;
  }

  async deleteDriver(id) {
    try {
      await this.core.delete(`/intg/drivers/${enc(id)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  /** Installs a custom-integration archive (update=true replaces an installed one, keeping its config files). */
  async install(archive, filename, { update = false } = {}) {
    return this.core.upload(`/intg/install${update ? "?update=true" : ""}`, archive, filename);
  }
}

/** Number of references to the instance in each part of a snapshot (used to check a restore). */
export function countRefs(snap, prefix) {
  const n = (o) => JSON.stringify(o ?? null).split(prefix).length - 1;
  const out = {};
  for (const a of snap.activities || []) out[`activity ${a.entity_id}`] = n(a.options);
  for (const m of snap.macros || []) out[`macro ${m.entity_id}`] = n(m.options);
  for (const { profileId, page } of snap.profilePages || []) out[`home page ${profileId}/${page.page_id}`] = n(page.items);
  for (const { profileId, group } of snap.profileGroups || []) out[`home group ${profileId}/${group.group_id}`] = n(group.entities);
  out.entities = (snap.configured || []).length;
  return out;
}

const enc = encodeURIComponent;
const text = (v) => (typeof v === "string" ? v : v?.en || (v && Object.values(v)[0]) || "");
