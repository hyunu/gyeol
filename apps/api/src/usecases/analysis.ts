import { conflict, notFound, notStored } from "../domain/errors.ts";
import { uuidv7 } from "../domain/ids.ts";
import { canAnalyze } from "../domain/recording.ts";
import { decideIdentification } from "../domain/speaker.ts";
import type { AnalysisJob, Recording } from "../domain/types.ts";
import type { NewConversation } from "../ports/store.ts";
import type { Deps } from "./deps.ts";

/**
 * 비동기 분석 (ADR-0007, ADR-0004 대체).
 *
 * - 등록(`enqueue`): `POST .../analyze` 는 작업만 만들고 202 로 돌아간다.
 * - 실행(`runNextAnalysisJob`): 워커가 작업을 선점(claim)해 파이프라인을 돌린다.
 *   실패하면 재시도 가능 여부에 따라 queued 로 되돌리거나 failed 로 종료한다.
 * - 조회(`getAnalysisJob`): `GET /analysis-jobs/{id}` 로 상태를 폴링한다.
 */

export interface EnqueueResult {
  recording: Recording;
  job: AnalysisJob;
  /** 이미 활성 작업이 있어 새로 만들지 않았는지. */
  reused: boolean;
}

/**
 * `decideIdentification` 은 후보 id 를 그대로 돌려준다. 아직 persons 행을 만들지 않은
 * 상태에서 임계값·격차만 판정하기 위한 임시 id 다. 실제 저장에는 쓰지 않는다.
 */
const PENDING_PERSON_ID = "00000000-0000-0000-0000-000000000000";

export async function enqueueAnalysis(
  deps: Deps,
  userId: string,
  recordingId: string,
): Promise<EnqueueResult> {
  const recording = await deps.store.findRecording(recordingId);
  if (!recording || recording.userId !== userId || recording.deletedAt) throw notFound("녹음");
  if (!canAnalyze(recording)) throw notStored(recording.status);
  if (!recording.storageKey) throw notStored(recording.status);

  const active = await deps.store.findActiveAnalysisJob(recording.id);
  if (active) return { recording, job: active, reused: true };

  const now = deps.clock.now();
  const job: AnalysisJob = {
    id: uuidv7(),
    userId,
    recordingId: recording.id,
    status: "queued",
    attempt: 0,
    maxAttempts: deps.analysis.maxAttempts,
    timeoutMs: deps.analysis.timeoutMs,
    availableAt: now,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    conversationId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  return { recording, job: await deps.store.createAnalysisJob(job), reused: false };
}

export async function getAnalysisJob(
  deps: Deps,
  userId: string,
  jobId: string,
): Promise<AnalysisJob> {
  const job = await deps.store.findAnalysisJob(jobId);
  if (!job || job.userId !== userId) throw notFound("분석 작업");
  return job;
}

/**
 * 작업 하나를 선점해 실행한다. 처리했으면 true, 할 일이 없으면 false.
 * 테스트와 워커 루프가 같은 함수를 쓴다(결정적 실행).
 */
export async function runNextAnalysisJob(deps: Deps): Promise<boolean> {
  const job = await deps.store.claimNextAnalysisJob(deps.clock.now());
  if (!job) return false;
  await runClaimedJob(deps, job);
  return true;
}

async function runClaimedJob(deps: Deps, job: AnalysisJob): Promise<void> {
  const recording = await deps.store.findRecording(job.recordingId);

  if (!recording || recording.deletedAt || recording.status === "purged") {
    await finishFailed(deps, job, recording, "녹음이 없거나 삭제되었습니다.");
    return;
  }
  if (!recording.storageKey) {
    await finishFailed(deps, job, recording, "저장 위치가 없습니다.");
    return;
  }

  const now = deps.clock.now();
  const analyzing =
    recording.status === "analyzing"
      ? recording
      : await deps.store.updateRecording({ ...recording, status: "analyzing", updatedAt: now });

  try {
    const audio = await deps.storage.read(analyzing.storageKey as string);
    const result = await withTimeout(
      deps.ai.analyze({ recording: analyzing, audio }),
      job.timeoutMs,
    );

    const speakers = [] as NewConversation["speakers"];
    for (const speaker of result.speakers) {
      let personId: string | null = null;
      let status: "unknown" | "suggested" | "confirmed" = "unknown";
      let confidence: number | null = null;

      if (speaker.personName) {
        const existingPerson = await deps.store.findPerson(job.userId, speaker.personName);
        // 아직 사람을 만들지 않았으므로 판정용 임시 id 를 쓴다. 판정이 unknown 이면
        // persons 행을 만들지 않는다(Unknown Speaker 불변식).
        const decision = decideIdentification(
          [{ personId: existingPerson?.id ?? PENDING_PERSON_ID, score: speaker.confidence ?? 0 }],
          deps.speakerThreshold.threshold,
          deps.speakerThreshold.margin,
        );
        if (decision.status !== "unknown") {
          const person = existingPerson ?? (await ensurePerson(deps, job.userId, speaker.personName));
          personId = person.id;
          status = decision.status;
          confidence = decision.confidence;
        } else {
          confidence = decision.confidence;
        }
      }
      speakers.push({ label: speaker.label, personId, identificationStatus: status, confidence });
    }

    const existing = await deps.store.findConversationByRecordingId(analyzing.id);
    const previousLinks = existing
      ? (await deps.store.listRecordingLinks(existing.id)).filter(
          (link) => link.recordingId !== analyzing.id,
        )
      : [];
    const input: NewConversation = {
      userId: job.userId,
      title: result.title,
      summary: result.summary,
      language: result.language,
      startedAt: analyzing.startedAt,
      endedAt: analyzing.endedAt,
      status: result.status,
      analysisVersion: 1,
      pipeline: result.pipeline,
      speakers,
      segments: result.segments,
      entities: result.entities,
      actionItems: result.actionItems,
      embedding: result.embedding,
      recordingLinks: [
        ...previousLinks,
        { recordingId: analyzing.id, startOffsetMs: 0, endOffsetMs: analyzing.durationMs },
      ],
    };

    const conversation = existing
      ? await deps.store.replaceConversation(existing.id, {
          ...input,
          analysisVersion: existing.analysisVersion + 1,
        })
      : await deps.store.createConversation(input);

    const done = deps.clock.now();
    await deps.store.updateRecording({
      ...analyzing,
      status: "analyzed",
      analyzedAt: done,
      updatedAt: done,
    });
    await deps.store.updateAnalysisJob({
      ...job,
      status: "succeeded",
      conversationId: conversation.id,
      leaseExpiresAt: null,
      finishedAt: done,
      lastError: null,
      updatedAt: done,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await retryOrFail(deps, job, analyzing, message, err);
  }
}

async function retryOrFail(
  deps: Deps,
  job: AnalysisJob,
  recording: Recording,
  message: string,
  error?: unknown,
): Promise<void> {
  const now = deps.clock.now();
  const retryable = (error as { retryable?: boolean } | undefined)?.retryable ?? true;

  if (retryable !== false && job.attempt < job.maxAttempts) {
    const backoff = Math.min(
      deps.analysis.retryMaxMs,
      deps.analysis.retryBaseMs * 2 ** Math.max(0, job.attempt - 1),
    );
    await deps.store.updateAnalysisJob({
      ...job,
      status: "queued",
      availableAt: new Date(now.getTime() + backoff),
      leaseExpiresAt: null,
      lastError: message,
      updatedAt: now,
    });
    // 재시도 중에는 녹음을 analyzing 으로 둔다(전이표에 analyzing→stored 가 없다).
    return;
  }

  await finishFailed(deps, job, recording, message);
}

async function finishFailed(
  deps: Deps,
  job: AnalysisJob,
  recording: Recording | null,
  message: string,
): Promise<void> {
  const now = deps.clock.now();
  if (recording && recording.status !== "purged") {
    await deps.store.updateRecording({
      ...recording,
      status: "analysis_failed",
      updatedAt: now,
    });
  }
  await deps.store.updateAnalysisJob({
    ...job,
    status: "failed",
    leaseExpiresAt: null,
    finishedAt: now,
    lastError: message,
    updatedAt: now,
  });
}

async function ensurePerson(deps: Deps, userId: string, displayName: string) {
  const existing = await deps.store.findPerson(userId, displayName);
  if (existing) return existing;
  const now = deps.clock.now();
  return deps.store.createPerson({
    id: uuidv7(),
    userId,
    displayName,
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
}

/** 분석 타임아웃. 원본 promise 의 거부도 소비해 unhandled rejection 을 만들지 않는다. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`분석 타임아웃 (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 백그라운드 워커. `start()` 는 주기적으로 `runNextAnalysisJob` 을 호출한다.
 * 한 번에 하나씩 처리하므로 결정적이고, 다중 워커는 claim 의 원자성으로 확장한다.
 */
export class AnalysisWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: Deps;
  private readonly intervalMs: number;

  constructor(deps: Deps, intervalMs = 1000) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  async runOnce(): Promise<boolean> {
    return runNextAnalysisJob(this.deps);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        console.error("analysis worker 오류:", err instanceof Error ? err.message : err);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 워커가 처리할 작업이 없을 때까지 반복한다(테스트·배치용). */
export async function drainAnalysisJobs(deps: Deps, maxSteps = 100): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (!(await runNextAnalysisJob(deps))) return;
  }
  throw conflict("ANALYSIS_DRAIN_LIMIT", "분석 작업이 제한 횟수 안에 끝나지 않았습니다.");
}
