import { createBrowserRouter, Navigate } from "react-router";

import { AppLayout } from "./components/layout/AppLayout";
import { EducationLayout } from "./education/EducationLayout";
import { useAuth } from "./education/AuthContext";
import { LoginPage } from "./education/LoginPage";
import { MyApplicationsPage } from "./education/MyApplicationsPage";
import { MyLearningPage } from "./education/MyLearningPage";
import { RequireAuth } from "./education/RequireAuth";
import { TeacherApplicationsPage } from "./education/TeacherApplicationsPage";
import { IndexRoute } from "./routes/IndexRoute";
import { SessionRoute } from "./routes/SessionRoute";

// 聊天首页的入口守卫：没登录去登录页（登录后回来）；老师没有学员聊天，送去老师工作台；学员才渲染聊天布局。
function ChatGate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-on-surface-variant">加载中…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: "/" }} />;
  if (user.role === "teacher") return <Navigate to="/teacher" replace />;
  return <AppLayout />;
}

export const router = createBrowserRouter([
  {
    element: <EducationLayout />,
    children: [
      { path: "login", element: <LoginPage /> },
      // 学员聊天：/ 是"待创建"态（发第一条消息才建会话），/sessions/:conversationId 打开已有会话。
      {
        element: <ChatGate />,
        children: [
          { index: true, element: <IndexRoute /> },
          { path: "sessions/:conversationId", element: <SessionRoute /> },
        ],
      },
      {
        path: "my-learning",
        element: (
          <RequireAuth role="student">
            <MyLearningPage />
          </RequireAuth>
        ),
      },
      {
        path: "my-applications",
        element: (
          <RequireAuth role="student">
            <MyApplicationsPage />
          </RequireAuth>
        ),
      },
      {
        path: "teacher",
        element: (
          <RequireAuth role="teacher">
            <TeacherApplicationsPage />
          </RequireAuth>
        ),
      },
    ],
  },
]);
