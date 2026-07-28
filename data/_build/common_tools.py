import json, os

from common import SYS, load, save

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_TOOLS_PATH = os.path.join(BASE, "customer_service_zh_sft_tools_mock.json")
SFT_TOOLS_PATH = os.path.join(BASE, "customer_service_zh_sft_tools.json")

# 逐字对应 customer-agents/src/mastra/tools/{knowledge-rag,logistics-lookup}.ts 的
# inputSchema。训练时把两个工具都放进 tools，让模型学会“在多个候选里选对的那个”，
# 而不是只见过单一工具、无从练习挑选。
TOOLS = [
    {
        "name": "knowledgeRagTool",
        "description": (
            "检索商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识。只用于非实时知识，"
            "不要用于实时订单、物流、库存、价格、退款进度等查询。调用时 queryText 使用用户原问题，topK 使用 25 "
            "以便先召回候选，再由 rerank 精排。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "queryText": {"type": "string", "description": "用户原始问题，用于生成查询向量"},
                "topK": {"type": "number", "description": "先召回的候选数量"},
            },
            "required": ["queryText", "topK"],
        },
    },
    {
        "name": "logisticsLookupTool",
        "description": (
            "根据订单号查询该订单当前的物流状态、最新节点和承运信息。仅在用户已提供订单号且询问物流、"
            "快递、签收、派送、催件时调用；不要用于库存、价格、退款进度等其他实时信息查询。"
        ),
        "parameters": {
            "type": "object",
            "properties": {"orderId": {"type": "string", "description": "订单号"}},
            "required": ["orderId"],
        },
    },
]
TOOLS_JSON = json.dumps(TOOLS, ensure_ascii=False)


def mk_tool_call(user_msg, tool_name, arguments, observation, final_answer):
    """构造一条 human -> function_call -> observation -> gpt 的四轮样本。"""
    return {
        "conversations": [
            {"from": "human", "value": user_msg},
            {
                "from": "function_call",
                "value": json.dumps({"name": tool_name, "arguments": arguments}, ensure_ascii=False),
            },
            {"from": "observation", "value": json.dumps(observation, ensure_ascii=False)},
            {"from": "gpt", "value": final_answer},
        ],
        "system": SYS,
        "tools": TOOLS_JSON,
    }


def _instruction_of(item):
    return item["conversations"][0]["value"]


def commit_tools(scenario_name, mock_items, sft_items):
    mocks = load(MOCK_TOOLS_PATH)
    sfts = load(SFT_TOOLS_PATH)

    existing_instr = {_instruction_of(m) for m in mocks} | {_instruction_of(s) for s in sfts}
    new_instr = [_instruction_of(m) for m in mock_items] + [_instruction_of(s) for s in sft_items]
    dupes = [i for i in new_instr if i in existing_instr]
    if dupes:
        raise ValueError(f"{scenario_name}: duplicate instruction(s) already present: {dupes}")
    if len(set(new_instr)) != len(new_instr):
        raise ValueError(f"{scenario_name}: duplicate instruction(s) within this scenario batch")

    mocks.extend(mock_items)
    sfts.extend(sft_items)
    save(MOCK_TOOLS_PATH, mocks)
    save(SFT_TOOLS_PATH, sfts)
    print(f"[ok] {scenario_name}: +{len(sft_items)} sft (+{len(mock_items)} mock), total sft={len(sfts)} mock={len(mocks)}")
