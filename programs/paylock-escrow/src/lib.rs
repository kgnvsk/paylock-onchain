use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8");

// ─── Constants ───────────────────────────────────────────────────────────────
const FEE_BPS: u64 = 200;
const BPS_DENOMINATOR: u64 = 10_000;
const MAX_DESCRIPTION_LEN: usize = 256;
const MAX_DELIVERY_HASH_LEN: usize = 64;

// ─── Program ─────────────────────────────────────────────────────────────────
#[program]
pub mod paylock_escrow {
    use super::*;

    /// Create a new escrow agreement between a client and a provider.
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
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.treasury = ctx.accounts.treasury.key();
        escrow.status = EscrowStatus::Created;
        escrow.bump = ctx.bumps.escrow;
        escrow.created_at = Clock::get()?.unix_timestamp;

        let escrow_key = escrow.key();
        let client_key = escrow.client;
        let provider_key = escrow.provider;

        emit!(EscrowCreated {
            escrow: escrow_key,
            client: client_key,
            provider: provider_key,
            amount,
            deadline,
        });

        Ok(())
    }

    /// Fund the escrow vault with tokens.
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Created,
            EscrowError::InvalidStatus
        );

        let amount = ctx.accounts.escrow.amount;

        let cpi_accounts = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Funded;

        emit!(EscrowFunded { escrow: escrow.key(), amount });

        Ok(())
    }

    /// Provider submits delivery proof hash.
    pub fn submit_delivery(ctx: Context<SubmitDelivery>, verify_hash: String) -> Result<()> {
        require!(verify_hash.len() <= MAX_DELIVERY_HASH_LEN, EscrowError::HashTooLong);
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Funded,
            EscrowError::InvalidStatus
        );

        let provider_key = ctx.accounts.provider.key();
        let escrow = &mut ctx.accounts.escrow;
        escrow.verify_hash = verify_hash;
        escrow.status = EscrowStatus::DeliverySubmitted;

        emit!(DeliverySubmitted { escrow: escrow.key(), provider: provider_key });

        Ok(())
    }

    /// Release funds to provider after delivery verification.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        // Validate status first before any borrows
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Funded
                || ctx.accounts.escrow.status == EscrowStatus::DeliverySubmitted,
            EscrowError::InvalidStatus
        );

        // Extract all needed values before mutable borrow
        let auto_approved = !ctx.accounts.escrow.delivery_hash.is_empty()
            && !ctx.accounts.escrow.verify_hash.is_empty()
            && ctx.accounts.escrow.delivery_hash == ctx.accounts.escrow.verify_hash;

        let clock = Clock::get()?;
        let caller_is_client = ctx.accounts.authority.key() == ctx.accounts.escrow.client;

        require!(
            caller_is_client || auto_approved || clock.unix_timestamp > ctx.accounts.escrow.deadline,
            EscrowError::Unauthorized
        );

        let amount = ctx.accounts.escrow.amount;
        let fee_bps = ctx.accounts.escrow.fee_bps;
        let client_key = ctx.accounts.escrow.client;
        let provider_key = ctx.accounts.escrow.provider;
        let bump = ctx.accounts.escrow.bump;

        let fee_amount = amount.checked_mul(fee_bps).ok_or(EscrowError::ArithmeticOverflow)?.checked_div(BPS_DENOMINATOR).ok_or(EscrowError::ArithmeticOverflow)?;
        let provider_amount = amount.checked_sub(fee_amount).ok_or(EscrowError::ArithmeticOverflow)?;

        // Build signer seeds
        let client_ref = client_key.as_ref().to_vec();
        let provider_ref = provider_key.as_ref().to_vec();
        let bump_arr = [bump];
        let seeds: &[&[u8]] = &[b"escrow", &client_ref, &provider_ref, &bump_arr];
        let signer_seeds = &[seeds];

        // Get account infos
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let vault_info = ctx.accounts.vault.to_account_info();
        let provider_ata_info = ctx.accounts.provider_token_account.to_account_info();
        let treasury_info = ctx.accounts.treasury_token_account.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();

        // Transfer to provider
        token::transfer(
            CpiContext::new_with_signer(
                token_program_info.clone(),
                Transfer {
                    from: vault_info.clone(),
                    to: provider_ata_info,
                    authority: escrow_info.clone(),
                },
                signer_seeds,
            ),
            provider_amount,
        )?;

        // Transfer fee to treasury
        if fee_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_info,
                    Transfer {
                        from: vault_info,
                        to: treasury_info,
                        authority: escrow_info,
                    },
                    signer_seeds,
                ),
                fee_amount,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Released;

        emit!(EscrowReleased { escrow: escrow.key(), provider_amount, fee_amount });

        Ok(())
    }

    /// Open a dispute.
    pub fn dispute_escrow(ctx: Context<DisputeEscrow>, reason: String) -> Result<()> {
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Funded
                || ctx.accounts.escrow.status == EscrowStatus::DeliverySubmitted,
            EscrowError::InvalidStatus
        );

        let caller = ctx.accounts.authority.key();
        require!(
            caller == ctx.accounts.escrow.client || caller == ctx.accounts.escrow.provider,
            EscrowError::Unauthorized
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Disputed;

        emit!(EscrowDisputed { escrow: escrow.key(), disputer: caller, reason });

        Ok(())
    }

    /// Resolve a dispute. Only arbitrator can call.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, client_share_bps: u64) -> Result<()> {
        require!(client_share_bps <= BPS_DENOMINATOR, EscrowError::InvalidAmount);
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Disputed,
            EscrowError::InvalidStatus
        );

        let amount = ctx.accounts.escrow.amount;
        let client_key = ctx.accounts.escrow.client;
        let provider_key = ctx.accounts.escrow.provider;
        let bump = ctx.accounts.escrow.bump;

        let client_amount = amount.checked_mul(client_share_bps).ok_or(EscrowError::ArithmeticOverflow)?.checked_div(BPS_DENOMINATOR).ok_or(EscrowError::ArithmeticOverflow)?;
        let provider_amount = amount.checked_sub(client_amount).ok_or(EscrowError::ArithmeticOverflow)?;

        let client_ref = client_key.as_ref().to_vec();
        let provider_ref = provider_key.as_ref().to_vec();
        let bump_arr = [bump];
        let seeds: &[&[u8]] = &[b"escrow", &client_ref, &provider_ref, &bump_arr];
        let signer_seeds = &[seeds];

        let escrow_info = ctx.accounts.escrow.to_account_info();
        let vault_info = ctx.accounts.vault.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let client_ata_info = ctx.accounts.client_token_account.to_account_info();
        let provider_ata_info = ctx.accounts.provider_token_account.to_account_info();

        if client_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_info.clone(),
                    Transfer {
                        from: vault_info.clone(),
                        to: client_ata_info,
                        authority: escrow_info.clone(),
                    },
                    signer_seeds,
                ),
                client_amount,
            )?;
        }

        if provider_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_info,
                    Transfer {
                        from: vault_info,
                        to: provider_ata_info,
                        authority: escrow_info,
                    },
                    signer_seeds,
                ),
                provider_amount,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Resolved;

        emit!(DisputeResolved { escrow: escrow.key(), client_amount, provider_amount });

        Ok(())
    }

    /// Cancel an escrow and return funds to client.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let clock = Clock::get()?;
        let caller = ctx.accounts.authority.key();
        let status = ctx.accounts.escrow.status.clone();
        let client_key = ctx.accounts.escrow.client;
        let provider_key = ctx.accounts.escrow.provider;
        let bump = ctx.accounts.escrow.bump;
        let amount = ctx.accounts.escrow.amount;

        match status {
            EscrowStatus::Created => {
                require!(caller == client_key, EscrowError::Unauthorized);
                // No tokens to return — vault is empty
                let escrow = &mut ctx.accounts.escrow;
                escrow.status = EscrowStatus::Cancelled;
            }
            EscrowStatus::Funded | EscrowStatus::DeliverySubmitted => {
                require!(caller == client_key, EscrowError::Unauthorized);
                require!(clock.unix_timestamp > ctx.accounts.escrow.deadline, EscrowError::Unauthorized);

                let client_ref = client_key.as_ref().to_vec();
                let provider_ref = provider_key.as_ref().to_vec();
                let bump_arr = [bump];
                let seeds: &[&[u8]] = &[b"escrow", &client_ref, &provider_ref, &bump_arr];
                let signer_seeds = &[seeds];

                let escrow_info = ctx.accounts.escrow.to_account_info();
                let vault_info = ctx.accounts.vault.to_account_info();
                let client_ata_info = ctx.accounts.client_token_account.to_account_info();
                let token_program_info = ctx.accounts.token_program.to_account_info();

                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_info,
                        Transfer {
                            from: vault_info,
                            to: client_ata_info,
                            authority: escrow_info,
                        },
                        signer_seeds,
                    ),
                    amount,
                )?;

                let escrow = &mut ctx.accounts.escrow;
                escrow.status = EscrowStatus::Cancelled;
            }
            _ => return err!(EscrowError::InvalidStatus),
        }

        emit!(EscrowCancelled { escrow: ctx.accounts.escrow.key(), cancelled_by: caller });

        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(description: String, delivery_hash: String, amount: u64, deadline: i64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    /// CHECK: Provider pubkey — no validation needed, stored in escrow state
    pub provider: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    /// CHECK: Arbitrator allowed to resolve disputes for this escrow
    pub arbitrator: AccountInfo<'info>,

    /// CHECK: Treasury authority that receives fees for this escrow
    pub treasury: AccountInfo<'info>,

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

    /// CHECK: Treasury authority bound to escrow at creation time
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
        has_one = treasury,
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

    #[account(
        mut,
        associated_token::mint = escrow.mint,
        associated_token::authority = treasury,
    )]
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
    pub arbitrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref()],
        bump = escrow.bump,
        has_one = arbitrator,
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
    pub client: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub arbitrator: Pubkey,
    pub treasury: Pubkey,
    pub amount: u64,
    pub fee_bps: u64,
    pub deadline: i64,
    pub created_at: i64,
    pub description: String,
    pub delivery_hash: String,
    pub verify_hash: String,
    pub status: EscrowStatus,
    pub bump: u8,
}

impl EscrowAccount {
    pub const SPACE: usize = 8
        + 32 + 32 + 32 + 32 + 32 + 32  // pubkeys
        + 8 + 8 + 8 + 8      // u64/i64 fields
        + 4 + MAX_DESCRIPTION_LEN
        + 4 + MAX_DELIVERY_HASH_LEN
        + 4 + MAX_DELIVERY_HASH_LEN
        + 1                   // status
        + 1                   // bump
        + 64;                 // padding
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
    #[msg("Arithmetic overflow in fee calculation")]
    ArithmeticOverflow,
}
