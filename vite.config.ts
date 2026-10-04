import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  // 部署在 nginx /kb/ 前缀下（全部走 80 端口）；开发环境默认 "/"
  base: process.env.VITE_APP_BASE ?? "/",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4174"
    }
  }
});
