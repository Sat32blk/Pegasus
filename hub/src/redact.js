// Masks secrets in integration log lines before the hub stores or shows them.
//
// Integrations often log everything they receive at debug level, including what the user typed
// into their setup screens (API keys, passwords, PINs, tokens). The hub keeps those logs in its
// data folder and shows them on its page, so values of secret-looking fields are replaced by ***.

const SECRET_NAME = "(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|pwd|pin|pin[_-]?code|passcode|auth|authorization|cookie|session[_-]?id)";

// "name": "value" / 'name': 'value' / name=value / name: value  (JSON, Python dicts, query strings, headers)
const FIELD = new RegExp(`((?:^|[^A-Za-z0-9_-])(["']?)${SECRET_NAME}\\\\?\\2\\s*[:=]\\s*)(\\\\?["']?)(?!(?:Bearer|Basic)\\s)([^"'\\s,;&}\\]\\\\]+)`, "gi");
// "Bearer xxx" / "Basic xxx" anywhere
const SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g;

export function redact(line) {
  if (typeof line !== "string" || !line) return line;
  return line.replace(SCHEME, "$1 ***").replace(FIELD, (m, head, _q, open, value) => (value === "***" ? m : `${head}${open}***`));
}
