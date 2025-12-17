import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function tg(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {})
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    const retryAfter = json?.parameters?.retry_after;
    const err = new Error(json?.description ?? "TG_API_ERROR");
    err.code = json?.error_code;
    err.retryAfter = retryAfter;
    throw err;
  }
  return json.result;
}

async function safeSendMessage(chatId, text, opts = {}) {
  try {
    return await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...opts });
  } catch (e) {
    const retryAfter = e?.retryAfter;
    if (e?.code === 429 && typeof retryAfter === "number") {
      await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
      return await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...opts });
    }
    throw e;
  }
}

function parseCommand(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [first, ...rest] = trimmed.split(/\s+/);
  const cmd = first.split("@")[0].slice(1).toLowerCase();
  return { cmd, args: rest };
}

function renderCircleLine(c) {
  const name = c.name ? ` — ${c.name}` : "";
  const addr = c.contract_address ? `\nContract: ${c.contract_address}` : "";
  return `• ${c.circle_id}${name}\nStatus: ${c.status}${addr}`;
}

function renderCircleStatus(c) {
  const name = c.name ? ` — ${c.name}` : "";
  return [
    `MoneyCircle${name}`,
    `Status: ${c.status}`,
    c.contract_address ? `Contract: ${c.contract_address}` : `Contract: (not attached yet)`,
    c.onchain_due_at ? `Due: ${c.onchain_due_at}` : null,
    c.onchain_grace_end_at ? `Grace ends: ${c.onchain_grace_end_at}` : null,
    c.onchain_commit_end_at ? `Commit ends: ${c.onchain_commit_end_at}` : null,
    c.onchain_reveal_end_at ? `Reveal ends: ${c.onchain_reveal_end_at}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

async function listCircles(chatId) {
  const { data, error } = await supabase
    .from("circles")
    .select("circle_id,name,status,contract_address,onchain_due_at,onchain_grace_end_at,onchain_commit_end_at,onchain_reveal_end_at,created_at")
    .eq("group_chat_id", chatId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function getCircle(circleId) {
  const { data, error } = await supabase
    .from("circles")
    .select("circle_id,name,status,contract_address,onchain_due_at,onchain_grace_end_at,onchain_commit_end_at,onchain_reveal_end_at")
    .eq("circle_id", circleId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function handleMessage(msg) {
  const text = msg.text ?? "";
  const cmd = parseCommand(text);
  if (!cmd) return;

  const chatId = msg.chat?.id;
  const chatType = msg.chat?.type;
  if (!chatId) return;

  if (cmd.cmd === "start") {
    await safeSendMessage(chatId, "MoneyCircle bot is running.\nUse /help for commands.");
    return;
  }

  if (cmd.cmd === "help") {
    await safeSendMessage(
      chatId,
      [
        "MoneyCircle commands:",
        "/circle — list circles for this group",
        "/status [circle_id] — show circle status and on-chain timestamps",
        "",
        "This bot uses neutral reminders (no shaming) and avoids @mentions by default."
      ].join("\n")
    );
    return;
  }

  // Group-only commands
  if (chatType !== "group" && chatType !== "supergroup") {
    await safeSendMessage(chatId, "Open this command in the MoneyCircle group.");
    return;
  }

  if (cmd.cmd === "circle") {
    const circles = await listCircles(chatId);
    if (circles.length === 0) {
      await safeSendMessage(chatId, "No circles found for this group yet.");
      return;
    }
    const recruiting = circles.filter((c) => c.status === "Recruiting");
    const active = circles.filter((c) => c.status === "Active" || c.status === "Locked");
    const past = circles.filter((c) => !active.includes(c) && !recruiting.includes(c));

    const parts = [];
    if (active.length) parts.push("Active/Locked:\n" + active.map(renderCircleLine).join("\n\n"));
    if (recruiting.length) parts.push("Recruiting:\n" + recruiting.map(renderCircleLine).join("\n\n"));
    if (past.length) parts.push("Past:\n" + past.map(renderCircleLine).join("\n\n"));

    await safeSendMessage(chatId, parts.join("\n\n"));
    return;
  }

  if (cmd.cmd === "status") {
    const circleId = cmd.args?.[0];
    if (circleId) {
      const c = await getCircle(circleId);
      await safeSendMessage(chatId, renderCircleStatus(c));
      return;
    }
    const circles = await listCircles(chatId);
    const active = circles.find((c) => c.status === "Active" || c.status === "Locked") ?? circles[0];
    await safeSendMessage(chatId, renderCircleStatus(active));
    return;
  }
}

async function main() {
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await tg("getUpdates", { timeout: 30, offset });
      for (const u of updates ?? []) {
        offset = u.update_id + 1;
        if (u.message) {
          await handleMessage(u.message).catch(() => {});
        }
      }
    } catch (e) {
      const retryAfter = e?.retryAfter;
      if (e?.code === 429 && typeof retryAfter === "number") {
        await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
