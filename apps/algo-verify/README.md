# GYEOL 알고리즘 검증 웹앱 (`apps/algo-verify`)

모바일/서버 음성 분석 파이프라인을 **병렬로 검증**하기 위한 웹앱입니다.
데모 샘플을 선택하면 기존 API 흐름(녹음 생성 → 청크 업로드 → ACK → `/analyze` → 작업 폴링 → 대화 조회)으로 분석을 실행하고, 결과를 표시합니다.

## 표시 항목
- **추출 텍스트**: 세그먼트 전체 텍스트
- **요약**: 제목/요약/상태
- **화자 분리**: 화자 클러스터(라벨·인물·식별 상태·신뢰도) 및 화자별 세그먼트 타임라인

## 샘플
- 원본: `demo/audio-samples/*.wav` (YouTube 구간, 16kHz mono PCM s16le, 20개)
- 목록/출처: `src/samples.json`, `demo/audio-samples/README.md`

로컬 개발/빌드 전에 샘플을 정적 자산으로 복사합니다.

```bash
mkdir -p public/samples
cp ../../demo/audio-samples/*.wav public/samples/
npm install
npm run dev      # http://127.0.0.1:5174 (API 8080 프록시)
npm run build
```

> 기본적으로 `X-User-Id` 개발 인증(로컬 환경)으로 API를 호출합니다. `VITE_API_BASE`로 API 기준 경로를 지정할 수 있습니다.

## n100 서비스 허브 배포
- 컨테이너: `algo-verify` (nginx 정적 서빙 + `/api` 프록시)
- 엔드포인트: `18081` (`deploy/n100/compose.yaml`, `deploy/n100/service.yaml`)
- 빌드: `deploy/n100/algo-verify/Dockerfile` (repo 루트 컨텍스트, `demo/audio-samples`를 포함해 빌드)
