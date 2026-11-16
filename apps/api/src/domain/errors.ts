/** 응용 계층 오류. HTTP 매핑은 엣지 계층에서만 한다. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(code: string, status: number, message: string, detail?: string, retryable = false) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }
}

export const notFound = (what: string) =>
  new AppError("NOT_FOUND", 404, `${what}을(를) 찾을 수 없습니다.`);

export const unauthorized = (detail = "인증 정보가 없습니다.") =>
  new AppError("UNAUTHORIZED", 401, "인증이 필요합니다.", detail);

export const authNotConfigured = () =>
  new AppError(
    "AUTH_NOT_CONFIGURED",
    503,
    "인증이 구성되지 않았습니다.",
    "APPLE_CLIENT_IDS 가 설정되지 않았습니다.",
    true,
  );

export const csrfRequired = () =>
  new AppError(
    "CSRF_REQUIRED",
    403,
    "CSRF 확인이 필요합니다.",
    "쿠키 인증으로 변경 요청을 보낼 때는 X-GYEOL-CSRF: 1 헤더가 필요합니다.",
  );

export const conflict = (code: string, message: string, detail?: string) =>
  new AppError(code, 409, message, detail);

export const validationFailed = (detail: string) =>
  new AppError("VALIDATION_FAILED", 422, "요청 값을 확인해 주세요.", detail);

export const badRequest = (detail: string) =>
  new AppError("BAD_REQUEST", 400, "요청 형식이 올바르지 않습니다.", detail);

export const recordingNotDeletable = (reasons: string[]) =>
  new AppError(
    "RECORDING_NOT_DELETABLE",
    409,
    "원본을 아직 삭제할 수 없습니다.",
    reasons.join(", "),
    true,
  );

export const offsetMismatch = (expected: number, received: number) =>
  new AppError(
    "OFFSET_MISMATCH",
    409,
    "업로드 오프셋이 일치하지 않습니다.",
    `expected=${expected} received=${received}`,
  );

export const sessionNotOpen = (status: string) =>
  conflict("SESSION_NOT_OPEN", "업로드 세션을 사용할 수 없습니다.", `status=${status}`);

export const notStored = (status: string) =>
  conflict("RECORDING_NOT_STORED", "원본 검증이 끝나지 않았습니다.", `status=${status}`);

export const alreadyAnalyzedRunning = () =>
  conflict("ANALYSIS_IN_PROGRESS", "분석이 이미 진행 중입니다.");

export const methodNotAllowed = () =>
  new AppError("METHOD_NOT_ALLOWED", 405, "허용되지 않은 메서드입니다.");
