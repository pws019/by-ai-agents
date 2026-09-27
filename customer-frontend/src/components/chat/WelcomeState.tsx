import { Icon } from "../ui/Icon";

const PROMPT_SUGGESTIONS = [
  { label: "查课表", example: "我的课表是什么？" },
  { label: "看进度", example: "我学到哪了？" },
  { label: "转班", example: "我想转班，时间有冲突" },
  { label: "退费", example: "我想退费" },
];

type WelcomeStateProps = {
  onPick: (text: string) => void;
};

// "待创建"态下的欢迎语 + 快捷示例：直接可以打字或点示例，不是需要先点"开始"的拦截式空状态。
export function WelcomeState({ onPick }: WelcomeStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center max-w-container-max-width mx-auto px-gutter text-center">
      <div className="mb-8 p-6 rounded-full bg-surface-container flex items-center justify-center">
        <Icon name="support_agent" filled className="text-primary text-6xl" />
      </div>
      <h3 className="text-2xl font-semibold text-on-surface mb-3">有什么可以帮你？</h3>
      <p className="text-on-surface-variant text-body-md max-w-lg mb-10">
        我可以帮你查询课表和学习进度、了解可转入的班期，也可以帮你起草转班或退费申请（提交前需要你本人确认）。
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
