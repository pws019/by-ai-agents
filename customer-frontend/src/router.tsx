import { createBrowserRouter } from "react-router";

import { AppLayout } from "./components/layout/AppLayout";
import { IndexRoute } from "./routes/IndexRoute";
import { SessionRoute } from "./routes/SessionRoute";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <IndexRoute /> },
      { path: "sessions/:threadId", element: <SessionRoute /> },
    ],
  },
]);
