import { Icon } from "../ui/Icon";

type TypingIndicatorProps = {
  label: string;
};

export function TypingIndicator({ label }: TypingIndicatorProps) {
  return (
    <div className="flex justify-start w-full">
      <div className="flex gap-4 max-w-[85%]">
        <div className="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center shrink-0">
          <Icon name="smart_toy" filled className="text-[18px] text-primary" />
        </div>
        <div className="flex items-center gap-3 px-4 py-3 border border-outline-variant rounded-full w-fit bg-surface-container-lowest">
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-primary rounded-full typing-dot" />
            <span className="w-1.5 h-1.5 bg-primary rounded-full typing-dot" />
            <span className="w-1.5 h-1.5 bg-primary rounded-full typing-dot" />
          </span>
          <span className="text-label-sm text-secondary">{label}</span>
        </div>
      </div>
    </div>
  );
}
