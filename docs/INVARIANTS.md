# PayLock Escrow Invariants & State Machine

## States
- `Created`
- `Funded`
- `DeliverySubmitted`
- `Disputed`
- `Released` (terminal)
- `Resolved` (terminal)
- `Cancelled` (terminal)

## Allowed transitions
1. `Created -> Funded` via `fund_escrow`
2. `Created -> Cancelled` via `cancel_escrow` (client only)
3. `Funded -> DeliverySubmitted` via `submit_delivery` (provider only)
4. `Funded -> Released` via `release_escrow` (client, auto-match, or post-deadline)
5. `Funded -> Disputed` via `dispute_escrow` (client/provider)
6. `Funded -> Cancelled` via `cancel_escrow` (client, post-deadline)
7. `DeliverySubmitted -> Released` via `release_escrow`
8. `DeliverySubmitted -> Disputed` via `dispute_escrow`
9. `DeliverySubmitted -> Cancelled` via `cancel_escrow` (client, post-deadline)
10. `Disputed -> Resolved` via `resolve_dispute` (arbitrator only)

## Forbidden transitions (must fail)
- Any transition out of terminal states: `Released`, `Resolved`, `Cancelled`
- `Created -> DeliverySubmitted`
- `Created -> Released`
- `Created -> Disputed` by non-participant
- `Funded -> Funded` (double funding)
- `DeliverySubmitted -> DeliverySubmitted` (double submit)
- `Disputed -> Released`
- `Disputed -> Cancelled`
- `Disputed -> Funded`

## Global invariants
- `amount > 0`
- `deadline > now` at creation
- `delivery_hash` and `verify_hash` must be canonical `sha256` hex (exactly 64 chars, hex only)
- Fee is always `amount * 200 / 10_000`
- `treasury` and `arbitrator` are immutable once escrow is created
- Vault authority is escrow PDA only
- Only role-bound signers can execute role-gated transitions

## Enforcement mapping
- Runtime checks: `require!` guards in `lib.rs`
- Account constraints: `has_one`, PDA seeds, and signer requirements
- Test coverage: `tests/paylock-escrow.ts` (negative transition matrix + authorization/deadline edges)
