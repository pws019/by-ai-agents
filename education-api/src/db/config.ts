// 与 education-agent 使用同一个环境变量名；默认值对应 infra/education/.env.example。
export const DATABASE_URL =
  process.env.EDUCATION_DATABASE_URL ??
  "postgresql://edu:dev-only-change-me@localhost:5433/education";
