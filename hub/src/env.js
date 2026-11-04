// Settings are PEGASUS_* (e.g. PEGASUS_PORT). Compose files written before the rename use
// PEGASIS_*: those still work, unless the new name is also set.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("PEGASIS_")) {
    const now = "PEGASUS_" + k.slice(8);
    if (process.env[now] === undefined) process.env[now] = v;
  }
}
