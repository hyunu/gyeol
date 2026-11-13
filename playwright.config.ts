import { defineConfig, devices } from "@playwright/test";

/**
 * W-17 E2E.
 *
 * globalSetup 이 메모리 API(8080)를 띄우고 고정 데이터를 넣는다.
 * webServer 는 Vite(5273)를 띄우며 /api 를 8080 으로 프록시한다.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5273",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  globalSetup: "./tests/e2e/global-setup.mjs",
  webServer: {
    command: "npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5273 --strictPort",
    url: "http://127.0.0.1:5273",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
