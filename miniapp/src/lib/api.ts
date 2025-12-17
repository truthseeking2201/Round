import { env } from "./env";

export type ApiError = { code: string; message?: string };

async function apiFetch<T>(path: string, options: { method: string; token?: string; body?: unknown } = { method: "GET" }): Promise<T> {
  if (!env.FUNCTIONS_BASE_URL) {
    throw { code: "MISSING_FUNCTIONS_BASE_URL", message: "Set VITE_FUNCTIONS_BASE_URL" } satisfies ApiError;
  }

  const url = `${env.FUNCTIONS_BASE_URL.replace(/\/$/, "")}/${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const payload = (json ?? {}) as { error?: { code?: unknown; message?: unknown } };
    const err = typeof payload.error?.code === "string" ? payload.error.code : "API_ERROR";
    const message = typeof payload.error?.message === "string" ? payload.error.message : undefined;
    throw { code: err, message } satisfies ApiError;
  }
  return json as T;
}

export type TgUser = {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  language_code: string | null;
};

export type TgGroup = {
  group_chat_id: number;
  title: string | null;
  type: string | null;
  bot_present: boolean;
  bot_admin: boolean;
  last_checked_at: string | null;
};

export type AuthTelegramResponse = {
  session_token: string;
  user: TgUser;
  group: TgGroup | null;
};

export async function authTelegram(initData: string): Promise<AuthTelegramResponse> {
  return await apiFetch<AuthTelegramResponse>("auth-telegram", { method: "POST", body: { initData } });
}

export type CirclesListResponse = {
  circles: Array<{
    circle_id: string;
    name?: string | null;
    status: string;
    contract_address?: string | null;
    n_members: number;
    contribution_units: string;
    current_cycle_index: number;
    onchain_due_at?: string | null;
    onchain_grace_end_at?: string | null;
    onchain_commit_end_at?: string | null;
    onchain_reveal_end_at?: string | null;
    last_indexed_at?: string | null;
    last_indexer_error?: string | null;
    created_at: string;
  }>;
};

export async function listCircles(token: string): Promise<CirclesListResponse> {
  return await apiFetch<CirclesListResponse>("circles-list", { method: "GET", token });
}

export type CircleRecord = {
  circle_id: string;
  group_chat_id: number;
  name: string | null;
  status: string;
  contract_address: string | null;
  jetton_master: string | null;
  n_members: number;
  contribution_units: string;
  total_cycles: number;
  interval_sec: number;
  grace_sec: number;
  take_rate_bps: number;
  collateral_rate_bps: number;
  max_discount_bps: number;
  vesting_bps_cycle1: number;
  early_lock_rate_bps_cycle1: number;
  commit_duration_sec: number;
  reveal_duration_sec: number;
  max_pot_cap_units: string;
  min_deposit_units: string;
  current_cycle_index: number;
  onchain_phase: number | null;
  onchain_funded_count: number | null;
  onchain_jetton_wallet: string | null;
  onchain_due_at: string | null;
  onchain_grace_end_at: string | null;
  onchain_commit_end_at: string | null;
  onchain_reveal_end_at: string | null;
  last_indexer_attempt_at: string | null;
  last_indexed_at: string | null;
  last_indexer_error: string | null;
};

export type CircleMemberRecord = {
  join_status: string;
  wallet_address: string | null;
  rules_signature_hash: string | null;
  has_won: boolean;
  collateral: string;
  prefund: string;
  credit: string;
  vesting_locked: string;
  vesting_released: string;
  future_locked: string;
  withdrawable: string;
  due_remaining: string;
};

export type CircleStatusResponse = { circle: CircleRecord; member: CircleMemberRecord | null };

export async function getCircleStatus(token: string, circleId: string): Promise<CircleStatusResponse> {
  const q = new URLSearchParams({ circle_id: circleId });
  return await apiFetch<CircleStatusResponse>(`circles-status?${q.toString()}`, { method: "GET", token });
}

export type CreateCircleResponse = { ok: true; circle: CircleRecord };

export async function createCircle(
  token: string,
  params: { name?: string; n_members: number; contribution_usdt: string; interval: "weekly" | "monthly" }
): Promise<CreateCircleResponse> {
  return await apiFetch<CreateCircleResponse>("circles-create", { method: "POST", token, body: params });
}

export type JoinCircleResponse = { ok: true; member: CircleMemberRecord };

export async function joinCircle(token: string, circleId: string): Promise<JoinCircleResponse> {
  return await apiFetch<JoinCircleResponse>("circles-join", { method: "POST", token, body: { circle_id: circleId } });
}

export type AcceptRulesResponse = { ok: true; member: CircleMemberRecord };

export async function acceptRules(token: string, circleId: string, rulesSignatureHash: string): Promise<AcceptRulesResponse> {
  return await apiFetch<AcceptRulesResponse>("circles-accept-rules", {
    method: "POST",
    token,
    body: { circle_id: circleId, rules_signature_hash: rulesSignatureHash }
  });
}

export async function walletBindChallenge(token: string, circleId: string): Promise<{ nonce: string; exp: number; message_to_sign: string }> {
  return await apiFetch<{ nonce: string; exp: number; message_to_sign: string }>("wallet-bind-challenge", {
    method: "POST",
    token,
    body: { circle_id: circleId }
  });
}

export type WalletBindConfirmResponse = { ok: true; wallet_address: string; member: CircleMemberRecord };

export async function walletBindConfirm(token: string, circleId: string, signData: unknown): Promise<WalletBindConfirmResponse> {
  return await apiFetch<WalletBindConfirmResponse>("wallet-bind-confirm", { method: "POST", token, body: { circle_id: circleId, sign_data: signData } });
}

export type JoinTicketResponse = { wallet: string; exp: number; nonce: string; sig: string; contract_address: string };

export async function joinTicket(token: string, circleId: string): Promise<JoinTicketResponse> {
  return await apiFetch<JoinTicketResponse>("circles-join-ticket", { method: "POST", token, body: { circle_id: circleId } });
}

export type AttachContractResponse = { ok: true; circle: CircleRecord };

export async function attachContract(token: string, params: { circle_id: string; contract_address: string }): Promise<AttachContractResponse> {
  return await apiFetch<AttachContractResponse>("circles-attach-contract", { method: "POST", token, body: params });
}

export type DepositIntentResponse = {
  ok: true;
  jetton_master: string;
  jetton_wallet: string;
  to_contract: string;
  amount_units: string;
  tx_value_nano: string;
  payload_base64: string;
};

export async function depositIntent(
  token: string,
  params: { circle_id: string; purpose: "collateral" | "prefund"; amount_usdt: string | number }
): Promise<DepositIntentResponse> {
  return await apiFetch<DepositIntentResponse>("circles-deposit-intent", { method: "POST", token, body: params });
}
