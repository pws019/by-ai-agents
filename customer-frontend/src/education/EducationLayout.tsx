// 只包住教育相关路由的 <AuthProvider>，不包到 legacy 聊天路由上——
// 否则 legacy Demo（dev:legacy，不起 education-api）加载时会白白发一个注定失败的 GET /me。
import { Outlet } from "react-router";
import { AuthProvider } from "./AuthContext";

export function EducationLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
