.PHONY: help install check validate typecheck test test-db contract-test db-up db-down db-migrate db-checks clean

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

db-up: ## 로컬 PostgreSQL(pgvector) 기동
	docker compose -f deploy/docker-compose.yml up -d

db-down: ## 로컬 PostgreSQL 중지
	docker compose -f deploy/docker-compose.yml down

db-migrate: ## 마이그레이션 적용 (DATABASE_URL 필요)
	npm run db:migrate

db-checks: ## DB 제약·인덱스 실동작 검증 (DATABASE_URL 필요)
	npm run --silent db:checks

clean: ## 로컬 산출물 정리
	rm -rf node_modules .artifacts
