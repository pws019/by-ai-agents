import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "./config.js";
import { migrate } from "./migrate.js";

const dir = fileURLToPath(new URL("./migrations", import.meta.url));
const ran = await migrate(DATABASE_URL, dir);
console.log(ran.length ? `已执行: ${ran.join(", ")}` : "没有待执行的迁移");
