/**
 * MoneyCircle — INIT jetton wallet discovery (TEP-89) for CircleContract
 *
 * Usage:
 *   npx tsx scripts/init.ts --network testnet EQ...contract
 *
 * Required env:
 *   DEPLOY_WALLET_MNEMONIC="word1 ... word24"
 *
 * Optional env:
 *   TONCENTER_ENDPOINT, TONCENTER_KEY
 *   INIT_VALUE_TON="0.05" (must be >= MIN_WITHDRAW_GAS in contract)
 */

import { Address, beginCell, internal, toNano } from "@ton/core";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";

import { CircleContract } from "../build/CircleContract_CircleContract.ts";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function endpointForNetwork(network: "testnet" | "mainnet"): string {
  const fromEnv = process.env.TONCENTER_ENDPOINT;
  if (fromEnv) return fromEnv;
  return network === "testnet" ? "https://testnet.toncenter.com/api/v2/jsonRPC" : "https://toncenter.com/api/v2/jsonRPC";
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const network = (argValue("--network") ?? (hasFlag("--mainnet") ? "mainnet" : "testnet")) as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("Invalid --network (testnet|mainnet)");

  const contractAddress = process.argv.find((a) => a.startsWith("EQ") || a.startsWith("kQ") || a.includes(":"));
  if (!contractAddress) {
    console.error("Usage: npx tsx scripts/init.ts --network testnet <contract_address>");
    process.exit(1);
  }

  const endpoint = endpointForNetwork(network);
  const apiKey = process.env.TONCENTER_KEY;
  const client = new TonClient({ endpoint, apiKey });

  const mnemonic = requireEnv("DEPLOY_WALLET_MNEMONIC").trim().split(/\\s+/);
  const walletKey = await mnemonicToWalletKey(mnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: walletKey.publicKey });
  const walletContract = client.open(wallet);

  const walletDeployed = await client.isContractDeployed(wallet.address);
  if (!walletDeployed) throw new Error(`Deployer wallet is not deployed: ${wallet.address.toString()}`);

  const addr = Address.parse(contractAddress);
  const contract = client.open(CircleContract.fromAddress(addr));

  const current = await contract.getGetJettonWallet();
  if (current) {
    console.log(`Already initialized: jetton_wallet=${current.toString()}`);
    return;
  }

  const initValue = process.env.INIT_VALUE_TON ?? "0.05";
  const body = beginCell().storeUint(0xa001, 32).endCell();

  const seqno = await walletContract.getSeqno();
  console.log(`[wallet] ${wallet.address.toString()} seqno=${seqno} sending INIT…`);

  await walletContract.sendTransfer({
    seqno,
    secretKey: walletKey.secretKey,
    messages: [
      internal({
        to: addr,
        value: toNano(initValue),
        body,
      }),
    ],
  });

  // Wait until jetton_wallet is set (best-effort).
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const jw = await contract.getGetJettonWallet();
    if (jw) {
      console.log(`✅ jetton_wallet set: ${jw.toString()}`);
      return;
    }
    process.stdout.write(".");
  }
  process.stdout.write("\\n");
  console.log("⚠️ INIT sent, but jetton_wallet not visible yet. Retry verify later.");
}

main().catch((err) => {
  console.error("Init failed:", err?.message ?? err);
  process.exit(1);
});
