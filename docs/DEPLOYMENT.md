# PayLock Escrow — Deployed Program Addresses

## Devnet (Active)

| Field | Value |
|-------|-------|
| **Program ID** | `BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8` |
| **Network** | Solana Devnet |
| **Framework** | Anchor 0.31.0 |
| **Explorer** | [View on Solana Explorer](https://explorer.solana.com/address/BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8?cluster=devnet) |

## Mainnet

Not yet deployed. Devnet is the canonical live environment.

---

## Verifying the Deployment

```bash
# Check program exists on devnet
solana program show BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8 --url devnet

# Or via Anchor
anchor idl fetch BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8 --provider.cluster devnet
```

## Using the Program ID in Your Code

### TypeScript / Anchor client

```typescript
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8");
const connection = new Connection(clusterApiUrl("devnet"));
```

### Rust / CPI

```rust
// In your Cargo.toml, add paylock-escrow as a dependency with cpi feature
// Then reference the program ID:
declare_id!("BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8");
```

### CLI (included in this repo)

```bash
# The CLI reads program ID from Anchor.toml automatically
npx ts-node cli/status.ts --escrow <ESCROW_PDA>
```

---

## Anchor.toml Reference

```toml
[programs.devnet]
paylock_escrow = "BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8"
```

---

## Deployment History

| Date | Network | Program ID | Notes |
|------|---------|------------|-------|
| 2026-02 | Devnet | `BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8` | Initial deploy, Superteam bounty submission |

---

*Last updated: 2026-03-14*
