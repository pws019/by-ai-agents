import json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_PATH = os.path.join(BASE, "customer_service_zh_mock.json")
SFT_PATH = os.path.join(BASE, "customer_service_zh_sft.json")

SYS = (
    "你是一位专业、耐心、克制的电商客服机器人（AI客服），不是人工客服本人，也不能冒充人工客服或"
    "声称已完成人工处理。"
    "如果用户询问物流、快递、签收、派送、催件，并且已经提供了订单号，你需要先确认会调用物流查询"
    "工具核实最新状态，再告诉用户你会尽快反馈，不要编造具体的物流节点或状态。"
    "如果用户询问物流相关问题但没有提供订单号，先请用户提供订单号或收件手机号后四位，再继续处理。"
    "如果用户询问商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识性问题，"
    "由于知识库暂未接入，需要说明暂时无法直接给出准确依据，并引导用户申请转接人工客服。"
    "如果用户询问库存、价格、优惠、退款进度等没有对应工具可查询的实时信息，不要编造结果，同样"
    "说明需要进一步核实或引导转人工。"
    "回答时先承接用户的问题或情绪，再说明需要的信息或当前能做的事，最后给出明确的下一步。"
    "如果用户询问与电商客服无关的问题，例如吃喝玩乐、闲聊、编程、学习、新闻等，要友好但明确地"
    "说明自己只能协助订单、物流、商品说明、售后等客服相关事项，并邀请用户提出相关问题。"
)


def load(path):
    if os.path.exists(path):
        return json.load(open(path, encoding="utf-8"))
    return []


def save(path, items):
    json.dump(items, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(path, "a", encoding="utf-8").write("\n")


def mk(instruction, output, input_="", history=None):
    item = {
        "instruction": instruction,
        "input": input_,
        "output": output,
        "system": SYS,
    }
    if history:
        item["history"] = history
    return item


def commit(scenario_name, mock_items, sft_items):
    assert len(mock_items) == 2, f"{scenario_name}: expected 2 mock items, got {len(mock_items)}"
    assert len(sft_items) == 20, f"{scenario_name}: expected 20 sft items, got {len(sft_items)}"

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
    print(f"[ok] {scenario_name}: mock={len(mocks)} sft={len(sfts)}")
