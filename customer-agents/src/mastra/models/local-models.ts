import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// 本地 Qwen3-8B + LoRA 的 OpenAI-compatible chat/completions 服务。
export const localModel = createOpenAICompatible({
  name: "yd-local-model",
  baseURL: process.env.LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:8123/v1",
  apiKey: process.env.LOCAL_MODEL_API_KEY ?? "local-not-used",
});

export const localChatModel = localModel.chatModel(
  process.env.LOCAL_MODEL_ID ?? "local-qwen3-8b-lora",
);
