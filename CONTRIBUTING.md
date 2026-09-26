# Contributing

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d          # Postgres, or point DATABASE_URL at your own instance
pnpm db:migrate
pnpm db:seed
```

## Working on this repo

- Core financial logic (`packages/ledger`, `packages/policy-engine`) must
  stay independently testable without a running x402 facilitator — see
  ADR-007. If you find yourself importing `@x402/*` outside
  `packages/x402-adapter` or an app's own entrypoint wiring, stop.
- Money is always a `bigint` count of the asset's minor unit, wrapped in
  the `Money` type from `@x402-treasury/shared`. Never introduce a
  `number` for an amount that will be persisted or compared. See ADR-003.
- Every rejected payment decision must carry machine-readable
  `reason_codes`, not just a message.
- New tables that hold financial history are append-only by convention;
  if you add one, revoke `UPDATE`/`DELETE` from `treasury_app` on it in the
  migration, the same way `ledger_entries` does.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit tests, no database required
pnpm test:integration  # requires a running Postgres (see docker-compose.yml)
```

## Commit style

Conventional-commit-style prefixes (`feat:`, `fix:`, `docs:`, `test:`,
`chore:`) with a message that explains _why_, matching the existing log.
