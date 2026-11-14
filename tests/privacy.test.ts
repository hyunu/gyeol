import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/http/server.ts";
import { MemoryStore } from "../apps/api/src/adapters/memory/store.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { uuidv7 } from "../apps/api/src/domain/ids.ts";
import { unauthorized } from "../apps/api/src/domain/errors.ts";
import type { Recording } from "../apps/api/src/domain/types.ts";
import type { IdentityVerifier, VerifiedIdentity } from "../apps/api/src/ports/identity.ts";
import type { ObjectStorage } from "../apps/api/src/ports/store.ts";
import { defaultDeps, type Deps } from "../apps/api/src/usecases/deps.ts";
import {
  ACCOUNT_PURGE_GRACE_MS,
  purgeDeletedAccounts,
  purgeExpiredRecordings,
} from "../apps/api/src/usecases/privacy.ts";
import { makeDevice, makeRecording, newConversation } from "./db/helpers.ts";

/** W-25: 내보내기·계정 삭제·보존 purge·감사. */

class MapStorage implements ObjectStorage {
  readonly kind = "local" as const;
  readonly objects = new Map<string, Buffer>();

  async startSession(): Promise<void> {}
  async appendChunk(): Promise<number> {
    throw new Error("not used");
  }
  async commitSession(): Promise<{ size: number; sha256: string }> {
    throw new Error("not used");
  }
  async abortSession(): Promise<void> {}
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async read(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing");
    return value;
  }

  put(key: string, data: Buffer): void {
    this.objects.set(key, data);
  }
}

class FakeVerifier implements IdentityVerifier {
  private readonly tokens = new Map<string, VerifiedIdentity>();

  issue(token: string, subject: string): void {
    this.tokens.set(token, { subject, email: null });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const value = this.tokens.get(token);
    if (!value) throw unauthorized();
    return value;
  }
}

function clock(start = new Date("2026-11-14T00:00:00Z")) {
  let current = start;
  return {
    now: () => current,
    set(value: Date) {
      current = value;
    },
  };
}

async function startApp(options: { identity?: IdentityVerifier } = {}) {
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-privacy-"));
  const store = new MemoryStore();
  const storage = new MapStorage();
  const time = clock();
  const deps: Deps = defaultDeps({
    store,
    storage,
    ai: new FakeAiPipeline(),
    clock: time,
    ...(options.identity ? { identity: options.identity } : {}),
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
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${baseUrl}${pathName}`, { method, headers });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
  };

  return {
    store,
    storage,
    time,
    deps,
    baseUrl,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

async function seed(app: Awaited<ReturnType<typeof startApp>>, userId: string) {
  const device = makeDevice(userId, `GYL-PRIV-${uuidv7()}`);
  await app.store.createDevice(device);
  const recording = makeRecording(userId, device.id, {
    clientRecordingId: `priv:${uuidv7()}`,
    status: "analyzed",
    storageKey: `recordings/${uuidv7()}/original`,
    integrityVerifiedAt: new Date(),
    storageVerifiedAt: new Date(),
    clientAckAt: new Date(),
    analyzedAt: new Date(),
  });
  await app.store.createRecording(recording);
  app.storage.put(recording.storageKey as string, Buffer.from("audio"));

  const person = await app.store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "김민수",
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const conversation = await app.store.createConversation(newConversation(userId, person.id, recording));
  return { device, recording, person, conversation };
}

test("내보내기는 본인 데이터만 JSON 으로 반환하고 감사를 남긴다", async () => {
  const app = await startApp();
  try {
    const userA = uuidv7();
    const userB = uuidv7();
    await app.store.ensureUser(userA);
    await app.store.ensureUser(userB);
    const seeded = await seed(app, userA);

    const exported = await app.call("GET", "/api/v1/export", { "x-user-id": userA });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(exported.body.user.id, userA);
    assert.equal(exported.body.persons.length, 1);
    assert.equal(exported.body.recordings.length, 1);
    assert.equal(exported.body.conversations.length, 1);
    assert.equal(exported.body.conversations[0].id, seeded.conversation.id);

    const other = await app.call("GET", "/api/v1/export", { "x-user-id": userB });
    assert.equal(other.status, 200);
    assert.deepEqual(other.body.persons, []);
    assert.deepEqual(other.body.recordings, []);
    assert.deepEqual(other.body.conversations, []);

    const audit = await app.store.listAuditEvents(userA);
    assert.equal(audit[0]?.action, "export");
    assert.equal(audit[0]?.metadata.conversations, 1);
  } finally {
    await app.close();
  }
});

test("계정 삭제: 세션 폐기·재로그인 차단·30일 유예", async () => {
  const verifier = new FakeVerifier();
  verifier.issue("apple-privacy", "apple:privacy-user");
  const app = await startApp({ identity: verifier });
  try {
    const loginRes = await fetch(`${app.baseUrl}/api/v1/auth/apple`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: "apple-privacy", displayName: "삭제 사용자" }),
    });
    const login: any = await loginRes.json();
    assert.equal(loginRes.status, 201);
    const token = login.session.token;
    const userId = login.session.user.id;

    const deleted = await app.call("DELETE", "/api/v1/me", {
      authorization: `Bearer ${token}`,
    });
    assert.equal(deleted.status, 202);
    assert.equal(deleted.body.deletion.status, "pending_purge");
    const purgeAfter = new Date(deleted.body.deletion.purgeAfter).getTime();
    assert.ok(Math.abs(purgeAfter - (app.time.now().getTime() + ACCOUNT_PURGE_GRACE_MS)) < 1000);

    const account = await app.store.findUserAccount(userId);
    assert.equal(account?.status, "deleted");

    const denied = await app.call("GET", "/api/v1/export", { authorization: `Bearer ${token}` });
    assert.equal(denied.status, 401);

    const relogin = await fetch(`${app.baseUrl}/api/v1/auth/apple`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: "apple-privacy" }),
    });
    assert.equal(relogin.status, 401, "삭제된 계정은 재로그인할 수 없다");

    // 재요청은 멱등이다.
    const again = await app.call("DELETE", "/api/v1/me", { "x-user-id": userId });
    assert.equal(again.status, 202);
    assert.equal(again.body.deletion.requestedAt, deleted.body.deletion.requestedAt);
  } finally {
    await app.close();
  }
});

test("30일 지난 원본만 purge 하고 ACK 없는 녹음은 건드리지 않는다", async () => {
  const app = await startApp();
  try {
    const user = uuidv7();
    await app.store.ensureUser(user);
    const device = makeDevice(user, `GYL-PURGE-${uuidv7()}`);
    await app.store.createDevice(device);
    const now = app.time.now();

    const old = makeRecording(user, device.id, {
      clientRecordingId: `purge:old:${uuidv7()}`,
      status: "analyzed",
      storageKey: `recordings/old/${uuidv7()}`,
      clientAckAt: new Date(now.getTime() - 40 * 86_400_000),
      analyzedAt: new Date(now.getTime() - 31 * 86_400_000),
      integrityVerifiedAt: new Date(now.getTime() - 40 * 86_400_000),
      storageVerifiedAt: new Date(now.getTime() - 40 * 86_400_000),
    });
    const recent = makeRecording(user, device.id, {
      clientRecordingId: `purge:new:${uuidv7()}`,
      status: "analyzed",
      storageKey: `recordings/new/${uuidv7()}`,
      clientAckAt: new Date(now.getTime() - 1 * 86_400_000),
      analyzedAt: new Date(now.getTime() - 1 * 86_400_000),
    });
    const noAck = makeRecording(user, device.id, {
      clientRecordingId: `purge:noack:${uuidv7()}`,
      status: "stored",
      storageKey: `recordings/noack/${uuidv7()}`,
      clientAckAt: null,
      analyzedAt: null,
    });
    for (const recording of [old, recent, noAck]) {
      await app.store.createRecording(recording);
      app.storage.put(recording.storageKey as string, Buffer.from("audio"));
    }

    const result = await purgeExpiredRecordings(app.deps, now);
    assert.equal(result.purged, 1);
    assert.equal(result.failed, 0);
    assert.equal((await app.store.findRecording(old.id))?.status, "purged");
    assert.equal(await app.storage.exists(old.storageKey as string), false);
    assert.equal((await app.store.findRecording(recent.id))?.status, "analyzed");
    assert.equal((await app.store.findRecording(noAck.id))?.status, "stored");

    const second = await purgeExpiredRecordings(app.deps, now);
    assert.equal(second.purged, 0, "멱등");

    const audit = await app.store.listAuditEvents(user);
    assert.ok(audit.some((event) => event.action === "recording_purged"));
  } finally {
    await app.close();
  }
});

test("30일 지난 삭제 계정은 하드 삭제되고 오브젝트도 지운다", async () => {
  const app = await startApp();
  try {
    const user = uuidv7();
    await app.store.ensureUser(user);
    const seeded = await seed(app, user);
    await app.store.markUserDeleted(user, new Date(app.time.now().getTime() - 31 * 86_400_000));

    const result = await purgeDeletedAccounts(app.deps, app.time.now());
    assert.equal(result.purged, 1);
    assert.equal(result.failed, 0);
    assert.equal(await app.store.findUserAccount(user), null);
    assert.equal(await app.store.findRecording(seeded.recording.id), null);
    assert.equal(await app.store.findPersonById(seeded.person.id), null);
    assert.equal(await app.storage.exists(seeded.recording.storageKey as string), false);
  } finally {
    await app.close();
  }
});
