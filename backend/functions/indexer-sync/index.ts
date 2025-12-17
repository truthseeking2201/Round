import { getCorsHeaders, errorResponse, jsonResponse, withCors } from "../_shared/http.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { runGetMethodWithRetry } from "../_shared/tonapi.ts";
import { editMessageText, sendMessage } from "../_shared/telegram-api.ts";
import { readAddressFromStackRecord, readNumAt, readOptionalAddressFromStackRecord, unwrapTuple } from "../_shared/tvm.ts";
import { Address } from "npm:@ton/core@0.60.0";

function addressKey(input: string): string | null {
  try {
    return Address.parse(input).toRawString();
  } catch {
    return null;
  }
}

function statusToText(code: number): string | null {
  switch (code) {
    case 0:
      return "Recruiting";
    case 1:
      return "Locked";
    case 2:
      return "Active";
    case 3:
      return "Completed";
    case 4:
      return "Terminated";
    case 5:
      return "EmergencyStop";
    default:
      return null;
  }
}

function tsFromSeconds(sec: bigint): string | null {
  if (sec <= 0n) return null;
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function phaseToText(code: number): string {
  switch (code) {
    case 0:
      return "Funding";
    case 1:
      return "Commit";
    case 2:
      return "Reveal";
    case 3:
      return "DefaultEligible";
    default:
      return `Phase(${code})`;
  }
}

function renderProgressText(params: {
  circleId: string;
  circleName: string | null;
  status: string;
  cycleIndex: number;
  phaseCode: number;
  fundedCount: number;
  nMembers: number;
  dueAt: string | null;
  graceEndAt: string | null;
  commitEndAt: string | null;
  revealEndAt: string | null;
  contractAddress: string;
}): string {
  const name = params.circleName ? ` — ${params.circleName}` : "";
  const lines: string[] = [];
  lines.push(`MoneyCircle${name}`);
  lines.push(`Circle: ${params.circleId}`);
  lines.push(`Status: ${params.status}`);
  if (params.cycleIndex > 0) lines.push(`Cycle: ${params.cycleIndex}`);
  lines.push(`Phase: ${phaseToText(params.phaseCode)}`);
  if (params.nMembers > 0) lines.push(`Funded: ${params.fundedCount}/${params.nMembers}`);
  if (params.dueAt) lines.push(`Due: ${params.dueAt}`);
  if (params.graceEndAt) lines.push(`Grace ends: ${params.graceEndAt}`);
  if (params.commitEndAt) lines.push(`Commit ends: ${params.commitEndAt}`);
  if (params.revealEndAt) lines.push(`Reveal ends: ${params.revealEndAt}`);
  lines.push(`Contract: ${params.contractAddress}`);
  return lines.join("\n");
}

async function postOrEditProgressMessage(params: {
  supabase: ReturnType<typeof createServiceClient>;
  botToken: string;
  groupChatId: number;
  circleId: string;
  text: string;
}) {
  const nowMs = Date.now();
  const existing = await params.supabase
    .from("bot_messages")
    .select("message_id,last_edited_at")
    .eq("group_chat_id", params.groupChatId)
    .eq("circle_id", params.circleId)
    .eq("message_type", "Progress")
    .maybeSingle();

  if (existing.error) {
    console.error("[BOT_PROGRESS_DB_ERROR]", existing.error.message);
    return;
  }

  const lastEditedIso = existing.data?.last_edited_at ?? null;
  if (lastEditedIso) {
    const lastMs = Date.parse(String(lastEditedIso));
    // Hard throttle to reduce edit spam in case indexer runs very frequently.
    if (Number.isFinite(lastMs) && nowMs - lastMs < 60_000) return;
  }

  if (!existing.data) {
    const sent = await sendMessage({ botToken: params.botToken, chatId: params.groupChatId, text: params.text });
    if (!sent.ok) {
      console.error("[BOT_PROGRESS_SEND_FAILED]", sent.description ?? sent.error_code);
      return;
    }
    await params.supabase.from("bot_messages").upsert(
      {
        group_chat_id: params.groupChatId,
        circle_id: params.circleId,
        message_type: "Progress",
        message_id: sent.result.message_id,
        pinned: false,
        last_edited_at: new Date().toISOString(),
      },
      { onConflict: "group_chat_id,circle_id,message_type" }
    );
    return;
  }

  const edited = await editMessageText({
    botToken: params.botToken,
    chatId: params.groupChatId,
    messageId: Number(existing.data.message_id),
    text: params.text,
  });
  if (!edited.ok) {
    console.error("[BOT_PROGRESS_EDIT_FAILED]", edited.description ?? edited.error_code);
    return;
  }
  await params.supabase
    .from("bot_messages")
    .update({ last_edited_at: new Date().toISOString() })
    .eq("group_chat_id", params.groupChatId)
    .eq("circle_id", params.circleId)
    .eq("message_type", "Progress");
}

async function postOnceBotMessage(params: {
  supabase: ReturnType<typeof createServiceClient>;
  botToken: string;
  groupChatId: number;
  circleId: string;
  messageType: "Settlement" | "Default" | "Emergency";
  text: string;
}) {
  const existing = await params.supabase
    .from("bot_messages")
    .select("message_id")
    .eq("group_chat_id", params.groupChatId)
    .eq("circle_id", params.circleId)
    .eq("message_type", params.messageType)
    .maybeSingle();
  if (existing.error) {
    console.error("[BOT_ONCE_DB_ERROR]", existing.error.message);
    return;
  }
  if (existing.data) return;

  const sent = await sendMessage({ botToken: params.botToken, chatId: params.groupChatId, text: params.text });
  if (!sent.ok) {
    console.error("[BOT_ONCE_SEND_FAILED]", sent.description ?? sent.error_code);
    return;
  }

  await params.supabase.from("bot_messages").upsert(
    {
      group_chat_id: params.groupChatId,
      circle_id: params.circleId,
      message_type: params.messageType,
      message_id: sent.result.message_id,
      pinned: false,
      last_edited_at: new Date().toISOString(),
    },
    { onConflict: "group_chat_id,circle_id,message_type" }
  );
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204, headers: getCorsHeaders(origin) }), origin);
  }
  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", 405, undefined, origin);
  }

  const expectedSecret = Deno.env.get("INDEXER_CRON_SECRET");
  if (expectedSecret) {
    const got = req.headers.get("x-cron-secret") ?? "";
    if (got !== expectedSecret) {
      return errorResponse("FORBIDDEN", 403, undefined, origin);
    }
  }

  const supabase = createServiceClient();

  const circlesRes = await supabase
    .from("circles")
    .select(
      "circle_id,contract_address,status,group_chat_id,name,n_members,current_cycle_index,onchain_phase,onchain_funded_count,onchain_due_at,onchain_grace_end_at,onchain_commit_end_at,onchain_reveal_end_at"
    )
    .not("contract_address", "is", null)
    .in("status", ["Recruiting", "Locked", "Active", "Terminated", "EmergencyStop", "Completed"]);

  if (circlesRes.error) {
    return errorResponse("DB_ERROR", 500, circlesRes.error.message, origin);
  }

  const results: { circle_id: string; ok: boolean; error?: string }[] = [];
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? null;

  for (const circle of circlesRes.data ?? []) {
    const contract = circle.contract_address as string | null;
    if (!contract) continue;

    const attemptIso = new Date().toISOString();

    try {
      // get_status (with retry and fallback)
      const statusExec = await runGetMethodWithRetry({ account: contract, method: "get_status", maxRetries: 3 });
      if (!statusExec || !statusExec.success) throw new Error("GET_STATUS_FAILED");
      const t = unwrapTuple(statusExec.stack);

      const statusCode = Number(readNumAt(t, 0));
      const cycleIndex = Number(readNumAt(t, 1));
      const phaseCode = Number(readNumAt(t, 2));
      const dueAt = readNumAt(t, 3);
      const graceEndAt = readNumAt(t, 4);
      const commitEndAt = readNumAt(t, 5);
      const revealEndAt = readNumAt(t, 6);
      const fundedCount = Number(readNumAt(t, 7));

      const statusText = statusToText(statusCode) ?? circle.status;
      const newDueIso = tsFromSeconds(dueAt);
      const newGraceIso = tsFromSeconds(graceEndAt);
      const newCommitIso = tsFromSeconds(commitEndAt);
      const newRevealIso = tsFromSeconds(revealEndAt);

      const prevPhase = Number((circle as any).onchain_phase ?? -1);
      const prevFunded = Number((circle as any).onchain_funded_count ?? -1);
      const prevCycle = Number((circle as any).current_cycle_index ?? -1);
      const prevStatus = String((circle as any).status ?? "");
      const prevDue = (circle as any).onchain_due_at ? String((circle as any).onchain_due_at) : null;
      const prevGrace = (circle as any).onchain_grace_end_at ? String((circle as any).onchain_grace_end_at) : null;
      const prevCommit = (circle as any).onchain_commit_end_at ? String((circle as any).onchain_commit_end_at) : null;
      const prevReveal = (circle as any).onchain_reveal_end_at ? String((circle as any).onchain_reveal_end_at) : null;

      const shouldUpdateProgress =
        statusText !== prevStatus ||
        cycleIndex !== prevCycle ||
        phaseCode !== prevPhase ||
        fundedCount !== prevFunded ||
        newDueIso !== prevDue ||
        newGraceIso !== prevGrace ||
        newCommitIso !== prevCommit ||
        newRevealIso !== prevReveal;

      // get_jetton_wallet (optional Address)
      const jettonExec = await runGetMethodWithRetry({ account: contract, method: "get_jetton_wallet", maxRetries: 2 });
      const jettonT = jettonExec && jettonExec.success ? unwrapTuple(jettonExec.stack) : [];
      const jettonWallet = jettonT.length ? readOptionalAddressFromStackRecord(jettonT[0])?.toString() ?? null : null;

      await supabase
        .from("circles")
        .update({
          status: statusText,
          current_cycle_index: cycleIndex,
          onchain_phase: phaseCode,
          onchain_funded_count: fundedCount,
          onchain_jetton_wallet: jettonWallet,
          onchain_due_at: newDueIso,
          onchain_grace_end_at: newGraceIso,
          onchain_commit_end_at: newCommitIso,
          onchain_reveal_end_at: newRevealIso,
          last_indexer_attempt_at: attemptIso,
          last_indexed_at: attemptIso,
          last_indexer_error: null,
        })
        .eq("circle_id", circle.circle_id);

      // Best-effort: keep a single "Progress" message edited over time (anti-spam).
      if (botToken && shouldUpdateProgress) {
        const groupChatId = Number((circle as any).group_chat_id ?? 0);
        const hasGroup = Number.isFinite(groupChatId) && groupChatId !== 0;

        if (hasGroup && (statusText === "Locked" || statusText === "Active")) {
          const text = renderProgressText({
            circleId: String(circle.circle_id),
            circleName: (circle as any).name ? String((circle as any).name) : null,
            status: statusText,
            cycleIndex,
            phaseCode,
            fundedCount,
            nMembers: Number((circle as any).n_members ?? 0),
            dueAt: newDueIso,
            graceEndAt: newGraceIso,
            commitEndAt: newCommitIso,
            revealEndAt: newRevealIso,
            contractAddress: contract,
          });
          await postOrEditProgressMessage({
            supabase,
            botToken,
            groupChatId,
            circleId: String(circle.circle_id),
            text,
          });
        }

        // Best-effort: one-time state-change notices.
        if (hasGroup && prevStatus !== statusText) {
          const base = [
            (circle as any).name ? `MoneyCircle — ${String((circle as any).name)}` : "MoneyCircle",
            `Circle: ${String(circle.circle_id)}`,
            contract ? `Contract: ${contract}` : null,
          ]
            .filter(Boolean)
            .join("\n");

          const appUrl = (Deno.env.get("MINIAPP_PUBLIC_URL") ?? "").trim();
          const withdrawUrl = appUrl ? `${appUrl.replace(/\\/$/, "")}/#/circle/${String(circle.circle_id)}/withdraw` : null;

          if (statusText === "Completed") {
            const text = [base, "Status: Completed", "", "Withdraw All is available in the Mini App.", withdrawUrl ? `Withdraw: ${withdrawUrl}` : null]
              .filter(Boolean)
              .join("\n");
            await postOnceBotMessage({
              supabase,
              botToken,
              groupChatId,
              circleId: String(circle.circle_id),
              messageType: "Settlement",
              text,
            });
          }

          if (statusText === "Terminated") {
            const text = [base, "Status: Terminated (default)", "", "Withdraw All is available in the Mini App.", withdrawUrl ? `Withdraw: ${withdrawUrl}` : null]
              .filter(Boolean)
              .join("\n");
            await postOnceBotMessage({
              supabase,
              botToken,
              groupChatId,
              circleId: String(circle.circle_id),
              messageType: "Default",
              text,
            });
          }

          if (statusText === "EmergencyStop") {
            const text = [base, "Status: Emergency Stop", "", "Operations are frozen by rules. Withdraw All is available in the Mini App.", withdrawUrl ? `Withdraw: ${withdrawUrl}` : null]
              .filter(Boolean)
              .join("\n");
            await postOnceBotMessage({
              supabase,
              botToken,
              groupChatId,
              circleId: String(circle.circle_id),
              messageType: "Emergency",
              text,
            });
          }
        }
      }

      // Load current DB wallet map for this circle (wallet -> telegram_user_id)
      const membersDb = await supabase
        .from("circle_members")
        .select("telegram_user_id,wallet_address,join_status")
        .eq("circle_id", circle.circle_id)
        .not("wallet_address", "is", null);
      if (membersDb.error) throw new Error("DB_MEMBERS_FAILED");

      const dbRows = (membersDb.data ?? []).map((m) => {
        const wallet = String(m.wallet_address ?? "");
        return {
          telegram_user_id: Number(m.telegram_user_id),
          join_status: String(m.join_status),
          wallet_address: wallet,
          wallet_key: addressKey(wallet),
        };
      });

      // Normalize by raw address so bounceable/testOnly encodings won't break matching.
      const walletToRows = new Map<string, { telegram_user_id: number; join_status: string }[]>();
      for (const r of dbRows) {
        if (!r.wallet_key) continue;
        if (!walletToRows.has(r.wallet_key)) walletToRows.set(r.wallet_key, []);
        walletToRows.get(r.wallet_key)!.push({ telegram_user_id: r.telegram_user_id, join_status: r.join_status });
      }

      // get_members_count + member_list
      const countExec = await runGetMethodWithRetry({ account: contract, method: "get_members_count", maxRetries: 2 });
      if (!countExec || !countExec.success) throw new Error("GET_MEMBERS_COUNT_FAILED");
      const countT = unwrapTuple(countExec.stack);
      const count = Number(readNumAt(countT, 0));

      // Track wallets that are on-chain for marking join_tickets.used
      const onchainWalletKeys: string[] = [];
      const onchainUserIds = new Set<number>();

      for (let i = 0; i < count; i++) {
        const addrExec = await runGetMethodWithRetry({
          account: contract,
          method: "get_member_at",
          args: [String(i)],
          maxRetries: 2,
        });
        if (!addrExec || !addrExec.success) continue;
        const addrT = unwrapTuple(addrExec.stack);
        const wallet = readAddressFromStackRecord(addrT[0]);
        const walletAddr = wallet.toString();
        const walletKey = wallet.toRawString();

        onchainWalletKeys.push(walletKey);

        const rows = walletToRows.get(walletKey);
        if (!rows || rows.length === 0) continue;

        const viewExec = await runGetMethodWithRetry({
          account: contract,
          method: "get_member",
          args: [walletAddr],
          maxRetries: 2,
        });
        if (!viewExec || !viewExec.success) continue;
        const mv = unwrapTuple(viewExec.stack);

        // MemberView: active, has_won, collateral, prefund, credit, vesting_locked, vesting_released, future_locked, withdrawable, due_remaining
        const hasWon = readNumAt(mv, 1) !== 0n;
        const collateral = readNumAt(mv, 2).toString();
        const prefund = readNumAt(mv, 3).toString();
        const credit = readNumAt(mv, 4).toString();
        const vestingLocked = readNumAt(mv, 5).toString();
        const vestingReleased = readNumAt(mv, 6).toString();
        const futureLocked = readNumAt(mv, 7).toString();
        const withdrawable = readNumAt(mv, 8).toString();
        const dueRemaining = readNumAt(mv, 9).toString();

        // Update all matching rows (should be 1 row in MVP)
        for (const r of rows) {
          onchainUserIds.add(r.telegram_user_id);

          await supabase
            .from("circle_members")
            .update({
              join_status: "onchain_joined",
              has_won: hasWon,
              collateral,
              prefund,
              credit,
              vesting_locked: vestingLocked,
              vesting_released: vestingReleased,
              future_locked: futureLocked,
              withdrawable,
              due_remaining: dueRemaining,
            })
            .eq("circle_id", circle.circle_id)
            .eq("telegram_user_id", r.telegram_user_id);
        }
      }

      // Downgrade stale rows that claim "onchain_joined" but are not in member_list anymore.
      // This prevents backend from allowing deposits to wallets the contract will ignore.
      const onchainSet = new Set(onchainWalletKeys);
      for (const r of dbRows) {
        if (r.join_status !== "onchain_joined") continue;
        if (!r.wallet_key) continue;
        if (onchainSet.has(r.wallet_key)) continue;
        await supabase
          .from("circle_members")
          .update({
            join_status: "exited",
            has_won: false,
            collateral: "0",
            prefund: "0",
            credit: "0",
            vesting_locked: "0",
            vesting_released: "0",
            future_locked: "0",
            withdrawable: "0",
            due_remaining: "0",
          })
          .eq("circle_id", circle.circle_id)
          .eq("telegram_user_id", r.telegram_user_id);
      }

      // Mark join_tickets as used for all users that are on-chain.
      if (onchainUserIds.size > 0) {
        await supabase
          .from("join_tickets")
          .update({ used: true })
          .eq("circle_id", circle.circle_id)
          .in("telegram_user_id", Array.from(onchainUserIds))
          .eq("used", false);
      }

      results.push({ circle_id: circle.circle_id, ok: true });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`[INDEXER_SYNC_ERROR] circle=${circle.circle_id}`, errorMsg);
      // Best-effort: record error for ops monitoring (do not change last_indexed_at).
      await supabase
        .from("circles")
        .update({ last_indexer_attempt_at: attemptIso, last_indexer_error: errorMsg })
        .eq("circle_id", circle.circle_id);
      results.push({ circle_id: circle.circle_id, ok: false, error: errorMsg });
    }
  }

  return jsonResponse({ ok: true, results }, 200, origin);
});
