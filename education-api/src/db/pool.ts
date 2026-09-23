// 运行时连接池：区别于 migrate.ts 里一次性用完就关的 Client——服务进程要长期存活，
// 每个请求各自借一条连接，用完还回池里，不是每个请求新开一条物理连接。
import pg from "pg";
import { APP_SCHEMA } from "./migrate.js";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, options: `-c search_path=${APP_SCHEMA}` });
}
