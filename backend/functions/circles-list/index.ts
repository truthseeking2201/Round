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

  if (!session.group_chat_id) {
    return errorResponse("TG_GROUP_REQUIRED", 400, "Open the mini app inside a Telegram group", origin);
  }

  const res = await supabase
    .from("circles")
    .select(
      "circle_id,name,status,contract_address,n_members,contribution_units,current_cycle_index,onchain_due_at,onchain_grace_end_at,onchain_commit_end_at,onchain_reveal_end_at,last_indexed_at,last_indexer_error,created_at"
    )
    .eq("group_chat_id", session.group_chat_id)
    .order("created_at", { ascending: false });

  if (res.error) return errorResponse("DB_ERROR", 500, res.error.message, origin);

  return jsonResponse({ circles: res.data ?? [] }, 200, origin);
});
