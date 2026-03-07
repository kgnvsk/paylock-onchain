# Paylock On-Chain Escrow Threat Model

## Scope
Smart contract: `programs/paylock-escrow/src/lib.rs` (Anchor/Solana).  
Assets in scope: escrowed SPL tokens, escrow state correctness, release/dispute authorization.

## Security Objectives
1. Funds only move according to explicit state transitions.
2. Only authorized actors (client/provider/arbitrator/treasury binding) can trigger privileged actions.
3. Delivery verification cannot be spoofed via malformed hashes.
4. Fee routing cannot be redirected away from bound treasury.

## Trust Boundaries
- **On-chain program boundary**: all critical authorization and state checks must be enforced by account constraints + runtime checks.
- **Signer boundary**: any signer not matching bound escrow roles is untrusted.
- **Token program CPI boundary**: SPL token transfers rely on correct PDA signer seeds and vault authority.
- **Off-chain boundary**: clients/providers can submit arbitrary strings and timing; all inputs are adversarial.

## Key Attack Scenarios & Mitigations

### 1) Unauthorized state transitions
- **Scenario**: attacker or wrong role calls `submit_delivery`, `dispute_escrow`, `release_escrow`, `resolve_dispute`, or `cancel_escrow`.
- **Impact**: premature release, denial of service, or dispute manipulation.
- **Mitigations**:
  - Anchor `has_one` constraints on role accounts (provider, arbitrator, treasury).
  - Signer checks + explicit runtime authorization checks.
  - State machine guards (`InvalidStatus`) on every transition.

### 2) Hash ambiguity / malformed commitment bypass
- **Scenario**: submit short/non-hex/garbage delivery hashes to bypass meaningful proof matching.
- **Impact**: false auto-approval or unverifiable commitment workflow.
- **Mitigations**:
  - Enforce SHA-256 hex format exactly (64 hex chars) in `create_escrow` and `submit_delivery`.
  - Reject malformed values with explicit `InvalidHashFormat`.

### 3) Treasury redirection attack
- **Scenario**: caller passes alternate treasury account during release.
- **Impact**: protocol fee theft.
- **Mitigations**:
  - Escrow stores treasury at creation.
  - `ReleaseEscrow` requires `has_one = treasury`; mismatched treasury fails.

### 4) Arbitrator impersonation
- **Scenario**: non-designated signer resolves dispute.
- **Impact**: forced unfair split.
- **Mitigations**:
  - Escrow stores arbitrator at creation.
  - `ResolveDispute` enforces `has_one = arbitrator`.

### 5) Deadline edge abuse
- **Scenario**: create escrow with already-expired deadline or exploit boundary timestamps.
- **Impact**: immediate unauthorized timeout actions or broken UX/security assumptions.
- **Mitigations**:
  - `create_escrow` requires `deadline > now`.
  - timeout-dependent flows use strict comparisons and are covered by explicit edge tests.

## Residual Risks / Notes
- Off-chain delivery semantics are only as strong as hash preimage process and business workflow.
- Timestamp dependency uses Solana clock and is subject to normal block-time variance.
- No emergency pause/admin override in current design (intentional decentralization tradeoff).

## Test Coverage Mapping
Hardening tests now include:
- Negative auth cases (unauthorized dispute, mismatch treasury/arbitrator).
- State machine negatives (submit before funding).
- Hash validation negatives (create + submit delivery).
- Deadline boundary check (deadline == now rejected).
