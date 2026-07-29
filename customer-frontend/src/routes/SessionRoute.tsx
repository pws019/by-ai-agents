import { useParams } from "react-router";

import { ChatPanel } from "../components/chat/ChatPanel";

// 对应 "/sessions/:threadId"：打开一个已存在的会话。
export function SessionRoute() {
  const { threadId } = useParams<{ threadId: string }>();
  return <ChatPanel threadId={threadId} />;
}
