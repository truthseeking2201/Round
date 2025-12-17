import { TonConnectButton, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { Address } from "@ton/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { ApiError, CircleStatusResponse, JoinTicketResponse } from "../lib/api";
import { acceptRules, getCircleStatus, joinCircle, joinTicket, walletBindChallenge, walletBindConfirm } from "../lib/api";
import { useAuth } from "../auth/useAuth";
import { buildJoinWithTicketPayload, toNano } from "../lib/tonPayloads";
import { Page } from "../components/layout/Page";
import { FundsBanner } from "../components/mc/FundsBanner";
import { IndexerLagBanner } from "../components/mc/IndexerLagBanner";
import { OnChainScheduleCard } from "../components/mc/OnChainScheduleCard";
import { Button } from "../components/ui/Button";
import { Card, CardDescription, CardTitle } from "../components/ui/Card";
import { describeError } from "../lib/errors";
import { formatUsdt } from "../lib/usdt";

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Step = "join_db" | "accept_rules" | "wallet_verify" | "ticket" | "submit" | "done";

function intervalLabel(intervalSec: unknown): string {
  const s = Number(intervalSec);
  if (!Number.isFinite(s) || s <= 0) return "—";
  // MVP: weekly (7d) or monthly (30d)
  return s >= 20 * 24 * 3600 ? "Monthly" : "Weekly";
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function parseJoinTicket(raw: string): JoinTicketResponse | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.wallet !== "string") return null;
    if (typeof o.exp !== "number") return null;
    if (typeof o.nonce !== "string") return null;
    if (typeof o.sig !== "string") return null;
    if (typeof o.contract_address !== "string") return null;
    return o as JoinTicketResponse;
  } catch {
    return null;
  }
}

export function JoinPage() {
  const auth = useAuth();
  const params = useParams();
  const nav = useNavigate();
  const circleId = String(params.circleId ?? "");

  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();

  const [data, setData] = useState<CircleStatusResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const humanError = error ? describeError(error) : null;
  const [rulesChecked, setRulesChecked] = useState<boolean>(false);
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [ticket, setTicket] = useState<JoinTicketResponse | null>(null);

  const circle = data?.circle ?? null;
  const member = data?.member ?? null;

  const step: Step = useMemo(() => {
    if (!member) return "join_db";
    const js = String(member.join_status ?? "joined");
    if (js === "joined") return "accept_rules";
    if (js === "accepted_rules") return "wallet_verify";
    if (js === "wallet_verified") return "ticket";
    if (js === "ticket_issued") return "submit";
    if (js === "onchain_joined") return "done";
    if (js === "exited") return "join_db";
    return "accept_rules";
  }, [member]);

  const refresh = async () => {
    if (auth.status !== "ready" || !circleId) return;
    try {
      const res = await getCircleStatus(auth.token, circleId);
      setData(res);
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "API_ERROR", message: err.message });
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, circleId]);

  useEffect(() => {
    const raw = sessionStorage.getItem(`mc_ticket:${circleId}`);
    setTicket(raw ? parseJoinTicket(raw) : null);
  }, [circleId]);

  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ensureDbJoin = async () => {
    if (auth.status !== "ready") return;
    setBusy("Joining…");
    setError(null);
    try {
      await joinCircle(auth.token, circleId);
      await refresh();
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "API_ERROR", message: err.message });
    } finally {
      setBusy(null);
    }
  };

  const doAcceptRules = async () => {
    if (auth.status !== "ready") return;
    if (!rulesChecked) {
      setError({ code: "RULES_NOT_ACCEPTED", message: "Please confirm you understand and accept the rules." });
      return;
    }
    setBusy("Accepting…");
    setError(null);
    try {
      const now = Math.floor(Date.now() / 1000);
      const tgId = String(auth.user.telegram_user_id);
      const msg = `MC_RULES_ACCEPT|${circleId}|${tgId}|${now}`;
      const h = await sha256Hex(msg);
      await acceptRules(auth.token, circleId, h);
      await refresh();
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "API_ERROR", message: err.message });
    } finally {
      setBusy(null);
    }
  };

  const doWalletVerify = async () => {
    if (auth.status !== "ready") return;
    if (!wallet) {
      setError({ code: "WALLET_NOT_CONNECTED", message: "Connect wallet first." });
      return;
    }
    setBusy("Requesting challenge…");
    setError(null);
    try {
      const ch = await walletBindChallenge(auth.token, circleId);
      setBusy("Signing…");
      const signRes = await tonConnectUI.signData({ type: "text", text: ch.message_to_sign });
      setBusy("Verifying…");
      await walletBindConfirm(auth.token, circleId, signRes);
      await refresh();
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "WALLET_PROOF_INVALID", message: err.message });
    } finally {
      setBusy(null);
    }
  };

  const doTicket = async () => {
    if (auth.status !== "ready") return;
    setBusy("Issuing ticket…");
    setError(null);
    try {
      const t = await joinTicket(auth.token, circleId);
      setBusy(null);
      // Store ticket locally for submit step
      sessionStorage.setItem(`mc_ticket:${circleId}`, JSON.stringify(t));
      setTicket(t);
      await refresh();
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "API_ERROR", message: err.message });
      setBusy(null);
    }
  };

  const doSubmitOnChain = async () => {
    if (!wallet) {
      setError({ code: "WALLET_NOT_CONNECTED", message: "Connect wallet first." });
      return;
    }
    if (!circle?.contract_address) {
      setError({ code: "CONTRACT_NOT_READY", message: "Contract address is not attached yet." });
      return;
    }
    if (!ticket) {
      setError({ code: "TICKET_MISSING", message: "Issue a join ticket first." });
      return;
    }
    try {
      const connected = String(wallet.account.address ?? "");
      if (connected && ticket.wallet) {
        // Normalize to avoid bounceable formatting differences.
        const a = Address.parse(connected);
        const b = Address.parse(ticket.wallet);
        if (!a.equals(b)) {
          setError({ code: "WALLET_MISMATCH", message: "Connected wallet does not match the ticket wallet." });
          return;
        }
      }
    } catch {
      // If parsing fails, proceed and let the contract reject (safest behavior).
    }
    setBusy("Sending join tx…");
    setError(null);
    try {
      const payload = buildJoinWithTicketPayload(ticket);
      const tx = await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
        messages: [
          {
            address: circle.contract_address,
            amount: toNano("0.05"),
            payload
          }
        ]
      });
      sessionStorage.setItem(`mc_last_join_tx:${circleId}`, JSON.stringify(tx));
      setBusy(null);
      // Back to dashboard to refresh
      nav(`/circle/${circleId}`);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError({ code: "TX_FAILED", message: err?.message ?? "Transaction failed" });
      setBusy(null);
    }
  };

  const expiresInSec = ticket ? ticket.exp - nowSec : 0;
  const ticketExpired = !!ticket && expiresInSec <= 0;

  return (
    <Page title="Join Circle">
      <div className="space-y-4">
        <FundsBanner />
        <IndexerLagBanner circle={circle} />

        <div className="flex items-center justify-between gap-3">
          <Link to={`/circle/${circleId}`} className="text-sm text-slate-300 hover:text-slate-50">
            ← Back
          </Link>
          <TonConnectButton />
        </div>

        {error && humanError ? (
          <Card>
            <CardTitle>{humanError.title}</CardTitle>
            <CardDescription>
              {humanError.description}
              <div className="mt-2 text-xs text-slate-500">Code: {error.code}</div>
            </CardDescription>
          </Card>
        ) : null}

        {circle ? (
          <Card>
            <CardTitle>{circle.name ?? circle.circle_id}</CardTitle>
            <CardDescription className="mt-1">
              N={circle.n_members} · C={formatUsdt(BigInt(circle.contribution_units))} USDT · Interval: {intervalLabel(circle.interval_sec)}
              <br />
              Status: {String(circle.status)} · Contract: <code className="text-slate-200">{circle.contract_address ?? "(not attached yet)"}</code>
            </CardDescription>
          </Card>
        ) : (
          <Card>
            <CardTitle>Loading…</CardTitle>
            <CardDescription>Fetching on-chain mirror.</CardDescription>
          </Card>
        )}

        {circle ? <OnChainScheduleCard circle={circle} /> : null}

        <Card>
          <CardTitle>15-second explanation</CardTitle>
          <CardDescription className="mt-2">
            In each cycle, one member receives the pot.
            <br />
            You place a blind bid by entering <span className="font-semibold">“How much do you want to receive?”</span>
            <br />
            The person willing to receive the least wins.
            <br />
            The difference becomes credits for other members (reduces their next payment).
          </CardDescription>
        </Card>

        <Card>
          <CardTitle>Next step</CardTitle>
          <CardDescription className="mt-1">Current step: {step}</CardDescription>

          {busy ? <div className="mt-3 text-sm text-slate-300">{busy}</div> : null}

          <div className="mt-4 grid gap-2">
            {step === "join_db" ? (
              <Button onClick={() => void ensureDbJoin()} disabled={!!busy}>
                Join Circle
              </Button>
            ) : null}

            {step === "accept_rules" ? (
              <>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={rulesChecked} onChange={(e) => setRulesChecked(e.target.checked)} />
                  <span>I understand and accept the rules.</span>
                </label>
                <Button onClick={() => void doAcceptRules()} disabled={!!busy || !rulesChecked}>
                  Continue
                </Button>
              </>
            ) : null}

            {step === "wallet_verify" ? (
              <Button onClick={() => void doWalletVerify()} disabled={!!busy}>
                Sign to verify wallet ownership
              </Button>
            ) : null}

            {step === "ticket" ? (
              <Button onClick={() => void doTicket()} disabled={!!busy}>
                Get join ticket
              </Button>
            ) : null}

            {step === "submit" ? (
              <>
                <div className="text-sm text-slate-300">Ticket expires in: {ticket ? mmss(expiresInSec) : "—"}</div>
                <Button onClick={() => void doSubmitOnChain()} disabled={!!busy || ticketExpired}>
                  Submit Join On-chain
                </Button>
                {ticketExpired ? (
                  <Button variant="secondary" onClick={() => void doTicket()} disabled={!!busy}>
                    Get a new ticket
                  </Button>
                ) : null}
              </>
            ) : null}

            {step === "done" ? (
              <>
                <div className="text-sm text-slate-300">You are already joined on-chain.</div>
                <Button onClick={() => nav(`/circle/${circleId}`)} disabled={!!busy}>
                  Back to Dashboard
                </Button>
              </>
            ) : null}
          </div>
        </Card>
      </div>
    </Page>
  );
}
