import { getCorsHeaders, errorResponse, jsonResponse, withCors } from "../_shared/http.ts";
import { requireSession } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204, headers: getCorsHeaders(origin) }), origin);
  }
  if (req.method !== "GET") {
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

  const url = new URL(req.url);
  const circleId = url.searchParams.get("circle_id");
  if (!circleId) {
    return errorResponse("BAD_REQUEST", 400, "circle_id required", origin);
  }

  const circleRes = await supabase
    .from("circles")
    .select(
      "circle_id,group_chat_id,name,status,contract_address,jetton_master,n_members,contribution_units,total_cycles,interval_sec,grace_sec,take_rate_bps,collateral_rate_bps,max_discount_bps,vesting_bps_cycle1,early_lock_rate_bps_cycle1,commit_duration_sec,reveal_duration_sec,max_pot_cap_units,min_deposit_units,current_cycle_index,onchain_phase,onchain_funded_count,onchain_jetton_wallet,onchain_due_at,onchain_grace_end_at,onchain_commit_end_at,onchain_reveal_end_at,last_indexer_attempt_at,last_indexed_at,last_indexer_error"
    )
    .eq("circle_id", circleId)
    .single();
  if (circleRes.error || !circleRes.data) {
    return errorResponse("CIRCLE_NOT_FOUND", 404, undefined, origin);
  }

  // Basic scoping: if session is tied to a group, require circle belongs to it.
  if (session.group_chat_id && Number(session.group_chat_id) !== Number(circleRes.data.group_chat_id)) {
    return errorResponse("FORBIDDEN", 403, undefined, origin);
  }

  const memberRes = await supabase
    .from("circle_members")
    .select(
      "join_status,wallet_address,rules_signature_hash,has_won,collateral,prefund,credit,vesting_locked,vesting_released,future_locked,withdrawable,due_remaining"
    )
    .eq("circle_id", circleId)
    .eq("telegram_user_id", session.telegram_user_id)
    .maybeSingle();

  if (memberRes.error) {
    return errorResponse("DB_ERROR", 500, memberRes.error.message, origin);
  }

  return jsonResponse({ circle: circleRes.data, member: memberRes.data ?? null }, 200, origin);
});
