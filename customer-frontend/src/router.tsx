import { createBrowserRouter, Navigate, useLocation } from "react-router";

import { AppLayout } from "./components/layout/AppLayout";
import { EducationLayout } from "./education/EducationLayout";
import { useAuth } from "./education/AuthContext";
import { LoginPage } from "./education/LoginPage";
import { MyApplicationsPage } from "./education/MyApplicationsPage";
import { MyLearningPage } from "./education/MyLearningPage";
import { TeacherApplicationsPage } from "./education/TeacherApplicationsPage";
import { TeacherHandoffsPage } from "./education/TeacherHandoffsPage";
import { TeacherLayout } from "./education/TeacherLayout";
import { IndexRoute } from "./routes/IndexRoute";
import { SessionRoute } from "./routes/SessionRoute";

// 学员端的入口守卫：没登录去登录页（记住来源页，登录后回跳）；老师没有学员这一套页面，送去老师工作台。
// 通过了就渲染 AppLayout——固定的会话侧栏，聊天/我的学习/我的申请都是它的 <Outlet />，
// 切换这三者时侧栏不会重新挂载，这也是它们能共享"新建会话""退出"这些入口的原因。
function StudentGate() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-on-surface-variant">加载中…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role === "teacher") return <Navigate to="/teacher" replace />;
  return <AppLayout />;
}

// 老师端同理：送到 TeacherLayout，申请审批/会话工作台是它的 <Outlet />。
function TeacherGate() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-on-surface-variant">加载中…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role === "student") return <Navigate to="/" replace />;
  return <TeacherLayout />;
}

export const router = createBrowserRouter([
  {
    element: <EducationLayout />,
    children: [
      { path: "login", element: <LoginPage /> },
      {
        element: <StudentGate />,
        children: [
          // / 是"待创建"态（发第一条消息才建会话），/sessions/:conversationId 打开已有会话。
          { index: true, element: <IndexRoute /> },
          { path: "sessions/:conversationId", element: <SessionRoute /> },
          { path: "my-learning", element: <MyLearningPage /> },
          { path: "my-applications", element: <MyApplicationsPage /> },
        ],
      },
      {
        element: <TeacherGate />,
        children: [
          { path: "teacher", element: <TeacherApplicationsPage /> },
          { path: "teacher/handoffs", element: <TeacherHandoffsPage /> },
        ],
      },
    ],
  },
]);
