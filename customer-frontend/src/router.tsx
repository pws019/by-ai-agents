import { createBrowserRouter } from "react-router";

import { AppLayout } from "./components/layout/AppLayout";
import { EducationLayout } from "./education/EducationLayout";
import { LoginPage } from "./education/LoginPage";
import { MyLearningPage } from "./education/MyLearningPage";
import { RequireAuth } from "./education/RequireAuth";
import { TeacherPlaceholderPage } from "./education/TeacherPlaceholderPage";
import { IndexRoute } from "./routes/IndexRoute";
import { SessionRoute } from "./routes/SessionRoute";

export const router = createBrowserRouter([
  // legacy 电商客服 Demo（dev:legacy），原样保留，不受下面教育路由影响。
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <IndexRoute /> },
      { path: "sessions/:threadId", element: <SessionRoute /> },
    ],
  },
  // 教育服务学生/老师入口（T-11）。独立的 <AuthProvider>，不复用上面 legacy 那棵树。
  {
    element: <EducationLayout />,
    children: [
      { path: "login", element: <LoginPage /> },
      {
        path: "my-learning",
        element: (
          <RequireAuth role="student">
            <MyLearningPage />
          </RequireAuth>
        ),
      },
      {
        path: "teacher",
        element: (
          <RequireAuth role="teacher">
            <TeacherPlaceholderPage />
          </RequireAuth>
        ),
      },
    ],
  },
]);
