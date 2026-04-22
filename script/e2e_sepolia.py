import os
"""E2E escrow flow on Base Sepolia — real USDC, real chain.

Steps:
  1. Generate fresh seller keypair
  2. Fund seller with small ETH from admin (for gas)
  3. Admin (as buyer) calls createEscrow
  4. Admin approves USDC + deposits
  5. Seller signs submitDelivery with matching verifyHash
  6. Anyone calls release — payout fires
  7. Verify balances: seller gets amount - fee, treasury gets fee

Uses raw tx construction (web3.py) — no Foundry dependency beyond deploy.
"""
import sys

from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_defunct
import secrets as _secrets

RPC = "https://sepolia.base.org"
CONTRACT = Web3.to_checksum_address("0xcBe994F0e33Af41033dE22af7fd9624dC9889194")
USDC = Web3.to_checksum_address("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
ADMIN_PRIV = os.environ["BASE_ADMIN_PRIVATE_KEY"]  # from .env

w3 = Web3(Web3.HTTPProvider(RPC))
admin = Account.from_key(ADMIN_PRIV)
print(f"Admin: {admin.address}")

# 1. Generate seller
seller_priv = "0x" + _secrets.token_hex(32)
seller = Account.from_key(seller_priv)
print(f"Seller (ephemeral): {seller.address}")

# --- Minimal ABIs ---
PAYLOCK_ABI = [
    {"name":"createEscrow","type":"function","stateMutability":"nonpayable",
     "inputs":[
         {"name":"id","type":"bytes32"},{"name":"seller","type":"address"},
         {"name":"description","type":"string"},{"name":"deliveryHash","type":"bytes32"},
         {"name":"amount","type":"uint256"},{"name":"deadline","type":"uint256"}],
     "outputs":[]},
    {"name":"deposit","type":"function","stateMutability":"nonpayable",
     "inputs":[{"name":"id","type":"bytes32"}],"outputs":[]},
    {"name":"submitDelivery","type":"function","stateMutability":"nonpayable",
     "inputs":[{"name":"id","type":"bytes32"},{"name":"verifyHash","type":"bytes32"}],
     "outputs":[]},
    {"name":"release","type":"function","stateMutability":"nonpayable",
     "inputs":[{"name":"id","type":"bytes32"}],"outputs":[]},
    {"name":"escrows","type":"function","stateMutability":"view",
     "inputs":[{"name":"","type":"bytes32"}],
     "outputs":[
         {"name":"buyer","type":"address"},{"name":"seller","type":"address"},
         {"name":"amount","type":"uint256"},{"name":"feeBps","type":"uint256"},
         {"name":"deadline","type":"uint256"},{"name":"description","type":"string"},
         {"name":"deliveryHash","type":"bytes32"},{"name":"verifyHash","type":"bytes32"},
         {"name":"status","type":"uint8"},{"name":"createdAt","type":"uint64"},
         {"name":"fundedAt","type":"uint64"},{"name":"deliveredAt","type":"uint64"},
         {"name":"releasedAt","type":"uint64"}]},
]

ERC20_ABI = [
    {"name":"approve","type":"function","stateMutability":"nonpayable",
     "inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],
     "outputs":[{"name":"","type":"bool"}]},
    {"name":"balanceOf","type":"function","stateMutability":"view",
     "inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
]

paylock = w3.eth.contract(address=CONTRACT, abi=PAYLOCK_ABI)
usdc = w3.eth.contract(address=USDC, abi=ERC20_ABI)

def send(acct, fn, value=0, gas=None):
    """Build+sign+send; wait for receipt; return receipt."""
    nonce = w3.eth.get_transaction_count(acct.address, "pending")
    tx = fn.build_transaction({
        "from": acct.address, "nonce": nonce, "value": value,
        "gas": gas or 300_000,
        "maxFeePerGas": w3.to_wei(0.2, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(0.05, "gwei"),
        "chainId": 84532,
    })
    signed = w3.eth.account.sign_transaction(tx, acct.key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"    tx: {h.hex()}")
    r = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    if r.status != 1:
        print(f"    FAILED: {r}")
        sys.exit(1)
    return r

def send_eth(from_acct, to, amount_wei):
    nonce = w3.eth.get_transaction_count(from_acct.address)
    tx = {
        "from": from_acct.address, "to": to, "value": amount_wei,
        "nonce": nonce, "gas": 21_000,
        "maxFeePerGas": w3.to_wei(0.2, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(0.05, "gwei"),
        "chainId": 84532,
    }
    signed = w3.eth.account.sign_transaction(tx, from_acct.key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"    tx: {h.hex()}")
    w3.eth.wait_for_transaction_receipt(h, timeout=120)

# --- Test params ---
# Random bytes32 id, random delivery hash (secret), amount 1 USDC, deadline 1 hour
eid = "0x" + _secrets.token_hex(32)
delivery_hash = "0x" + _secrets.token_hex(32)
amount = 1_000_000  # 1 USDC (6 decimals)
import time as _t
deadline = int(_t.time()) + 3600

print(f"\nEscrow id: {eid}")
print(f"Delivery hash: {delivery_hash} (seller will submit this)")
print(f"Amount: 1 USDC, deadline: +1h")

# 2. Fund seller with 0.00005 ETH for gas
print("\n[2/7] Fund seller with 0.00005 ETH (gas)")
send_eth(admin, seller.address, w3.to_wei(0.0001, "ether"))

# 3. Admin createEscrow (admin = buyer)
print("\n[3/7] admin createEscrow")
send(admin, paylock.functions.createEscrow(
    Web3.to_bytes(hexstr=eid), seller.address, "E2E test on Sepolia",
    Web3.to_bytes(hexstr=delivery_hash), amount, deadline,
))

# 4. Admin approve USDC
print("\n[4/7] admin approve USDC")
send(admin, usdc.functions.approve(CONTRACT, amount))

# 5. Admin deposit (pulls USDC)
print("\n[5/7] admin deposit")
send(admin, paylock.functions.deposit(Web3.to_bytes(hexstr=eid)))

# 6. Seller submitDelivery with matching hash
print("\n[6/7] seller submitDelivery")
send(seller, paylock.functions.submitDelivery(
    Web3.to_bytes(hexstr=eid), Web3.to_bytes(hexstr=delivery_hash),
))

# 7. Anyone releases
print("\n[7/7] admin release")
send(admin, paylock.functions.release(Web3.to_bytes(hexstr=eid)))

# Final state
print("\n=== Final state ===")
escrow = paylock.functions.escrows(Web3.to_bytes(hexstr=eid)).call()
STATUS_NAMES = ["None", "Created", "Funded", "Delivered", "Released", "Disputed", "Resolved", "Cancelled", "Refunded"]
print(f"status: {STATUS_NAMES[escrow[8]]} (enum value {escrow[8]})")
print(f"seller USDC balance: {usdc.functions.balanceOf(seller.address).call() / 1e6} USDC")
print(f"admin USDC balance:  {usdc.functions.balanceOf(admin.address).call() / 1e6} USDC")
admin_balance = usdc.functions.balanceOf(admin.address).call()
print(f"\nAdmin total USDC spent: {(20_000_000 - admin_balance) / 1e6}")
print("(Admin is treasury too on Sepolia — receives fee, so net spend = amount)")
