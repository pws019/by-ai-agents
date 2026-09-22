import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

// 业务表放在 app schema，checkpoint 在 agent_checkpoint，互不混用。
export const APP_SCHEMA = "app";

// 任意固定整数：同一个库上所有迁移进程用它互斥，避免两个进程同时建表。
const LOCK_KEY = 728301;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * 按文件名顺序执行 dir 下尚未执行的 .sql 迁移，返回本次新执行的文件名。
 *
 * - 每个迁移文件在一个事务里执行，失败整体回滚，不会留下半张表。
 * - 已执行的迁移记录内容指纹；文件被改动或被删除时直接报错，
 *   因为"改已执行的迁移"会让不同环境的表结构悄悄分叉。
 */
export async function migrate(connectionString: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString, options: `-c search_path=${APP_SCHEMA}` });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const rows = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const name of applied.keys()) {
      if (!files.includes(name)) throw new Error(`已执行的迁移 ${name} 在磁盘上不存在`);
    }

    const ran: string[] = [];
    for (const name of files) {
      const sql = await readFile(join(dir, name), "utf8");
      const checksum = sha256(sql);
      const previous = applied.get(name);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`迁移 ${name} 已执行过，但内容被修改（checksum 不一致）`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`迁移 ${name} 失败: ${(err as Error).message}`, { cause: err });
      }
      ran.push(name);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
