#!/usr/bin/env node
/**
 * API 실행 진입점.
 *
 * 구현은 apps/api/src (TypeScript) 에 있고, 이 파일은 기존 Phase 0b 계약 테스트가
 * `createApp` 을 그대로 import 할 수 있도록 유지하는 얇은 래퍼다.
 */
import { createApp, CONTRACT_VERSION } from "./src/http/server.ts";

export { createApp, CONTRACT_VERSION };

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  createApp().listen(port, host, () => {
    console.log(
      `GYEOL API http://${host}:${port} (contract ${CONTRACT_VERSION}, env ${process.env.GYEOL_ENV ?? "local"})`,
    );
  });
}
