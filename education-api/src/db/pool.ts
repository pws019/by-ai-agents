// 运行时连接池：区别于 migrate.ts 里一次性用完就关的 Client——服务进程要长期存活，
// 每个请求各自借一条连接，用完还回池里，不是每个请求新开一条物理连接。
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { APP_SCHEMA } from "./migrate.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, options: `-c search_path=${APP_SCHEMA}` });
}

// schema.ts 里的表用 pgSchema("app") 定义，生成的 SQL 会显式带 app. 前缀，
// 不依赖连接的 search_path——两边其实是双保险，不是谁替代谁。
export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
