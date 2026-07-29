import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Icon } from "../ui/Icon";

type ChatInputProps = {
  disabled: boolean;
  onSend: (text: string) => void;
  value?: string;
};

export function ChatInput({ disabled, onSend, value }: ChatInputProps) {
  const [text, setText] = useState(value ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    requestAnimationFrame(resize);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <footer className="p-inset-padding md:px-0 md:pb-8 flex justify-center bg-transparent">
      <div className="w-full max-w-container-max-width px-4">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-[0_4px_6px_-1px_rgb(0_0_0/0.1),0_2px_4px_-2px_rgb(0_0_0/0.1)] focus-within:border-primary transition-all p-2">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none text-body-md py-2 px-2 resize-none max-h-40"
              placeholder="输入消息…"
              rows={1}
              value={text}
              disabled={disabled}
              onChange={(e) => {
                setText(e.target.value);
                resize();
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={handleSend}
              className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 transition-all active:scale-90 ${
                canSend
                  ? "bg-primary text-on-primary hover:shadow-md"
                  : "bg-surface-container-high text-secondary cursor-not-allowed"
              }`}
            >
              <Icon name="send" filled />
            </button>
          </div>
        </div>
        <p className="text-center text-[11px] text-outline mt-3">
          AI 生成内容可能有误，重要信息请与实际业务核实。
        </p>
      </div>
    </footer>
  );
}
