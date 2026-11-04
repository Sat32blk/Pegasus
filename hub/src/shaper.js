// Shapes the traffic of one integration session (one WebSocket between the remote's core and an
// integration on the hub) to spare the remote's Wi-Fi and battery:
//
//  - updates for entities the remote didn't subscribe to are dropped (many integrations send
//    every device they know; the remote ignores the ones it doesn't use)
//  - an entity update that repeats the last one sent is dropped
//  - while the remote sleeps, events are held: only the newest state of each entity (attributes
//    merged) and the newest device state are kept, and everything is delivered on wake, in one go
//  - optionally ("stay connected"), the remote's enter/exit standby events aren't passed to the
//    integration, so it keeps its connection to the device and the first press after waking is fast
//
// Only small text messages are looked at; anything else passes through untouched. Answers to the
// remote's requests are never held.

const MAX_LOOK = 256 * 1024; // larger messages pass through unparsed
const MAX_HELD = 2000; // entities held per session while asleep (more: oldest go out as they are)

export class SessionShaper {
  constructor({ keepConnected = () => false, count = () => {} } = {}) {
    this.keepConnected = keepConnected;
    this.count = count; // count(kind, n): "unsubscribed" | "repeat" | "merged" | "held" | "standby"
    this.subscribed = null; // Set of entity ids, or null until the remote subscribes (then all pass)
    this.last = new Map(); // entity id -> JSON of the last attributes sent
    this.held = new Map(); // entity id -> merged entity_change message (while asleep)
    this.heldOther = []; // other events held, in order (device state keeps only its newest)
    this.heldDevice = null;
  }

  /** A message from the remote to the integration. Returns it, or null to swallow it. */
  fromRemote(payload) {
    const m = small(payload);
    if (!m) return payload;
    if (m.kind === "req" && (m.msg === "subscribe_events" || m.msg === "unsubscribe_events")) {
      const ids = m.msg_data?.entity_ids;
      if (Array.isArray(ids)) {
        if (m.msg === "subscribe_events") {
          // an empty list subscribes to nothing in particular: don't filter on it
          if (ids.length) {
            this.subscribed ||= new Set();
            for (const id of ids) this.subscribed.add(String(id));
          }
        } else if (this.subscribed) for (const id of ids) this.subscribed.delete(String(id));
      }
      // the remote will want the current state of what it (re)subscribes to
      for (const id of ids || []) this.last.delete(String(id));
    }
    if (m.kind === "req" && m.msg === "get_entity_states") this.last.clear();
    if (m.kind === "event" && (m.msg === "enter_standby" || m.msg === "exit_standby") && this.keepConnected()) {
      this.count("standby", 1);
      return null;
    }
    return payload;
  }

  /**
   * A message from the integration to the remote. Returns the messages to send now (possibly none).
   * asleep: the remote is in standby.
   */
  fromDriver(payload, asleep) {
    const m = small(payload);
    if (!m || m.kind !== "event") {
      // answers and anything we don't understand: send, after anything held (keeps the order sane)
      return asleep || !this.hasHeld() ? [payload] : [...this.flush(), payload];
    }
    if (m.msg === "entity_change") {
      const d = m.msg_data || {};
      const id = d.entity_id != null ? String(d.entity_id) : null;
      if (id && this.subscribed && !this.subscribed.has(id)) {
        this.count("unsubscribed", 1);
        return [];
      }
      if (asleep && id) {
        const prev = this.held.get(id);
        if (prev) {
          prev.msg_data.attributes = { ...(prev.msg_data.attributes || {}), ...(d.attributes || {}) };
          this.count("merged", 1);
        } else {
          if (this.held.size >= MAX_HELD) return [payload]; // too many: let it through
          this.held.set(id, structuredClone(m));
          this.count("held", 1);
        }
        return [];
      }
      if (id) {
        const key = JSON.stringify(d.attributes ?? null);
        if (this.last.get(id) === key) {
          this.count("repeat", 1);
          return [];
        }
        this.last.set(id, key);
      }
      return this.hasHeld() ? [...this.flush(), payload] : [payload];
    }
    if (asleep) {
      if (m.msg === "device_state") {
        if (this.heldDevice) this.count("merged", 1);
        else this.count("held", 1);
        this.heldDevice = payload;
      } else {
        this.heldOther.push(payload);
        this.count("held", 1);
      }
      return [];
    }
    return this.hasHeld() ? [...this.flush(), payload] : [payload];
  }

  hasHeld() {
    return this.held.size > 0 || this.heldOther.length > 0 || !!this.heldDevice;
  }

  /** Everything held, to send on wake: other events in order, the device state, then entity states. */
  flush() {
    const out = [...this.heldOther];
    if (this.heldDevice) out.push(this.heldDevice);
    for (const [id, m] of this.held) {
      const key = JSON.stringify(m.msg_data?.attributes ?? null);
      if (this.last.get(id) === key) {
        this.count("repeat", 1);
        continue; // ended up where it started
      }
      this.last.set(id, key);
      out.push(Buffer.from(JSON.stringify(m)));
    }
    this.held.clear();
    this.heldOther = [];
    this.heldDevice = null;
    return out;
  }
}

/** The message as an object if it's small JSON text, else null. */
function small(payload) {
  if (!payload || payload.length > MAX_LOOK) return null;
  const first = payload[0];
  if (first !== 0x7b) return null; // "{"
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}
