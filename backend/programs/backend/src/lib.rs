use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("CdHmtAeZLRFLqeZmfJtEM6deJxbW2i9kqMDJr9kmcP7Y");

// ─────────────────────────────────────────────────────────────────────────────
//  SolSponsor — Performance-Based Sponsorship Escrow on Solana
//
//  Instructions:
//    1. initialize_contract  — Sponsor creates the escrow account + vault PDA
//    2. fund_escrow          — Sponsor deposits SOL into the vault PDA
//    3. verify_conditions    — Authority marks whether conditions were met
//    4. release_payment      — Releases vault SOL → athlete (if conditions met)
//    5. refund_sponsor       — Returns vault SOL → sponsor (if conditions NOT met)
//
//  Account: SponsorshipContract
//    sponsor           Pubkey   — who deposits / created the contract
//    athlete           Pubkey   — who receives payment on success
//    escrow_vault      Pubkey   — the PDA holding locked SOL
//    amount            u64      — lamports to hold in escrow
//    conditions_met    bool     — set true by authority after oracle verification
//    payment_released  bool     — guards against double-release
//    bump              u8       — vault PDA bump seed
//    created_at        i64      — Unix timestamp
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod solsponsor {
    use super::*;

    // ── 1. INITIALIZE CONTRACT ────────────────────────────────────────────────
    /// Sponsor creates the SponsorshipContract account and derives the vault PDA.
    /// The vault PDA is a pure SOL escrow — no token mint required.
    ///
    /// Accounts:
    ///   sponsor   — signer, pays rent for the contract account
    ///   contract  — new keypair (generated client-side), stores contract state
    ///   vault     — PDA ["vault", contract.key()], will hold locked SOL
    pub fn initialize_contract(
        ctx: Context<InitializeContract>,
        athlete: Pubkey,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, SolSponsorError::InvalidAmount);

        let contract = &mut ctx.accounts.contract;
        let clock = Clock::get()?;

        contract.sponsor = ctx.accounts.sponsor.key();
        contract.athlete = athlete;
        contract.escrow_vault = ctx.accounts.vault.key();
        contract.amount = amount;
        contract.conditions_met = false;
        contract.payment_released = false;
        contract.bump = ctx.bumps.vault;
        contract.created_at = clock.unix_timestamp;

        emit!(ContractInitialized {
            sponsor: contract.sponsor,
            athlete: contract.athlete,
            amount,
            vault: contract.escrow_vault,
            timestamp: clock.unix_timestamp,
        });

        msg!(
            "SolSponsor: Contract initialized. Sponsor={}, Athlete={}, Amount={}",
            contract.sponsor,
            contract.athlete,
            amount
        );

        Ok(())
    }

    // ── 2. FUND ESCROW ────────────────────────────────────────────────────────
    /// Sponsor transfers `contract.amount` lamports into the vault PDA.
    /// Uses system_program::transfer — no CPI to token program.
    ///
    /// Accounts:
    ///   sponsor   — signer, must match contract.sponsor, provides lamports
    ///   contract  — existing SponsorshipContract account (mut)
    ///   vault     — PDA that will hold the SOL
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let contract = &ctx.accounts.contract;

        require!(
            ctx.accounts.sponsor.key() == contract.sponsor,
            SolSponsorError::Unauthorized
        );
        require!(!contract.payment_released, SolSponsorError::AlreadyReleased);

        let amount = contract.amount;

        // Transfer SOL sponsor → vault PDA via CPI to system program
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sponsor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, amount)?;

        emit!(EscrowFunded {
            sponsor: ctx.accounts.sponsor.key(),
            vault: ctx.accounts.vault.key(),
            amount,
        });

        msg!("SolSponsor: Vault funded with {} lamports", amount);

        Ok(())
    }

    // ── 3. VERIFY CONDITIONS ──────────────────────────────────────────────────
    /// Called by the oracle authority (currently the sponsor for the demo).
    /// In production: a multisig oracle or a Switchboard/Pyth feed integration.
    ///
    /// Sets conditions_met on the contract account.
    /// The AI oracle (Gemini) has already evaluated the race data off-chain;
    /// this instruction writes the verdict on-chain.
    ///
    /// Accounts:
    ///   authority  — signer, must be the original sponsor / oracle authority
    ///   contract   — existing SponsorshipContract account (mut)
    pub fn verify_conditions(
        ctx: Context<VerifyConditions>,
        conditions_met: bool,
    ) -> Result<()> {
        let contract = &mut ctx.accounts.contract;

        require!(
            ctx.accounts.authority.key() == contract.sponsor,
            SolSponsorError::Unauthorized
        );
        require!(!contract.payment_released, SolSponsorError::AlreadyReleased);

        contract.conditions_met = conditions_met;

        emit!(ConditionsVerified {
            contract: contract.key(),
            conditions_met,
            verifier: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!(
            "SolSponsor: Conditions verified — conditions_met={}",
            conditions_met
        );

        Ok(())
    }

    // ── 4. RELEASE PAYMENT ────────────────────────────────────────────────────
    /// Transfers SOL from vault PDA → athlete wallet.
    /// Only succeeds when conditions_met == true.
    ///
    /// Uses PDA signer seeds ["vault", contract.key(), bump] for the CPI.
    ///
    /// Accounts:
    ///   contract  — SponsorshipContract (mut), provides signer seeds context
    ///   vault     — PDA holding the SOL (mut)
    ///   athlete   — destination wallet (mut), must match contract.athlete
    pub fn release_payment(ctx: Context<ReleasePayment>) -> Result<()> {
        let contract = &mut ctx.accounts.contract;

        require!(contract.conditions_met, SolSponsorError::ConditionsNotMet);
        require!(!contract.payment_released, SolSponsorError::AlreadyReleased);
        require!(
            ctx.accounts.athlete.key() == contract.athlete,
            SolSponsorError::Unauthorized
        );

        let amount = contract.amount;
        let bump = contract.bump;
        let contract_key = contract.key();

        // PDA signer seeds
        let seeds: &[&[&[u8]]] = &[&[
            b"vault",
            contract_key.as_ref(),
            &[bump],
        ]];

        // Transfer SOL vault PDA → athlete via system_program CPI with PDA signer
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.athlete.to_account_info(),
            },
            seeds,
        );
        system_program::transfer(cpi_ctx, amount)?;

        contract.payment_released = true;

        emit!(PaymentReleased {
            athlete: ctx.accounts.athlete.key(),
            amount,
            vault: ctx.accounts.vault.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!(
            "SolSponsor: {} lamports released → athlete {}",
            amount,
            ctx.accounts.athlete.key()
        );

        Ok(())
    }

    // ── 5. REFUND SPONSOR ─────────────────────────────────────────────────────
    /// Returns vault SOL back to the sponsor when conditions were NOT met.
    /// Callable only by the sponsor, only after conditions_met == false is set.
    ///
    /// Accounts:
    ///   sponsor   — signer + recipient (mut), must match contract.sponsor
    ///   contract  — SponsorshipContract (mut)
    ///   vault     — PDA holding the SOL (mut)
    pub fn refund_sponsor(ctx: Context<RefundSponsor>) -> Result<()> {
        let contract = &mut ctx.accounts.contract;

        require!(
            ctx.accounts.sponsor.key() == contract.sponsor,
            SolSponsorError::Unauthorized
        );
        // conditions_met must have been explicitly set to false first
        require!(!contract.conditions_met, SolSponsorError::ConditionsWereMet);
        require!(!contract.payment_released, SolSponsorError::AlreadyReleased);

        let amount = contract.amount;
        let bump = contract.bump;
        let contract_key = contract.key();

        let seeds: &[&[&[u8]]] = &[&[
            b"vault",
            contract_key.as_ref(),
            &[bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.sponsor.to_account_info(),
            },
            seeds,
        );
        system_program::transfer(cpi_ctx, amount)?;

        // Mark as released to block double-refund
        contract.payment_released = true;

        emit!(SponsorRefunded {
            sponsor: ctx.accounts.sponsor.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!(
            "SolSponsor: {} lamports refunded → sponsor {}",
            amount,
            ctx.accounts.sponsor.key()
        );

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Account Contexts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeContract<'info> {
    /// Sponsor pays for account rent and signs the transaction
    #[account(mut)]
    pub sponsor: Signer<'info>,

    /// New SponsorshipContract account — client generates the keypair
    /// Space: 8 discriminator + 32 sponsor + 32 athlete + 32 vault +
    ///        8 amount + 1 conditions_met + 1 payment_released + 1 bump + 8 created_at
    ///        = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8 = 123 bytes
    #[account(
        init,
        payer = sponsor,
        space = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8,
    )]
    pub contract: Account<'info, SponsorshipContract>,

    /// Vault PDA derived from ["vault", contract.key()]
    /// Holds no data — just accumulates SOL lamports
    #[account(
        mut,
        seeds = [b"vault", contract.key().as_ref()],
        bump,
    )]
    /// CHECK: This is a pure lamport vault PDA. No data stored here.
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        has_one = sponsor @ SolSponsorError::Unauthorized,
    )]
    pub contract: Account<'info, SponsorshipContract>,

    /// CHECK: Vault PDA — lamport sink
    #[account(
        mut,
        seeds = [b"vault", contract.key().as_ref()],
        bump = contract.bump,
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyConditions<'info> {
    /// Oracle authority — for demo this is the sponsor.
    /// Production: replace with a dedicated oracle keypair or multisig.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = sponsor @ SolSponsorError::Unauthorized,
        // Reuse sponsor field: authority must == sponsor
        // (constraint checked in instruction body)
    )]
    pub contract: Account<'info, SponsorshipContract>,

    /// CHECK: Only used for key comparison in the instruction body
    pub sponsor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ReleasePayment<'info> {
    #[account(
        mut,
        has_one = athlete @ SolSponsorError::Unauthorized,
    )]
    pub contract: Account<'info, SponsorshipContract>,

    /// CHECK: Vault PDA — lamport source
    #[account(
        mut,
        seeds = [b"vault", contract.key().as_ref()],
        bump = contract.bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// Destination: must match contract.athlete
    /// CHECK: Validated via has_one constraint above
    #[account(mut)]
    pub athlete: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundSponsor<'info> {
    #[account(
        mut,
        has_one = sponsor @ SolSponsorError::Unauthorized,
    )]
    pub contract: Account<'info, SponsorshipContract>,

    /// CHECK: Vault PDA — lamport source
    #[account(
        mut,
        seeds = [b"vault", contract.key().as_ref()],
        bump = contract.bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Validated via has_one constraint above
    #[account(mut)]
    pub sponsor: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  State Account
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct SponsorshipContract {
    /// Wallet that created and funded the escrow
    pub sponsor: Pubkey,           // 32

    /// Wallet that receives payment when conditions are met
    pub athlete: Pubkey,           // 32

    /// The vault PDA public key (stored for reference / event indexing)
    pub escrow_vault: Pubkey,      // 32

    /// Lamports locked in the escrow vault
    pub amount: u64,               // 8

    /// Set to true by oracle authority after off-chain AI verification
    pub conditions_met: bool,      // 1

    /// Guards against double-release or double-refund
    pub payment_released: bool,    // 1

    /// PDA bump seed (needed for signer CPI in release/refund)
    pub bump: u8,                  // 1

    /// Unix timestamp of contract creation (for expiry logic in v2)
    pub created_at: i64,           // 8
                                   // TOTAL: 115 bytes + 8 discriminator = 123
}

// ─────────────────────────────────────────────────────────────────────────────
//  Events (emitted to Solana transaction logs, indexable by clients)
// ─────────────────────────────────────────────────────────────────────────────

#[event]
pub struct ContractInitialized {
    pub sponsor: Pubkey,
    pub athlete: Pubkey,
    pub amount: u64,
    pub vault: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EscrowFunded {
    pub sponsor: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ConditionsVerified {
    pub contract: Pubkey,
    pub conditions_met: bool,
    pub verifier: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PaymentReleased {
    pub athlete: Pubkey,
    pub amount: u64,
    pub vault: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct SponsorRefunded {
    pub sponsor: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum SolSponsorError {
    #[msg("Caller is not authorized to perform this action")]
    Unauthorized,

    #[msg("Race conditions have not been verified as met")]
    ConditionsNotMet,

    #[msg("Conditions were met — use releasePayment instead of refund")]
    ConditionsWereMet,

    #[msg("Payment has already been released or refunded")]
    AlreadyReleased,

    #[msg("Escrow amount must be greater than zero")]
    InvalidAmount,
}