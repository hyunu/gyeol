import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 개발 중에는 API 서버(기본 8080)로 /api 를 프록시한다.
 * 운영 빌드는 VITE_API_BASE 로 API 주소를 주입한다.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
