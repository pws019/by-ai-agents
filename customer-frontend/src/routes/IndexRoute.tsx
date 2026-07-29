import { ChatPanel } from "../components/chat/ChatPanel";

// 对应 "/"：全局零会话的首次访问、或点了侧边栏"新建会话"，都落到这里。
// 不传 threadId，ChatPanel 内部按"待创建"态渲染。
export function IndexRoute() {
  return <ChatPanel />;
}
