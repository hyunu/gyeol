import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MemoryStore } from "../adapters/memory/store.ts";
import { PostgresStore } from "../adapters/postgres/store.ts";
import { LocalDiskStorage } from "../adapters/storage/local-disk.ts";
import { S3Storage } from "../adapters/storage/s3.ts";
import { FakeAiPipeline } from "../adapters/ai/fake-pipeline.ts";
import { defaultDeps, pagination, type Deps } from "../usecases/deps.ts";
import * as deviceUseCases from "../usecases/devices.ts";
import * as recordingUseCases from "../usecases/recordings.ts";
import * as conversationUseCases from "../usecases/conversations.ts";
import * as analysisUseCases from "../usecases/analysis.ts";
import { methodNotAllowed, notFound, validationFailed } from "../domain/errors.ts";
import type { ActionItemStatus } from "../domain/types.ts";
import type { ObjectStorage, Store } from "../ports/store.ts";
import { DEMO_USER_ID, resolveUserId } from "./auth.ts";
import { sendEmpty, sendJson, sendProblem, readBinaryBody, readJsonBody } from "./respond.ts";
import * as dto from "./dto.ts";
import {
  assertNoUnknownKeys,
  queryDate,
  queryInt,
  queryString,
  queryUuid,
  readInt,
  readObject,
  readString,
  requireObject,
} from "./validate.ts";

export const CONTRACT_VERSION = "0.2.0";
export { DEMO_USER_ID };

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  traceId: string;
  userId: string;
  deps: Deps;
}

interface Route {
  method: string;
  segments: string[];
  auth: boolean;
  handle(ctx: Ctx): Promise<{ status: number; body?: unknown }>;
}

export interface AppOptions {
  deps?: Deps;
  storageDir?: string;
  env?: string;
  version?: string;
  /**
   * 백그라운드 분석 워커(ADR-0007).
   * 기본값은 `GYEOL_ANALYSIS_WORKER=off` 가 아니면 켜진다.
   * 테스트는 `{ enabled: false }` 로 끄고 `runNextAnalysisJob` 을 직접 호출한다.
   */
  worker?: { enabled?: boolean; intervalMs?: number };
}

/**
 * `GYEOL_STORE` 로 저장소 어댑터를 고른다.
 * 잘못된 값은 조용히 메모리로 떨어지지 않고 즉시 실패한다(fail-closed).
 */
export function createStoreFromEnv(kind = process.env.GYEOL_STORE ?? "memory"): Store {
  if (kind === "memory") return new MemoryStore();
  if (kind === "postgres") return new PostgresStore();
  throw new Error(`GYEOL_STORE 값이 올바르지 않습니다: ${kind} (memory|postgres)`);
}

/**
 * `GYEOL_STORAGE` 로 오브젝트 스토리지를 고른다.
 * 잘못된 값은 조용히 로컬 디스크로 떨어지지 않고 즉시 실패한다(fail-closed).
 */
export function createStorageFromEnv(storageDir: string, kind = process.env.GYEOL_STORAGE ?? "local"): ObjectStorage {
  if (kind === "local") return new LocalDiskStorage(storageDir);
  if (kind === "s3") return new S3Storage();
  throw new Error(`GYEOL_STORAGE 값이 올바르지 않습니다: ${kind} (local|s3)`);
}

function split(p: string): string[] {
  return p.split("/").filter(Boolean);
}

export function createApp(options: AppOptions = {}): http.Server {
  const env = options.env ?? process.env.GYEOL_ENV ?? "local";
  const storageDir =
    options.storageDir ?? process.env.GYEOL_STORAGE_DIR ?? path.join(process.cwd(), ".artifacts", "storage");
  const deps =
    options.deps ??
    defaultDeps({
      store: createStoreFromEnv(),
      storage: createStorageFromEnv(storageDir),
      ai: new FakeAiPipeline(),
    });
  const version = options.version ?? CONTRACT_VERSION;

  const routes: Route[] = [];
  const route = (method: string, template: string, auth: boolean, handle: Route["handle"]) => {
    routes.push({ method, segments: split(template), auth, handle });
  };

  route("GET", "/healthz", false, async ({ deps }) => {
    const checks: Array<{
      name: string;
      status: "ok" | "degraded" | "down" | "skipped";
      detail: string;
      latencyMs?: number;
    }> = [{ name: "store", status: "ok", detail: deps.store.kind }];

    if (deps.store.ping) {
      const startedAt = Date.now();
      try {
        await deps.store.ping();
        checks.push({
          name: "db",
          status: "ok",
          detail: deps.store.kind,
          latencyMs: Date.now() - startedAt,
        });
      } catch (err) {
        checks.push({
          name: "db",
          status: "down",
          detail: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt,
        });
      }
    } else {
      checks.push({
        name: "db",
        status: "skipped",
        detail: "메모리 저장소 사용 중 (PostgreSQL 미연결)",
      });
    }

    checks.push({
      name: "device-link",
      status: "skipped",
      detail: "실물 하드웨어 미연결 (HW-PENDING)",
    });

    const status = checks.some((c) => c.status === "down")
      ? "down"
      : checks.some((c) => c.status === "degraded")
        ? "degraded"
        : "ok";

    return {
      status: 200,
      body: { status, version, time: deps.clock.now().toISOString(), checks },
    };
  });

  route("GET", "/api/v1/info", false, async () => ({
    status: 200,
    body: {
      name: "gyeol",
      apiVersion: "v1",
      contractVersion: CONTRACT_VERSION,
      provisional: true,
      capabilities: ["devices", "recordings", "analysis-jobs", "conversations", "persons", "action-items"],
    },
  }));

  // ---------------------------------------------------------------- devices
  route("POST", "/api/v1/devices", true, async ({ req, userId, deps }) => {
    const body = requireObject(await readJsonBody(req));
    assertNoUnknownKeys(body, ["serialNo", "model", "hardwareRevision", "firmwareVersion"]);
    await deps.store.ensureUser(userId);
    const device = await deviceUseCases.registerDevice(deps, userId, {
      serialNo: readString(body, "serialNo", { required: true, max: 120 })!,
      model: readString(body, "model", { required: true })!,
      hardwareRevision: readString(body, "hardwareRevision"),
      firmwareVersion: readString(body, "firmwareVersion"),
    });
    return { status: 201, body: dto.deviceDto(device, deps.clock.now()) };
  });

  route("GET", "/api/v1/devices", true, async ({ url, userId, deps }) => {
    const { page, size } = pagination(url.searchParams.get("page"), url.searchParams.get("size"));
    const result = await deviceUseCases.listDevices(deps, userId, page, size);
    const now = deps.clock.now();
    return {
      status: 200,
      body: {
        items: result.items.map((d) => dto.deviceDto(d, now)),
        page,
        size,
        total: result.total,
        hasNext: page * size < result.total,
      },
    };
  });

  route("GET", "/api/v1/devices/:deviceId", true, async ({ params, userId, deps }) => {
    const device = await deviceUseCases.getDevice(deps, userId, params.deviceId);
    return { status: 200, body: dto.deviceDto(device, deps.clock.now()) };
  });

  // ------------------------------------------------------------- recordings
  route("POST", "/api/v1/recordings", true, async ({ req, userId, deps }) => {
    const body = requireObject(await readJsonBody(req));
    assertNoUnknownKeys(body, [
      "deviceId", "clientRecordingId", "deviceSeq", "startedAt", "endedAt", "capturedOffsetMin",
      "durationMs", "codec", "codecParams", "sampleRateHz", "channels", "byteSize", "sha256", "vad",
    ]);
    await deps.store.ensureUser(userId);
    const result = await recordingUseCases.createRecording(deps, userId, {
      deviceId: readString(body, "deviceId", { required: true })!,
      clientRecordingId: readString(body, "clientRecordingId", { required: true, max: 200 })!,
      deviceSeq: readInt(body, "deviceSeq", { min: 0 }),
      startedAt: readString(body, "startedAt", { required: true })!,
      endedAt: readString(body, "endedAt", { required: true })!,
      capturedOffsetMin: readInt(body, "capturedOffsetMin", { min: -840, max: 840 }),
      durationMs: readInt(body, "durationMs", { required: true, min: 1 })!,
      codec: readString(body, "codec", { required: true })!,
      codecParams: readObject(body, "codecParams"),
      sampleRateHz: readInt(body, "sampleRateHz", { required: true, min: 1 })!,
      channels: readInt(body, "channels", { required: true, min: 1 })!,
      byteSize: readInt(body, "byteSize", { required: true, min: 1 })!,
      sha256: readString(body, "sha256", { required: true })!,
      vad: readObject(body, "vad"),
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        recording: dto.recordingDto(result.recording),
        uploadSession: dto.uploadSessionDto(result.uploadSession),
      },
    };
  });

  route("GET", "/api/v1/recordings", true, async ({ url, userId, deps }) => {
    const { page, size } = pagination(url.searchParams.get("page"), url.searchParams.get("size"));
    const statusRaw = url.searchParams.get("status");
    const RECORDING_STATUSES = [
      "initiated", "uploading", "stored", "analyzing",
      "analyzed", "analysis_failed", "integrity_failed", "purged",
    ];
    if (statusRaw && !RECORDING_STATUSES.includes(statusRaw)) {
      throw validationFailed(`status 는 ${RECORDING_STATUSES.join(" | ")} 중 하나여야 합니다.`);
    }
    const result = await recordingUseCases.listRecordings(deps, userId, {
      deviceId: queryUuid(url, "deviceId"),
      status: (statusRaw ?? undefined) as never,
      from: queryDate(url, "from"),
      to: queryDate(url, "to"),
      page,
      size,
    });
    return {
      status: 200,
      body: {
        items: result.items.map(dto.recordingDto),
        page,
        size,
        total: result.total,
        hasNext: page * size < result.total,
      },
    };
  });

  route("GET", "/api/v1/recordings/:recordingId", true, async ({ params, userId, deps }) => {
    const recording = await recordingUseCases.getRecording(deps, userId, params.recordingId);
    return { status: 200, body: { recording: dto.recordingDto(recording) } };
  });

  route("DELETE", "/api/v1/recordings/:recordingId", true, async ({ params, userId, deps }) => {
    await recordingUseCases.deleteRecording(deps, userId, params.recordingId);
    return { status: 204 };
  });

  route("POST", "/api/v1/recordings/:recordingId/upload-sessions", true, async ({ params, userId, deps }) => {
    const result = await recordingUseCases.createUploadSession(deps, userId, params.recordingId);
    return {
      status: 201,
      body: {
        recording: dto.recordingDto(result.recording),
        uploadSession: dto.uploadSessionDto(result.uploadSession),
      },
    };
  });

  route(
    "PUT",
    "/api/v1/recordings/:recordingId/upload-sessions/:sessionId/chunks",
    true,
    async ({ req, url, params, userId, deps }) => {
      const offset = queryInt(url, "offset");
      if (offset === undefined) throw validationFailed("offset 쿼리 파라미터가 필요합니다.");
      const chunk = await readBinaryBody(req, 1024 * 1024);
      const result = await recordingUseCases.appendChunk(
        deps, userId, params.recordingId, params.sessionId, offset, chunk,
      );
      return {
        status: 200,
        body: {
          recording: dto.recordingDto(result.recording),
          uploadSession: dto.uploadSessionDto(result.uploadSession),
        },
      };
    },
  );

  route("POST", "/api/v1/recordings/:recordingId/ack", true, async ({ params, userId, deps }) => {
    const recording = await recordingUseCases.acknowledgeRecording(deps, userId, params.recordingId);
    return { status: 200, body: { recording: dto.recordingDto(recording) } };
  });

  route("POST", "/api/v1/recordings/:recordingId/analyze", true, async ({ params, userId, deps }) => {
    const result = await analysisUseCases.enqueueAnalysis(deps, userId, params.recordingId);
    return {
      status: 202,
      body: { recording: dto.recordingDto(result.recording), job: dto.analysisJobDto(result.job) },
    };
  });

  route("GET", "/api/v1/analysis-jobs/:jobId", true, async ({ params, userId, deps }) => {
    const job = await analysisUseCases.getAnalysisJob(deps, userId, params.jobId);
    return { status: 200, body: { job: dto.analysisJobDto(job) } };
  });

  // ---------------------------------------------------------- conversations
  route("GET", "/api/v1/conversations", true, async ({ url, userId, deps }) => {
    const { page, size } = pagination(url.searchParams.get("page"), url.searchParams.get("size"));
    const query = {
      personId: queryUuid(url, "personId"),
      from: queryDate(url, "from"),
      to: queryDate(url, "to"),
      q: queryString(url, "q"),
      page,
      size,
    };
    conversationUseCases.assertConversationQuery(query);
    const result = await conversationUseCases.listConversations(deps, userId, query);
    return {
      status: 200,
      body: {
        items: result.items.map(dto.conversationListDto),
        page,
        size,
        total: result.total,
        hasNext: page * size < result.total,
      },
    };
  });

  route("GET", "/api/v1/conversations/:conversationId", true, async ({ params, userId, deps }) => {
    const detail = await conversationUseCases.getConversation(deps, userId, params.conversationId);
    return { status: 200, body: dto.conversationDetailDto(detail) };
  });

  route("GET", "/api/v1/persons", true, async ({ url, userId, deps }) => {
    const { page, size } = pagination(url.searchParams.get("page"), url.searchParams.get("size"));
    const result = await conversationUseCases.listPersons(deps, userId, page, size);
    return {
      status: 200,
      body: {
        items: result.items.map(dto.personDto),
        page,
        size,
        total: result.total,
        hasNext: page * size < result.total,
      },
    };
  });

  route("PATCH", "/api/v1/action-items/:actionItemId", true, async ({ req, params, userId, deps }) => {
    const body = requireObject(await readJsonBody(req));
    assertNoUnknownKeys(body, ["status"]);
    const status = readString(body, "status", { required: true })!;
    if (!["open", "done", "dismissed"].includes(status)) {
      throw validationFailed("status 는 open | done | dismissed 중 하나여야 합니다.");
    }
    const item = await conversationUseCases.updateActionItem(
      deps, userId, params.actionItemId, status as ActionItemStatus,
    );
    return { status: 200, body: dto.actionItemDto(item) };
  });

  const server = http.createServer(async (req, res) => {
    const traceId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathSegments = split(url.pathname);
    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      if (candidate.segments.length !== pathSegments.length) continue;
      const extracted: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < candidate.segments.length; i += 1) {
        const tmpl = candidate.segments[i];
        const actual = pathSegments[i];
        if (tmpl.startsWith(":")) extracted[tmpl.slice(1)] = decodeURIComponent(actual);
        else if (tmpl !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = candidate;
        params = extracted;
        break;
      }
    }

    if (!matched) {
      const allowed = routes
        .filter(
          (r) =>
            r.segments.length === pathSegments.length &&
            r.segments.every((s, i) => s.startsWith(":") || s === pathSegments[i]),
        )
        .map((r) => r.method);
      if (allowed.length > 0) {
        res.setHeader("Allow", allowed.join(", "));
        sendProblem(res, methodNotAllowed(), traceId, url.pathname);
      } else {
        sendProblem(res, notFound("요청 경로"), traceId, url.pathname);
      }
      return;
    }

    try {
      let userId = "";
      if (matched.auth) {
        userId = resolveUserId(req, env);
        await deps.store.ensureUser(userId);
      }
      const result = await matched.handle({ req, res, url, params, traceId, userId, deps });
      if (result.status === 204) sendEmpty(res, 204, traceId);
      else sendJson(res, result.status, result.body ?? {}, traceId);
    } catch (err) {
      sendProblem(res, err, traceId, url.pathname);
    }
  });

  const workerEnabled =
    options.worker?.enabled ?? process.env.GYEOL_ANALYSIS_WORKER !== "off";
  if (workerEnabled) {
    const worker = new analysisUseCases.AnalysisWorker(
      deps,
      options.worker?.intervalMs ?? 1000,
    );
    server.on("listening", () => {
      worker.start();
      // 대기 중인 작업이 있으면 즉시 하나 처리한다.
      void worker.runOnce().catch(() => undefined);
    });
    server.on("close", () => worker.stop());
  }

  return server;
}
