# ADR 0010 — 인증은 Apple 로그인 + 서버 세션으로 한다

- 상태: **채택** (D-01) — 서버 세션 구현 완료(2026-11-14). iOS/웹 로그인 UI 는 Apple 설정 후
- 날짜: 2026-11-14
- 관련: W-12(설계), W-19(구현·강화), ADR-0003(임시 헤더), `users.auth_subject`

## 맥락

현재 인증은 `X-User-Id` 헤더이며 `GYEOL_ENV=local` 에서만 허용된다(ADR-0003). 운영에서는
사용자 식별과 소유자 스코프가 필요하다. 제품의 첫 클라이언트는 iOS 앱이고, 웹 대시보드는
같은 계정으로 기록을 읽는다.

## 결정

1. **1차 인증 수단은 Apple 로그인**이다(iOS `ASAuthorizationAppleIDProvider`, 웹은 Apple JS).
2. iOS 가 받은 **identity token(JWT)** 을 서버로 보내면 서버가 검증한다.
   - Apple JWKS(`https://appleid.apple.com/auth/keys`)로 서명 검증
   - `iss=https://appleid.apple.com`, `aud`(앱/서비스 ID), `exp`, `nonce` 확인
   - `sub` 를 `users.auth_subject = 'apple:' || sub` 로 저장(기존 UNIQUE 컬럼 사용)
   - 이메일은 비공개 릴레이일 수 있으므로 **필수로 요구하지 않는다**
3. 서버는 **불투명 세션 토큰**을 발급한다.
   - 32바이트 난수 → base64url. 서버에는 SHA-256 해시만 저장한다.
   - `sessions(id, user_id, token_hash UNIQUE, expires_at, created_at, last_used_at, revoked_at)`
   - 수명: **30일 절대 만료**. 갱신(슬라이딩)은 하지 않는다. 만료 시 재로그인.
4. API 인증은 두 형태를 받는다.
   - `Authorization: Bearer <token>` — iOS
   - `gyeol_session` **HttpOnly·Secure·SameSite=Lax** 쿠키 — 웹
   - 쿠키 기반 변경 요청은 `SameSite=Lax` + 커스텀 헤더(`X-GYEOL-CSRF: 1`)를 요구한다.
5. `X-User-Id` 는 **로컬 개발(`GYEOL_ENV=local`)에서만** 남긴다. 그 외 환경은 401.
6. 계정 삭제·비활성은 `users.status` 와 세션 폐기(`revoked_at`)로 처리한다.
   삭제 유예·파생 데이터 처리는 W-25 에서 정한다.

## 구현 순서 (W-19)

1. `0003_sessions.sql`: `sessions` 테이블 + `users.auth_subject` 사용 규칙 주석.
2. `POST /api/v1/auth/apple` (identity token → 세션), `POST /api/v1/auth/logout`.
3. 인증 미들웨어: Bearer/쿠키 → 세션 조회 → `userId` 주입. `X-User-Id` 는 local 외 거부.
4. 소유자 스코프 테스트: 타 사용자의 기기·녹음·대화·작업 접근이 404/403 인지.
5. 웹: 로그인 후 세션 쿠키 사용, 로그아웃. (계약 변경은 새 ADR/버전에서)

## 구현 상태 (2026-11-14)

- 완료: `0003_sessions.sql`, `POST /api/v1/auth/apple`, `POST /api/v1/auth/logout`,
  Bearer/쿠키 세션 인증, Apple JWKS 검증기, 소유자 스코프 테스트,
  HttpOnly `gyeol_session` 쿠키 발급·삭제, 쿠키 변경 요청 CSRF(`X-GYEOL-CSRF: 1`) 보호,
  웹 Apple JS 로그인·로그아웃·세션 복원 UI(`VITE_APPLE_CLIENT_ID`)
- 남음: 실제 Apple Service ID/Return URL 등록과 실토큰 E2E, iOS 실기기 토큰 E2E,
  iOS 키체인 토큰 보관(현재 로그인 세션은 메모리)
- 검증: `tests/auth.test.ts` 7건, `tests/db/auth.test.ts` 3건, 웹 빌드

## 결과

- 장점: iOS·웹 공통, 비밀번호 저장 없음, 토큰 폐기 가능.
- 비용: Apple 개발자 설정(Service ID·키)과 JWKS 캐시가 필요하다.
- 대안: OIDC(구글/애플)는 제공자 추상화가 늘어나 MVP 범위를 넘는다. 매직링크는 iOS
  딥링크·이메일 전달 문제가 있어 후순위.
- 되돌리기: 세션 토큰은 불투명하므로 발급 방식만 바꿔도 API 클라이언트 계약은 유지된다.
