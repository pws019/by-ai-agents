import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_tools import mk_tool_call, commit_tools

# 场景：调用了 knowledgeRagTool，但没有检索到有效结果（relevantContext 为空）。
# 训练目标：工具调了、也没查到东西时，不能编造答案，要如实说明并给出下一步。

CASES = [
    "这台跑步机的电机功率是多少",
    "这款空调支持自清洁功能吗",
    "这台洗碗机能用几年，有没有具体寿命说明",
    "这个吸尘器的滤网型号是多少",
    "这台微波炉能不能用来烘焙",
    "这款豆浆机噪音大概多少分贝",
    "这台加湿器的水箱能装多少毫升",
    "这款咖啡机适合什么样的咖啡豆",
    "这台除湿机的除湿量是多少",
    "这款破壁机能不能打热汤",
    "这台电饭煲有没有预约功能的详细说明",
    "这款净水器的滤芯多久更换一次",
    "这台烤箱最高温度能到多少度",
    "这款投影仪支持多大的投射尺寸",
    "这台电烤箱有没有童锁功能",
    "这款榨汁机能不能打冰沙",
    "这台电风扇的噪音等级是多少",
    "这款按摩椅支持几种按摩模式",
    "这台电热水器的加热速度怎么样",
    "这款空气净化器适合多大面积的房间",
    "这台油烟机的吸力参数是多少",
    "这款破壁机的电机质保期是多久",
    "这台冰柜的容量具体是多少升",
    "这款蒸烤箱支持哪些预设菜谱",
]

OPENERS = ["您好，理解您想了解详细参数，", "您好，收到您的问题了，", "您好，感谢您的耐心，", "您好，非常抱歉，"]


def mk_item(i, user_msg):
    obs = {"relevantContext": [], "sources": []}
    answer = (
        f"{OPENERS[i % len(OPENERS)]}暂时没有在知识库里查到与这个问题准确匹配的资料，"
        "不方便给您一个不确定的答复。建议您提供更具体的商品型号，或者我这边为您转接人工客服进一步核实，"
        "确保信息准确。"
    )
    return mk_tool_call(user_msg, "knowledgeRagTool", {"queryText": user_msg, "topK": 25}, obs, answer)


sft_items = [mk_item(i, u) for i, u in enumerate(CASES)]

MOCK_CASES = ["这款电磁炉支持的锅具材质有哪些", "这台冰箱的能效等级是多少", "这款空调的能效比是多少"]
mock_items = [mk_item(i + 100, u) for i, u in enumerate(MOCK_CASES)]

commit_tools("F4-非实时知识检索未命中", mock_items, sft_items)
