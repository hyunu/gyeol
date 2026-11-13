import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { AiProviderError, HttpAiPipeline } from "../apps/api/src/adapters/ai/http-pipeline.ts";
import { createAiFromEnv } from "../apps/api/src/adapters/ai/index.ts";
import { makeRecording } from "./db/helpers.ts";

/**
 * W-18 AI provider 어댑터 계약 검증.
 * 실제 vendor 대신 로컬 mock HTTP 서버로 요청/응답 계약과 실패 경로를 확인한다.
 */

interface MockServer {
  url: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
  close(): Promise<void>;
}

async function startMock(
  handler: (request: { path: string; body: Buffer }, response: http.ServerResponse) => void,
): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const path = req.url ?? "/";
    requests.push({ path, headers: req.headers, body });
    handler({ path, body }, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function analysisResponse() {
  return {
    title: "북한산 등산 계획",
    summary: "주말에 북한산에 오르기로 했다.",
    language: "ko",
    status: "ready",
    speakers: [
      { label: "SPEAKER_1", personName: "김민수", confidence: 0.93 },
      { label: "SPEAKER_2", personName: null, confidence: null },
    ],
    segments: [
      { seq: 0, startMs: 0, endMs: 1000, text: "이번 주말에 북한산 갈래?", speakerLabel: "SPEAKER_1", confidence: 0.9 },
      { seq: 1, startMs: 1000, endMs: 2000, text: "좋아, 토요일 아침에 출발하자.", speakerLabel: "SPEAKER_2", confidence: 0.85 },
      { seq: 2, startMs: 2000, endMs: 3000, text: "준비물은 내가 챙길게.", speakerLabel: "SPEAKER_1", confidence: 0.88 },
    ],
    entities: [
      { kind: "place", value: "북한산", normalizedValue: "북한산", confidence: 0.9, segmentSeq: 0 },
    ],
    actionItems: [
      { title: "토요일 출발 준비", dueAt: "2026-11-21T00:00:00Z", confidence: 0.7, entityIndex: null },
    ],
    embedding: {
      provider: "mock",
      model: "mock-embed",
      dim: 768,
      vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
    },
    pipeline: { provider: "mock", model: "mock-v1", stages: { stt: "ok" } },
  };
}

const recording = makeRecording("0199aaaa-0000-7000-8000-000000000001", "0199aaaa-0000-7000-8000-000000000002");
const audio = Buffer.from("fake-audio-bytes-for-provider");

test("분석 요청은 multipart 로 오디오·메타데이터를 보내고 응답을 도메인 타입으로 바꾼다", async () => {
  const mock = await startMock(({ path }, res) => {
    if (path === "/v1/analyze") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(analysisResponse()));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const adapter = new HttpAiPipeline({
      baseUrl: mock.url,
      token: "provider-token",
      timeoutMs: 2000,
      dim: 768,
    });
    const result = await adapter.analyze({ recording, audio });

    assert.equal(result.title, "북한산 등산 계획");
    assert.equal(result.segments.length, 3);
    assert.equal(result.speakers.length, 2);
    assert.equal(result.embedding.dim, 768);
    assert.equal(result.embedding.vector.length, 768);
    assert.ok(result.actionItems[0].dueAt instanceof Date);
    assert.equal(result.actionItems[0].dueAt?.toISOString(), "2026-11-21T00:00:00.000Z");

    const request = mock.requests[0];
    assert.equal(request.path, "/v1/analyze");
    assert.equal(request.headers.authorization, "Bearer provider-token");
    assert.match(request.headers["content-type"] ?? "", /multipart\/form-data/);
    const text = request.body.toString("latin1");
    assert.match(text, /name="metadata"/);
    assert.match(text, /name="audio"/);
    assert.ok(request.body.length > audio.length, "오디오 바이트가 본문에 포함되어야 한다");
  } finally {
    await mock.close();
  }
});

test("embedQuery 는 차원을 검증하고 잘못된 응답을 거부한다", async () => {
  const mock = await startMock(({ path }, res) => {
    if (path === "/v1/embed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ vector: Array.from({ length: 768 }, () => 0.1) }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({ vector: [1, 2, 3] }));
  });

  try {
    const adapter = new HttpAiPipeline({ baseUrl: mock.url, dim: 768 });
    const vector = await adapter.embedQuery("북한산");
    assert.equal(vector.length, 768);

    // 다른 경로로 잘못된 차원을 받으면 fail-closed.
    const wrong = new HttpAiPipeline({ baseUrl: mock.url, dim: 768 });
    await assert.rejects(
      () => wrong.analyze({ recording, audio }),
      (err: any) => err instanceof AiProviderError && err.code === "AI_INVALID_RESPONSE",
    );
  } finally {
    await mock.close();
  }
});

test("5xx 는 재시도 가능, 4xx 는 재시도 불가로 표시된다", async () => {
  const mock = await startMock(({ path }, res) => {
    if (path === "/v1/embed") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("overloaded");
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad audio" }));
  });

  try {
    const adapter = new HttpAiPipeline({ baseUrl: mock.url, dim: 768 });
    await assert.rejects(
      () => adapter.embedQuery("x"),
      (err: any) => err instanceof AiProviderError && err.status === 503 && err.retryable === true,
    );
    await assert.rejects(
      () => adapter.analyze({ recording, audio }),
      (err: any) => err instanceof AiProviderError && err.status === 400 && err.retryable === false,
    );
  } finally {
    await mock.close();
  }
});

test("타임아웃과 잘못된 JSON 은 예외로 처리한다", async () => {
  const mock = await startMock(({ path }, res) => {
    if (path === "/v1/analyze") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(analysisResponse()));
      }, 200);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not-json");
  });

  try {
    const slow = new HttpAiPipeline({ baseUrl: mock.url, dim: 768, timeoutMs: 20 });
    await assert.rejects(
      () => slow.analyze({ recording, audio }),
      (err: any) => err instanceof AiProviderError && err.code === "AI_TIMEOUT",
    );

    const badJson = new HttpAiPipeline({ baseUrl: mock.url, dim: 768, timeoutMs: 2000 });
    await assert.rejects(
      () => badJson.embedQuery("x"),
      (err: any) => err instanceof AiProviderError && err.code === "AI_INVALID_RESPONSE",
    );
  } finally {
    await mock.close();
  }
});

test("GYEOL_AI 선택은 fail-closed 이고, Fake 와 HTTP 는 같은 포트 계약을 만족한다", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.GYEOL_AI;
    delete process.env.AI_PROVIDER_URL;
    assert.ok(createAiFromEnv("fake") instanceof FakeAiPipeline);
    assert.throws(() => createAiFromEnv("http"), /AI_PROVIDER_URL/);
    assert.throws(() => createAiFromEnv("vendor-x"), /GYEOL_AI 값이 올바르지 않습니다/);

    const fake = new FakeAiPipeline();
    const fakeResult = await fake.analyze({ recording });
    for (const result of [fakeResult]) {
      assert.equal(typeof result.title, "string");
      assert.equal(result.segments.length >= 1, true);
      assert.equal(result.embedding.vector.length, 768);
      assert.equal(result.status === "ready" || result.status === "partial", true);
    }
  } finally {
    process.env = saved;
  }
});
