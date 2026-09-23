import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 端口跟 customer-agents 的 mastra dev（4111）错开，避免冲突。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 代理到 education-api（8400），浏览器眼里请求和页面同源，
      // session cookie 能自动带上，不用为开发环境单独搭一套 CORS。
      "/api": "http://127.0.0.1:8400",
    },
  },
});
