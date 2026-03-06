# PayLock On-Chain Escrow 🔒

> **Production-grade escrow system rebuilt as a Solana Anchor program.**  
> Originally deployed as an off-chain API (paylock.xyz), now fully on-chain with trustless execution, SPL token support, and dispute resolution.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.0-purple)](https://www.anchor-lang.com/)
[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)](https://solana.com/)

## 🌟 What is PayLock?

PayLock is an escrow protocol for AI agent deals and freelance contracts. A **client** locks funds for a **provider**; funds are released only after verified delivery. The original system was a centralized Python API — this repo is the full on-chain rebuild.

**Deployed on Devnet:** `BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8`  
*(Run `anchor deploy --provider.cluster devnet` to get a live address)*

## 📐 Architecture

```
Client                  PayLock Program (Anchor)              Provider
  │                            │                                 │
  ├──create_escrow()──────────►│ EscrowAccount PDA               │
  │                            │ + Vault ATA (PDA authority)      │
  ├──fund_escrow()────────────►│ tokens locked in vault          │
  │                            │                                 │
  │                            │◄────────submit_delivery()───────┤
  │                            │  verify_hash stored             │
  ├──release_escrow()─────────►│ auto-verify if hashes match     │
  │  OR auto-release           │──tokens→ provider (98%)─────────►│
  │                            │──tokens→ treasury (2%)          │
  │                            │                                 │
  │──dispute_escrow()─────────►│ status = Disputed               │
  │                            │◄────resolve_dispute(arbitrator)  │
  │                            │  split by arbitrator decision   │
```

### Program Accounts

| Account | Type | Description |
|---------|------|-------------|
| `EscrowAccount` | PDA `[b"escrow", client, provider]` | Escrow state: parties, amount, status, hashes |
| `Vault` | ATA of EscrowAccount | SPL token vault, authority = EscrowAccount PDA |

### Escrow Status Machine

```
Created → Funded → DeliverySubmitted → Released
    │         │              │
    │         └──────────────┴──► Disputed → Resolved
    │
    └──► Cancelled (any party, before funding or after deadline)
```

## 🚀 Quick Start

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"

# Install Anchor via AVM
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.31.0
avm use 0.31.0

# Install Node dependencies
yarn install
```

### Build

```bash
anchor build
```

### Test (local validator)

```bash
anchor test
```

### Deploy to Devnet

```bash
# Set cluster
solana config set --url devnet

# Generate/fund wallet
solana-keygen new --outfile ~/.config/solana/id.json
solana airdrop 2

# Deploy
anchor deploy --provider.cluster devnet

# Update program ID in Anchor.toml and lib.rs, then rebuild
anchor build && anchor deploy --provider.cluster devnet
```

## 🔑 Instructions

### `create_escrow`
```typescript
await program.methods
  .createEscrow(
    "Develop escrow module",          // description (max 256 chars)
    sha256hex("delivery-content"),    // expected delivery hash (or "")
    new BN(1_000_000),                // amount in token units (1 USDC)
    new BN(Math.floor(Date.now()/1000) + 86400) // deadline (unix)
  )
  .accounts({ client, provider, mint, escrow, vault, ... })
  .signers([clientKeypair])
  .rpc();
```

### `fund_escrow`
Transfers `amount` tokens from client's ATA to the vault PDA.

### `submit_delivery`
Provider submits SHA-256 proof hash. If it matches `delivery_hash`, auto-release is possible.

### `release_escrow`
Client approves release. If hashes match, anyone can trigger auto-release. 2% fee goes to treasury.

### `dispute_escrow`
Either party can dispute. Sets status to `Disputed` for arbitrator resolution.

### `resolve_dispute`
Arbitrator (treasury key) splits funds via `client_share_bps` (0–10000 = 0–100%).

### `cancel_escrow`
- Before funding: client can cancel anytime
- After funding: only after deadline, or if provider agrees

## 💰 Fee Structure

| Parameter | Value |
|-----------|-------|
| Platform fee | 2% (`FEE_BPS = 200`) |
| Provider receives | 98% of escrow amount |
| Treasury receives | 2% of escrow amount |
| Fee calculation | `amount × fee_bps / 10_000` |

## 🔐 Security

- **PDA authority**: vault is controlled by the EscrowAccount PDA — no private key exposure
- **Status guards**: every instruction checks current status before executing
- **Hash verification**: SHA-256 delivery proofs enable trustless auto-release
- **Deadline enforcement**: prevents indefinite locking of funds
- **Signer checks**: all sensitive operations require appropriate party's signature

## 📁 Project Structure

```
paylock-onchain/
├── programs/
│   └── paylock-escrow/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs          # Full Anchor program
├── tests/
│   └── paylock-escrow.ts       # TypeScript test suite (Mocha/Chai)
├── docs/
│   └── DESIGN.md               # Deep dive design decisions
├── Anchor.toml
├── Cargo.toml
├── package.json
└── tsconfig.json
```

## 🏆 Superteam Earn Bounty

This project was built for the **Superteam Poland** bounty:  
**"Rebuild production backend systems as on-chain Rust programs"** ($1,000 USDC)

The original PayLock escrow was a production Python/Flask API at paylock.xyz handling real AI agent transactions. This Anchor program reimplements it with:
- Trustless execution (no centralized server)
- SPL token support (USDC, SOL-wrapped, any SPL)
- On-chain dispute resolution
- Cryptographic delivery verification
- Composable CPI interface for other programs

See [docs/DESIGN.md](docs/DESIGN.md) for the full design deep dive.

## 📄 License

MIT — see [LICENSE](LICENSE)
