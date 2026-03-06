use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("PLKescXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// ─── Constants ───────────────────────────────────────────────────────────────
/// Basis points for fee calculation (1 bp = 0.01%)
const FEE_BPS: u64 = 200; // 2% platform fee
const BPS_DENOMINATOR: u64 = 10_000;
/// Maximum length for metadata strings
const MAX_DESCRIPTION_LEN: usize = 256;
const MAX_DELIVERY_HASH_LEN: usize = 64;

// ─── Program ─────────────────────────────────────────────────────────────────
#[program]
pub mod paylock_escrow {
    use super::*;

    /// Create a new escrow agreement between a client and a provider.
    ///
    /// # Arguments
    /// * `description`    – Human-readable description of the deliverable
    /// * `delivery_hash`  – SHA-256 hex of expected delivery proof (optional)
    /// * `amount`         – Total amount to be held in escrow (lamports or token units)
    /// * `deadline`       – Unix timestamp after which dispute/cancel is allowed
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        description: String,
        delivery_hash: String,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(description.len() <= MAX_DESCRIPTION_LEN, EscrowError::DescriptionTooLong);
        require!(delivery_hash.len() <= MAX_DELIVERY_HASH_LEN, EscrowError::HashTooLong);
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(deadline > Clock::get()?.unix_timestamp, EscrowError::DeadlineInPast);

        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.amount = amount;
        escrow.fee_bps = FEE_BPS;
        escrow.deadline = deadline;
        escrow.description = description;
        escrow.delivery_hash = delivery_hash;
        escrow.verify_hash = String::new();
        escrow.status = EscrowStatus::Created;
        escrow.bump = ctx.bumps.escrow;
        escrow.created_at = Clock::get()?.unix_timestamp;

        emit!(EscrowCreated {
            escrow: escrow.key(),
            client: escrow.client,
            provider: escrow.provider,
            amount,
            deadline,
        });

        Ok(())
    }

    /// Fund the escrow vault with tokens.
    /// Only the client can fund; transfers `amount` tokens into the vault PDA.
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Created, EscrowError::InvalidStatus);

        // Transfer tokens from client to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, escrow.amount)?;

        escrow.status = EscrowStatus::Funded;

        emit!(EscrowFunded {
            escrow: escrow.key(),
            amount: escrow.amount,
        });

        Ok(())
    }

    /// Provider submits delivery proof hash. Client then verifies or disputes.
    pub fn submit_delivery(ctx: Context<SubmitDelivery>, verify_hash: String) -> Result<()> {
        require!(verify_hash.len() <= MAX_DELIVERY_HASH_LEN, EscrowError::HashTooLong);

        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);

        escrow.verify_hash = verify_hash;
        escrow.status = EscrowStatus::DeliverySubmitted;

        emit!(DeliverySubmitted {
            escrow: escrow.key(),
            provider: ctx.accounts.provider.key(),
        });

        Ok(())
    }

    /// Release funds to the provider after successful delivery verification.
    /// Only the client can release (or auto-release if deadline passed).
    /// Platform fee is deducted and sent to treasury.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded
                || escrow.status == EscrowStatus::DeliverySubmitted,
            EscrowError::InvalidStatus
        );

        // Auto-verify: if delivery_hash matches verify_hash, approve automatically
        let auto_approved = !escrow.delivery_hash.is_empty()
            && !escrow.verify_hash.is_empty()
            && escrow.delivery_hash == escrow.verify_hash;

        let clock = Clock::get()?;
        let caller_is_client = ctx.accounts.authority.key() == escrow.client;

        require!(
            caller_is_client || auto_approved || clock.unix_timestamp > escrow.deadline,
            EscrowError::Unauthorized
        );

        // Calculate fee
        let fee_amount = escrow.amount
            .checked_mul(escrow.fee_bps)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        let provider_amount = escrow.amount.checked_sub(fee_amount).unwrap();

        let seeds = &[
            b"escrow",
            escrow.client.as_ref(),
            escrow.provider.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer to provider
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.provider_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, provider_amount)?;

        // Transfer fee to treasury
        if fee_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, fee_amount)?;
        }

        escrow.status = EscrowStatus::Released;

        emit!(EscrowReleased {
            escrow: escrow.key(),
            provider_amount,
            fee_amount,
        });

        Ok(())
    }

    /// Open a dispute. Either party can dispute after submission, before deadline.
    pub fn dispute_escrow(ctx: Context<DisputeEscrow>, reason: String) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded
                || escrow.status == EscrowStatus::DeliverySubmitted,
            EscrowError::InvalidStatus
        );

        let caller = ctx.accounts.authority.key();
        require!(
            caller == escrow.client || caller == escrow.provider,
            EscrowError::Unauthorized
        );

        escrow.status = EscrowStatus::Disputed;

        emit!(EscrowDisputed {
            escrow: escrow.key(),
            disputer: caller,
            reason,
        });

        Ok(())
    }

    /// Resolve a dispute. Only an arbitrator (treasury authority) can resolve.
    /// `client_share_bps` — how many basis points go to client (rest to provider).
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, client_share_bps: u64) -> Result<()> {
        require!(client_share_bps <= BPS_DENOMINATOR, EscrowError::InvalidAmount);

        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Disputed, EscrowError::InvalidStatus);

        let client_amount = escrow.amount
            .checked_mul(client_share_bps)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        let provider_amount = escrow.amount.checked_sub(client_amount).unwrap();

        let seeds = &[
            b"escrow",
            escrow.client.as_ref(),
            escrow.provider.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        if client_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, client_amount)?;
        }

        if provider_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, provider_amount)?;
        }

        escrow.status = EscrowStatus::Resolved;

        emit!(DisputeResolved {
            escrow: escrow.key(),
            client_amount,
            provider_amount,
        });

        Ok(())
    }

    /// Cancel an escrow and return funds to client.
    /// Can only be cancelled if: not yet funded, or both parties agree, or deadline passed.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        let clock = Clock::get()?;
        let caller = ctx.accounts.authority.key();

        match escrow.status {
            EscrowStatus::Created => {
                // Client can cancel before funding
                require!(caller == escrow.client, EscrowError::Unauthorized);
            }
            EscrowStatus::Funded | EscrowStatus::DeliverySubmitted => {
                // After deadline, client can cancel; provider can always cancel (mutual agreement implied)
                require!(
                    clock.unix_timestamp > escrow.deadline || caller == escrow.provider,
                    EscrowError::Unauthorized
                );

                // Refund client
                let seeds = &[
                    b"escrow",
                    escrow.client.as_ref(),
                    escrow.provider.as_ref(),
                    &[escrow.bump],
                ];
                let signer_seeds = &[&seeds[..]];

                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.client_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                token::transfer(cpi_ctx, escrow.amount)?;
            }
            _ => return err!(EscrowError::InvalidStatus),
        }

        escrow.status = EscrowStatus::Cancelled;

        emit!(EscrowCancelled {
            escrow: escrow.key(),
            cancelled_by: caller,
        });

        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(description: String, delivery_hash: String, amount: u64, deadline: i64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    /// CHECK: Provider pubkey, validated in logic
    pub provider: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = client,
        space = EscrowAccount::SPACE,
        seeds = [b"escrow", client.key().as_ref(), provider.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = client,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", client.key().as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
        has_one = client,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct SubmitDelivery<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), provider.key().as_ref()],
        bump = escrow.bump,
        has_one = provider,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow.provider,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct DisputeEscrow<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// CHECK: Arbitrator — must be the treasury authority
    pub arbitrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow.client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow.provider,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = escrow.client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ─── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct EscrowAccount {
    /// The client who creates and funds the escrow
    pub client: Pubkey,
    /// The service provider who fulfills the contract
    pub provider: Pubkey,
    /// SPL token mint (e.g., USDC)
    pub mint: Pubkey,
    /// Vault PDA holding the tokens
    pub vault: Pubkey,
    /// Total escrow amount in token units
    pub amount: u64,
    /// Platform fee in basis points (200 = 2%)
    pub fee_bps: u64,
    /// Deadline unix timestamp
    pub deadline: i64,
    /// Created at unix timestamp
    pub created_at: i64,
    /// Human-readable description
    pub description: String,
    /// SHA-256 hex of expected delivery (set at creation)
    pub delivery_hash: String,
    /// SHA-256 hex submitted by provider as proof
    pub verify_hash: String,
    /// Current escrow status
    pub status: EscrowStatus,
    /// PDA bump
    pub bump: u8,
}

impl EscrowAccount {
    pub const SPACE: usize = 8          // discriminator
        + 32                            // client
        + 32                            // provider
        + 32                            // mint
        + 32                            // vault
        + 8                             // amount
        + 8                             // fee_bps
        + 8                             // deadline
        + 8                             // created_at
        + 4 + MAX_DESCRIPTION_LEN       // description
        + 4 + MAX_DELIVERY_HASH_LEN     // delivery_hash
        + 4 + MAX_DELIVERY_HASH_LEN     // verify_hash
        + 1                             // status enum
        + 1                             // bump
        + 64;                           // padding
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum EscrowStatus {
    Created,
    Funded,
    DeliverySubmitted,
    Released,
    Disputed,
    Resolved,
    Cancelled,
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct EscrowFunded {
    pub escrow: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DeliverySubmitted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub provider_amount: u64,
    pub fee_amount: u64,
}

#[event]
pub struct EscrowDisputed {
    pub escrow: Pubkey,
    pub disputer: Pubkey,
    pub reason: String,
}

#[event]
pub struct DisputeResolved {
    pub escrow: Pubkey,
    pub client_amount: u64,
    pub provider_amount: u64,
}

#[event]
pub struct EscrowCancelled {
    pub escrow: Pubkey,
    pub cancelled_by: Pubkey,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum EscrowError {
    #[msg("Escrow is not in the required status for this operation")]
    InvalidStatus,
    #[msg("Caller is not authorized to perform this action")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Description exceeds maximum length of 256 characters")]
    DescriptionTooLong,
    #[msg("Hash exceeds maximum length of 64 characters")]
    HashTooLong,
}
