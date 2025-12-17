type IndexerCircleMeta = {
  last_indexed_at?: string | null;
  last_indexer_attempt_at?: string | null;
  last_indexer_error?: string | null;
};

function safeShort(input: string, maxLen = 120): string {
  const clean = input.replaceAll(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function secondsAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

function fmtAgo(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s ago`;
  const h = Math.floor(m / 60);
  if (h < 1) return `${m}m ago`;
  return `${h}h ${m % 60}m ago`;
}

export function IndexerLagBanner(props: { circle: IndexerCircleMeta | null }) {
  const c = props.circle;
  if (!c) return null;

  const lastOkSec = secondsAgo(c.last_indexed_at);
  const lastAttemptSec = secondsAgo(c.last_indexer_attempt_at);
  const hasError = Boolean(c.last_indexer_error && String(c.last_indexer_error).trim().length > 0);

  // Default thresholds: warn after 5m, critical after 15m.
  const warnSec = 5 * 60;
  const critSec = 15 * 60;

  const isStale = lastOkSec != null ? lastOkSec >= warnSec : hasError;
  if (!isStale) return null;

  const critical = lastOkSec != null ? lastOkSec >= critSec : hasError;

  const title = critical ? "Chain sync delayed" : "Sync delayed";
  const ageText = lastOkSec != null ? `Last sync: ${fmtAgo(lastOkSec)}` : lastAttemptSec != null ? `Last attempt: ${fmtAgo(lastAttemptSec)}` : "Sync status unknown";
  const errText = hasError ? safeShort(String(c.last_indexer_error)) : null;

  return (
    <div
      className={[
        "rounded-2xl px-4 py-3 text-sm ring-1",
        critical ? "bg-amber-900/30 text-amber-100 ring-amber-900/60" : "bg-slate-900/60 text-slate-200 ring-slate-800",
      ].join(" ")}
    >
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-xs opacity-90">{ageText}</div>
      {errText ? <div className="mt-1 text-xs opacity-90">Last error: {errText}</div> : null}
      <div className="mt-2 text-xs opacity-90">
        Data may be outdated. If you just sent a transaction, wait 15–60s and tap Refresh.
      </div>
    </div>
  );
}

