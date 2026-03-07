# PayLock Escrow Event Schema

All state transitions emit an event with the escrow id and actor.

## `EscrowCreated`
- `escrow: Pubkey`
- `actor: Pubkey` (creator/client)
- `client: Pubkey`
- `provider: Pubkey`
- `amount: u64`
- `fee_bps: u64`
- `deadline: i64`

## `EscrowFunded`
- `escrow: Pubkey`
- `actor: Pubkey` (client)
- `amount: u64`

## `DeliverySubmitted`
- `escrow: Pubkey`
- `actor: Pubkey` (provider)
- `verify_hash: String`

## `EscrowReleased`
- `escrow: Pubkey`
- `actor: Pubkey` (release caller)
- `amount: u64` (gross amount)
- `provider_amount: u64`
- `fee_amount: u64`

## `EscrowDisputed`
- `escrow: Pubkey`
- `actor: Pubkey` (disputer)
- `reason: String`

## `DisputeResolved`
- `escrow: Pubkey`
- `actor: Pubkey` (arbitrator)
- `amount: u64` (gross amount)
- `client_amount: u64`
- `provider_amount: u64`

## `EscrowCancelled`
- `escrow: Pubkey`
- `actor: Pubkey` (canceller)
- `amount: u64` (escrow amount)
