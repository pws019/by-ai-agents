/**
 * RAG 的集中配置。
 *
 * 这份文件的作用是把“可变的基础设施参数”收口到一起：
 * - Qdrant 在哪里
 * - collection 叫什么
 * - embedding 服务在哪里
 * - 向量维度是多少
 * - 检索时取多少条、最低相似度是多少
 *
 * 代码里的其他模块只读 ragConfig，不直接散落 process.env，
 * 这样后续换向量模型、换 Qdrant 地址、调 topK 时不用到处改。
 */
export const ragConfig = {
  // Qdrant HTTP API 地址。本地 docker 默认暴露 6333。
  qdrantUrl: process.env.QDRANT_URL ?? "http://127.0.0.1:6333",
  // 一个 collection 可以理解为一张“向量表”，这里专门放维修知识。
  qdrantCollection: process.env.QDRANT_COLLECTION ?? "customer_service_repair_knowledge",
  // Qwen3-Embedding-0.6B 默认 1024 维；collection 创建后维度不能随便改。
  vectorSize: Number(process.env.QDRANT_VECTOR_SIZE ?? "1024"),
  // 从 Qdrant 取回最相似的前几条知识片段。
  topK: Number(process.env.RAG_TOP_K ?? "5"),
  // 分数太低的结果直接丢掉，避免拿不相关文档喂给 LLM。
  scoreThreshold: Number(process.env.RAG_SCORE_THRESHOLD ?? "0.35"),
  // 默认按 TEI 风格 /embed 接口调用，也支持 openai-compatible /v1/embeddings。
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "tei",
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? "http://127.0.0.1:8080",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B",
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? "local-not-used",
  // Qwen embedding 支持 instruction-aware 检索：文档和问题用不同 instruction 会更贴近检索任务。
  documentInstruction:
    process.env.RAG_DOCUMENT_INSTRUCTION ??
    "Represent this maintenance knowledge document for retrieval:",
  queryInstruction:
    process.env.RAG_QUERY_INSTRUCTION ??
    "Represent this customer service question for retrieving relevant appliance repair knowledge:",
};
