# Paylock On-Chain Escrow Threat Model

## Scope
Program: `programs/paylock-escrow/src/lib.rs`.
Assets: escrowed SPL token funds, escrow state, role bindings (`client/provider/arbitrator/treasury`), and delivery proof integrity.

## Threat scenarios and mitigations

| Threat | Attack path | Mitigation in code | Test coverage |
|---|---|---|---|
| Unauthorized release/cancel/dispute/resolve | Wrong signer calls privileged instruction | Signer + role checks, `has_one` constraints, status guards | `authorization matrix` and `forbidden transition` tests in `tests/paylock-escrow.ts` |
| Treasury redirection | Caller supplies alternate treasury to siphon fee | `ReleaseEscrow` enforces `has_one = treasury` bound at create | `rejects wrong treasury` |
| Arbitrator impersonation | Rogue signer resolves dispute | `ResolveDispute` enforces `has_one = arbitrator` | `rejects wrong arbitrator` |
| Proof format confusion | Malformed hash (wrong len/non-hex/mixed junk) accepted | Central `Sha256HexProof::parse` enforces exact 64-char hex | Rust unit tests + TS malformed payload tests |
| Deadline boundary abuse | Calls at `== now` or before/after deadline to bypass policy | Strict `deadline > now` at create and strict `now > deadline` for timeout paths | Deadline edge tests (`==`, `<`, `>`) |
| Replay after terminal transition | Re-run release/dispute/cancel/fund after completion | Terminal states rejected by status machine guards | Anti-replay tests across Released/Resolved/Cancelled |
| Invalid state transitions | e.g., submit before fund, resolve outside disputed | Explicit transition guards per instruction | Forbidden-transition matrix tests |
| Arithmetic bug in split/fee math | Overflow/underflow in fee or resolution split | Checked arithmetic + explicit overflow errors | Existing release/resolve flow tests |

## Security invariants
1. Funds move only under allowed state transitions.
2. Terminal states are final (`Released`, `Resolved`, `Cancelled`).
3. Role bindings (treasury/arbitrator/client/provider) are immutable for an escrow.
4. Proof values are canonicalized SHA-256 hex strings.
5. Fee transfer uses fixed basis points and is routed only to bound treasury.

## Residual risks
- Dispute fairness depends on trusted arbitrator model (by design in this phase).
- Clock-based deadlines depend on Solana timestamp variance.
- Off-chain artifact correctness is only as strong as the commitment workflow around hash preimages.
