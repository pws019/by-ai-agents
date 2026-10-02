import { useLocation, useParams } from "react-router";

import { ChatPanel } from "../components/chat/ChatPanel";
import type { ChatState } from "../lib/chat/state";

// 对应 "/sessions/:conversationId"：打开一个已存在的会话，或者（刚建好的新会话）接收 ChatPanel
// 通过 navigate(path, { state }) 带过来的 seedState——见 ChatPanel/useChat.ts 里的说明。
// 普通打开一个老会话（点侧边栏链接、直接输入 URL、刷新页面）没有这个 state，undefined 就按老流程走。
export function SessionRoute() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();
  const seedState = (location.state as { seedState?: ChatState } | null)?.seedState;
  return <ChatPanel conversationId={conversationId} seedState={seedState} />;
}
