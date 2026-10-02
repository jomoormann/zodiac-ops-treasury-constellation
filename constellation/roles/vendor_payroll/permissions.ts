import { custom } from "@zodiaceco/sdk/actions";
import { vendor_usdc_12h } from "../../allowances";

// Vendor payments: USDC to any receiver, 50 USDC every 12 hours. The amount
// is the only limit, so this budget can leave the vault for good.
//
// A separate role from `payroll`: in one role, two permissions on
// USDC.transfer would merge, and its receiver list would no longer bind.
// Written with `custom` because a `transfer` entry needs named recipients.
export default [
  custom({
    label: "Vendor payments in USDC (any receiver, 50 per 12h)",
    permissions: [
      allow.eth.usdc.transfer(
        undefined, // any receiver
        c.withinAllowance(vendor_usdc_12h.key),
      ),
    ],
  }),
] satisfies Permissions;
