// 校验事件 schema 的正反例，以及 openapi.yaml 中的错误示例是否符合 ErrorResponse。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };

const validateEvent = ajv.compile(JSON.parse(read("events.schema.json")));
for (const e of JSON.parse(read("examples/events.valid.json"))) {
  check(validateEvent(e), `valid event ${e.type}${validateEvent.errors ? " " + JSON.stringify(validateEvent.errors) : ""}`);
}
for (const { why, event } of JSON.parse(read("examples/events.invalid.json"))) {
  check(!validateEvent(event), `rejects: ${why}`);
}

const spec = YAML.parse(read("openapi.yaml"));
const validateErr = ajv.compile(spec.components.schemas.ErrorResponse);
let n = 0;
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    for (const [code, res] of Object.entries(op.responses ?? {})) {
      for (const [name, ex] of Object.entries(res.content?.["application/json"]?.examples ?? {})) {
        if (!code.startsWith("4")) continue;
        n++;
        check(validateErr(ex.value), `${method.toUpperCase()} ${path} ${code} example "${name}" matches ErrorResponse`);
      }
    }
  }
}
check(n >= 3, `found ${n} error examples (need >= 3)`);
process.exit(failed ? 1 : 0);
