# ADR 0008 — 오브젝트 스토리지는 S3 호환 API 어댑터로 연결한다

- 상태: **채택**
- 날짜: 2026-11-14
- 관련: W-14, `ObjectStorage` 포트, `apps/api/src/adapters/storage/s3.ts`

## 맥락

`ObjectStorage` 포트는 "세션에 청크를 이어 붙이고, 커밋하면 크기·SHA-256 을 돌려준다"는
의미를 갖는다. 로컬 디스크 구현은 파일 append 로 이를 만족한다. 운영에서는 오브젝트
스토리지가 필요하지만 S3 는 객체 append 를 지원하지 않는다.

업로드 청크는 256 KiB 이고, S3 multipart 의 최소 파트 크기는 5 MiB(마지막 제외)다.
따라서 청크마다 `UploadPart` 를 호출할 수 없다.

## 결정

1. **S3 호환 어댑터**(`S3Storage`)를 추가하고 `GYEOL_STORAGE=s3` 로 선택한다.
   MinIO 로 로컬·CI 검증을 한다.
2. 세션 청크는 각각 임시 객체로 저장한다.
   - `_sessions/<sessionId>/<offset 12자리>` — 재개·오프셋 검증의 기준
3. 커밋 시 임시 객체를 오프셋 순서로 읽어 **8 MiB 단위 multipart upload** 로 최종 객체를
   만들고, 읽으면서 SHA-256 을 계산한다. 완료 후 임시 객체를 지운다.
4. `appendChunk` 는 기존 임시 객체 크기의 합과 `offset` 이 다르면 실패한다
   (로컬 디스크 구현과 같은 규칙).
5. 버킷이 없으면 최초 사용 시 만든다. `S3_ENDPOINT`·`S3_REGION`·`S3_BUCKET`·
   `S3_ACCESS_KEY_ID`·`S3_SECRET_ACCESS_KEY`·`S3_FORCE_PATH_STYLE` 로 설정한다.
6. 잘못된 `GYEOL_STORAGE` 값은 로컬로 조용히 떨어지지 않고 즉시 실패한다(fail-closed).

## 결과

- 장점: 포트 의미를 바꾸지 않고 교체 가능. 재개 업로드·무결성 검증이 그대로 동작한다.
  API 프로세스가 재시작돼도 임시 청크가 S3 에 남아 재개할 수 있다.
- 비용: 커밋 시 S3 에서 읽어 다시 쓰므로 **전송량이 2배**가 된다. 청크마다 크기 합계를
  구하기 위해 목록 조회가 한 번 더 발생한다.
- 완화: 이 경로는 서버 경유 업로드다. 운영 규모에서는 아래 중 하나로 바꾼다.
  1. 클라이언트가 **presigned URL** 로 S3 에 직접 업로드하고, 서버는 완료 통보와 검증만 한다.
  2. 클라이언트가 S3 multipart 를 직접 수행하고 파트 ETag 를 서버에 제출한다.
  두 경우 모두 API 계약(업로드 세션)을 새 ADR 로 확장해야 한다.
- 테스트: `npm run test:s3` — 7건(어댑터 6 + 전 구간 1). CI 는 MinIO 컨테이너를 띄운다.
- 되돌리기: `GYEOL_STORAGE=local` 로 바꾸면 기존 로컬 디스크 구현을 쓴다. 포트는 그대로다.
