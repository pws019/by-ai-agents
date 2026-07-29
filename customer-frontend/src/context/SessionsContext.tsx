import { createContext, useContext, type ReactNode } from "react";

import { useSessions } from "../hooks/useSessions";

// SessionSidebar 是常驻组件，只在 AppLayout 挂载时初始化一次（这是故意的，见 PRD
// "左侧列表不重新挂载"）；ChatPanel 每次路由切换都会重新挂载。两者原本各自调用一次
// useSessions()，互不相通——ChatPanel 里新建了会话，SessionSidebar 那份状态完全不知道，
// 只能等整页刷新重新挂载才会看到。
//
// 用一个共享 Context 把 useSessions() 的状态提升到 AppLayout 层，两边读同一份状态、
// 调同一个 refresh()，新建会话后主动 refresh 一下就能让侧边栏立刻同步。
const SessionsContext = createContext<ReturnType<typeof useSessions> | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const sessions = useSessions();
  return <SessionsContext.Provider value={sessions}>{children}</SessionsContext.Provider>;
}

export function useSessionsContext() {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error("useSessionsContext 必须在 <SessionsProvider> 内部使用");
  }
  return ctx;
}
