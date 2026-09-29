// People and payees. Every address below is a PLACEHOLDER: the real ones
// follow later. The pattern is 0x000…<letter>00<n> so they are easy to find.
//
// Swap in either a plain address or, once the person is an org user,
// `eth.user["Full Name"]` (their personal Safe on Ethereum).

// Signers and role members
export const ANA = "0x000000000000000000000000000000000000a001";
export const BEN = "0x000000000000000000000000000000000000b001";
export const MARIA = "0x000000000000000000000000000000000000c001";
export const STEVE = "0x000000000000000000000000000000000000d001";

// Separate keys controlled by the Zodiac team, never shared with the members.
export const ZODIAC_TEAM_1 = "0x000000000000000000000000000000000000f001";
export const ZODIAC_TEAM_2 = "0x000000000000000000000000000000000000f002";
export const ZODIAC_TEAM_3 = "0x000000000000000000000000000000000000f003";

const memberKeys = new Set(
  [ANA, BEN, MARIA, STEVE].map((address) => address.toLowerCase()),
);
const teamKeys = [ZODIAC_TEAM_1, ZODIAC_TEAM_2, ZODIAC_TEAM_3].map((address) =>
  address.toLowerCase(),
);
if (
  new Set(teamKeys).size !== 3 ||
  teamKeys.some((address) => memberKeys.has(address))
) {
  throw new Error(
    "Zodiac team keys must be distinct from each other and every member key",
  );
}

// The three whitelisted payroll receivers
export const PAYEE_1 = "0x000000000000000000000000000000000000e001";
export const PAYEE_2 = "0x000000000000000000000000000000000000e002";
export const PAYEE_3 = "0x000000000000000000000000000000000000e003";

// A Safe owned by a placeholder can never sign again, so a deployment with
// one left in would lock the treasury. Refuse to build the spec until every
// placeholder is replaced; ALLOW_PLACEHOLDERS=1 is for local checks only.
const placeholders = Object.entries({
  ANA,
  BEN,
  MARIA,
  STEVE,
  ZODIAC_TEAM_1,
  ZODIAC_TEAM_2,
  ZODIAC_TEAM_3,
  PAYEE_1,
  PAYEE_2,
  PAYEE_3,
}).filter(([, address]) => /^0x0{36}[a-f]0/.test(address));

if (placeholders.length > 0 && process.env.ALLOW_PLACEHOLDERS !== "1") {
  throw new Error(
    `Placeholder addresses left in constellation/members.ts: ${placeholders
      .map(([name]) => name)
      .join(", ")}`,
  );
}
