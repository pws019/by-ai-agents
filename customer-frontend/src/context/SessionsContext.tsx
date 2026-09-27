import { createContext, useContext, type ReactNode } from "react";

import { useConversations } from "../hooks/useConversations";

// 左侧栏是常驻组件，只在布局挂载时初始化一次；右侧聊天面板随路由重新挂载。两边共用同一份会话列表状态，
// 面板里新建会话后调 refresh()，侧边栏就能立刻同步，不必等整页刷新。
const SessionsContext = createContext<ReturnType<typeof useConversations> | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const value = useConversations();
  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessionsContext() {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessionsContext 必须在 <SessionsProvider> 内部使用");
  return ctx;
}
