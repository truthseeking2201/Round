import type { ApiError } from "./api";

export type HumanError = {
  title: string;
  description: string;
};

export function describeError(err: ApiError): HumanError {
  const code = String(err.code ?? "API_ERROR");

  // Prefer explicit, user-facing copy. Keep it short and non-technical.
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_INVALID":
      return { title: "Session expired", description: "Please reopen the mini app in Telegram or tap Retry." };

    case "TG_GROUP_REQUIRED":
      return { title: "Open in a group", description: "Open the mini app inside the MoneyCircle Telegram group." };
    case "TG_NOT_IN_GROUP":
    case "NOT_VERIFIED_IN_GROUP":
      return { title: "Not in group", description: "You must be a member of the Telegram group to continue." };
    case "TG_BANNED":
      return { title: "Access blocked", description: "Your account is not allowed in this group." };
    case "BOT_NOT_IN_GROUP":
      return { title: "Bot missing", description: "Add the MoneyCircle bot to this group and try again." };
    case "CAP_EXCEEDED":
      return { title: "Circle cap exceeded", description: "This circle exceeds the current cap. Reduce N or contribution." };

    case "CIRCLE_NOT_RECRUITING":
      return { title: "Circle is locked", description: "This circle is no longer accepting new members." };
    case "CIRCLE_NOT_FOUND":
      return { title: "Circle not found", description: "This circle does not exist or is not accessible." };
    case "NOT_JOINED":
      return { title: "Join required", description: "Join this circle first, then retry." };
    case "FORBIDDEN":
      return { title: "Forbidden", description: "You do not have permission to perform this action." };
    case "SERVER_MISCONFIGURED":
      return { title: "Server unavailable", description: "The server is not configured correctly. Please try again later." };

    case "RULES_NOT_ACCEPTED":
    case "RULES_SIGNATURE_REQUIRED":
      return { title: "Accept rules required", description: "Please accept the rules before continuing." };
    case "WALLET_NOT_VERIFIED":
    case "WALLET_PROOF_INVALID":
      return { title: "Wallet verification failed", description: "Please retry wallet verification." };
    case "WALLET_ALREADY_BOUND":
      return { title: "Wallet already bound", description: "This wallet is already linked. Wallet changes are not supported in MVP." };
    case "WALLET_BIND_EXPIRED":
      return { title: "Verification expired", description: "Your verification request expired. Please retry." };

    case "CONTRACT_NOT_READY":
      return { title: "Contract not ready", description: "This circle contract is not attached yet. Please retry later." };
    case "JETTON_WALLET_NOT_INITIALIZED":
      return { title: "Init required", description: "Run INIT once before depositing (contract Jetton wallet not set yet)." };
    case "DEPOSIT_TOO_SMALL":
      return { title: "Deposit too small", description: "This deposit is below the minimum and would be ignored by the contract." };
    case "NOT_ONCHAIN_MEMBER":
      return { title: "Join on-chain first", description: "Please complete the on-chain join before depositing." };
    case "JETTON_GET_WALLET_FAILED":
      return { title: "Jetton lookup failed", description: "Unable to find your USDT Jetton wallet. Please retry in a minute." };

    case "EMERGENCY_STOP":
      return { title: "Emergency stop", description: "Operations are frozen by rules. Withdraw is still available." };

    case "BID_OUT_OF_BOUNDS":
      return { title: "Bid out of bounds", description: "Your bid must be within the allowed minimum and maximum payout." };
    case "MISSING_BID_DATA":
      return { title: "Missing bid data", description: err.message ?? "Your saved bid data is missing. You cannot reveal without it." };

    case "RATE_LIMITED":
    case "LEADER_RATE_LIMIT":
      return { title: "Too many requests", description: err.message ?? "Please wait and try again." };

    case "WALLET_NOT_CONNECTED":
      return { title: "Connect wallet", description: "Connect your wallet to continue." };
    case "WALLET_MISMATCH":
      return { title: "Wrong wallet", description: "Switch to the wallet you verified/joined with, then retry." };
    case "TX_FAILED":
      return { title: "Transaction failed", description: err.message ?? "Please retry the transaction." };

    default: {
      const msg = err.message?.trim();
      return { title: `Error: ${code}`, description: msg && msg.length > 0 ? msg : "An unexpected error occurred. Please try again." };
    }
  }
}
