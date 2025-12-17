import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { TonConnectButton, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { Address } from "@ton/core";

import { getCircleStatus } from "../lib/api";
import type { ApiError, CircleStatusResponse } from "../lib/api";
import { formatUsdt, parseUsdtToUnits } from "../lib/usdt";
import { buildBidCommitHash, buildCommitBody, buildRevealBody, randomU256 } from "../lib/ton";
import { Page } from "../components/layout/Page";
import { FundsBanner } from "../components/mc/FundsBanner";
import { IndexerLagBanner } from "../components/mc/IndexerLagBanner";
import { OnChainScheduleCard } from "../components/mc/OnChainScheduleCard";
import { Button } from "../components/ui/Button";
import { Card, CardDescription, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { useSessionToken } from "../auth/useSessionToken";
import { describeError } from "../lib/errors";

function diffText(targetIso: string | null, nowSec: number): string {
  if (!targetIso) return "—";
  const target = Math.floor(Date.parse(targetIso) / 1000);
  if (!Number.isFinite(target)) return "—";
  const d = Math.max(0, target - nowSec);
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function AuctionPage() {
  const token = useSessionToken();
  const { circleId } = useParams();
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonAddress(false);

  const [data, setData] = React.useState<CircleStatusResponse | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [payout, setPayout] = React.useState("");
  const [nowSec, setNowSec] = React.useState<number>(() => Math.floor(Date.now() / 1000));
  const humanError = error ? describeError(error) : null;

  React.useEffect(() => {
    if (!circleId) return;
    getCircleStatus(token, circleId)
      .then(setData)
      .catch((e: unknown) => {
        const maybe = (e ?? {}) as { code?: unknown; message?: unknown };
        const code = typeof maybe.code === "string" ? maybe.code : "FAILED";
        const msg = typeof maybe.message === "string" ? maybe.message : undefined;
        setError({ code, message: msg });
      });
  }, [token, circleId]);

  React.useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!circleId) return <Page title="Auction">Missing circle id</Page>;
  const circle = data?.circle;
  const member = data?.member ?? null;

  const pot = circle ? BigInt(circle.n_members) * BigInt(circle.contribution_units) : 0n;
  const minPayout = circle ? (pot * BigInt(10_000 - Number(circle.max_discount_bps))) / 10_000n : 0n;

  const commitEnd = circle?.onchain_commit_end_at ?? null;
  const revealEnd = circle?.onchain_reveal_end_at ?? null;

  const commitEndSec = commitEnd ? Math.floor(Date.parse(commitEnd) / 1000) : 0;
  const revealEndSec = revealEnd ? Math.floor(Date.parse(revealEnd) / 1000) : 0;
  const now = nowSec;

  const stage = commitEndSec && now < commitEndSec ? "commit" : revealEndSec && now < revealEndSec ? "reveal" : "closed";
  const cannotBid = Boolean(member?.has_won);

  async function onCommit() {
    setError(null);
    try {
      if (!circle?.contract_address) throw new Error("CONTRACT_NOT_READY");
      if (!wallet) throw new Error("WALLET_NOT_CONNECTED");
      if (member?.wallet_address) {
        try {
          if (!Address.parse(wallet).equals(Address.parse(String(member.wallet_address)))) {
            throw new Error("WALLET_MISMATCH");
          }
        } catch {
          // ignore and let contract reject
        }
      }

      const payoutUnits = parseUsdtToUnits(payout);
      if (payoutUnits < minPayout || payoutUnits > pot) throw new Error("BID_OUT_OF_BOUNDS");

      const salt = randomU256();
      const commitHash = buildBidCommitHash({
        contractAddress: circle.contract_address,
        cycleIndex: Number(circle.current_cycle_index),
        walletAddress: wallet,
        payoutWantedUnits: payoutUnits,
        salt
      });

      localStorage.setItem(`mc_bid_${circleId}`, JSON.stringify({ payout: payoutUnits.toString(), salt: salt.toString() }));

      const payload = buildCommitBody(commitHash);
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address: circle.contract_address, amount: "200000000", payload }]
      });
    } catch (e: unknown) {
      const maybe = (e ?? {}) as { message?: unknown };
      const msg = typeof maybe.message === "string" ? maybe.message : "FAILED";
      if (msg === "CONTRACT_NOT_READY" || msg === "WALLET_NOT_CONNECTED" || msg === "BID_OUT_OF_BOUNDS" || msg === "WALLET_MISMATCH") {
        setError({ code: msg });
      } else {
        setError({ code: "TX_FAILED", message: msg });
      }
    }
  }

  async function onReveal() {
    setError(null);
    try {
      if (!circle?.contract_address) throw new Error("CONTRACT_NOT_READY");
      if (!wallet) throw new Error("WALLET_NOT_CONNECTED");
      if (member?.wallet_address) {
        try {
          if (!Address.parse(wallet).equals(Address.parse(String(member.wallet_address)))) {
            throw new Error("WALLET_MISMATCH");
          }
        } catch {
          // ignore and let contract reject
        }
      }
      const raw = localStorage.getItem(`mc_bid_${circleId}`);
      if (!raw) throw new Error("MISSING_BID_DATA");
      const parsed = JSON.parse(raw) as { payout: string; salt: string };

      const payload = buildRevealBody(BigInt(parsed.payout), BigInt(parsed.salt));
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address: circle.contract_address, amount: "200000000", payload }]
      });
    } catch (e: unknown) {
      const maybe = (e ?? {}) as { message?: unknown };
      const msg = typeof maybe.message === "string" ? maybe.message : "FAILED";
      if (msg === "MISSING_BID_DATA") {
        setError({ code: "MISSING_BID_DATA", message: "You need your saved bid data to reveal. Please contact support if you lost it." });
      } else if (msg === "CONTRACT_NOT_READY" || msg === "WALLET_NOT_CONNECTED" || msg === "WALLET_MISMATCH") {
        setError({ code: msg });
      } else {
        setError({ code: "TX_FAILED", message: msg });
      }
    }
  }

  return (
    <Page title="Auction">
      <div className="space-y-4">
        <FundsBanner />
        <IndexerLagBanner circle={circle ?? null} />

        <div className="flex items-center justify-between gap-3">
          <Link to={`/circle/${circleId}`} className="text-sm text-slate-300 hover:text-slate-50">
            ← Back
          </Link>
          <TonConnectButton />
        </div>

        {!circle ? (
          <Card>
            <CardTitle>Loading…</CardTitle>
            <CardDescription>Fetching on-chain mirror.</CardDescription>
          </Card>
        ) : (
          <Card>
            <CardTitle>{stage === "commit" ? "Blind Auction — Commit" : stage === "reveal" ? "Blind Auction — Reveal" : "Auction"}</CardTitle>
            <CardDescription>
              Commit ends in: {diffText(commitEnd, nowSec)} · Reveal ends in: {diffText(revealEnd, nowSec)}
            </CardDescription>

            <div className="mt-4 space-y-3 text-sm text-slate-200">
              <div className="rounded-xl bg-slate-950/40 p-3 ring-1 ring-slate-800 text-sm text-slate-300">
                <div>Commit ends: {commitEnd ?? "—"}</div>
                <div>Reveal ends: {revealEnd ?? "—"}</div>
              </div>

              <div className="rounded-xl bg-slate-950/40 p-3 ring-1 ring-slate-800 text-slate-300">
                In each cycle, one member receives the pot.
                <br />
                You place a blind bid by entering <span className="font-semibold">“How much do you want to receive?”</span>
                <br />
                The person willing to receive the least wins the cycle.
                <br />
                The difference becomes credits for other members (reduces their next payment).
              </div>

              {stage === "commit" ? (
                <>
                  {cannotBid ? (
                    <div className="text-sm text-slate-300">
                      You already won a previous cycle. In MVP, each member can win at most once.
                    </div>
                  ) : null}
                  <div className="text-sm text-slate-300">
                    Minimum: {formatUsdt(minPayout)} · Maximum: {formatUsdt(pot)}
                  </div>
                  <Input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="How much do you want to receive? (USDT)" inputMode="decimal" />
                  <Button onClick={onCommit} disabled={!tonConnectUI.connected || cannotBid}>
                    Commit Bid
                  </Button>
                </>
              ) : null}

              {stage === "reveal" ? (
                <Button onClick={onReveal} disabled={!tonConnectUI.connected}>
                  Reveal Bid
                </Button>
              ) : null}

              {stage === "closed" ? <div className="text-slate-300">Auction window is closed.</div> : null}
            </div>
          </Card>
        )}

        {circle ? <OnChainScheduleCard circle={circle} /> : null}

        {error && humanError ? (
          <Card>
            <CardTitle>{humanError.title}</CardTitle>
            <CardDescription>
              {humanError.description}
              <div className="mt-2 text-xs text-slate-500">Code: {error.code}</div>
            </CardDescription>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
