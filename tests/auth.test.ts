import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/http/server.ts";
import { MemoryStore } from "../apps/api/src/adapters/memory/store.ts";
import { LocalDiskStorage } from "../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { uuidv7 } from "../apps/api/src/domain/ids.ts";
import { unauthorized } from "../apps/api/src/domain/errors.ts";
import type { IdentityVerifier, VerifiedIdentity } from "../apps/api/src/ports/identity.ts";
import { defaultDeps, type Deps } from "../apps/api/src/usecases/deps.ts";
import { hashSessionToken } from "../apps/api/src/usecases/auth.ts";
import { makeDevice, makeRecording, newConversation } from "./db/helpers.ts";

/**
 * 세션 인증 (ADR-0010, W-19 서버 부분).
 * Apple 검증은 Fake verifier 로 대체하고, 세션 발급·사용·폐기·만료·소유자 스코프를 검증한다.
 */

class FakeIdentityVerifier implements IdentityVerifier {
  private readonly tokens = new Map<string, VerifiedIdentity>();

  issue(token: string, identity: VerifiedIdentity): void {
    this.tokens.set(token, identity);
  }

  async verify(identityToken: string): Promise<VerifiedIdentity> {
    const identity = this.tokens.get(identityToken);
    if (!identity) throw unauthorized("테스트 토큰이 아닙니다.");
    return identity;
  }
}

function mutableClock(start = new Date("2026-11-14T00:00:00Z")) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

async function startApp(options: { identity?: IdentityVerifier | null; clock?: { now(): Date } } = {}) {
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-auth-"));
  const store = new MemoryStore();
  const clock = options.clock ?? mutableClock();
  const deps: Deps = defaultDeps({
    store,
    storage: new LocalDiskStorage(storageDir),
    ai: new FakeAiPipeline(),
    clock,
    ...(options.identity === null ? {} : { identity: options.identity ?? new FakeIdentityVerifier() }),
  });

  const server = createApp({
    deps,
    storageDir,
    env: "local",
    worker: { enabled: false },
    logger: { info: () => undefined, error: () => undefined },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const call = async (
    method: string,
    pathName: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
  };

  return {
    store,
    clock,
    baseUrl,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

test("Apple 로그인: 세션 발급 → Bearer 접근, 같은 sub 는 같은 사용자", async () => {
  const verifier = new FakeIdentityVerifier();
  verifier.issue("apple-token-1", { subject: "apple:sub-1", email: "minsu@example.com" });
  const app = await startApp({ identity: verifier });

  try {
    const first = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "apple-token-1",
      displayName: "김민수",
    });
    assert.equal(first.status, 201);
    const session = first.body.session;
    assert.equal(session.tokenType, "Bearer");
    assert.equal(session.user.displayName, "김민수");
    assert.ok(session.token.length >= 20);
    assert.ok(session.expiresAt);

    const authorized = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: `Bearer ${session.token}`,
    });
    assert.equal(authorized.status, 200);

    // 원문 토큰은 저장하지 않고 해시만 저장한다.
    assert.equal(await app.store.findSessionByTokenHash(session.token), null);
    const stored = await app.store.findSessionByTokenHash(hashSessionToken(session.token));
    assert.equal(stored?.userId, session.user.id);

    const second = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "apple-token-1",
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.session.user.id, session.user.id, "같은 sub 는 같은 사용자");
    assert.equal(second.body.session.user.displayName, "김민수", "기존 이름 유지");
    assert.notEqual(second.body.session.token, session.token, "로그인마다 새 세션");
  } finally {
    await app.close();
  }
});

test("쿠키 인증과 로그아웃(폐기)이 동작한다", async () => {
  const verifier = new FakeIdentityVerifier();
  verifier.issue("apple-cookie", { subject: "apple:sub-cookie", email: null });
  const app = await startApp({ identity: verifier });

  try {
    const login = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "apple-cookie",
      displayName: "쿠키 사용자",
    });
    const token = login.body.session.token;

    const viaCookie = await app.call("GET", "/api/v1/devices", undefined, {
      cookie: `theme=dark; gyeol_session=${encodeURIComponent(token)}`,
    });
    assert.equal(viaCookie.status, 200);

    const logout = await app.call("POST", "/api/v1/auth/logout", undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(logout.status, 204);

    const denied = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, "UNAUTHORIZED");

    const cookieDenied = await app.call("GET", "/api/v1/devices", undefined, {
      cookie: `gyeol_session=${encodeURIComponent(token)}`,
    });
    assert.equal(cookieDenied.status, 401);
  } finally {
    await app.close();
  }
});

test("세션은 30일 뒤 만료되고, 잘못된 토큰은 fail-closed 다", async () => {
  const clock = mutableClock();
  const verifier = new FakeIdentityVerifier();
  verifier.issue("apple-expiry", { subject: "apple:sub-expiry", email: null });
  const app = await startApp({ identity: verifier, clock });

  try {
    const login = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "apple-expiry",
      displayName: "만료 사용자",
    });
    const token = login.body.session.token;
    assert.equal(login.body.session.expiresAt, "2026-12-14T00:00:00.000Z");

    const ok = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(ok.status, 200);

    clock.advance(31 * 24 * 60 * 60 * 1000);
    const expired = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(expired.status, 401);

    const bogus = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: "Bearer this-is-not-a-real-session-token-123456",
    });
    assert.equal(bogus.status, 401);

    // 토큰이 있는데 유효하지 않으면 X-User-Id 로 되돌아가지 않는다.
    const fallback = await app.call("GET", "/api/v1/devices", undefined, {
      authorization: "Bearer this-is-not-a-real-session-token-123456",
      "x-user-id": "0199aaaa-0000-7000-8000-000000000001",
    });
    assert.equal(fallback.status, 401);
  } finally {
    await app.close();
  }
});

test("Apple 검증 실패는 401, 검증기 미설정은 503", async () => {
  const verifier = new FakeIdentityVerifier();
  const app = await startApp({ identity: verifier });
  try {
    const bad = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "unknown-token",
    });
    assert.equal(bad.status, 401);
  } finally {
    await app.close();
  }

  const unconfigured = await startApp({ identity: null });
  try {
    const res = await unconfigured.call("POST", "/api/v1/auth/apple", {
      identityToken: "anything",
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "AUTH_NOT_CONFIGURED");
  } finally {
    await unconfigured.close();
  }
});

test("타 사용자의 기기·녹음·대화·할 일·분석 작업은 404", async () => {
  const verifier = new FakeIdentityVerifier();
  verifier.issue("token-a", { subject: "apple:sub-a", email: null });
  verifier.issue("token-b", { subject: "apple:sub-b", email: null });
  const app = await startApp({ identity: verifier });

  try {
    const a = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "token-a",
      displayName: "사용자 A",
    });
    const b = await app.call("POST", "/api/v1/auth/apple", {
      identityToken: "token-b",
      displayName: "사용자 B",
    });
    const authA = { authorization: `Bearer ${a.body.session.token}` };
    const authB = { authorization: `Bearer ${b.body.session.token}` };
    const userA = a.body.session.user.id;

    const device = makeDevice(userA, `GYL-SCOPE-${uuidv7()}`);
    await app.store.createDevice(device);
    const recording = makeRecording(userA, device.id, { clientRecordingId: `scope:${uuidv7()}` });
    await app.store.createRecording(recording);
    const person = await app.store.createPerson({
      id: uuidv7(),
      userId: userA,
      displayName: "A의 사람",
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const conversation = await app.store.createConversation(newConversation(userA, person.id, recording));
    const detail = await app.store.getConversationDetail(conversation.id);
    const actionItemId = detail!.actionItems[0].id;
    const job = await app.store.createAnalysisJob({
      id: uuidv7(),
      userId: userA,
      recordingId: recording.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 3,
      timeoutMs: 300_000,
      availableAt: new Date(),
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      conversationId: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A 본인은 접근 가능하다.
    assert.equal((await app.call("GET", `/api/v1/devices/${device.id}`, undefined, authA)).status, 200);
    assert.equal(
      (await app.call("GET", `/api/v1/conversations/${conversation.id}`, undefined, authA)).status,
      200,
    );

    // B 는 모두 404(존재 은닉)다.
    assert.equal((await app.call("GET", `/api/v1/devices/${device.id}`, undefined, authB)).status, 404);
    assert.equal((await app.call("GET", `/api/v1/recordings/${recording.id}`, undefined, authB)).status, 404);
    assert.equal(
      (await app.call("GET", `/api/v1/conversations/${conversation.id}`, undefined, authB)).status,
      404,
    );
    assert.equal(
      (await app.call("GET", `/api/v1/analysis-jobs/${job.id}`, undefined, authB)).status,
      404,
    );
    assert.equal(
      (
        await app.call("PATCH", `/api/v1/action-items/${actionItemId}`, { status: "done" }, authB)
      ).status,
      404,
    );
    assert.equal((await app.call("DELETE", `/api/v1/recordings/${recording.id}`, undefined, authB)).status, 404);
  } finally {
    await app.close();
  }
});

test("로컬 개발에서는 X-User-Id 를 계속 쓸 수 있다", async () => {
  const app = await startApp();
  try {
    const res = await app.call("GET", "/api/v1/devices", undefined, {
      "x-user-id": "0199aaaa-0000-7000-8000-000000000001",
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});
