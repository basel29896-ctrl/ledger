# Accounting platform — developer entrypoints.
# Every target is safe to re-run.

COMPOSE := docker compose
API := $(COMPOSE) exec -T api

.PHONY: dev down migrate migrate-new seed seed-demo test test-e2e lint typecheck ledger-rebuild ledger-verify logs psql reset

dev: ## build, start, migrate, seed
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d --build
	$(MAKE) migrate
	$(MAKE) seed
	@echo "web http://localhost:3000  api http://localhost:4000/health  db http://localhost:8081  mail http://localhost:8025"

down:
	$(COMPOSE) down

migrate:
	$(API) pnpm --filter @acct/db migrate

migrate-new:
	$(API) pnpm --filter @acct/db generate

seed:
	$(API) pnpm --filter @acct/db seed

seed-demo:
	$(API) pnpm --filter @acct/db seed:demo

test:
	$(COMPOSE) -f docker-compose.test.yml up -d
	pnpm test

test-e2e:
	pnpm --filter @acct/web test:e2e

lint:
	pnpm lint

typecheck:
	pnpm typecheck

ledger-rebuild:
	$(API) pnpm --filter @acct/db ledger:rebuild

ledger-verify:
	$(API) pnpm --filter @acct/db ledger:verify

logs:
	$(COMPOSE) logs -f --tail=100

psql:
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-accounting} -d $${POSTGRES_DB:-accounting}

reset: ## DESTRUCTIVE: drops all local data volumes
	$(COMPOSE) down -v
	$(MAKE) dev

# Aliases matching the documented `make target:sub` spelling.
.PHONY: migrate:new seed:demo test:e2e ledger:rebuild ledger:verify
migrate\:new: migrate-new
seed\:demo: seed-demo
test\:e2e: test-e2e
ledger\:rebuild: ledger-rebuild
ledger\:verify: ledger-verify
