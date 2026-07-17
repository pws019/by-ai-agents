import { mastra } from "../mastra";

async function main() {
  const agent = mastra.getAgentById("customerServiceAgent");

  const cases = [
    "我的快递到哪了？订单号OD202607170099。",
    "帮我推荐一部好看的电影。",
  ];

  for (const message of cases) {
    console.log(`\n=== 用户: ${message} ===`);
    const response = await agent.generate(message, {
      memory: { resource: "test-user", thread: `test-thread-${Date.now()}` },
    });
    console.log("Agent:", response.text);
    console.log("toolCalls:", JSON.stringify(response.toolCalls ?? [], null, 2));
    console.log("toolResults:", JSON.stringify(response.toolResults ?? [], null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
