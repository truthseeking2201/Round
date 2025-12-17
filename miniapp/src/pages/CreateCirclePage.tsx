import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ApiError } from "../lib/api";
import { createCircle } from "../lib/api";
import { useAuth } from "../auth/useAuth";
import { describeError } from "../lib/errors";

export function CreateCirclePage() {
  const auth = useAuth();
  const nav = useNavigate();

  const [name, setName] = useState<string>("");
  const [nMembers, setNMembers] = useState<number>(6);
  const [contribution, setContribution] = useState<string>("10");
  const [interval, setInterval] = useState<"weekly" | "monthly">("weekly");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const humanError = error ? describeError(error) : null;

  async function onSubmit() {
    if (auth.status !== "ready") return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createCircle(auth.token, { name: name.trim() || undefined, n_members: nMembers, contribution_usdt: contribution, interval });
      const circleId = String(res?.circle?.circle_id ?? "");
      if (circleId) {
        nav(`/circle/${circleId}`);
      } else {
        setError({ code: "BAD_RESPONSE", message: "Missing circle_id" });
      }
    } catch (e: unknown) {
      const err = (e ?? {}) as Partial<ApiError>;
      setError({ code: err.code ?? "API_ERROR", message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: 16, textAlign: "left", display: "grid", gap: 12 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Create a Circle</h1>

      {error && humanError ? (
        <div style={{ border: "1px solid rgba(255,255,255,0.25)", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 700 }}>{humanError.title}</div>
          <div style={{ opacity: 0.9 }}>{humanError.description}</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Code: {error.code}</div>
        </div>
      ) : null}

      <label style={{ display: "grid", gap: 6 }}>
        <div>Circle name (optional)</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team Savings" />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <div>Members (2–12)</div>
        <input type="number" min={2} max={12} value={nMembers} onChange={(e) => setNMembers(Number(e.target.value))} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <div>Contribution per cycle (USDT)</div>
        <input value={contribution} onChange={(e) => setContribution(e.target.value)} placeholder="10" inputMode="decimal" />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <div>Interval</div>
        <select value={interval} onChange={(e) => setInterval(e.target.value === "monthly" ? "monthly" : "weekly")}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>

      <div style={{ opacity: 0.85, fontSize: 13, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>MVP fixed rules</div>
        <div>Discount cap: 5%</div>
        <div>Grace period: 24h</div>
        <div>Collateral: fixed by circle rules (v1.2.1)</div>
        <div>Fees: 1% (winner pays)</div>
        <div>Safety lock: enabled for Cycle 1</div>
      </div>

      <button disabled={submitting} onClick={() => void onSubmit()}>
        {submitting ? "Creating…" : "Create Circle"}
      </button>
    </div>
  );
}
