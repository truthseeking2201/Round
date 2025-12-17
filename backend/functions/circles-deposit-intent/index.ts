import { Address, beginCell } from "npm:@ton/core@0.60.0";

import { errorResponse, jsonResponse, readJson, withCors } from "../_shared/http.ts";
import { requireSession } from "../_shared/auth.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { runGetMethodWithRetry } from "../_shared/tonapi.ts";
import { readAddressFromStackRecord, readNumAt, unwrapTuple } from "../_shared/tvm.ts";
import { parseUsdtToUnits } from "../_shared/usdt.ts";

type DepositIntentRequest = {
  circle_id: string;
  purpose: "collateral" | "prefund";
  amount_usdt: string | number;
};

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const DEPOSIT_MAGIC = 0xc0ffee01;
const PURPOSE_COLLATERAL = 1;
const PURPOSE_PREFUND = 2;

const FORWARD_TON_AMOUNT = 50_000_000n; // 0.05 TON (safe for MVP)
const TX_VALUE = 100_000_000n; // 0.1 TON (covers forward + fees)

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), origin);
  }
  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", 405, undefined, origin);
  }

  const supabase = createServiceClient();

  let session;
  try {
    session = await requireSession({ req, supabase });
  } catch (e) {
    const code = e instanceof Error ? e.message : "AUTH_INVALID";
    return errorResponse(code, 401, undefined, origin);
  }

  const limited = await enforceRateLimit({
    supabase,
    origin,
    action: "deposit_intent",
    key: `tg:${session.telegram_user_id}`,
    limit: 60,
    windowSeconds: 24 * 60 * 60,
  });
  if (limited) return limited;

  let body: DepositIntentRequest;
  try {
    body = await readJson<DepositIntentRequest>(req);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "INVALID_JSON", 400, undefined, origin);
  }
  if (!body?.circle_id || !body?.purpose) return errorResponse("BAD_REQUEST", 400, undefined, origin);

  let amountUnits: bigint;
  try {
    amountUnits = parseUsdtToUnits(body.amount_usdt);
  } catch {
    return errorResponse("BAD_REQUEST", 400, "invalid amount_usdt", origin);
  }
  if (amountUnits <= 0n) return errorResponse("BAD_REQUEST", 400, "amount_usdt must be > 0", origin);

  const circleRes = await supabase
    .from("circles")
    .select("circle_id,group_chat_id,status,contract_address,jetton_master,min_deposit_units,onchain_jetton_wallet")
    .eq("circle_id", body.circle_id)
    .single();
  if (circleRes.error || !circleRes.data) return errorResponse("CIRCLE_NOT_FOUND", 404, undefined, origin);
  if (!circleRes.data.contract_address) return errorResponse("CONTRACT_NOT_READY", 400, undefined, origin);
  if (circleRes.data.status === "EmergencyStop") return errorResponse("EMERGENCY_STOP", 400, undefined, origin);
  if (!circleRes.data.onchain_jetton_wallet)
    return errorResponse("JETTON_WALLET_NOT_INITIALIZED", 400, "Run INIT first", origin);

  // Prevent silent fund loss: CircleContract ignores deposits < min_deposit_units.
  try {
    const minDep = BigInt(circleRes.data.min_deposit_units);
    if (amountUnits < minDep) {
      return errorResponse("DEPOSIT_TOO_SMALL", 400, "amount_usdt below min_deposit_units", origin);
    }
  } catch {
    return errorResponse("SERVER_MISCONFIGURED", 500, "Invalid min_deposit_units", origin);
  }

  if (session.group_chat_id && Number(session.group_chat_id) !== Number(circleRes.data.group_chat_id)) {
    return errorResponse("FORBIDDEN", 403, undefined, origin);
  }

  const memberRes = await supabase
    .from("circle_members")
    .select("join_status,wallet_address")
    .eq("circle_id", body.circle_id)
    .eq("telegram_user_id", session.telegram_user_id)
    .single();
  if (memberRes.error || !memberRes.data) return errorResponse("NOT_JOINED", 400, undefined, origin);
  if (memberRes.data.join_status === "exited") return errorResponse("NOT_JOINED", 400, undefined, origin);
  if (!memberRes.data.wallet_address) return errorResponse("WALLET_NOT_VERIFIED", 400, undefined, origin);

  const jettonMaster = String(circleRes.data.jetton_master ?? Deno.env.get("USDT_JETTON_MASTER") ?? "");
  if (!jettonMaster) return errorResponse("SERVER_MISCONFIGURED", 500, "Missing USDT_JETTON_MASTER", origin);

  const owner = String(memberRes.data.wallet_address);

  // Safety: DB is only a UX mirror. Verify the wallet is an active on-chain member before generating a deposit payload.
  // This prevents fund loss if `join_status` is stale (e.g., user exited Recruiting but DB still says onchain_joined).
  const mvExec = await runGetMethodWithRetry({
    account: String(circleRes.data.contract_address),
    method: "get_member",
    args: [owner],
    maxRetries: 2,
  });
  if (!mvExec || !mvExec.success) return errorResponse("CHAIN_UNAVAILABLE", 502, undefined, origin);
  const mv = unwrapTuple(mvExec.stack);
  const active = mv.length >= 1 ? readNumAt(mv, 0) !== 0n : false;
  if (!active) return errorResponse("NOT_ONCHAIN_MEMBER", 400, undefined, origin);

  // Best-effort: upgrade join_status if chain already shows membership (reduces UX friction under indexer lag).
  if (memberRes.data.join_status !== "onchain_joined") {
    await supabase
      .from("circle_members")
      .update({ join_status: "onchain_joined" })
      .eq("circle_id", body.circle_id)
      .eq("telegram_user_id", session.telegram_user_id);
  }

  const exec = await runGetMethodWithRetry({ account: jettonMaster, method: "get_wallet_address", args: [owner], maxRetries: 3 });
  if (!exec || !exec.success) return errorResponse("JETTON_GET_WALLET_FAILED", 502, undefined, origin);

  const tuple = unwrapTuple(exec.stack);
  if (tuple.length < 1) return errorResponse("JETTON_GET_WALLET_FAILED", 502, "empty stack", origin);

  let jettonWallet: string;
  try {
    jettonWallet = readAddressFromStackRecord(tuple[0]).toString();
  } catch {
    return errorResponse("JETTON_GET_WALLET_FAILED", 502, "bad address stack", origin);
  }

  const purpose = body.purpose === "collateral" ? PURPOSE_COLLATERAL : PURPOSE_PREFUND;
  const forwardPayload = beginCell().storeUint(DEPOSIT_MAGIC, 32).storeUint(purpose, 8).endCell();

  const transfer = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(0, 64) // query_id
    .storeCoins(amountUnits)
    .storeAddress(Address.parse(String(circleRes.data.contract_address))) // destination owner
    .storeAddress(Address.parse(owner)) // response_destination
    .storeBit(false) // custom_payload = null
    .storeCoins(FORWARD_TON_AMOUNT)
    .storeBit(true) // forward_payload in ref
    .storeRef(forwardPayload)
    .endCell();

  const payload = base64(transfer.toBoc({ idx: false }));

  return jsonResponse(
    {
      ok: true,
      jetton_master: jettonMaster,
      jetton_wallet: jettonWallet,
      to_contract: String(circleRes.data.contract_address),
      amount_units: amountUnits.toString(),
      tx_value_nano: TX_VALUE.toString(),
      payload_base64: payload,
    },
    200,
    origin
  );
});
