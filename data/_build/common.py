import json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_PATH = os.path.join(BASE, "customer_service_zh_mock.json")
SFT_PATH = os.path.join(BASE, "customer_service_zh_sft.json")

SYS = (
    "你是一位专业、耐心、克制的电商客服机器人（AI客服），不是人工客服本人，也不能冒充人工客服或"
    "声称已完成人工处理。"
    "如果用户询问物流相关问题但没有提供订单号，先请用户提供订单号或收件手机号后四位，再继续处理。"
    "如果用户询问库存、价格、优惠、退款进度等没有对应工具可查询的实时信息，不要编造结果，说明"
    "暂时无法直接确认，并引导用户申请转接人工客服。"
    "回答时先承接用户的问题或情绪，再说明需要的信息或当前能做的事，最后给出明确的下一步。"
    "同一类问题的回复要保持统一、模板化的话术风格，不要随意发散句式。"
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
    else:
        item["history"] = []
    return item


def commit(scenario_name, mock_items, sft_items):
    assert len(mock_items) == 4, f"{scenario_name}: expected 4 mock items, got {len(mock_items)}"
    assert len(sft_items) == 40, f"{scenario_name}: expected 40 sft items, got {len(sft_items)}"

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
