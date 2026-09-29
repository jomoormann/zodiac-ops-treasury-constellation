// Single constellation instance shared by index.ts and the role files, so a
// role file can name a node (the Delay, the council) without importing
// index.ts (circular).
//
// PLACEHOLDER: "Default workspace" is the Zodiac Demo Org. Change it to the
// workspace this constellation deploys into.
export const eth = constellation({
  workspace: "Default workspace",
  label: "Ops Treasury",
  chain: 1, // ethereum
});
