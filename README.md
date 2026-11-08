# The Rensselaer Market

A Polymarket-style prediction market, built for a hackathon, where RPI students bet SOL on
devnet over yes/no questions about grades ("Will Sam get an A in CSCI-4430?"). The on-chain
program is still named `grademarket` (its program ID doesn't change), but the product name
and UI are "The Rensselaer Market".

- **On-chain**: an Anchor (Rust) program backs each market with a constant-product AMM
  (like a Uniswap pool, but for Yes/No outcome shares) so prices move with trading and your
  payout per share locks in at the price you traded at — real Polymarket-style mechanics,
  not a pari-mutuel pool.
- **Frontend**: Vite + React + TypeScript, Solana wallet-adapter, `@coral-xyz/anchor`, styled
  in RPI's red-and-white with a flat (non-boxy), single top banner holding the logo, the
  title, and all three tabs (Markets / Account / History).

## How it works

- **Accounts**: connect a wallet and register once on the Account tab. The very first
  wallet to click "Initialize platform" becomes the permanent **admin**; everyone else
  registers as a **student** by self-attesting a student ID + name (no real university
  roster check — see the Notes section). Registration is one-time and permanent per wallet.
- **Website balance**: deposit SOL into your Profile account (your "website wallet") on the
  Account tab. All trading draws from this balance instead of signing a wallet transfer for
  every trade; withdraw back to your wallet whenever you like. The same tab also shows a
  **positions table** (every market you hold shares in, with inline sell/redeem) and a
  **History** tab logging every action you've taken in this browser (recorded locally the
  moment each action succeeds, since a bare local validator doesn't retain RPC transaction
  history the way devnet/mainnet do — so this isn't a chain query, and won't follow you to a
  different browser or survive clearing site data; your actual balances and positions are
  unaffected either way, since those live on-chain).
- **Admins** can only open **exam-average** markets (e.g. "Will the CSCI-4430 midterm
  average be above 75%?").
- **Students** can only open **personal-grade** markets (e.g. "Will I beat the average?"),
  and each one must be attached to an existing exam-average market as its parent, closing at
  exactly the same time — both enforced on-chain, not just a UI convention. The frontend
  renders personal markets nested under their exam-average parent as sub-bets.
- **Opening a market costs starting liquidity**: the creator seeds the market's AMM pool
  (from their website balance), which starts the price at an even 50¢/50¢. They're the
  market's sole liquidity provider and can withdraw their share of the pool back out once
  it resolves.
- **Trading**: buy Yes or No shares any time before close — the AMM's constant-product curve
  prices each trade, so buying moves the price for the *next* trade, not the value of shares
  you already hold. You can also sell shares back before close to exit early, at whatever the
  current price is.
- **Resolution is admin-only** — the market's creator (student or admin) can no longer
  resolve their own market; only the platform admin can, for any market, once trading closes.
  Students instead attach a short **evidence note + image** (e.g. a grade screenshot, up to
  5MB) to their market before it resolves. Only the on-chain record (note + a content-hash
  filename reference) is tied to the market and readable by anyone on-chain; the image bytes
  themselves live off-chain, in the dev server's `app/uploads/` folder (served by a small
  Vite middleware — see `app/vite-plugin-evidence-uploads.ts` — bundled into the same `npm
  run dev` process, no separate server to run). A transaction can only carry about a
  kilobyte of data, nowhere near enough for a real screenshot, which is why the image can't
  just live on-chain too. Either way it's surfaced only in the admin's view of the app — a
  UI convention, not cryptographic privacy.
- **Resolving "No resolution"** voids the market instead of picking Yes/No: everyone's
  **cost basis** (what they actually paid for the shares they still hold, tracked per
  position and adjusted when they sell) is refunded, and the liquidity provider gets back
  their original seed amount. Buy-and-hold positions refund exactly; if someone sold shares
  before the void, the refund math can leave a small amount of dust stuck in the market
  (safe — the contract never overpays, it just means a vanishingly small, already-safe
  edge case, not a security issue) rather than risk overpaying anyone.
- Otherwise, winning shares redeem 1:1 for SOL (credited to your website balance); losing
  shares are worthless. The liquidity provider then withdraws whatever's left in the
  winning-side reserve (or their original seed amount, on a void).

See [`program/programs/grademarket/src/lib.rs`](program/programs/grademarket/src/lib.rs) for
the full instruction set: `initialize_config`, `register_student`, `register_admin`,
`deposit`, `withdraw`, `create_market`, `buy`, `sell`, `resolve_market`, `submit_evidence`,
`redeem`, `withdraw_liquidity`.

### Testing both roles

Only one wallet can hold the Config's admin slot, and each wallet can only register once
(as either admin or student, not both). To try both sides yourself, use two separate
wallets/accounts — e.g. your main Phantom account as student, and a second Phantom account
(or a second browser profile) as admin, airdropping local-validator SOL to each
(`solana airdrop 10 <address> --url http://127.0.0.1:8899`).

## Status: built, deployed, and verified end-to-end

A full Rust/Solana/Anchor toolchain was set up in WSL2 (Ubuntu 24.04) since this machine had
none installed natively (Anchor's BPF/SBF build requires Linux platform-tools). The program
builds cleanly with `anchor-lang` 1.2.2 / `anchor-cli` 1.2.2.

```
Program ID: 81mLfBPT8MeJnCmbu62EZ978TePNcwfXH6UR4ii9pFou
```

This ID is set in `program/programs/grademarket/src/lib.rs` (`declare_id!`),
`program/Anchor.toml`, `program/idl/grademarket.json`, and `app/.env`. The matching keypair
is at `program/target/deploy/grademarket-keypair.json` — **keep it there** so future
`anchor build` runs reuse this exact program ID instead of generating a new one.

**It's currently deployed to a local Solana test validator, not public devnet.** Every
public-devnet SOL faucet (CLI airdrop, the web faucet's Cloudflare-gated form, and the
proof-of-work miner fallback) was rate-limited/exhausted on this network across multiple
IPs, so deployment target was switched to a local validator to unblock the demo. The program
was verified with a full on-chain script: create a market, two wallets bet opposite sides,
resolve, and claim — payouts came out pari-mutuel-correct.

`app/.env` currently points `VITE_RPC_URL` at `http://127.0.0.1:8899` (the local validator)
rather than devnet.

### Running the local validator

Inside WSL (`wsl -d Ubuntu-24.04`), a validator is kept running in the background:

```bash
nohup solana-test-validator --reset > ~/validator.log 2>&1 & disown
```

It pre-funds whatever keypair is set as the default CLI config with ~500M test SOL, so
airdropping more is easy: `solana airdrop 10 <address> --url http://127.0.0.1:8899`.
WSL2's localhost forwarding means `http://127.0.0.1:8899` is reachable from Windows/the
frontend with no extra networking setup.

To test interactively you'll need a real Solana wallet extension (**Phantom** or
**Solflare** — not MetaMask, which is Ethereum-only and won't work here). Add a custom
RPC network in the wallet pointing at `http://127.0.0.1:8899`, then fund that wallet via
`solana airdrop`.

### Moving to real devnet (or mainnet) later

1. Switch `app/.env`'s `VITE_RPC_URL` back to `https://api.devnet.solana.com` (or another
   devnet/mainnet RPC).
2. Redeploy once the faucet isn't rate-limited:
   ```bash
   cd program
   anchor deploy --provider.cluster devnet
   ```
   (the program keypair is unchanged, so the program ID — and therefore the frontend
   config — doesn't need to change).
3. Re-run `anchor build` first if you've changed `lib.rs`, and copy the refreshed
   `program/target/idl/grademarket.json` over `program/idl/grademarket.json` and
   `app/src/idl/grademarket.json`.

### Toolchain setup (for reference / another machine)

```bash
wsl --install -d Ubuntu-24.04
wsl -d Ubuntu-24.04 -u root -- bash -lc "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
wsl -d Ubuntu-24.04 -u root -- bash -lc "sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
wsl -d Ubuntu-24.04 -u root -- bash -lc "cargo install --git https://github.com/coral-xyz/anchor avm --locked --force"
wsl -d Ubuntu-24.04 -u root -- bash -lc "avm install latest && avm use latest"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cargo build-sbf --tools-version v1.58 --install-only"
```

### Run the frontend

```bash
cd app
npm install   # already done on this machine
npm run dev
```

Open the printed localhost URL, connect a wallet pointed at the same RPC as `.env`
(the wallet-adapter auto-detects any installed browser wallet, no explicit adapter list
needed), and create/bet/resolve/claim.

## Project layout

```
program/
  Anchor.toml
  Cargo.toml
  programs/grademarket/src/lib.rs    # the on-chain program
  idl/grademarket.json               # hand-written IDL (anchor build will regenerate this)
  target/deploy/grademarket-keypair.json  # the program's keypair — keep this in place
app/
  src/lib/anchor.ts                  # PDA derivation + Program/provider helpers
  src/components/                    # AccountPage, CreateMarketModal, MarketCard, Header
  src/App.tsx                        # tabs, hierarchical market list + wiring
  src/index.css                      # Tailwind v4 @theme tokens (brand red/white palette)
  public/logo.png                    # the Rensselaer Market logo (top-left banner)
```

## Notes on the design

- **Constant-product AMM, not a central limit order book**: real Polymarket uses an
  off-chain-matched CLOB; this uses a Uniswap-style `yes_reserve * no_reserve = k` pool
  instead, seeded by the market creator as its sole liquidity provider. It gets you genuine
  price-locked-at-trade-time economics on-chain without needing off-chain order matching
  infrastructure. Selling is solved via the quadratic form of the same invariant (with an
  integer square root), rounded conservatively so the pool can never be drained below what
  it owes.
- **Website-wallet balances, not per-trade wallet signatures**: deposited SOL lives directly
  in each user's Profile account (above its rent-exempt minimum) rather than a separate
  vault, so trading only touches that balance, not a fresh wallet transfer each time.
- **Self-attested identity, not verified-truth**: student ID registration is an honest,
  permanent binding of an ID + name to a wallet, not a check against a real university
  system. Likewise, whoever creates a market is still the one who resolves it — there's no
  on-chain proof a grade outcome is true, just a trust/reputation system among students and
  a designated admin, same as an informal betting pool.
- **Vault is a data-less PDA**: it stays system-program-owned, so the program can move SOL
  out of it with a signed `system_program::transfer` CPI without ever taking ownership of
  the account.
