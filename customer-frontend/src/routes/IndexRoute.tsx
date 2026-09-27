import { ChatPanel } from "../components/chat/ChatPanel";

// 对应 "/"：不传 conversationId，聊天面板按"待创建"态渲染——发第一条消息时才真正建会话。
export function IndexRoute() {
  return <ChatPanel />;
}
