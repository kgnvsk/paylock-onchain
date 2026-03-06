# PayLock On-Chain Escrow — Design Deep Dive

## Origin Story: From API to On-Chain

PayLock started as a centralized Python/Flask API running on a VPS. The flow was simple: a client POSTs to `/contract`, gets a deposit address, sends SOL or USDC to it, the server confirms, and later releases. Fast to build, but fundamentally trust-dependent — you had to trust the server operator (us) not to run with the money.

Rebuilding as an Anchor program eliminates that trust requirement entirely.

---

## Design Decisions

### 1. PDA-Controlled Vault Instead of Multisig

**Decision:** Use an `EscrowAccount` PDA as the vault authority.

**Alternatives considered:**
- **Multisig** (e.g., Squads): requires all parties to be co-signers, complex UX
- **Lockbox with timelock**: doesn't support conditional release
- **Custom program authority**: too complex for a single-purpose escrow

**Why PDA:** The `EscrowAccount` PDA `[b"escrow", client, provider]` is deterministic — anyone can derive it, but only the program can sign for it using `signer_seeds`. The vault is an Associated Token Account (ATA) of this PDA, meaning:
- No private key to leak
- Funds are verifiably locked — even the deployer can't extract them
- Account address is predictable for frontend UIs

### 2. SHA-256 Delivery Hash Verification

**Decision:** Store a `delivery_hash` at creation and `verify_hash` at delivery. If they match, auto-release is possible.

**Why this matters:** In the centralized system, the server compared hashes in Python. On-chain, we can do the same string comparison in the BPF VM. This enables:

```
client sets: delivery_hash = sha256("specification-document-v3.pdf:<sha256_of_file>")
provider submits: verify_hash = sha256("specification-document-v3.pdf:<sha256_of_file>")
→ if equal, anyone can trigger release (even a crank bot)
```

**Limitation:** The program does NOT perform SHA-256 computation on-chain (Solana has `sol_sha256` syscall, but verifying arbitrary file content isn't practical on-chain). Instead, both parties pre-commit to hashes off-chain. This is a hash **commitment scheme**, not on-chain hash computation.

**Future improvement:** Use a ZK proof or oracle attestation for richer delivery verification.

### 3. Status State Machine

```rust
pub enum EscrowStatus {
    Created,
    Funded,
    DeliverySubmitted,
    Released,
    Disputed,
    Resolved,
    Cancelled,
}
```

Each instruction has a `require!(escrow.status == X, EscrowError::InvalidStatus)` guard. This prevents:
- Double-funding
- Release without funding
- Dispute after release
- Cancel after resolution

**Design choice:** Terminal states (`Released`, `Resolved`, `Cancelled`) are never exited. We don't delete the account (for auditability and explorer visibility).

### 4. Single Escrow Per Client-Provider Pair

**Decision:** PDA seed `[b"escrow", client, provider]` means one active escrow per pair.

**Tradeoff:** Simple lookup, but limits one concurrent deal per pair. 

**Alternative:** Add a `nonce: u64` to the seeds for multiple parallel escrows between the same parties. Not implemented in v1 to keep the API surface minimal for the bounty submission.

**Production fix:** 
```rust
seeds = [b"escrow", client.key().as_ref(), provider.key().as_ref(), &nonce.to_le_bytes()]
```

### 5. 2% Platform Fee Architecture

**Original PayLock:** 1.5–3% fee collected by the centralized server at release time.

**On-chain version:** Fee deducted atomically in `release_escrow` and sent to a treasury ATA. The fee is baked into the program constant (`FEE_BPS = 200`) rather than stored per-escrow, which:
- Reduces account space
- Prevents clients from negotiating different rates at creation time
- But: makes fee changes require a program upgrade

**Better design for production:** Store `fee_bps` as a program-level config account (singleton PDA) that an admin can update, with a cap (e.g., max 5%). This preserves upgradeability without requiring full redeployment.

### 6. Dispute Resolution — Arbitrator Model

**Decision:** Dispute resolved by a designated `arbitrator` (the treasury keypair in v1).

**Why not DAO vote:** Too slow for time-sensitive agent deals. For a $50–$500 freelance contract, waiting 7 days for a token vote is impractical.

**Why not both parties agree:** If they agreed, they wouldn't have disputed.

**Current model:** Treasury (PayLock operator) acts as arbitrator — same trust model as centralized platforms (Fiverr, Escrow.com). Not fully trustless, but practical.

**Roadmap:** 
- Kleros-style jury from staked token holders
- Optimistic oracle (UMA) for programmable resolution
- Multi-sig arbitration panel for high-value disputes

### 7. Deadline vs. Expiry

**`deadline`** is not an auto-expiry — it's a threshold that enables:
- Client to cancel after deadline if provider hasn't delivered
- Client to release after deadline (auto-release scenario with hash match)

This avoids locking funds permanently if a provider ghosts. But it also means funds don't auto-return — someone must submit a transaction. This is intentional: Solana doesn't have timers; you need a crank.

**Production improvement:** Implement a crank bot that monitors escrows past deadline and auto-cancels (refunding clients) for a small SOL reward.

### 8. Rent Management

All accounts use `init` with explicit `space` calculation. The `EscrowAccount::SPACE` constant includes:

```
8 (discriminator) + 32×4 (pubkeys) + 8×4 (u64/i64 fields) + 
4+256 (description) + 4+64×2 (hashes) + 1 (status) + 1 (bump) + 64 (padding)
= ~540 bytes
```

This is rent-exempt (~0.004 SOL). In production, closing the account after `Released`/`Cancelled` and returning rent to the client is a UX improvement (saves ~0.004 SOL per escrow). Not implemented to keep the audit trail intact.

### 9. SPL Token Over Native SOL

**Decision:** Accept SPL tokens (USDC, etc.) via ATA vault rather than native SOL.

**Why:** The original PayLock accepted SOL directly. For agent economy payments, USDC is preferred (stable value, standard in Solana DeFi). SPL token integration via `anchor-spl` is clean and composable.

**Native SOL support:** Would require `system_program::transfer` and tracking balances differently. Can be added as a separate instruction set or a wrapper that wraps SOL into wSOL.

### 10. CPI Composability

The program exports a `cpi` feature (via `Cargo.toml` `cpi = ["no-entrypoint"]`). Other programs can call PayLock instructions via CPI — for example:
- A marketplace program auto-creating escrows when orders are placed
- A DAO program releasing escrow after on-chain vote
- A subscription manager creating recurring escrows

---

## Comparison: Off-Chain vs On-Chain

| Feature | Original API | Anchor Program |
|---------|-------------|----------------|
| Trust model | Centralized (trust operator) | Trustless (PDA-controlled) |
| Fund custody | Server-controlled wallet | PDA vault |
| Fee collection | Manual at release | Atomic in transaction |
| Delivery proof | SHA-256 comparison in Python | Hash commitment on-chain |
| Dispute resolution | Manual (email/Telegram) | Arbitrator instruction |
| Auditability | Server logs | Full on-chain history |
| Composability | REST API | CPI-ready |
| Uptime | VPS dependent | Solana network |
| Cost per escrow | ~0 (server already running) | ~0.004 SOL rent |

---

## Known Limitations & Future Work

1. **One escrow per pair**: Add nonce seed for parallel escrows
2. **Centralized arbitrator**: Replace with decentralized jury
3. **No auto-release crank**: Build crank bot for deadline-based release
4. **No native SOL**: Add SOL-native vault variant
5. **Fixed fee**: Make fee configurable via admin account
6. **No expiry**: Account closure after terminal states for rent reclaim
7. **No subscription support**: Recurring payment escrows (future bounty?)

---

## Gas/Compute Analysis

Estimated compute units per instruction:
- `create_escrow`: ~15,000 CU (account init + ATA creation)
- `fund_escrow`: ~8,000 CU (token transfer)
- `submit_delivery`: ~3,000 CU (state update only)
- `release_escrow`: ~12,000 CU (2 token transfers)
- `dispute_escrow`: ~3,000 CU
- `resolve_dispute`: ~12,000 CU
- `cancel_escrow`: ~8,000 CU

All well within the 200,000 CU default limit. Priority fees for MEV protection are recommended in production.
