#!/usr/bin/env node
/**
 * 릴리스 수용 테스트 러너 (W-29).
 *
 * 로컬에서 실행 가능한 검증을 한 번에 돌리고 표로 요약한다.
 * 하드웨어·실 provider·배포 인증서처럼 환경 의존 항목은 SKIP 으로 남긴다.
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run acceptance
 *   npm run acceptance -- --with-ios
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withIos = process.argv.includes("--with-ios");
const databaseUrl = process.env.DATABASE_URL;
const s3 = Boolean(process.env.S3_ENDPOINT);

function findPio() {
  if (process.env.PIO_BIN) return process.env.PIO_BIN;
  const candidates = [
    `${process.env.HOME}/.platformio/penv/bin/pio`,
    "/opt/homebrew/bin/pio",
    "/usr/local/bin/pio",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["pio", "platformio"]) {
    const probe = spawnSync("which", [name], { encoding: "utf8" });
    const found = probe.status === 0 ? probe.stdout.trim().split("\n")[0] : "";
    if (found && existsSync(found)) return found;
  }
  return `${process.env.HOME}/.platformio/penv/bin/pio`;
}

const pioBin = findPio();
const hasPio = existsSync(pioBin);
const hasXcodebuild = existsSync("/usr/bin/xcodebuild");

const checks = [
  { name: "계약 + 타입 + 단위/통합", command: "npm", args: ["run", "check"], required: true },
  {
    name: "DB 마이그레이션 제약",
    command: "npm",
    args: ["run", "db:checks"],
    required: true,
    skip: databaseUrl ? null : "DATABASE_URL 없음",
  },
  {
    name: "PostgreSQL 패리티",
    command: "npm",
    args: ["run", "test:db"],
    required: true,
    skip: databaseUrl ? null : "DATABASE_URL 없음",
  },
  {
    name: "S3/MinIO 스토리지",
    command: "npm",
    args: ["run", "test:s3"],
    required: false,
    skip: s3 ? null : "S3_ENDPOINT 없음",
  },
  { name: "웹 E2E", command: "npm", args: ["run", "test:e2e"], required: true },
  {
    name: "Swift BLE 패키지",
    command: "swift",
    args: ["test", "--package-path", "apps/ios/Packages/GyeolBLE"],
    required: true,
    skip: process.platform !== "darwin" ? "macOS 전용" : null,
  },
  {
    name: "펌웨어 빌드 (ESP32-S3)",
    command: pioBin,
    args: ["run"],
    cwd: path.join(ROOT, "firmware", "esp32s3"),
    required: false,
    skip: hasPio ? null : "PlatformIO 없음",
  },
  {
    name: "iOS 시뮬레이터 빌드",
    command: "xcodebuild",
    args: [
      "-project",
      "Gyeol.xcodeproj",
      "-scheme",
      "Gyeol",
      "-sdk",
      "iphonesimulator",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      "/tmp/gyeol-ios-build",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    cwd: path.join(ROOT, "apps", "ios"),
    required: false,
    skip: !withIos ? "--with-ios 미지정" : hasXcodebuild ? null : "Xcode 없음",
  },
];

const results = [];
for (const check of checks) {
  if (check.skip) {
    results.push({ ...check, status: "SKIP", seconds: 0 });
    continue;
  }
  const started = Date.now();
  const result = await run(check);
  results.push({ ...check, ...result, seconds: (Date.now() - started) / 1000 });
}

console.log("\n| 검증 | 결과 | 시간 |");
console.log("| --- | --- | ---: |");
for (const result of results) {
  const label =
    result.status === "PASS" ? "PASS" : result.status === "SKIP" ? `SKIP (${result.skip})` : "FAIL";
  console.log(`| ${result.name} | ${label} | ${result.seconds.toFixed(1)}s |`);
}

const failed = results.filter((result) => result.status === "FAIL");
const requiredFailed = failed.filter((result) => result.required);
console.log(
  `\n${results.filter((r) => r.status === "PASS").length} 통과, ${results.filter((r) => r.status === "SKIP").length} 건너뜀, ${failed.length} 실패`,
);
if (requiredFailed.length > 0 || failed.length > 0) {
  console.error("\n✗ 수용 테스트 실패");
  for (const result of failed) console.error(`  - ${result.name} (exit ${result.exitCode ?? "?"})`);
  process.exit(1);
}
console.log("✓ 로컬 수용 테스트 통과");
console.log("  하드웨어·실 provider·배포 인증서 항목은 docs/15-release-checklist.md 의 차단 목록을 따른다.");

function run(check) {
  return new Promise((resolve) => {
    const child = spawn(check.command, check.args, {
      cwd: check.cwd ?? ROOT,
      env: process.env,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: "FAIL", exitCode: "timeout" });
    }, 15 * 60 * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`\n[acceptance] ${check.name} 실행 실패: ${err.message}`);
      resolve({ status: "FAIL", exitCode: "spawn" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: code === 0 ? "PASS" : "FAIL", exitCode: code });
    });
  });
}
