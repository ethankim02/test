# Roadmap

What's deliberately not built yet, and why. None of this blocks the
project's core claim (concurrency-safe budgets + a verified real x402
settlement) — it's scoped out so that claim could be made correctly
first, per the project's own stated priorities (see
[`docs/DECISIONS.md`](DECISIONS.md) and [`README.md`](../README.md)
"Limitations").

- **Human-approval resume flow for `REVIEW` decisions.** The policy
  engine already returns `REVIEW` as a distinct decision from `ALLOW`/
  `BLOCK`, but the API currently treats it the same as a block — there's
  no endpoint yet for an approver to resume a held payment.
- **Scheduled reservation-expiry and reconciliation sweeps.** Both exist
  today as plain callable functions (`runReconciliation`, an expiry
  sweep) that something has to invoke — nothing runs them on a timer or
  cron yet.
- **A budget re-parenting API.** The cycle-prevention trigger that would
  make this safe already exists in the schema; no endpoint calls it.
- **A lightweight read-only dashboard** (spec §33). Deliberately not
  built before core payment correctness — a UI over correct data is easy
  to add later; correct data over a UI is not.
- **Prometheus-compatible metrics export.** An internal counter
  abstraction exists; nothing scrapes or exposes it yet.
- **A full user/identity system** beyond org- and agent-scoped API keys
  (see [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) for what the current
  auth model does and doesn't cover).
- **`upto` and `batch-settlement` x402 schemes, and non-EVM networks.**
  Only the `exact` scheme on EVM (Base Sepolia) is implemented.
