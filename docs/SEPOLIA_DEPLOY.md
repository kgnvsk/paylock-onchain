# Base Sepolia Deploy — Handoff (manual steps)

**Status:** Contract + tests + audit done. Ready to deploy. Needs **human** for wallet setup and faucets.

## What's been done (autonomous, in this session)

- ✅ Phase 2.1 — Foundry scaffold, OpenZeppelin + forge-std submodules, `.env.example`
- ✅ Phase 2.2 — `contracts/PaylockEscrow.sol` (~330 LoC) + **49/49 tests PASS** (41 unit + 5 fuzz × 1000 runs + 3 invariants × ~8k calls)
- ✅ Phase 2.3 — `docs/AUDIT_EVM_ESCROW.md` — self-audit **0 CRIT/HIGH**, 1 LOW accepted (admin-key blast radius capped by `maxLocked=10k USDC`). Slither clean.
- ✅ Phase 2.5 (code only) — `agent-escrow/paylock/evm.py` + `agent-escrow/paylock/chain.py` dispatcher. Modules are offline-safe (`is_ready()` returns False without config — live `paylock.service` unaffected).

## What you need to do next (5-10 min manual setup)

### 1. Create admin + treasury wallets

```bash
# On any EVM-capable machine (laptop/wallet app):
# Option A — programmatic via cast (from foundry, installed on server):
ssh root@38.49.214.214 'export PATH=/root/.foundry/bin:$PATH; cast wallet new' 2>&1
# Save the output — mnemonic + private key + address

# Repeat for treasury:
ssh root@38.49.214.214 'export PATH=/root/.foundry/bin:$PATH; cast wallet new'

# Option B — use MetaMask / Coinbase Wallet UI → "Create Wallet"
#   Two separate wallets: ADMIN (used server-side) and TREASURY (receives fees).
```

**Store the mnemonics somewhere safe.** The server only needs the *admin* private key.

### 2. Get Base Sepolia testnet funds

- **ETH** — https://www.alchemy.com/faucets/base-sepolia (connect wallet, click "Send 0.1 ETH"). Or https://docs.base.org/base-chain/tools/network-faucets
- **USDC** — https://faucet.circle.com (pick Base Sepolia, paste address, get 10 USDC)

Repeat for both admin and treasury wallets (at least ETH — treasury doesn't need USDC initially).

### 3. Get BaseScan API key (for auto-verify)

https://basescan.org/myapikey — sign up, create key.

### 4. Fill `.env` on the server

```bash
ssh root@38.49.214.214
cd /srv/cash2/openclaw-workspace/projects/paylock-onchain
cp .env.example .env
chmod 600 .env
chown root:root .env  # only root runs forge commands for now

# Edit with your values:
vim .env
# BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # default ok
# BASE_ADMIN_PRIVATE_KEY=0x...                    # from step 1
# BASE_TREASURY_ADDRESS=0x...                     # separate address from step 1
# BASESCAN_API_KEY=...                            # from step 3
```

### 5. Deploy to Sepolia

```bash
cd /srv/cash2/openclaw-workspace/projects/paylock-onchain
export PATH=/root/.foundry/bin:$PATH

# Smoke-check wallet has funds
cast balance --rpc-url $BASE_SEPOLIA_RPC_URL $ADMIN_ADDRESS --ether    # >= 0.05
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "balanceOf(address)(uint256)" $ADMIN_ADDRESS    # >= 10e6 (10 USDC)

# Deploy (script needs to be written — simple, 20 lines of Solidity)
# TODO: script/DeployBaseSepolia.s.sol still needs to be created.
# Template below — paste into that file then:
# forge script script/DeployBaseSepolia.s.sol --rpc-url base_sepolia --broadcast --verify -vvvv
```

**Deploy script template** (`script/DeployBaseSepolia.s.sol`):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaylockEscrow} from "../contracts/PaylockEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployBaseSepolia is Script {
    // Sepolia USDC (canonical)
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        address admin    = vm.envAddress("BASE_ADMIN_ADDRESS");
        address treasury = vm.envAddress("BASE_TREASURY_ADDRESS");
        uint256 maxLocked = 10_000e6; // 10k USDC cap

        vm.startBroadcast();
        PaylockEscrow escrow = new PaylockEscrow(
            IERC20(USDC_SEPOLIA), admin, treasury, maxLocked
        );
        vm.stopBroadcast();

        console.log("Deployed PaylockEscrow at:", address(escrow));
    }
}
```

After deploy, save the printed address to `.env` as `BASE_SEPOLIA_ESCROW_ADDRESS=0x...`, then also **restart agent-escrow service** if you want the Python client to pick it up:

```bash
systemctl restart paylock.service
```

(Until `BASE_ESCROW_ADDRESS` is set, `evm.py.is_ready()` stays False and existing Solana flow is 100% unaffected.)

### 6. Smoke test end-to-end

Once deployed, approve USDC + call createEscrow + deposit via cast:

```bash
# Approve USDC to contract
cast send --rpc-url base_sepolia --private-key $BASE_ADMIN_PRIVATE_KEY \
  0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "approve(address,uint256)" $ESCROW_ADDR 1000000

# Create + fund a test escrow
ID=$(cast --format-bytes32-string "test001")
HASH=$(cast keccak "delivered")
DEADLINE=$(( $(date +%s) + 86400 ))   # 24h from now
cast send --rpc-url base_sepolia --private-key $BASE_ADMIN_PRIVATE_KEY \
  $ESCROW_ADDR "createEscrow(bytes32,address,string,bytes32,uint256,uint256)" \
  $ID $SELLER "test gig" $HASH 1000000 $DEADLINE

cast send --rpc-url base_sepolia --private-key $BASE_ADMIN_PRIVATE_KEY \
  $ESCROW_ADDR "deposit(bytes32)" $ID

# Check state
cast call --rpc-url base_sepolia $ESCROW_ADDR "escrows(bytes32)" $ID
```

## When Sepolia is green — come back for Phases 2.6, 2.7, 2.10

- **Phase 2.6** — indexer service (Python poll loop + systemd unit) — ready to write once contract is live.
- **Phase 2.7** — marketplace integration (chain field pass-through in `/escrow/create`) — ready to write.
- **Phase 2.10** — mainnet deploy gate (AUDIT_EVM_ESCROW.md sign-off already satisfies the code criterion).

Ping me with "продолжай Phase 2 с Sepolia deploy готов, address=0x..." — я заберу дальше.

## Security reminder

- `BASE_ADMIN_PRIVATE_KEY` — **never commit**. `.env` is gitignored. `chmod 600`.
- Admin wallet compromise has bounded blast radius (`maxLocked=10_000 USDC`) — see AUDIT_EVM_ESCROW.md LOW-1.
- Rotate admin key via `setAdmin()` contract call if key exposure suspected.

## Files delivered

- `contracts/PaylockEscrow.sol`
- `test/PaylockEscrow.t.sol` (41 unit tests)
- `test/PaylockEscrow.fuzz.t.sol` (5 properties × 1000 runs)
- `test/PaylockEscrow.invariant.t.sol` (3 invariants × ~8k handler calls)
- `foundry.toml`, `remappings.txt`, `.env.example`
- `docs/AUDIT_EVM_ESCROW.md`
- `docs/SEPOLIA_DEPLOY.md` (this file)
- `/srv/cash2/openclaw-workspace/projects/agent-escrow/paylock/evm.py` (web3.py client, offline-safe)
- `/srv/cash2/openclaw-workspace/projects/agent-escrow/paylock/chain.py` (dispatcher)

Branch: `feat/evm-escrow-base` on `kgnvsk/paylock-onchain`.
