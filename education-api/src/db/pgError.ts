// drizzle 把底层 pg 驱动抛出的错误包进 DrizzleQueryError，原始错误（带 .code）挂在 .cause 上，
// 不再是错误对象本身的直接属性——判断具体是哪种 Postgres 错误时要先解包，两层都要看。
const UNIQUE_VIOLATION = "23505";

function pgErrorCode(err: unknown): string | undefined {
  const direct = (err as { code?: string })?.code;
  if (direct) return direct;
  return (err as { cause?: { code?: string } })?.cause?.code;
}

export const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === UNIQUE_VIOLATION;
