#!/usr/bin/env bun
/**
 * Leak test: what can someone do with a stolen role key?
 *
 * Deploys the treasury's Safe, Roles Modifier and Delay on a local mainnet
 * fork, loads the exact permissions Zodiac compiles for this constellation,
 * and then acts as each role member. Every normal flow has to go through;
 * every attempt to move value out of the vault has to be refused by the
 * Roles Modifier.
 *
 *   anvil --fork-url https://ethereum-rpc.publicnode.com      (or: hardhat node --fork …)
 *   bun test:leaks                                            (FORK_RPC, default http://127.0.0.1:8545)
 *
 * Permissions come from Zodiac's resolve endpoint (ZODIAC_API_KEY from .env),
 * which compiles the spec and stores nothing. On the fork the Roles Modifier
 * has a test owner so the roles can be loaded directly; the governance wiring
 * (who owns what) is what `bun push` shows for review.
 */
import "../.lib/globals";
import { push } from "@zodiaceco/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hashTypedData,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import {
  encodeKey,
  flattenCondition,
  rolesAbi,
  Status,
  type Condition,
} from "zodiac-roles-sdk";

// Placeholder members can be impersonated on a fork like any other address
process.env.ALLOW_PLACEHOLDERS = "1";
const { ANA, BEN, MARIA, STEVE, PAYEE_1, PAYEE_2, PAYEE_3 } =
  await import("../constellation/members");
const nodes = await import("../constellation");
const { default: config } = await import("../zodiac.config");
const eth = config.contracts.eth;

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
const API = (
  process.env.ZODIAC_API_URL ?? "https://app.zodiac.eco/api/v1"
).replace(/\/$/, "");

// ───────────────────────── contracts and constants ─────────────────────────

const SAFE_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2 1.4.1
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const MODULE_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236";
const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337"; // Roles v2
const DELAY_MASTERCOPY = "0xd54895B1121A2eE3f37b502F507631FA1331BED6";
const MULTISEND = "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526";
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2";
const MULTISEND_UNWRAPPER = "0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0";
const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const A_ETH_WSTETH = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ERC20_BALANCE = keccak256(toBytes("erc20"));

const ATTACKER = "0x00000000000000000000000000000000000bad00";
const OPERATOR = "0x0000000000000000000000000000000000000909"; // stands in for the Operator Vault on the Delay

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
const safeAbi = parseAbi([
  "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
  "function enableModule(address)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
  "function createProxyWithNonce(address,bytes,uint256) returns (address)",
]);
const moduleFactoryAbi = parseAbi([
  "function deployModule(address,bytes,uint256) returns (address)",
]);
const setUpAbi = parseAbi(["function setUp(bytes)"]);
const delayAbi = parseAbi([
  "function execTransactionFromModule(address,uint256,bytes,uint8) returns (bool)",
  "function executeNextTx(address,uint256,bytes,uint8)",
  "function setTxNonce(uint256)",
  "function setTxCooldown(uint256)",
  "function enableModule(address)",
  "function txNonce() view returns (uint256)",
  "function queueNonce() view returns (uint256)",
]);
const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256)",
]);
const orderTuple =
  "(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,bytes32 kind,bool partiallyFillable,bytes32 sellTokenBalance,bytes32 buyTokenBalance)";
const orderSignerAbi = parseAbi([
  `function signOrder(${orderTuple} order,uint32 validDuration,uint256 feeAmountBP)`,
  `function unsignOrder(${orderTuple} order)`,
]);
const settlementAbi = parseAbi([
  "function setPreSignature(bytes,bool)",
  "function preSignature(bytes) view returns (uint256)",
]);
const lidoAbi = parseAbi([
  "function submit(address) payable returns (uint256)",
]);
const wstethAbi = parseAbi([
  "function wrap(uint256) returns (uint256)",
  "function unwrap(uint256) returns (uint256)",
]);
const queueAbi = parseAbi([
  "function requestWithdrawals(uint256[],address) returns (uint256[])",
  "function claimWithdrawals(uint256[],uint256[])",
  "function claimWithdrawalsTo(uint256[],uint256[],address)",
  "function getWithdrawalRequests(address) view returns (uint256[])",
  "function transferFrom(address,address,uint256)",
]);
const poolAbi = parseAbi([
  "function supply(address,uint256,address,uint16)",
  "function withdraw(address,uint256,address) returns (uint256)",
  "function borrow(address,uint256,uint256,uint16,address)",
]);
const vaultAbi = parseAbi([
  "function deposit(uint256,address) returns (uint256)",
  "function mint(uint256,address) returns (uint256)",
  "function withdraw(uint256,address,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function multicall(bytes[])",
  "function forceDeallocate(address,bytes,uint256,address) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const multisendAbi = parseAbi(["function multiSend(bytes)"]);

// ───────────────────────────── clients ─────────────────────────────

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC),
});
const wallet = createWalletClient({ chain: mainnet, transport: http(RPC) });
const testClient = createTestClient({
  chain: mainnet,
  mode: "hardhat",
  transport: http(RPC),
});

const impersonate = async (address: Address) => {
  await testClient.impersonateAccount({ address });
  await testClient.setBalance({ address, value: parseEther("10") });
};

const send = async (from: Address, to: Address, data: Hex, value = 0n) => {
  const hash = await wallet.sendTransaction({
    account: from,
    to,
    data,
    value,
    chain: mainnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx to ${to} reverted`);
  return receipt;
};

const balance = (token: Address, owner: Address) =>
  publicClient.readContract({
    address: token,
    abi: erc20,
    functionName: "balanceOf",
    args: [owner],
  });

// ─────────────────── 1. compile the spec through Zodiac ───────────────────

console.log(
  "Compiling the constellation through Zodiac (resolve stores nothing)…",
);

let captured: { workspaceId: string; payload: any } | undefined;
await push(nodes as any, {
  api: {
    applyConstellation: async (workspaceId: string, payload: any) => {
      captured = { workspaceId, payload };
      return {} as any;
    },
  } as any,
});
if (!captured) throw new Error("push() produced no payload");
const spec: any[] = JSON.parse(
  JSON.stringify(captured.payload.specification, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ),
);

// A permission can name another node (the veto role names the Delay). Zodiac
// substitutes the address it predicts for mainnet, but on the fork the node
// lives at another address. Such permissions are taken out before resolving
// and loaded by hand below, with the fork address.
const rolesSpec = spec.find((n) => n.type === "ROLES");
const byRef: Record<string, Address> = {};
const localRoles: { name: string; members: string[]; permissions: any[] }[] =
  [];
for (const [name, role] of Object.entries<any>(rolesSpec.roles)) {
  const local: any[] = [];
  role.permissions = role.permissions
    .map((entry: any) => {
      if (!("permissions" in entry)) return entry;
      const kept = entry.permissions.filter(
        (p: any) => !String(p.targetAddress).startsWith("$"),
      );
      local.push(
        ...entry.permissions.filter((p: any) =>
          String(p.targetAddress).startsWith("$"),
        ),
      );
      return { ...entry, permissions: kept };
    })
    .filter(
      (entry: any) => !("permissions" in entry) || entry.permissions.length > 0,
    );
  if (local.length > 0)
    localRoles.push({ name, members: role.members, permissions: local });
  if (role.permissions.length === 0) delete rolesSpec.roles[name];
}

const res = await fetch(
  `${API}/workspace/${captured.workspaceId}/constellation/resolve`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.ZODIAC_API_KEY}`,
    },
    body: JSON.stringify({ specification: spec }),
  },
);
if (!res.ok)
  throw new Error(`resolve failed: ${res.status} ${await res.text()}`);
const { result: resolved } = (await res.json()) as { result: any[] };
for (const node of spec) {
  const match = resolved.find(
    (r) => r.type === node.type && r.label === node.label,
  );
  if (match) byRef[`$${node.ref}`] = match.address;
}
const compiled = resolved.find((n) => n.type === "ROLES");

// ─────────────────────── 2. deploy on the fork ───────────────────────

const [owner] = await wallet.getAddresses(); // an unlocked test account
console.log(
  `Deploying on the fork (${RPC}), block ${await publicClient.getBlockNumber()}…`,
);

const deployedAddress = (
  logs: { address: string; topics: Hex[]; data: Hex }[],
  factory: string,
) => {
  const log = logs.find(
    (l) => l.address.toLowerCase() === factory.toLowerCase(),
  );
  if (!log) throw new Error("no creation log");
  const word = log.topics[1] ?? (log.data.slice(0, 66) as Hex);
  return `0x${word.slice(26)}` as Address;
};

const salt = BigInt(Date.now());
const safeReceipt = await send(
  owner,
  SAFE_FACTORY,
  encodeFunctionData({
    abi: safeAbi,
    functionName: "createProxyWithNonce",
    args: [
      SAFE_SINGLETON,
      encodeFunctionData({
        abi: safeAbi,
        functionName: "setup",
        args: [
          [owner],
          1n,
          zeroAddress,
          "0x",
          SAFE_FALLBACK,
          zeroAddress,
          0n,
          zeroAddress,
        ],
      }),
      salt,
    ],
  }),
);
const treasury = deployedAddress(safeReceipt.logs, SAFE_FACTORY);

const deployModule = async (mastercopy: Address, params: Hex) =>
  deployedAddress(
    (
      await send(
        owner,
        MODULE_FACTORY,
        encodeFunctionData({
          abi: moduleFactoryAbi,
          functionName: "deployModule",
          args: [
            mastercopy,
            encodeFunctionData({
              abi: setUpAbi,
              functionName: "setUp",
              args: [params],
            }),
            salt,
          ],
        }),
      )
    ).logs,
    MODULE_FACTORY,
  );

const roles = await deployModule(
  ROLES_MASTERCOPY,
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [owner, treasury, treasury],
  ),
);
const delay = await deployModule(
  DELAY_MASTERCOPY,
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [treasury, treasury, treasury, 86_400n, 604_800n],
  ),
);

// Treasury owner transactions (1/1 on the fork, signed by msg.sender)
const ownerSignature = encodePacked(
  ["uint256", "uint256", "uint8"],
  [BigInt(owner), 0n, 1],
);
const asTreasury = (to: Address, data: Hex) =>
  send(
    owner,
    treasury,
    encodeFunctionData({
      abi: safeAbi,
      functionName: "execTransaction",
      args: [
        to,
        0n,
        data,
        0,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        ownerSignature,
      ],
    }),
  );
await asTreasury(
  treasury,
  encodeFunctionData({
    abi: safeAbi,
    functionName: "enableModule",
    args: [roles],
  }),
);
await asTreasury(
  treasury,
  encodeFunctionData({
    abi: safeAbi,
    functionName: "enableModule",
    args: [delay],
  }),
);
await asTreasury(
  delay,
  encodeFunctionData({
    abi: delayAbi,
    functionName: "enableModule",
    args: [OPERATOR],
  }),
);

// Node references resolve to what now exists on the fork
const refOf = (type: string, where: (n: any) => boolean = () => true) =>
  `$${spec.find((n) => n.type === type && where(n)).ref}`;
Object.assign(byRef, {
  [refOf("SAFE", (n) => n.vault)]: treasury,
  [refOf("ROLES")]: roles,
  [refOf("DELAY")]: delay,
});
const addressOf = (v: string) => (v.startsWith("$") ? byRef[v] : v) as Address;
// The Security Council stands in as the veto role's member
const council = addressOf(
  localRoles.find((r) => r.name === "veto")!.members[0],
);

// ──────────────────── 3. load the compiled roles ────────────────────

const asRolesOwner = (functionName: string, args: readonly unknown[]) =>
  send(
    owner,
    roles,
    encodeFunctionData({
      abi: rolesAbi,
      functionName: functionName as any,
      args: args as any,
    }),
  );

const roleNames = new Map<string, string>();
const loadTarget = async (key: Hex, target: any) => {
  const address = addressOf(target.address);
  if (target.clearance === 1)
    return asRolesOwner("allowTarget", [key, address, target.executionOptions]);
  await asRolesOwner("scopeTarget", [key, address]);
  for (const fn of target.functions ?? []) {
    if (fn.wildcarded || fn.condition == null) {
      await asRolesOwner("allowFunction", [
        key,
        address,
        fn.selector,
        fn.executionOptions,
      ]);
    } else {
      const flat = flattenCondition(fn.condition as Condition).map((c) => ({
        parent: c.parent,
        paramType: c.paramType,
        operator: c.operator,
        compValue: c.compValue ?? "0x",
      }));
      await asRolesOwner("scopeFunction", [
        key,
        address,
        fn.selector,
        flat,
        fn.executionOptions,
      ]);
    }
  }
};

for (const role of compiled.roles) {
  for (const member of role.members)
    await asRolesOwner("assignRoles", [addressOf(member), [role.key], [true]]);
  for (const target of role.targets) await loadTarget(role.key, target);
}
for (const role of localRoles) {
  const key = encodeKey(role.name);
  roleNames.set(key, role.name);
  for (const member of role.members)
    await asRolesOwner("assignRoles", [addressOf(member), [key], [true]]);
  for (const p of role.permissions) {
    await loadTarget(key, {
      address: p.targetAddress,
      clearance: 2,
      functions: [
        {
          selector: p.selector,
          condition: p.condition,
          executionOptions: (p.send ? 1 : 0) + (p.delegatecall ? 2 : 0),
        },
      ],
    });
  }
}
for (const a of compiled.allowances) {
  await asRolesOwner("setAllowance", [
    a.key,
    BigInt(a.balance),
    BigInt(a.maxRefill),
    BigInt(a.refill),
    BigInt(a.period),
    BigInt(a.timestamp),
  ]);
}
for (const multisend of [MULTISEND, MULTISEND_CALL_ONLY]) {
  await asRolesOwner("setTransactionUnwrapper", [
    multisend,
    "0x8d80ff0a",
    MULTISEND_UNWRAPPER,
  ]);
}

// ─────────────────────── 4. fund the treasury ───────────────────────

// About $1,000 in ETH is the plan; the fork adds stablecoins so every flow
// can run without first settling a CoW order.
await testClient.setBalance({ address: treasury, value: parseEther("0.5") });
const fund = async (token: Address, amount: bigint, whales: Address[]) => {
  for (const whale of whales) {
    if ((await balance(token, whale)) < amount) continue;
    await impersonate(whale);
    await send(
      whale,
      token,
      encodeFunctionData({
        abi: erc20,
        functionName: "transfer",
        args: [treasury, amount],
      }),
    );
    return;
  }
  throw new Error(`no whale with enough ${token}`);
};
const WHALES = [
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance
  "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance
  "0x5754284f345afc66a98fbB0a0Afe71e0F007B949", // Tether treasury
] as Address[];
await fund(eth.usdc, parseUnits("1000", 6), WHALES);
await fund(eth.usdt, parseUnits("1000", 6), WHALES);

for (const who of [ANA, BEN, MARIA, STEVE, council, OPERATOR] as Address[])
  await impersonate(who);

// ───────────────────────────── 5. the checks ─────────────────────────────

const keyOf = (name: string) => {
  const key = encodeKey(name);
  if (!compiled.roles.some((r: any) => r.key === key) && !roleNames.has(key))
    throw new Error(`no role ${name}`);
  return key;
};

type Call = { to: Address; data: Hex; value?: bigint; operation?: 0 | 1 };
// A refusal only counts when the Roles Modifier itself refused (byRoles)
type Outcome =
  { ok: true; note?: string } | { ok: false; reason: string; byRoles: boolean };

const execAs = async (
  member: Address,
  role: string,
  call: Call,
): Promise<Outcome> => {
  const data = encodeFunctionData({
    abi: rolesAbi,
    functionName: "execTransactionWithRole",
    args: [
      call.to,
      call.value ?? 0n,
      call.data,
      call.operation ?? 0,
      keyOf(role),
      true,
    ],
  });
  // Plain eth_call, so the revert data comes back the same from anvil and
  // hardhat (hardhat nests it one level deeper)
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ from: member, to: roles, data }, "latest"],
    }),
  });
  const { error } = (await response.json()) as {
    error?: { message: string; data?: any };
  };
  if (error) {
    const revert = (
      typeof error.data === "string" ? error.data : error.data?.data
    ) as Hex | undefined;
    let decoded;
    try {
      decoded = decodeErrorResult({ abi: rolesAbi, data: revert! });
    } catch {
      return {
        ok: false,
        byRoles: false,
        reason: `not a Roles error: ${error.message}`,
      };
    }
    if (decoded.errorName === "ModuleTransactionFailed") {
      return {
        ok: true,
        note: "Roles allowed it; the protocol itself reverted",
      };
    }
    if (decoded.errorName === "ConditionViolation") {
      return {
        ok: false,
        byRoles: true,
        reason: Status[Number(decoded.args[0])] ?? `status ${decoded.args[0]}`,
      };
    }
    return { ok: false, byRoles: true, reason: decoded.errorName };
  }
  await send(member, roles, data);
  return { ok: true };
};

let failures = 0;
const results: string[] = [];
const expect = async (
  want: "allow" | "deny",
  who: string,
  what: string,
  outcome: Promise<Outcome>,
  verify?: () => Promise<boolean>,
) => {
  const o = await outcome;
  let pass = want === "allow" ? o.ok : !o.ok && o.byRoles;
  let detail = o.ok ? (o.note ?? "executed") : o.reason;
  if (pass && o.ok && verify && !(await verify())) {
    pass = false;
    detail += ", but the effect is missing";
  }
  if (!pass) failures++;
  const line = `${pass ? "✓" : "✗"} ${want === "allow" ? "allowed" : "refused"}  ${who.padEnd(7)} ${what}  [${detail}]`;
  results.push(line);
  console.log(line);
};
const section = (title: string) => console.log(`\n── ${title}`);

const call = (
  to: Address,
  abi: any,
  functionName: string,
  args: readonly unknown[] = [],
  extra: Partial<Call> = {},
): Call => ({
  to,
  data: encodeFunctionData({ abi, functionName, args } as any),
  ...extra,
});
const now = async () => (await publicClient.getBlock()).timestamp;
const nextDay = async () => {
  await testClient.increaseTime({ seconds: 86_401 });
  await testClient.mine({ blocks: 1 });
};

// ── payroll (Ana)
section("payroll: USDC to three whitelisted receivers, 133 USDC per day");
const usdc = (n: string) => parseUnits(n, 6);
const payee1Before = await balance(eth.usdc, PAYEE_1);
await expect(
  "allow",
  "Ana",
  "pay 100 USDC to receiver 1",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transfer", [PAYEE_1, usdc("100")]),
  ),
  async () => (await balance(eth.usdc, PAYEE_1)) - payee1Before === usdc("100"),
);
await expect(
  "allow",
  "Ana",
  "pay 33 USDC to receiver 3",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transfer", [PAYEE_3, usdc("33")]),
  ),
);
await expect(
  "deny",
  "Ana",
  "pay 1 more USDC today (daily budget used up)",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transfer", [PAYEE_2, usdc("1")]),
  ),
);
await expect(
  "deny",
  "Ana",
  "pay 1 USDC to an attacker",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transfer", [ATTACKER, usdc("1")]),
  ),
);
await expect(
  "deny",
  "Ana",
  "approve an attacker to pull USDC",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "approve", [ATTACKER, maxUint256]),
  ),
);
await expect(
  "deny",
  "Ana",
  "transferFrom the vault to an attacker",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transferFrom", [treasury, ATTACKER, 1n]),
  ),
);
await expect(
  "deny",
  "Ana",
  "pay in USDT instead",
  execAs(ANA, "payroll", call(eth.usdt, erc20, "transfer", [PAYEE_1, 1n])),
);
await expect(
  "deny",
  "Ana",
  "send 0.01 ETH to an attacker",
  execAs(ANA, "payroll", {
    to: ATTACKER,
    data: "0x",
    value: parseEther("0.01"),
  }),
);
await expect(
  "deny",
  "Ana",
  "use the swap role (not a member)",
  execAs(ANA, "swap", call(eth.weth, wethAbi, "deposit", [], { value: 1n })),
);

// ── vendor payments (Ana)
section("vendor_payroll: USDC to any receiver, 50 USDC per 12 hours");
const VENDOR: Address = "0x000000000000000000000000000000000000be01";
const vendorBefore = await balance(eth.usdc, VENDOR);
await expect(
  "allow",
  "Ana",
  "pay 30 USDC to a vendor outside the vault (capped by design)",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transfer", [VENDOR, usdc("30")]),
  ),
  async () => (await balance(eth.usdc, VENDOR)) - vendorBefore === usdc("30"),
);
await expect(
  "allow",
  "Ana",
  "pay 20 USDC to any other address (capped by design)",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transfer", [ATTACKER, usdc("20")]),
  ),
);
await expect(
  "deny",
  "Ana",
  "pay 1 more USDC in the same 12 hours",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transfer", [VENDOR, usdc("1")]),
  ),
);
await expect(
  "deny",
  "Ana",
  "pay a vendor in USDT",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdt, erc20, "transfer", [VENDOR, 1n]),
  ),
);
await expect(
  "deny",
  "Ana",
  "approve a vendor to pull USDC",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "approve", [VENDOR, maxUint256]),
  ),
);
await expect(
  "deny",
  "Ana",
  "transferFrom the vault to a vendor",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transferFrom", [treasury, VENDOR, 1n]),
  ),
);
await expect(
  "deny",
  "Ana",
  "send ETH to a vendor",
  execAs(ANA, "vendor_payroll", { to: VENDOR, data: "0x", value: 1n }),
);
// A budget set with timestamp 0 starts at the block it was set in, and
// refills every whole period after that
const [, , vendorPeriod, , vendorTimestamp] = await publicClient.readContract({
  address: roles,
  abi: rolesAbi,
  functionName: "allowances",
  args: [encodeKey("vendor_usdc_12h")],
});
const nextRefill =
  vendorTimestamp +
  (((await now()) - vendorTimestamp) / vendorPeriod + 1n) * vendorPeriod;
await testClient.increaseTime({ seconds: Number(nextRefill - (await now())) });
await testClient.mine({ blocks: 1 });
await expect(
  "allow",
  "Ana",
  "pay 50 USDC again after the 12-hour refill",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transfer", [VENDOR, usdc("50")]),
  ),
);

// ── swaps (Ben)
section("swap: CoW between ETH/WETH, USDC and USDT, proceeds to the vault");
const settlementDomain = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: 1,
  verifyingContract: GPV2_SETTLEMENT,
} as const;
const orderTypes = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;
const order = async (
  o: Partial<Record<string, unknown>> & {
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
  },
) => ({
  receiver: treasury as Address,
  buyAmount: 1n,
  validTo: Number((await now()) + 3600n),
  appData: `0x${"00".repeat(32)}` as Hex,
  feeAmount: 0n,
  kind: keccak256(toBytes("sell")),
  partiallyFillable: false,
  sellTokenBalance: ERC20_BALANCE,
  buyTokenBalance: ERC20_BALANCE,
  ...o,
});
const signOrder = (o: any) =>
  call(eth.cowswap.order_signer, orderSignerAbi, "signOrder", [o, 7200, 0n], {
    operation: 1,
  });
const uidOf = (o: any) => {
  const digest = hashTypedData({
    domain: settlementDomain,
    types: orderTypes,
    primaryType: "Order",
    message: {
      ...o,
      kind: "sell",
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
    },
  });
  return encodePacked(
    ["bytes32", "address", "uint32"],
    [digest, treasury, o.validTo],
  );
};
const presigned = async (o: any) =>
  (await publicClient.readContract({
    address: GPV2_SETTLEMENT,
    abi: settlementAbi,
    functionName: "preSignature",
    args: [uidOf(o)],
  })) !== 0n;

await expect(
  "allow",
  "Ben",
  "wrap 0.1 ETH to WETH",
  execAs(
    BEN,
    "swap",
    call(eth.weth, wethAbi, "deposit", [], { value: parseEther("0.1") }),
  ),
);
await expect(
  "allow",
  "Ben",
  "approve the CoW vault relayer for WETH",
  execAs(
    BEN,
    "swap",
    call(eth.weth, erc20, "approve", [eth.cowswap.vault_relayer, maxUint256]),
  ),
);
// buyAmount is 1 wei in every order here: Roles v2 cannot check a price, so
// a stolen key could sign a bad limit price. CoW's solver competition sets the
// actual fill; the exposure is capped at the daily sell budget.
const wethOrder = await order({
  sellToken: eth.weth,
  buyToken: eth.usdc,
  sellAmount: parseEther("0.05"),
});
await expect(
  "allow",
  "Ben",
  "sign a CoW order: 0.05 WETH -> USDC to the vault",
  execAs(BEN, "swap", signOrder(wethOrder)),
  () => presigned(wethOrder),
);
await expect(
  "deny",
  "Ben",
  "sell 0.001 more WETH today (daily budget used up)",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.weth,
        buyToken: eth.usdc,
        sellAmount: parseEther("0.001"),
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "sign an order paying an attacker",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.usdc,
        buyToken: eth.weth,
        sellAmount: usdc("10"),
        receiver: ATTACKER,
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "buy a token outside the list (DAI)",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.usdc,
        buyToken: DAI,
        sellAmount: usdc("10"),
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "sell stETH",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.lido.steth,
        buyToken: eth.usdc,
        sellAmount: 1n,
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "add a fee to the order",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.usdc,
        buyToken: eth.weth,
        sellAmount: usdc("10"),
        feeAmount: usdc("5"),
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "route proceeds to Balancer internal balance",
  execAs(
    BEN,
    "swap",
    signOrder(
      await order({
        sellToken: eth.usdc,
        buyToken: eth.weth,
        sellAmount: usdc("10"),
        buyTokenBalance: keccak256(toBytes("internal")),
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "presign an arbitrary order uid on CoW directly",
  execAs(
    BEN,
    "swap",
    call(GPV2_SETTLEMENT, settlementAbi, "setPreSignature", [
      uidOf(wethOrder),
      true,
    ]),
  ),
);
await expect(
  "deny",
  "Ben",
  "transfer WETH to an attacker",
  execAs(BEN, "swap", call(eth.weth, erc20, "transfer", [ATTACKER, 1n])),
);
await expect(
  "deny",
  "Ben",
  "approve an attacker for WETH",
  execAs(BEN, "swap", call(eth.weth, erc20, "approve", [ATTACKER, maxUint256])),
);
await expect(
  "deny",
  "Ben",
  "delegatecall any other contract",
  execAs(BEN, "swap", { to: ATTACKER, data: "0x12345678", operation: 1 }),
);
await expect(
  "allow",
  "Ben",
  "approve the relayer for USDC",
  execAs(
    BEN,
    "swap",
    call(eth.usdc, erc20, "approve", [eth.cowswap.vault_relayer, maxUint256]),
  ),
);
const usdcOrder = await order({
  sellToken: eth.usdc,
  buyToken: NATIVE_ETH,
  sellAmount: usdc("133"),
});
await expect(
  "allow",
  "Ben",
  "sign 133 USDC -> native ETH to the vault",
  execAs(BEN, "swap", signOrder(usdcOrder)),
  () => presigned(usdcOrder),
);
await expect(
  "allow",
  "Ben",
  "approve the relayer for USDT",
  execAs(
    BEN,
    "swap",
    call(eth.usdt, erc20, "approve", [eth.cowswap.vault_relayer, maxUint256]),
  ),
);
const usdtOrder = await order({
  sellToken: eth.usdt,
  buyToken: eth.weth,
  sellAmount: usdc("133"),
});
await expect(
  "allow",
  "Ben",
  "sign 133 USDT -> WETH to the vault",
  execAs(BEN, "swap", signOrder(usdtOrder)),
  () => presigned(usdtOrder),
);
await expect(
  "allow",
  "Ben",
  "cancel the WETH order",
  execAs(
    BEN,
    "swap",
    call(eth.cowswap.order_signer, orderSignerAbi, "unsignOrder", [wethOrder], {
      operation: 1,
    }),
  ),
  async () => !(await presigned(wethOrder)),
);
await expect(
  "allow",
  "Ben",
  "unwrap 0.05 WETH",
  execAs(
    BEN,
    "swap",
    call(eth.weth, wethAbi, "withdraw", [parseEther("0.05")]),
  ),
);

// ── FOLD swaps (Ben)
section("fold_swap: CoW WETH -> FOLD, any receiver, 50 USD of WETH per day");
const foldBudget = BigInt(
  compiled.allowances.find((a: any) => a.key === encodeKey("fold_weth_daily"))
    .refill,
);
await expect(
  "allow",
  "Ben",
  "wrap 0.05 ETH to WETH",
  execAs(
    BEN,
    "fold_swap",
    call(eth.weth, wethAbi, "deposit", [], { value: parseEther("0.05") }),
  ),
);
await expect(
  "allow",
  "Ben",
  "approve the CoW vault relayer for WETH",
  execAs(
    BEN,
    "fold_swap",
    call(eth.weth, erc20, "approve", [eth.cowswap.vault_relayer, maxUint256]),
  ),
);
// One pinned field off per order, while the budget is still unspent
await expect(
  "deny",
  "Ben",
  "buy USDC instead of FOLD",
  execAs(
    BEN,
    "fold_swap",
    signOrder(
      await order({ sellToken: eth.weth, buyToken: eth.usdc, sellAmount: 1n }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "sell USDC for FOLD",
  execAs(
    BEN,
    "fold_swap",
    signOrder(
      await order({ sellToken: eth.usdc, buyToken: eth.fold, sellAmount: 1n }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "add a fee to a FOLD order",
  execAs(
    BEN,
    "fold_swap",
    signOrder(
      await order({
        sellToken: eth.weth,
        buyToken: eth.fold,
        sellAmount: 1n,
        feeAmount: 1n,
      }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "sell more WETH than one day's budget",
  execAs(
    BEN,
    "fold_swap",
    signOrder(
      await order({
        sellToken: eth.weth,
        buyToken: eth.fold,
        sellAmount: foldBudget + 1n,
      }),
    ),
  ),
);
const foldOrder = await order({
  sellToken: eth.weth,
  buyToken: eth.fold,
  sellAmount: foldBudget,
  receiver: ATTACKER,
});
await expect(
  "allow",
  "Ben",
  `sell ${Number(foldBudget) / 1e18} WETH for FOLD paid outside the vault (capped by design)`,
  execAs(BEN, "fold_swap", signOrder(foldOrder)),
  () => presigned(foldOrder),
);
await expect(
  "deny",
  "Ben",
  "sell 1 more wei of WETH today",
  execAs(
    BEN,
    "fold_swap",
    signOrder(
      await order({ sellToken: eth.weth, buyToken: eth.fold, sellAmount: 1n }),
    ),
  ),
);
await expect(
  "deny",
  "Ben",
  "transfer WETH out directly",
  execAs(BEN, "fold_swap", call(eth.weth, erc20, "transfer", [ATTACKER, 1n])),
);
await expect(
  "allow",
  "Ben",
  "cancel the FOLD order",
  execAs(
    BEN,
    "fold_swap",
    call(eth.cowswap.order_signer, orderSignerAbi, "unsignOrder", [foldOrder], {
      operation: 1,
    }),
  ),
  async () => !(await presigned(foldOrder)),
);

// ── Lido (Maria)
section("lido_staking: stake ETH (0.05 ETH per day), unstake to the vault");
await expect(
  "allow",
  "Maria",
  "stake 0.05 ETH",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.steth, lidoAbi, "submit", [zeroAddress], {
      value: parseEther("0.05"),
    }),
  ),
  async () => (await balance(eth.lido.steth, treasury)) >= parseEther("0.0499"),
);
await expect(
  "deny",
  "Maria",
  "stake 0.001 more ETH today",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.steth, lidoAbi, "submit", [zeroAddress], {
      value: parseEther("0.001"),
    }),
  ),
);
await expect(
  "allow",
  "Maria",
  "approve the withdrawal queue",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.steth, erc20, "approve", [
      eth.lido.withdrawal_queue,
      maxUint256,
    ]),
  ),
);
await expect(
  "allow",
  "Maria",
  "request a withdrawal of 0.01 stETH, owned by the vault",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.withdrawal_queue, queueAbi, "requestWithdrawals", [
      [parseEther("0.01")],
      treasury,
    ]),
  ),
);
const [requestId] = await publicClient.readContract({
  address: eth.lido.withdrawal_queue,
  abi: queueAbi,
  functionName: "getWithdrawalRequests",
  args: [treasury],
});
await expect(
  "deny",
  "Maria",
  "request a withdrawal owned by an attacker",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.withdrawal_queue, queueAbi, "requestWithdrawals", [
      [parseEther("0.01")],
      ATTACKER,
    ]),
  ),
);
await expect(
  "allow",
  "Maria",
  "claim a withdrawal (pays the vault)",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.withdrawal_queue, queueAbi, "claimWithdrawals", [
      [requestId],
      [0n],
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "claim a withdrawal to an attacker",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.withdrawal_queue, queueAbi, "claimWithdrawalsTo", [
      [requestId],
      [0n],
      ATTACKER,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "hand the withdrawal NFT to an attacker",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.withdrawal_queue, queueAbi, "transferFrom", [
      treasury,
      ATTACKER,
      requestId,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "transfer stETH to an attacker",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.steth, erc20, "transfer", [ATTACKER, 1n]),
  ),
);
await expect(
  "deny",
  "Maria",
  "approve an attacker for stETH",
  execAs(
    MARIA,
    "lido_staking",
    call(eth.lido.steth, erc20, "approve", [ATTACKER, maxUint256]),
  ),
);
await expect(
  "deny",
  "Ben",
  "stake from the swap role",
  execAs(
    BEN,
    "lido_staking",
    call(eth.lido.steth, lidoAbi, "submit", [zeroAddress], { value: 1n }),
  ),
);

// ── Aave (Maria)
section(
  "aave_wsteth: wrap stETH, supply wstETH to Aave v3 Core (0.05 ETH worth per day)",
);
await expect(
  "allow",
  "Maria",
  "approve wstETH to wrap stETH",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.lido.steth, erc20, "approve", [eth.lido.wsteth, maxUint256]),
  ),
);
await expect(
  "allow",
  "Maria",
  "wrap 0.035 stETH",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.lido.wsteth, wstethAbi, "wrap", [parseEther("0.035")]),
  ),
);
const wsteth = await balance(eth.lido.wsteth, treasury);
await expect(
  "allow",
  "Maria",
  "approve the Aave Core pool for wstETH",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.lido.wsteth, erc20, "approve", [
      eth.aave_v3.core_pool,
      maxUint256,
    ]),
  ),
);
await expect(
  "allow",
  "Maria",
  `supply ${Number(wsteth) / 1e18} wstETH for the vault`,
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "supply", [
      eth.lido.wsteth,
      wsteth,
      treasury,
      0,
    ]),
  ),
  async () => (await balance(A_ETH_WSTETH, treasury)) >= wsteth - 1n,
);
await expect(
  "deny",
  "Maria",
  "supply 0.02 more wstETH today",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "supply", [
      eth.lido.wsteth,
      parseEther("0.02"),
      treasury,
      0,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "supply on behalf of an attacker",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "supply", [
      eth.lido.wsteth,
      1n,
      ATTACKER,
      0,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "supply USDC",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "supply", [eth.usdc, 1n, treasury, 0]),
  ),
);
await expect(
  "deny",
  "Maria",
  "withdraw to an attacker",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "withdraw", [
      eth.lido.wsteth,
      maxUint256,
      ATTACKER,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "borrow USDC against the position",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "borrow", [
      eth.usdc,
      1n,
      2n,
      0,
      treasury,
    ]),
  ),
);
await expect(
  "deny",
  "Maria",
  "transfer the aTokens to an attacker",
  execAs(
    MARIA,
    "aave_wsteth",
    call(A_ETH_WSTETH, erc20, "transfer", [ATTACKER, 1n]),
  ),
);
await expect(
  "deny",
  "Maria",
  "transfer wstETH to an attacker",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.lido.wsteth, erc20, "transfer", [ATTACKER, 1n]),
  ),
);
await expect(
  "allow",
  "Maria",
  "withdraw everything back to the vault",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.aave_v3.core_pool, poolAbi, "withdraw", [
      eth.lido.wsteth,
      maxUint256,
      treasury,
    ]),
  ),
  async () => (await balance(A_ETH_WSTETH, treasury)) === 0n,
);
await expect(
  "allow",
  "Maria",
  "unwrap the wstETH",
  execAs(
    MARIA,
    "aave_wsteth",
    call(eth.lido.wsteth, wstethAbi, "unwrap", [
      await balance(eth.lido.wsteth, treasury),
    ]),
  ),
);

// ── Morpho (Steve)
section("morpho_usdc: Steakhouse Prime USDC (133 USDC per day)");
const vault = eth.morpho.steakhouse_prime_usdc;
await expect(
  "allow",
  "Steve",
  "approve the vault for USDC",
  execAs(
    STEVE,
    "morpho_usdc",
    call(eth.usdc, erc20, "approve", [vault, maxUint256]),
  ),
);
// Before the budget is spent, so the receiver check is what refuses it
await expect(
  "deny",
  "Steve",
  "deposit on behalf of an attacker",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "deposit", [1n, ATTACKER]),
  ),
);
await expect(
  "allow",
  "Steve",
  "deposit 133 USDC for the vault",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "deposit", [usdc("133"), treasury]),
  ),
  async () => (await balance(vault, treasury)) > 0n,
);
await expect(
  "deny",
  "Steve",
  "deposit 1 more USDC today",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "deposit", [usdc("1"), treasury]),
  ),
);
await expect(
  "deny",
  "Steve",
  "withdraw to an attacker",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "withdraw", [usdc("10"), ATTACKER, treasury]),
  ),
);
await expect(
  "deny",
  "Steve",
  "withdraw someone else's shares",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "withdraw", [usdc("10"), treasury, ATTACKER]),
  ),
);
await expect(
  "deny",
  "Steve",
  "redeem to an attacker",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "redeem", [1n, ATTACKER, treasury]),
  ),
);
await expect(
  "deny",
  "Steve",
  "mint shares (bypasses the USDC meter)",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "mint", [parseEther("1"), treasury]),
  ),
);
await expect(
  "deny",
  "Steve",
  "transfer vault shares to an attacker",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "transfer", [ATTACKER, 1n]),
  ),
);
await expect(
  "deny",
  "Steve",
  "call the vault's multicall",
  execAs(STEVE, "morpho_usdc", call(vault, vaultAbi, "multicall", [[]])),
);
await expect(
  "deny",
  "Steve",
  "force a deallocation",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "forceDeallocate", [ATTACKER, "0x", 1n, treasury]),
  ),
);
await expect(
  "allow",
  "Steve",
  "withdraw 50 USDC to the vault",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "withdraw", [usdc("50"), treasury, treasury]),
  ),
);
await expect(
  "allow",
  "Steve",
  "redeem the remaining shares to the vault",
  execAs(
    STEVE,
    "morpho_usdc",
    call(vault, vaultAbi, "redeem", [
      await balance(vault, treasury),
      treasury,
      treasury,
    ]),
  ),
  async () => (await balance(vault, treasury)) === 0n,
);

// ── batches
section("batches through MultiSend are checked call by call");
const packCalls = (calls: Call[]) =>
  encodeFunctionData({
    abi: multisendAbi,
    functionName: "multiSend",
    args: [
      `0x${calls
        .map((c) =>
          encodePacked(
            ["uint8", "address", "uint256", "uint256", "bytes"],
            [0, c.to, c.value ?? 0n, BigInt((c.data.length - 2) / 2), c.data],
          ).slice(2),
        )
        .join("")}` as Hex,
    ],
  });
await expect(
  "allow",
  "Maria",
  "batch: approve + wrap stETH",
  execAs(MARIA, "aave_wsteth", {
    to: MULTISEND_CALL_ONLY,
    operation: 1,
    data: packCalls([
      call(eth.lido.steth, erc20, "approve", [eth.lido.wsteth, maxUint256]),
      call(eth.lido.wsteth, wstethAbi, "wrap", [parseEther("0.001")]),
    ]),
  }),
);
await expect(
  "deny",
  "Ben",
  "batch: wrap ETH + WETH transfer to an attacker",
  execAs(BEN, "swap", {
    to: MULTISEND_CALL_ONLY,
    operation: 1,
    data: packCalls([
      call(eth.weth, wethAbi, "deposit", [], { value: 1n }),
      call(eth.weth, erc20, "transfer", [ATTACKER, 1n]),
    ]),
  }),
);

// ── veto (Security Council)
section(
  "veto: the council can skip queued treasury transactions, nothing else",
);
const drain = encodeFunctionData({
  abi: erc20,
  functionName: "transfer",
  args: [ATTACKER, await balance(eth.usdc, treasury)],
});
await send(
  OPERATOR,
  delay,
  encodeFunctionData({
    abi: delayAbi,
    functionName: "execTransactionFromModule",
    args: [eth.usdc, 0n, drain, 0],
  }),
);
console.log(
  "  (a compromised Operator Vault queues: transfer all USDC to an attacker)",
);
await expect(
  "deny",
  "Council",
  "lower the Delay cooldown to 0",
  execAs(council, "veto", call(delay, delayAbi, "setTxCooldown", [0n])),
);
await expect(
  "deny",
  "Council",
  "add itself as a Delay module",
  execAs(council, "veto", call(delay, delayAbi, "enableModule", [ATTACKER])),
);
await expect(
  "deny",
  "Council",
  "transfer USDC out of the vault",
  execAs(council, "veto", call(eth.usdc, erc20, "transfer", [ATTACKER, 1n])),
);
const queued = await publicClient.readContract({
  address: delay,
  abi: delayAbi,
  functionName: "queueNonce",
});
await expect(
  "allow",
  "Council",
  "veto the queued drain (setTxNonce)",
  execAs(council, "veto", call(delay, delayAbi, "setTxNonce", [queued])),
  async () =>
    (await publicClient.readContract({
      address: delay,
      abi: delayAbi,
      functionName: "txNonce",
    })) === queued,
);
await nextDay();
const usdcBefore = await balance(eth.usdc, treasury);
const executed = await send(
  OPERATOR,
  delay,
  encodeFunctionData({
    abi: delayAbi,
    functionName: "executeNextTx",
    args: [eth.usdc, 0n, drain, 0],
  }),
).then(
  () => true,
  () => false,
);
const vetoHeld =
  !executed && (await balance(eth.usdc, treasury)) === usdcBefore;
if (!vetoHeld) failures++;
console.log(
  `${vetoHeld ? "✓" : "✗"} after the 24h cooldown the vetoed drain cannot be executed`,
);

// ── budgets refill
section("budgets refill after a day");
await expect(
  "allow",
  "Ana",
  "pay 133 USDC to receiver 2 the next day",
  execAs(
    ANA,
    "payroll",
    call(eth.usdc, erc20, "transfer", [PAYEE_2, usdc("133")]),
  ),
);
const nextDayOrder = await order({
  sellToken: eth.weth,
  buyToken: eth.usdc,
  sellAmount: parseEther("0.05"),
});
await expect(
  "allow",
  "Ben",
  "sell 0.05 WETH the next day",
  execAs(BEN, "swap", signOrder(nextDayOrder)),
  () => presigned(nextDayOrder),
);

await expect(
  "allow",
  "Ana",
  "pay a vendor 50 USDC in a new period",
  execAs(
    ANA,
    "vendor_payroll",
    call(eth.usdc, erc20, "transfer", [VENDOR, usdc("50")]),
  ),
);
const nextDayFoldOrder = await order({
  sellToken: eth.weth,
  buyToken: eth.fold,
  sellAmount: foldBudget,
  receiver: ATTACKER,
});
await expect(
  "allow",
  "Ben",
  "sell one day's WETH budget for FOLD the next day",
  execAs(BEN, "fold_swap", signOrder(nextDayFoldOrder)),
  () => presigned(nextDayFoldOrder),
);

const total = results.length + 1;
console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
