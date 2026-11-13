/**
 * 가벼운 관측성 (W-27).
 *
 * - 로그: 요청마다 JSON 한 줄. 쿼리 문자열은 개인정보(검색어)라 남기지 않는다.
 * - 메트릭: /metrics 에 Prometheus 텍스트로 노출한다. 외부 의존 없음.
 *
 * 다중 인스턴스에서는 각 프로세스가 자기 메트릭을 노출한다(수집기가 합친다).
 */

export type LogLevel = "info" | "error";

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  info(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

export const consoleLogger: Logger = {
  info: (entry) => console.log(JSON.stringify(entry)),
  error: (entry) => console.error(JSON.stringify(entry)),
};

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class Metrics {
  private readonly startedAt = Date.now();
  private readonly requests = new Map<string, number>();
  private count = 0;
  private sum = 0;
  private readonly buckets = new Array<number>(DURATION_BUCKETS_MS.length).fill(0);

  observeRequest(method: string, status: number, durationMs: number): void {
    const key = `${method}\u0000${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.count += 1;
    this.sum += durationMs;
    for (let index = 0; index < DURATION_BUCKETS_MS.length; index += 1) {
      if (durationMs <= DURATION_BUCKETS_MS[index]) this.buckets[index] += 1;
    }
  }

  render(): string {
    const lines: string[] = [
      "# HELP gyeol_http_requests_total HTTP 요청 수",
      "# TYPE gyeol_http_requests_total counter",
    ];
    for (const [key, value] of [...this.requests.entries()].sort()) {
      const [method, status] = key.split("\u0000");
      lines.push(
        `gyeol_http_requests_total{method="${method}",status="${status}"} ${value}`,
      );
    }

    lines.push(
      "# HELP gyeol_http_request_duration_ms HTTP 요청 처리 시간(ms)",
      "# TYPE gyeol_http_request_duration_ms histogram",
    );
    for (let index = 0; index < DURATION_BUCKETS_MS.length; index += 1) {
      lines.push(
        `gyeol_http_request_duration_ms_bucket{le="${DURATION_BUCKETS_MS[index]}"} ${this.buckets[index]}`,
      );
    }
    lines.push(`gyeol_http_request_duration_ms_bucket{le="+Inf"} ${this.count}`);
    lines.push(`gyeol_http_request_duration_ms_sum ${this.sum.toFixed(3)}`);
    lines.push(`gyeol_http_request_duration_ms_count ${this.count}`);

    lines.push(
      "# HELP gyeol_process_uptime_seconds 프로세스 가동 시간(초)",
      "# TYPE gyeol_process_uptime_seconds gauge",
      `gyeol_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(1)}`,
      "# HELP gyeol_process_memory_rss_bytes RSS 메모리",
      "# TYPE gyeol_process_memory_rss_bytes gauge",
      `gyeol_process_memory_rss_bytes ${process.memoryUsage().rss}`,
    );

    return `${lines.join("\n")}\n`;
  }
}
