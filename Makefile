.PHONY: help install check validate typecheck test test-db test-s3 test-e2e contract-test db-up db-down db-migrate db-checks db-backup db-restore-rehearsal clean

help: ## 사용 가능한 명령
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## 의존성 설치
	npm ci || npm install

check: validate typecheck test ## 전체 검증 (CI 와 동일)

validate: ## 계약(스키마/OpenAPI) 검증
	npm run --silent validate

typecheck: ## TypeScript 타입 검사
	npm run --silent typecheck

test: ## 단위 + 통합 테스트
	npm run --silent test

test-db: ## PostgreSQL 통합 테스트 (DATABASE_URL 필요)
	npm run --silent test:db

contract-test: ## 실행 중인 서버를 OpenAPI 와 대조 (BASE_URL)
	npm run --silent contract-test

start: ## API 실행
	npm start

db-up: ## 로컬 PostgreSQL(pgvector)·MinIO 기동
	docker compose -f deploy/docker-compose.yml up -d

db-down: ## 로컬 PostgreSQL·MinIO 중지
	docker compose -f deploy/docker-compose.yml down

db-migrate: ## 마이그레이션 적용 (DATABASE_URL 필요)
	npm run db:migrate

db-checks: ## DB 제약·인덱스 실동작 검증 (DATABASE_URL 필요)
	npm run --silent db:checks

db-backup: ## 논리 백업 (BACKUP=경로, 기본 .artifacts/backups)
	npm run --silent db:backup -- $${BACKUP:-}

db-restore-rehearsal: ## 백업 복구 리허설 (BACKUP=경로 필요)
	@test -n "$$BACKUP" || (echo "BACKUP=경로 가 필요합니다."; exit 1)
	npm run --silent db:restore:rehearsal -- "$$BACKUP"

test-e2e: ## 웹 대시보드 E2E (Playwright, API·Vite 자동 기동)
	npm run --silent test:e2e

test-s3: ## S3(MinIO) 스토리지 테스트
	S3_ENDPOINT=$${S3_ENDPOINT:-http://127.0.0.1:9000} \
	S3_ACCESS_KEY_ID=$${S3_ACCESS_KEY_ID:-gyeol} \
	S3_SECRET_ACCESS_KEY=$${S3_SECRET_ACCESS_KEY:-gyeol-minio} \
	S3_BUCKET=$${S3_BUCKET:-gyeol-test} \
	npm run --silent test:s3

clean: ## 로컬 산출물 정리
	rm -rf node_modules .artifacts
