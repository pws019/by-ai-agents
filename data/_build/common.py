import json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_PATH = os.path.join(BASE, "customer_service_zh_mock.json")
SFT_PATH = os.path.join(BASE, "customer_service_zh_sft.json")

# 与 customer-agents/src/mastra/agents/customer-service-agent.ts 里 SYSTEM_PROMPT 逐字一致。
# LoRA 现在的定位是语气/结构微调，不是范围判断，所以训练时必须让模型在“真实生产 prompt”
# 下学习，而不是一份改写版——否则学到的行为跟真实运行环境对不上，等于白训。
# 如果生产端改了这段话，这里要同步改，两边永远保持逐字相同。
SYS = (
    "你是专业、耐心、克制的电商客服。\n"
    "如果用户询问物流、快递、签收、派送、催件，并且提供了订单号，必须先调用 logisticsLookupTool 查询。\n"
    "如果用户询问物流但没有提供订单号，先请用户提供订单号或收件手机号后四位。\n"
    "如果用户询问商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识，优先调用 knowledgeRagTool 检索知识库，再基于工具返回的 relevantContext 和 sources 回答。\n"
    "knowledgeRagTool 只用于非实时知识，不要用于实时订单、物流、库存、价格、退款进度等查询。\n"
    "不要编造订单、物流、库存、价格、退款进度或售后政策；knowledgeRagTool 没有命中、或 logisticsLookupTool 查询失败时，要说明暂未查到准确依据，并建议转人工或补充商品/订单信息。\n"
    "回答时先承接用户情绪，再说明查询结果或需要的信息，最后给出下一步处理方式。\n"
    "如果用户询问与电商客服无关的问题，例如吃喝玩乐、闲聊、编程、学习、新闻等，要友好但明确地说明自己只能协助订单、物流、商品说明、售后等客服相关事项，并邀请用户提供相关问题。"
)


def load(path):
    if os.path.exists(path):
        return json.load(open(path, encoding="utf-8"))
    return []


def save(path, items):
    json.dump(items, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(path, "a", encoding="utf-8").write("\n")


def mk(instruction, output, input_="", history=None):
    return {
        "instruction": instruction,
        "input": input_,
        "output": output,
        "system": SYS,
        "history": history or [],
    }


def commit(scenario_name, mock_items, sft_items):
    mocks = load(MOCK_PATH)
    sfts = load(SFT_PATH)

    existing_instr = {m["instruction"] for m in mocks} | {s["instruction"] for s in sfts}

    new_instr = [m["instruction"] for m in mock_items] + [s["instruction"] for s in sft_items]
    dupes = [i for i in new_instr if i in existing_instr]
    if dupes:
        raise ValueError(f"{scenario_name}: duplicate instruction(s) already present: {dupes}")
    if len(set(new_instr)) != len(new_instr):
        raise ValueError(f"{scenario_name}: duplicate instruction(s) within this scenario batch")

    mocks.extend(mock_items)
    sfts.extend(sft_items)
    save(MOCK_PATH, mocks)
    save(SFT_PATH, sfts)
    print(f"[ok] {scenario_name}: +{len(sft_items)} sft (+{len(mock_items)} mock), total sft={len(sfts)} mock={len(mocks)}")
