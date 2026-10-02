import {
  aave_wsteth,
  fold_swap,
  lido_staking,
  morpho_usdc,
  payroll,
  swap,
  vendor_payroll,
  veto,
} from "./roles";
import {
  aave_wsteth_daily,
  fold_weth_daily,
  lido_eth_daily,
  morpho_usdc_daily,
  payroll_usdc_daily,
  swap_usdc_daily,
  swap_usdt_daily,
  swap_weth_daily,
  vendor_usdc_12h,
} from "./allowances";
import { eth } from "./context";
import {
  ANA,
  BEN,
  MARIA,
  ZODIAC_TEAM_1,
  ZODIAC_TEAM_2,
  ZODIAC_TEAM_3,
} from "./members";

// A small ETH treasury (about $1,000) run by four people, built so that a
// leaked key cannot move value out of the vault:
//   - day-to-day work runs through six narrow roles, every value-moving step
//     capped at 0.05 ETH worth per day and every receiver pinned to the vault
//     (payroll: to three whitelisted receivers);
//   - operators queue through a 24h Delay; the Zodiac team owns the treasury.
//
// Wiring follows the sim org (Operator Vault queues through a 24h Delay, the
// Security Council vetoes). The council is 1/3 and the treasury's sole owner,
// so any one private team key can veto or execute an immediate treasury change.
// See README "Governance".

// Export names become node refs. Keep them lowercase: Zodiac lowercases a ref
// used as a permission target (the veto role names the Delay) but matches
// refs case-sensitively, so `$treasuryDelay` would fail to resolve.

// Governance: proposes treasury changes through the Delay queue. 2/3.
export const operator_vault = eth.safe["Ops Operator Vault"]({
  nonce: 0n,
  threshold: 2,
  owners: [ANA, BEN, MARIA],
});

// Controlled by the Zodiac team. 1/3, so any one council signer can veto.
// It is the treasury's sole owner.
export const security_council = eth.safe["Ops Security Council"]({
  nonce: 0n,
  threshold: 1,
  owners: [ZODIAC_TEAM_1, ZODIAC_TEAM_2, ZODIAC_TEAM_3],
});

// The vault holding the funds. 1-of-1, owned by the Security Council.
// The Operator Vault can only act through the Delay.
//
// modules: both modifiers must be enabled on the Safe. Naming a Safe as a
// modifier's avatar/target does not enable it. Forward references, resolved
// by label at push.
export const treasury = eth.safe["Ops Treasury"]({
  nonce: 0n,
  threshold: 1,
  owners: [security_council],
  modules: [eth.roles["Ops Treasury Roles"], eth.delay["Ops Treasury Delay"]],
  vault: true,
});

// Eight roles, one Roles Modifier:
//   payroll         Ana    USDC to 3 whitelisted receivers, 133 USDC/day
//   vendor_payroll  Ana    USDC to any receiver, 50 USDC per 12h
//   swap            Ben    CoW ETH/WETH <-> USDC <-> USDT, 0.05 ETH worth/day per sell token
//   fold_swap       Ben    CoW WETH -> FOLD, any receiver, 50 USD of WETH/day
//   lido_staking  Maria  stake ETH (0.05/day), unstake via the withdrawal queue
//   aave_wsteth   Maria  wrap stETH, supply wstETH to Aave v3 Core (0.05 ETH worth/day)
//   morpho_usdc   Steve  Steakhouse Prime USDC, 133 USDC/day
//   veto          Security Council  setTxNonce on the Delay, nothing else
// owner = treasury: changing a policy is itself a treasury transaction.
export const treasury_roles = eth.roles["Ops Treasury Roles"]({
  nonce: 0n,
  owner: treasury,
  avatar: treasury,
  target: treasury,
  roles: {
    payroll,
    vendor_payroll,
    swap,
    fold_swap,
    lido_staking,
    aave_wsteth,
    morpho_usdc,
    veto,
  },
  allowances: {
    payroll_usdc_daily,
    swap_weth_daily,
    swap_usdc_daily,
    swap_usdt_daily,
    lido_eth_daily,
    aave_wsteth_daily,
    morpho_usdc_daily,
    vendor_usdc_12h,
    fold_weth_daily,
  },
});

// The timelock. The Operator Vault is its only module: every operator
// proposal waits 24h and can be vetoed by the council (setTxNonce).
// owner = treasury, never the operator: the Delay's owner can lower the
// cooldown or add modules, which would unfreeze its own queue.
export const treasury_delay = eth.delay["Ops Treasury Delay"]({
  nonce: 0n,
  owner: treasury,
  avatar: treasury,
  target: treasury,
  cooldown: 86_400n, // 24h
  expiration: 604_800n, // 7d
  modules: [operator_vault],
});
