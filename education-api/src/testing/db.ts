// 测试用：删除临时数据库。
import type pg from "pg";

/**
 * pool.end() 只是发出关闭，服务端的后端进程可能还没退出；此时 DROP DATABASE ... WITH (FORCE) 会向它们发终止信号，
 * 客户端就会收到 "terminating connection due to administrator command"，成为未捕获错误、让不相干的测试文件失败。
 * 所以先等这个库上的连接退净（最多 2 秒）再删；FORCE 仍保留，作为等待超时后的兜底。
 * 说明：这是对间歇性失败的推断性缓解，见 progress.md「已知局限」。
 */
export async function dropTestDatabase(admin: pg.Client, dbName: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [dbName]);
    if (rows[0]!.n === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
}
