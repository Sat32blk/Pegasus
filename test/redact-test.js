// The hub masks secrets in integration logs.
import assert from "node:assert/strict";
import { redact } from "../hub/src/redact.js";

const k = "00000000-1111-4222-8333-444444444444";
const cases = [
  // the Govee integration's real log lines (ucapi debug output), key replaced by a fake one
  [`DEBUG | ucapi.api | <-: {"kind":"req","id":2,"msg":"setup_driver","msg_data":{"language":"en_US","reconfigure":false,"setup_data":{"api_key":"${k}"}}}`, `"api_key":"***"`],
  [`'setup_data': {'api_key': '${k}'}`, `'api_key': '***'`],
  [`headers={"Content-Type": "application/json", "Govee-API-Key": "${k}"}`, `"Govee-API-Key": "***"`],
  [`GET /x?apikey=${k}&page=2`, `apikey=***&page=2`],
  [`{"password":"hunter22","pin":"1234","access_token":"abc.def.ghi"}`, `{"password":"***","pin":"***","access_token":"***"}`],
  [`Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc`, `Bearer ***`],
  [`client_secret=s3cr3t; token=xyz`, `client_secret=***; token=***`],
  // escaped JSON (a log line that itself contains JSON as a string)
  [`{\\"api_key\\":\\"${k}\\"}`, `***`]
];
for (const [input, expect] of cases) {
  const out = redact(input);
  assert.ok(out.includes(expect), `expected ${expect} in: ${out}`);
  assert.ok(!out.includes(k) && !out.includes("hunter22") && !out.includes("s3cr3t") && !out.includes("eyJhbGci"), `secret left in: ${out}`);
}
// harmless lines stay as they are
for (const s of [
  "INFO | websockets.server | server listening on 127.0.0.1:10100",
  "mapping_count: 5, spinner: on, keyboard: us, tokens_used: 12",
  "Driver is up: uc-intg-govee, version: 0.3.5",
  `'setup_data_schema': {'settings': [{'id': 'api_key', 'label': {'en': 'Govee API Key'}}]}`
]) assert.equal(redact(s), s, `changed a harmless line: ${s}`);
console.log(`redact-test: ${cases.length + 4} checks ok`);
