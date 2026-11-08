use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("81mLfBPT8MeJnCmbu62EZ978TePNcwfXH6UR4ii9pFou");

const MAX_QUESTION_LEN: usize = 200;
const MAX_STUDENT_ID_LEN: usize = 32;
const MAX_NAME_LEN: usize = 64;
const MAX_EVIDENCE_NOTE_LEN: usize = 280;
/// The image itself lives off-chain (a transaction can't hold more than ~1KB of instruction
/// data anyway); this is just room for a content-hash-based filename reference.
const MAX_EVIDENCE_IMAGE_REF_LEN: usize = 128;

/// floor(sqrt(n)) via Newton's method.
fn isqrt_floor(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// ceil(sqrt(n)) — rounding the sqrt up keeps the sell payout conservative (protocol-favoring).
fn isqrt_ceil(n: u128) -> u128 {
    let f = isqrt_floor(n);
    if f.saturating_mul(f) == n {
        f
    } else {
        f + 1
    }
}

#[program]
pub mod grademarket {
    use super::*;

    /// One-time setup: whoever calls this first becomes the permanent admin.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.initializer.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Self-attested registration: binds a student ID + display name to this wallet, once.
    pub fn register_student(ctx: Context<RegisterStudent>, student_id: String, name: String) -> Result<()> {
        require!(
            !student_id.is_empty() && student_id.len() <= MAX_STUDENT_ID_LEN,
            MarketError::InvalidStudentId
        );
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, MarketError::InvalidName);

        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.role = Role::Student;
        profile.student_id = student_id;
        profile.name = name;
        profile.bump = ctx.bumps.profile;
        Ok(())
    }

    /// Only the wallet recorded as admin in Config can register an admin profile.
    pub fn register_admin(ctx: Context<RegisterAdmin>, name: String) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, MarketError::InvalidName);

        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.role = Role::Admin;
        profile.student_id = String::new();
        profile.name = name;
        profile.bump = ctx.bumps.profile;
        Ok(())
    }

    /// Deposit SOL from your wallet into your website balance (held in your Profile account).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.profile.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Withdraw unused website balance back to your wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);

        let profile_info = ctx.accounts.profile.to_account_info();
        let rent_exempt_min = Rent::get()?.minimum_balance(profile_info.data_len());
        let available = profile_info.lamports().saturating_sub(rent_exempt_min);
        require!(amount <= available, MarketError::InsufficientBalance);

        **profile_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    /// Students can only open PersonalGrade markets attached to an existing ExamAverage
    /// market; admins can only open ExamAverage markets. The creator becomes the resolver
    /// and the market's sole liquidity provider, seeding it with `liquidity` SOL (from their
    /// website balance) split evenly into the Yes/No AMM reserves (starting price: 50/50).
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        question: String,
        close_ts: i64,
        kind: MarketKind,
        liquidity: u64,
    ) -> Result<()> {
        require!(question.len() <= MAX_QUESTION_LEN, MarketError::QuestionTooLong);
        require!(
            close_ts > Clock::get()?.unix_timestamp,
            MarketError::CloseTimeInPast
        );
        require!(liquidity > 0, MarketError::ZeroAmount);

        let profile_role = ctx.accounts.profile.role;
        let parent_market_key: Option<Pubkey> = match profile_role {
            Role::Admin => {
                require!(kind == MarketKind::ExamAverage, MarketError::AdminMustCreateExamAverage);
                require!(
                    ctx.accounts.parent_market.is_none(),
                    MarketError::ExamAverageCannotHaveParent
                );
                None
            }
            Role::Student => {
                require!(kind == MarketKind::PersonalGrade, MarketError::StudentMustCreatePersonalGrade);
                let parent = ctx
                    .accounts
                    .parent_market
                    .as_ref()
                    .ok_or(MarketError::PersonalGradeNeedsParent)?;
                require!(parent.kind == MarketKind::ExamAverage, MarketError::ParentMustBeExamAverage);
                require!(
                    close_ts == parent.close_ts,
                    MarketError::PersonalGradeCloseTsMustMatchParent
                );
                Some(parent.key())
            }
        };

        // Seed liquidity from the creator's website balance into the AMM reserves.
        let profile_info = ctx.accounts.profile.to_account_info();
        let rent_exempt_min = Rent::get()?.minimum_balance(profile_info.data_len());
        let available = profile_info.lamports().saturating_sub(rent_exempt_min);
        require!(liquidity <= available, MarketError::InsufficientBalance);
        **profile_info.try_borrow_mut_lamports()? -= liquidity;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += liquidity;

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.creator.key();
        market.market_id = market_id;
        market.question = question;
        market.close_ts = close_ts;
        market.resolved = false;
        market.outcome = Outcome::Unresolved;
        market.yes_reserve = liquidity;
        market.no_reserve = liquidity;
        market.liquidity_paid = liquidity;
        market.kind = kind;
        market.parent_market = parent_market_key;
        market.lp_withdrawn = false;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Buy outcome shares with SOL from your website balance, at the current AMM price.
    /// Your payout per share (1 collateral unit if that side wins) is locked in at purchase;
    /// later trading by others changes the price for new trades, not the value of shares you
    /// already hold.
    pub fn buy(ctx: Context<Trade>, outcome_yes: bool, amount_in: u64) -> Result<()> {
        require!(amount_in > 0, MarketError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketResolved);
        require!(
            Clock::get()?.unix_timestamp < market.close_ts,
            MarketError::MarketClosed
        );

        let profile_info = ctx.accounts.profile.to_account_info();
        let rent_exempt_min = Rent::get()?.minimum_balance(profile_info.data_len());
        let available = profile_info.lamports().saturating_sub(rent_exempt_min);
        require!(amount_in <= available, MarketError::InsufficientBalance);

        let (self_reserve, other_reserve) = if outcome_yes {
            (market.yes_reserve, market.no_reserve)
        } else {
            (market.no_reserve, market.yes_reserve)
        };

        let k = (self_reserve as u128)
            .checked_mul(other_reserve as u128)
            .ok_or(MarketError::MathOverflow)?;
        let other_new = (other_reserve as u128)
            .checked_add(amount_in as u128)
            .ok_or(MarketError::MathOverflow)?;
        // Ceiling division keeps self_new from being under-estimated (protocol-favoring).
        let self_new = k
            .checked_add(other_new - 1)
            .ok_or(MarketError::MathOverflow)?
            / other_new;
        let self_before = (self_reserve as u128)
            .checked_add(amount_in as u128)
            .ok_or(MarketError::MathOverflow)?;
        require!(self_new <= self_before, MarketError::MathOverflow);
        let shares_out_u128 = self_before - self_new;
        require!(shares_out_u128 > 0, MarketError::ZeroSharesOut);
        let shares_out: u64 = shares_out_u128.try_into().map_err(|_| MarketError::MathOverflow)?;
        let self_new_u64: u64 = self_new.try_into().map_err(|_| MarketError::MathOverflow)?;
        let other_new_u64: u64 = other_new.try_into().map_err(|_| MarketError::MathOverflow)?;

        **profile_info.try_borrow_mut_lamports()? -= amount_in;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += amount_in;

        if outcome_yes {
            market.yes_reserve = self_new_u64;
            market.no_reserve = other_new_u64;
        } else {
            market.no_reserve = self_new_u64;
            market.yes_reserve = other_new_u64;
        }

        let position = &mut ctx.accounts.position;
        position.market = market.key();
        position.user = ctx.accounts.user.key();
        position.bump = ctx.bumps.position;
        if outcome_yes {
            position.yes_shares = position
                .yes_shares
                .checked_add(shares_out)
                .ok_or(MarketError::MathOverflow)?;
            position.yes_cost = position
                .yes_cost
                .checked_add(amount_in)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            position.no_shares = position
                .no_shares
                .checked_add(shares_out)
                .ok_or(MarketError::MathOverflow)?;
            position.no_cost = position
                .no_cost
                .checked_add(amount_in)
                .ok_or(MarketError::MathOverflow)?;
        }

        Ok(())
    }

    /// Sell outcome shares you hold back into the AMM for SOL (credited to your website
    /// balance), at the current price. Can be done any time before the market closes.
    pub fn sell(ctx: Context<Trade>, outcome_yes: bool, shares_in: u64) -> Result<()> {
        require!(shares_in > 0, MarketError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketResolved);
        require!(
            Clock::get()?.unix_timestamp < market.close_ts,
            MarketError::MarketClosed
        );

        let position = &mut ctx.accounts.position;
        let held = if outcome_yes { position.yes_shares } else { position.no_shares };
        require!(shares_in <= held, MarketError::InsufficientShares);

        let (self_reserve, other_reserve) = if outcome_yes {
            (market.yes_reserve, market.no_reserve)
        } else {
            (market.no_reserve, market.yes_reserve)
        };

        // a^2 - a*(X+s+O) + s*O = 0, solved for the smaller root, sqrt rounded up (and the
        // final division floored) so the payout is always conservative for the protocol.
        let x = self_reserve as u128;
        let o = other_reserve as u128;
        let s = shares_in as u128;
        let b = x
            .checked_add(s)
            .and_then(|v| v.checked_add(o))
            .ok_or(MarketError::MathOverflow)?;
        let four_so = 4u128
            .checked_mul(s)
            .and_then(|v| v.checked_mul(o))
            .ok_or(MarketError::MathOverflow)?;
        let b_sq = b.checked_mul(b).ok_or(MarketError::MathOverflow)?;
        require!(b_sq >= four_so, MarketError::MathOverflow);
        let discriminant = b_sq - four_so;
        let sqrt_d = isqrt_ceil(discriminant);
        require!(b >= sqrt_d, MarketError::MathOverflow);
        let amount_out_u128 = (b - sqrt_d) / 2;
        require!(amount_out_u128 > 0, MarketError::ZeroAmountOut);
        let amount_out: u64 = amount_out_u128.try_into().map_err(|_| MarketError::MathOverflow)?;

        let self_final = x
            .checked_add(s)
            .and_then(|v| v.checked_sub(amount_out_u128))
            .ok_or(MarketError::MathOverflow)?;
        let other_final = o.checked_sub(amount_out_u128).ok_or(MarketError::MathOverflow)?;
        let self_final_u64: u64 = self_final.try_into().map_err(|_| MarketError::MathOverflow)?;
        let other_final_u64: u64 = other_final.try_into().map_err(|_| MarketError::MathOverflow)?;

        // Reduce the held side's cost basis by the same fraction of shares being sold,
        // so any cost basis still attributed to a position always matches shares still held.
        if outcome_yes {
            let cost_removed: u64 = ((position.yes_cost as u128)
                .checked_mul(shares_in as u128)
                .ok_or(MarketError::MathOverflow)?
                / (held as u128))
                .try_into()
                .map_err(|_| MarketError::MathOverflow)?;
            market.yes_reserve = self_final_u64;
            market.no_reserve = other_final_u64;
            position.yes_shares -= shares_in;
            position.yes_cost -= cost_removed;
        } else {
            let cost_removed: u64 = ((position.no_cost as u128)
                .checked_mul(shares_in as u128)
                .ok_or(MarketError::MathOverflow)?
                / (held as u128))
                .try_into()
                .map_err(|_| MarketError::MathOverflow)?;
            market.no_reserve = self_final_u64;
            market.yes_reserve = other_final_u64;
            position.no_shares -= shares_in;
            position.no_cost -= cost_removed;
        }

        let market_key = market.key();
        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.profile.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_out,
        )?;

        Ok(())
    }

    /// Only the platform admin can settle a market's outcome, once trading has closed.
    /// `Void` refunds everyone's cost basis (what they actually paid for shares they still
    /// hold) instead of a Yes/No payout — use it when the result can't be determined.
    pub fn resolve_market(ctx: Context<ResolveMarket>, resolution: Resolution) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketResolved);
        require!(
            Clock::get()?.unix_timestamp >= market.close_ts,
            MarketError::MarketStillOpen
        );

        market.resolved = true;
        market.outcome = match resolution {
            Resolution::Yes => Outcome::Yes,
            Resolution::No => Outcome::No,
            Resolution::Void => Outcome::Void,
        };
        Ok(())
    }

    /// The market's creator attaches (or updates, before resolution) a short note and an
    /// optional reference to an image hosted off-chain (a transaction can only carry about a
    /// kilobyte of data, nowhere near enough for a real screenshot). Stored on-chain so the
    /// admin can read it from any device — technically public like all on-chain data, but
    /// the app's UI only ever surfaces it to the admin.
    pub fn submit_evidence(ctx: Context<SubmitEvidence>, note: String, image_ref: String) -> Result<()> {
        require!(!ctx.accounts.market.resolved, MarketError::MarketResolved);
        require!(note.len() <= MAX_EVIDENCE_NOTE_LEN, MarketError::EvidenceNoteTooLong);
        require!(
            image_ref.len() <= MAX_EVIDENCE_IMAGE_REF_LEN,
            MarketError::EvidenceImageRefTooLong
        );

        let evidence = &mut ctx.accounts.evidence;
        evidence.market = ctx.accounts.market.key();
        evidence.submitter = ctx.accounts.submitter.key();
        evidence.note = note;
        evidence.image_ref = image_ref;
        evidence.bump = ctx.bumps.evidence;
        Ok(())
    }

    /// Redeem your winning shares 1:1 for SOL, credited to your website balance.
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!position.redeemed, MarketError::AlreadyClaimed);

        let payout: u64 = match market.outcome {
            Outcome::Yes => position.yes_shares,
            Outcome::No => position.no_shares,
            Outcome::Void => (position.yes_cost as u128 + position.no_cost as u128)
                .try_into()
                .map_err(|_| MarketError::MathOverflow)?,
            Outcome::Unresolved => return err!(MarketError::MarketNotResolved),
        };

        position.redeemed = true;
        position.yes_shares = 0;
        position.no_shares = 0;
        position.yes_cost = 0;
        position.no_cost = 0;

        if payout > 0 {
            let market_key = market.key();
            let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.profile.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                payout,
            )?;
        }

        Ok(())
    }

    /// The market's creator (sole liquidity provider) withdraws whatever's left of the
    /// winning-side AMM reserve, once resolved. Callable once.
    pub fn withdraw_liquidity(ctx: Context<WithdrawLiquidity>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!market.lp_withdrawn, MarketError::LiquidityAlreadyWithdrawn);

        let payout = match market.outcome {
            Outcome::Yes => market.yes_reserve,
            Outcome::No => market.no_reserve,
            Outcome::Void => market.liquidity_paid,
            Outcome::Unresolved => return err!(MarketError::MarketNotResolved),
        };

        market.lp_withdrawn = true;
        market.yes_reserve = 0;
        market.no_reserve = 0;

        if payout > 0 {
            let market_key = market.key();
            let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.profile.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                payout,
            )?;
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Unresolved,
    Yes,
    No,
    /// No result could be determined; everyone's cost basis is refunded instead of a payout.
    Void,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    Yes,
    No,
    Void,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Student,
    Admin,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketKind {
    ExamAverage,
    PersonalGrade,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + 1;
}

#[account]
pub struct Profile {
    pub owner: Pubkey,
    pub role: Role,
    pub student_id: String,
    pub name: String,
    pub bump: u8,
}

impl Profile {
    // discriminator(8) + owner(32) + role(1) + student_id(4 + MAX) + name(4 + MAX) + bump(1)
    pub const SPACE: usize =
        8 + 32 + 1 + (4 + MAX_STUDENT_ID_LEN) + (4 + MAX_NAME_LEN) + 1;
}

/// A binary market backed by a constant-product AMM (yes_reserve * no_reserve = k).
/// Marginal price of Yes = no_reserve / (yes_reserve + no_reserve).
#[account]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: u64,
    pub question: String,
    pub close_ts: i64,
    pub resolved: bool,
    pub outcome: Outcome,
    pub yes_reserve: u64,
    pub no_reserve: u64,
    /// The liquidity provider's original contribution; refunded to them in full on Void.
    pub liquidity_paid: u64,
    pub kind: MarketKind,
    pub parent_market: Option<Pubkey>,
    pub lp_withdrawn: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    // discriminator(8) + authority(32) + market_id(8) + question(4 + MAX) + close_ts(8)
    // + resolved(1) + outcome(1) + yes_reserve(8) + no_reserve(8) + liquidity_paid(8)
    // + kind(1) + parent_market(1 + 32) + lp_withdrawn(1) + bump(1) + vault_bump(1)
    pub const SPACE: usize =
        8 + 32 + 8 + (4 + MAX_QUESTION_LEN) + 8 + 1 + 1 + 8 + 8 + 8 + 1 + (1 + 32) + 1 + 1 + 1;
}

/// A user's outcome-share holdings in one market, plus the cost basis still tied to those
/// shares (what they paid for the shares they currently hold, adjusted as they sell), used
/// to refund them exactly if the market is Void.
#[account]
pub struct Position {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    pub yes_cost: u64,
    pub no_cost: u64,
    pub redeemed: bool,
    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

/// A market's creator's note (and optional reference to an off-chain-hosted image)
/// supporting the outcome they'll resolve to. Readable by anyone who looks on-chain, like
/// all Solana account data — the app's own UI is what keeps it admin-only, not cryptography.
#[account]
pub struct Evidence {
    pub market: Pubkey,
    pub submitter: Pubkey,
    pub note: String,
    pub image_ref: String,
    pub bump: u8,
}

impl Evidence {
    pub const SPACE: usize =
        8 + 32 + 32 + (4 + MAX_EVIDENCE_NOTE_LEN) + (4 + MAX_EVIDENCE_IMAGE_REF_LEN) + 1;
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,

    #[account(
        init,
        payer = initializer,
        space = Config::SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterStudent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = Profile::SPACE,
        seeds = [b"profile", owner.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAdmin<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == owner.key() @ MarketError::NotAdmin
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        space = Profile::SPACE,
        seeds = [b"profile", owner.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", owner.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", owner.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", creator.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,

    #[account(
        init,
        payer = creator,
        space = Market::SPACE,
        seeds = [b"market", creator.key().as_ref(), market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    /// CHECK: PDA vault that only ever holds SOL; never allocated data, so it stays
    /// system-owned and can be debited via a signed system_program transfer.
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    /// Required (and must be an ExamAverage market) when the creator is a Student;
    /// must be absent when the creator is an Admin.
    pub parent_market: Option<Account<'info, Market>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", user.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    /// CHECK: see CreateMarket.
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ MarketError::NotAdmin
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitEvidence<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,

    #[account(
        constraint = market.authority == submitter.key() @ MarketError::NotAuthority
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = submitter,
        space = Evidence::SPACE,
        seeds = [b"evidence", market.key().as_ref()],
        bump
    )]
    pub evidence: Account<'info, Evidence>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", user.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,

    pub market: Account<'info, Market>,

    /// CHECK: see CreateMarket.
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = user @ MarketError::NotBetOwner
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"profile", authority.key().as_ref()],
        bump = profile.bump,
    )]
    pub profile: Account<'info, Profile>,

    #[account(
        mut,
        has_one = authority @ MarketError::NotAuthority
    )]
    pub market: Account<'info, Market>,

    /// CHECK: see CreateMarket.
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum MarketError {
    #[msg("Question text is too long")]
    QuestionTooLong,
    #[msg("Close time must be in the future")]
    CloseTimeInPast,
    #[msg("Bet amount must be greater than zero")]
    ZeroAmount,
    #[msg("Market is already resolved")]
    MarketResolved,
    #[msg("Betting is closed for this market")]
    MarketClosed,
    #[msg("Market has not been resolved yet")]
    MarketNotResolved,
    #[msg("Betting is still open; wait for close time to resolve")]
    MarketStillOpen,
    #[msg("Winnings already claimed")]
    AlreadyClaimed,
    #[msg("Only the market's creator can resolve it")]
    NotAuthority,
    #[msg("This position does not belong to you")]
    NotBetOwner,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Student ID must be 1-32 characters")]
    InvalidStudentId,
    #[msg("Name must be 1-64 characters")]
    InvalidName,
    #[msg("Only the configured admin wallet can register as admin")]
    NotAdmin,
    #[msg("Admins can only create exam-average markets")]
    AdminMustCreateExamAverage,
    #[msg("Exam-average markets cannot have a parent market")]
    ExamAverageCannotHaveParent,
    #[msg("Students can only create personal-grade markets")]
    StudentMustCreatePersonalGrade,
    #[msg("A personal-grade market must reference a parent exam-average market")]
    PersonalGradeNeedsParent,
    #[msg("The parent market must be an exam-average market")]
    ParentMustBeExamAverage,
    #[msg("A personal-grade market must close at the same time as its parent exam-average market")]
    PersonalGradeCloseTsMustMatchParent,
    #[msg("Insufficient website balance; deposit more SOL first")]
    InsufficientBalance,
    #[msg("This trade would mint zero shares")]
    ZeroSharesOut,
    #[msg("This trade would pay out zero SOL")]
    ZeroAmountOut,
    #[msg("You don't hold enough shares to sell that many")]
    InsufficientShares,
    #[msg("Liquidity has already been withdrawn from this market")]
    LiquidityAlreadyWithdrawn,
    #[msg("Evidence note must be 280 characters or fewer")]
    EvidenceNoteTooLong,
    #[msg("Evidence image reference must be 128 characters or fewer")]
    EvidenceImageRefTooLong,
}
