.PHONY: help install check validate test clean

help: ## 사용 가능한 명령
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## 의존성 설치
	npm ci || npm install

check: validate test ## 전체 검증 (CI 와 동일)

validate: ## 계약(스키마/OpenAPI) 검증
	npm run --silent validate

test: ## 테스트 실행
	npm run --silent test

clean: ## 로컬 산출물 정리
	rm -rf node_modules .artifacts
