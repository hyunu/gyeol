# apps/web — 결 대시보드

대화 기록을 날짜·인물·키워드로 다시 읽는 React 앱.

## 실행

API 서버가 먼저 떠 있어야 한다(기본 `http://127.0.0.1:8080`).

```bash
# 저장소 루트에서
npm start                      # 메모리 저장소
# 또는
GYEOL_STORE=postgres npm start # PostgreSQL (DATABASE_URL 필요)

# 이 디렉터리에서
npm install
npm run dev                    # http://127.0.0.1:5173
```

개발 서버는 `/api`·`/healthz` 를 `127.0.0.1:8080` 으로 프록시한다.
다른 주소를 쓰려면 `apps/web/vite.config.ts` 의 proxy target 을 바꾼다.

## 계약 타입

화면 타입은 OpenAPI 계약에서 생성한다. 계약을 바꾸면 반드시 다시 생성한다.

```bash
npm run api:types   # ../../contracts/openapi/openapi.yaml → src/api/schema.ts
```

CI 는 재생성 후 diff 가 있으면 실패한다.

## 인증

Apple 로그인 + 서버 세션을 쓴다(ADR-0010). 서버가 `HttpOnly; SameSite=Lax` 인
`gyeol_session` 쿠키를 발급하고, 웹은 쿠키로 API 를 호출한다. 쿠키 인증 변경 요청에는
클라이언트가 `X-GYEOL-CSRF: 1` 헤더를 붙인다.

Apple 로그인을 켜려면 빌드 시 Service ID 와 Return URL 을 설정한다.

```bash
VITE_APPLE_CLIENT_ID=com.example.gyeol.web \
VITE_APPLE_REDIRECT_URI=https://gyeol.example.com \
npm run build
```

`VITE_APPLE_CLIENT_ID` 가 없으면 로컬 개발용 `x-user-id` 데모 인증을 쓴다(ADR-0003).
기본 데모 사용자이며 `localStorage.gyeol.userId` 로 바꿀 수 있다. 개발 빌드에서는
로그인 화면의 "로컬 데모로 시작" 버튼으로 같은 데모 세션을 선택할 수 있다.

## 상태

- 목록: 첫 로딩(스켈레톤) / 갱신(기존 항목 유지) / 첫 사용 빈 상태 / 검색 결과 없음 / 오류+재시도
- 상세: 미선택 안내 / 로딩 / 오류+재시도 / 부분 인식(`status=partial`) 안내
- 할 일: 낙관적 갱신, 실패 시 되돌리고 오류 문구 유지
- 필터·선택은 URL(`q`, `person`, `id`)에 반영되어 새로고침·뒤로가기가 복원된다

## 디자인

Warm Editorial — 한지 바탕, 먹색, 점토색 악센트 하나. 카드·그림자·그라디언트 없이
괘선과 여백으로 구분한다. 날짜를 왼쪽 여백에 크게 두는 것이 이 화면의 기억점이다.
토큰은 `src/styles.css` 의 `:root` 에만 있다.
