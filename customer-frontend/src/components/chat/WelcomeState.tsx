import { Icon } from "../ui/Icon";

const PROMPT_SUGGESTIONS = [
  { label: "查物流", example: "帮我查一下订单 SO20260112003 的物流" },
  { label: "退换货政策", example: "这单能申请七天无理由退货吗？" },
  { label: "商品使用说明", example: "这台冰箱冷藏室老是积水，怎么处理？" },
  { label: "质保咨询", example: "这台洗衣机的质保期是多久？" },
];

type WelcomeStateProps = {
  onPick: (text: string) => void;
};

// "待创建"态下的欢迎语 + 快捷示例，直接可以打字或点示例发送，
// 不是需要先点一个"开始"按钮的拦截式空状态（见 PRD「会话创建时机」）。
export function WelcomeState({ onPick }: WelcomeStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center max-w-container-max-width mx-auto px-gutter text-center">
      <div className="mb-8 p-6 rounded-full bg-surface-container flex items-center justify-center">
        <Icon name="support_agent" filled className="text-primary text-6xl" />
      </div>
      <h3 className="text-2xl font-semibold text-on-surface mb-3">有什么可以帮您？</h3>
      <p className="text-on-surface-variant text-body-md max-w-lg mb-10">
        我可以帮您查询物流、了解退换货政策、解答商品使用和质保相关的问题。
        直接在下面输入，或者点一个示例试试看。
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {PROMPT_SUGGESTIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            className="text-left p-4 rounded-xl border border-outline-variant hover:border-primary hover:bg-surface-container-low transition-all"
            onClick={() => onPick(item.example)}
          >
            <p className="text-label-md text-primary mb-1">{item.label}</p>
            <p className="text-body-sm text-on-surface-variant">“{item.example}”</p>
          </button>
        ))}
      </div>
    </div>
  );
}
