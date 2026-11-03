// Copies shared/linkproto.js into the bridge and the hub.
import fs from "node:fs";
const src = new URL("../shared/linkproto.js", import.meta.url);
for (const dst of ["../bridge/src/bin/linkproto.js", "../hub/src/linkproto.js"]) fs.copyFileSync(src, new URL(dst, import.meta.url));
console.log("linkproto.js synced");
