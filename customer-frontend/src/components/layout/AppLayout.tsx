import { Outlet } from "react-router";

import { SessionsProvider } from "../../context/SessionsContext";
import { SessionDrawer } from "../sidebar/SessionDrawer";
import { SessionSidebar } from "../sidebar/SessionSidebar";

// 两栏 layout route：左侧固定宽度（280px，token 见 index.css 的 --spacing-sidebar-width，
// 现在只是导航 + 用户信息），右侧 <Outlet /> 根据当前路由渲染 ChatPanel。宽度是布局常量，
// 不随左侧内容多少变化，切换会话只替换右侧内容，左侧不会重新挂载。
// SessionDrawer 悬浮在右上角，收起时不占空间，展开时从右侧盖上来——"新建会话"/"最近会话"
// 从以前常驻的左侧栏挪到这里。
//
// <SessionsProvider> 包在这一层：SessionDrawer 和右侧 ChatPanel（随路由重新挂载）
// 共用同一份会话列表状态，右侧新建会话后能主动通知抽屉刷新，不用等整页刷新。
export function AppLayout() {
  return (
    <SessionsProvider>
      <div className="h-screen w-screen flex overflow-hidden bg-surface text-on-background">
        <div className="w-sidebar-width h-full shrink-0 border-r border-outline-variant">
          <SessionSidebar />
        </div>
        <div className="flex-1 h-full min-w-0">
          <Outlet />
        </div>
        <SessionDrawer />
      </div>
    </SessionsProvider>
  );
}
