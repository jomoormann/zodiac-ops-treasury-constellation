# Zodiac Constellation — agent notes

This repo is a **Zodiac constellation**: a TypeScript description of an org's smart-account graph (Safes, mods, users, permissions). `bun push` sends the spec to Zodiac, which diffs it against onchain state and gives a UI to review + sign the transactions.

User-facing docs are in `README.md` — read it before suggesting edits to `constellation/`.

## This repo

Ops Treasury: a small ETH treasury on Ethereum (chain 1) for four people
(Ana, Ben, Maria, Steve), built so that a leaked role key cannot move value
out of the vault, except two capped roles that pay any receiver by design
(`vendor_payroll`, 50 USDC per 12h; `fold_swap`, WETH -> FOLD, 50 USD per day). Modeled on the sim org constellation. The Security council
is a 1/3 Safe controlled by the Zodiac team and the treasury's sole 1/1 owner.
Any one private council signer can veto or execute immediate treasury changes.
The Operator Vault can act only through the 24-hour Delay.

- All people, payees and the workspace are PLACEHOLDERS.
  `constellation/members.ts` throws while any placeholder is left, so `push`
  cannot deploy Safes owned by dead addresses. `ALLOW_PLACEHOLDERS=1` is for
  local checks only.
- Every value-moving step draws on its own daily budget of 0.05 ETH worth
  (`constellation/allowances/index.ts`, priced 2026-09-29). Wraps, unwraps and
  returns to the vault are unmetered on purpose.
- Every receiver, `onBehalf`, `owner` and `to` parameter is pinned with
  `c.avatar`, except in `vendor_payroll` and `fold_swap`. Keep those two in
  their own roles (same-function permissions merge inside a role). Do not
  loosen another one without running the leak test.
- `test/leak-test.ts` (`bun test:leaks`, needs a mainnet fork on FORK_RPC)
  loads the permissions as Zodiac compiles them and runs 38 normal steps and
  55 attacks. Run it after any change to `constellation/` or the config.
- Known Zodiac bugs (README "Known issues"): a node ref used as a permission
  target is lowercased but matched case-sensitively, so export names in
  `constellation/index.ts` stay lowercase (`treasury_delay`); the allow kit
  does not encode `etherWithinAllowance` keys (use `encodeKey`).
- Do not push or deploy. Jo does that once the real addresses are in.

## Project map

- `constellation/index.ts` — entrypoint. **Only exported values get pushed.**
- `constellation/roles/<role>/` — `members.ts` (addresses) + `permissions.ts`
  (a list of entries: `custom`, `defikit`, `swap`, `transfer` from
  `@zodiaceco/sdk/actions`, or a bare `allow` kit permission).
- `constellation/allowances/` — reusable Roles allowance objects (key, refill, period, ...).
  A permission draws on one by naming its key: `c.withinAllowance("usdm_user_payouts")`.
- `zodiac.config.ts` — contracts the `allow` kit should know about.
- `.zodiac/` — generated codegen; **never edit by hand**. Re-run `bun pull` (or `bun pull-org` / `bun pull-contracts`) to refresh.
- `.lib/` — internal helpers (push script, type plumbing, globals).

## Conventions

- Entries **describe, they never compile**. `defikit` stores a protocol, verb
  and parameters; `swap` stores its token lists. The permissions are built when
  the constellation is deployed, so a stored revision never carries a copy of
  what a preset meant on the day it was written.

- `constellation`, `allow`, `c`, `ref` are **globals** (set up in `.lib/globals.ts`). Don't import them.
- After editing `zodiac.config.ts` (contracts) or anything that changes referenced accounts/users, run `bun pull` so the generated types match.
- Use Bun: `bun install`, `bun run <script>`, `bun <file.ts>`. Bun auto-loads `.env`.
