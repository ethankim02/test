# Security Policy

x402 Treasury is a portfolio/research project, not a production
deployment — it has never handled real funds. `RealX402Adapter` only ever
targets Base Sepolia (a testnet) and hard-refuses any other network in
code, not just configuration. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
for the full threat model and explicit non-goals.

## Reporting a vulnerability

If you find a security issue in this repository (a real accounting bug,
an auth bypass, a way to double-spend a reservation, a private key or
secret leaked into the repo or its history), please report it privately
rather than opening a public issue: use GitHub's
["Report a vulnerability"](https://github.com/ethankim02/x402-treasury/security/advisories/new)
form on this repository's Security tab.

Please include:

- What the issue is and why it's a security concern (not just a bug)
- Steps to reproduce, or a failing test if you have one
- Which component is affected (ledger, policy engine, x402 adapter, API
  auth, etc.)

There's no bug bounty — this is an unpaid personal project — but every
report will get a response and, if valid, a fix.

## Supported versions

Only the `main` branch is supported. There are no released versions with
long-term security maintenance.
