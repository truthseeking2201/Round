import { TonConnectButton, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { Address } from "@ton/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type { ApiError, CircleStatusResponse } from "../lib/api";
import { getCircleStatus } from "../lib/api";
import { useAuth } from "../auth/useAuth";
import { buildInitJettonWalletPayload, buildWithdrawPayload, toNano } from "../lib/tonPayloads";
import { Page } from "../components/layout/Page";
import { FundsBanner } from "../components/mc/FundsBanner";
import { IndexerLagBanner } from "../components/mc/IndexerLagBanner";
import { OnChainScheduleCard } from "../components/mc/OnChainScheduleCard";
import { Button } from "../components/ui/Button";
import { Card, CardDescription, CardTitle } from "../components/ui/Card";
import { formatUsdt } from "../lib/usdt";
import { describeError } from "../lib/errors";

type WithdrawMode = 1 | 2 | 3;

function toBigIntSafe(v: unknown): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    if (typeof v === "string" && v.trim() !== "") return BigInt(v);
    return 0n;
  } catch {
    return 0n;
  }
}

export function WithdrawPage() {
  const auth = useAuth();
  const params = useParams();
  const circleId = String(params.circleId ?? "");

  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();

  const [data, setData] = useState<CircleStatusResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const humanError = error ? describeError(error) : null;

  const circle = data?.circle ?? null;
  const member = data?.member ?? null;

  const refresh = async () => {
    if (auth.status !== "ready") return;
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

  const allowed: WithdrawMode[] = useMemo(() => {
    if (!circle) return [];
    const isOnchainJoined = String(member?.join_status ?? "") === "onchain_joined";
    if (circle.status === "Recruiting") {
      return isOnchainJoined ? [3] : [];
    }
    if (circle.status === "Active") {
      const w = toBigIntSafe(member?.withdrawable);
      return isOnchainJoined && w > 0n ? [1] : [];
    }
    if (circle.status === "Completed" || circle.status === "Terminated" || circle.status === "EmergencyStop") {
      const vestingUnreleased = (() => {
        const locked = toBigIntSafe(member?.vesting_locked);
        const released = toBigIntSafe(member?.vesting_released);
        return locked > released ? locked - released : 0n;
      })();
      const totalAll =
        toBigIntSafe(member?.collateral) +
        toBigIntSafe(member?.prefund) +
        toBigIntSafe(member?.credit) +
        toBigIntSafe(member?.withdrawable) +
        toBigIntSafe(member?.future_locked) +
        vestingUnreleased;
      return isOnchainJoined && totalAll > 0n ? [2] : [];
    }
    return [];
  }, [circle, member]);

  const doWithdraw = async (mode: WithdrawMode) => {
    if (!wallet) {
      setError({ code: "WALLET_NOT_CONNECTED", message: "Connect wallet first." });
      return;
    }
    try {
      const connected = String(wallet.account.address ?? "");
      const bound = String(member?.wallet_address ?? "");
      if (connected && bound && !Address.parse(connected).equals(Address.parse(bound))) {
        setError({ code: "WALLET_MISMATCH", message: "Switch to your bound wallet and retry." });
        return;
      }
    } catch {
      // If parsing fails, proceed and let the contract reject (safest behavior).
    }
    if (!circle?.contract_address) {
      setError({ code: "CONTRACT_NOT_READY", message: "Contract address is not attached yet." });
      return;
    }
    setBusy("Sending withdraw tx…");
    setError(null);
    try {
      const confirmCopy =
        mode === 1
          ? "This will withdraw only your Withdrawable Now amount. Other funds remain locked by rules."
          : mode === 3
            ? (() => {
                const dep = toBigIntSafe(member?.collateral) + toBigIntSafe(member?.prefund);
                return dep > 0n
                  ? "This will exit the circle and refund your deposits. You will no longer be a participant."
                  : "This will exit the circle. You have no deposits to refund, and you will no longer be a participant.";
              })()
            : "This will withdraw all remaining balances.";
      if (!window.confirm(confirmCopy)) {
        setBusy(null);
        return;
      }

      const payload = buildWithdrawPayload(mode);
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
        messages: [
          {
            address: circle.contract_address,
            amount: toNano("0.05"),
            payload
          }
        ]
      });
      setBusy(null);
      await refresh();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError({ code: "TX_FAILED", message: err?.message ?? "Transaction failed" });
      setBusy(null);
    }
  };

  return (
    <Page title="Withdraw">
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
              Status: {circle.status} · Contract: <code className="text-slate-200">{circle.contract_address ?? "(not attached yet)"}</code>
            </CardDescription>

            {circle.contract_address && !circle.onchain_jetton_wallet ? (
              <div className="mt-4">
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (!wallet) {
                      setError({ code: "WALLET_NOT_CONNECTED", message: "Connect wallet first." });
                      return;
                    }
                    if (!window.confirm("Initialize the contract Jetton wallet (required once)?")) return;
                    setBusy("Sending INIT…");
                    setError(null);
                    try {
                      await tonConnectUI.sendTransaction({
                        validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
                        messages: [
                          {
                            address: String(circle.contract_address),
                            amount: toNano("0.05"),
                            payload: buildInitJettonWalletPayload()
                          }
                        ]
                      });
                    } catch (e: unknown) {
                      const err = e as { message?: string };
                      setError({ code: "TX_FAILED", message: err?.message ?? "Transaction failed" });
                    } finally {
                      setBusy(null);
                      await refresh();
                    }
                  }}
                  disabled={!!busy}
                >
                  Init Jetton Wallet (required once)
                </Button>
              </div>
            ) : null}
          </Card>
        ) : (
          <Card>
            <CardTitle>Loading…</CardTitle>
            <CardDescription>Fetching on-chain mirror.</CardDescription>
          </Card>
        )}

        {circle ? <OnChainScheduleCard circle={circle} /> : null}

        {member ? (
          <Card>
            <CardTitle>Your Balances (On-chain)</CardTitle>
            <div className="mt-3 space-y-1 text-sm text-slate-300">
              <div className="font-semibold text-slate-100">Withdrawable Now: {formatUsdt(toBigIntSafe(member.withdrawable))} USDT</div>
              <div>Collateral: {formatUsdt(toBigIntSafe(member.collateral))} USDT</div>
              <div>Prefund: {formatUsdt(toBigIntSafe(member.prefund))} USDT</div>
              <div>Credit: {formatUsdt(toBigIntSafe(member.credit))} USDT</div>
              <div>Vesting Locked: {formatUsdt(toBigIntSafe(member.vesting_locked))} USDT</div>
              <div>Locked for Future Payments: {formatUsdt(toBigIntSafe(member.future_locked))} USDT</div>
            </div>
          </Card>
        ) : null}

        {busy ? (
          <div className="text-sm text-slate-300">{busy}</div>
        ) : (
          <div className="text-sm text-slate-400">
            Active: withdraw only Withdrawable Now. Recruiting: Exit & Refund. Completed/Terminated/EmergencyStop: Withdraw All.
          </div>
        )}

        <div className="grid gap-2">
          {allowed.includes(1) ? (
            <Button onClick={() => void doWithdraw(1)} disabled={!!busy}>
              Withdraw Now
            </Button>
          ) : null}
          {allowed.includes(2) ? (
            <Button onClick={() => void doWithdraw(2)} disabled={!!busy}>
              Withdraw All
            </Button>
          ) : null}
          {allowed.includes(3) ? (
            <Button variant="danger" onClick={() => void doWithdraw(3)} disabled={!!busy}>
              Exit & Refund
            </Button>
          ) : null}
          {allowed.length === 0 ? (
            <Card>
              <CardTitle>Withdraw not available</CardTitle>
              <CardDescription>Nothing withdrawable in the current state, or you have zero balance.</CardDescription>
            </Card>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
