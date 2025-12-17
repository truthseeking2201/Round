import "@stdlib/deploy";

// --------------------------------------------
// MoneyCircle — CircleContract (v1.2.1)
// Source of truth:
// - docs/BUILD_GUIDE.md
// - docs/CONTRACT_SPEC.md
// - docs/SECURITY_TESTS.md
// --------------------------------------------

// Helper for numeric on-chain error codes (Tact built-in `require` uses string messages).
fun requireOrThrow(condition: Bool, errorCode: Int) {
  if (!condition) {
    throw(errorCode);
  }
}

// --- Opcodes (internal) ---
const OP_JOIN_WITH_TICKET: Int = 0x1001;
const OP_TRIGGER_DEBIT_ALL: Int = 0x2001;
const OP_COMMIT_BID: Int = 0x3001;
const OP_REVEAL_BID: Int = 0x3002;
const OP_FINALIZE_AUCTION: Int = 0x3003;
const OP_TERMINATE_DEFAULT: Int = 0x4001;
const OP_WITHDRAW: Int = 0x6001;
const OP_WITHDRAW_TREASURY: Int = 0x7001;
const OP_EMERGENCY_STOP: Int = 0x9001;
const OP_INIT: Int = 0xA001;

// --- Jetton standard opcodes ---
const OP_JETTON_TRANSFER: Int = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_NOTIFICATION: Int = 0x7362d09c;
const OP_JETTON_EXCESSES: Int = 0xd53276db;

// --- TEP-89 wallet discovery (best-effort; confirm against real USDT master) ---
const OP_PROVIDE_WALLET_ADDRESS: Int = 0x2;
const OP_TAKE_WALLET_ADDRESS: Int = 0x3;

// --- Forward payload format (deposit purpose) ---
const DEPOSIT_MAGIC: Int = 0xC0FFEE01;
const PURPOSE_COLLATERAL: Int = 1;
const PURPOSE_PREFUND: Int = 2;

// --- Status ---
const STATUS_RECRUITING: Int = 0;
const STATUS_LOCKED: Int = 1;
const STATUS_ACTIVE: Int = 2;
const STATUS_COMPLETED: Int = 3;
const STATUS_TERMINATED: Int = 4;
const STATUS_EMERGENCY_STOP: Int = 5;

// --- Phase ---
const PHASE_FUNDING: Int = 0;
const PHASE_COMMIT: Int = 1;
const PHASE_REVEAL: Int = 2;
const PHASE_DEFAULT_ELIGIBLE: Int = 3;

// --- Withdraw modes ---
const WITHDRAW_PAYOUT_ONLY: Int = 1;
const WITHDRAW_ALL: Int = 2;
const WITHDRAW_RECRUITING_EXIT: Int = 3;

// --- Pending out kinds (bounce-restore) ---
const OUT_USER_PAYOUT_ONLY: Int = 1;
const OUT_USER_ALL: Int = 2;
const OUT_RECRUITING_EXIT: Int = 3;
const OUT_TREASURY: Int = 4;

// --- Errors (keep stable once deployed) ---
const ERR_EMERGENCY_STOP: Int = 100;
const ERR_NOT_RECRUITING: Int = 101;
const ERR_CIRCLE_FULL: Int = 102;
const ERR_MEMBER_EXISTS: Int = 103;
const ERR_TICKET_EXPIRED: Int = 104;
const ERR_TICKET_SIG_INVALID: Int = 105;
const ERR_TICKET_NONCE_USED: Int = 106;
const ERR_WALLET_MISMATCH: Int = 107;
const ERR_RECRUITING_BUSY: Int = 108;

const ERR_JETTON_WALLET_NOT_SET: Int = 120;
const ERR_DEPOSIT_TOO_SMALL: Int = 121;
const ERR_SENDER_NOT_JETTON_WALLET: Int = 122;
const ERR_SENDER_NOT_MEMBER: Int = 123;

const ERR_NOT_FUNDING_PHASE: Int = 140;
const ERR_DEBIT_OUTSIDE_WINDOW: Int = 141;
const ERR_NOT_COMMIT_PHASE: Int = 142;
const ERR_COMMIT_CLOSED: Int = 143;
const ERR_ALREADY_COMMITTED: Int = 144;
const ERR_NOT_REVEAL_PHASE: Int = 145;
const ERR_REVEAL_CLOSED: Int = 146;
const ERR_NOT_COMMITTED: Int = 147;
const ERR_ALREADY_REVEALED: Int = 148;
const ERR_HASH_MISMATCH: Int = 149;
const ERR_BID_OUT_OF_BOUNDS: Int = 150;
const ERR_FINALIZE_TOO_EARLY: Int = 151;
const ERR_ALREADY_SETTLED: Int = 152;
const ERR_POT_NOT_FULL: Int = 153;
const ERR_ALL_MEMBERS_ALREADY_WON: Int = 154;

const ERR_NOT_DEFAULT_ELIGIBLE: Int = 170;
const ERR_TERMINATE_TOO_EARLY: Int = 171;

const ERR_WITHDRAW_MODE: Int = 190;
const ERR_NOT_WITHDRAWABLE_STATE: Int = 191;
const ERR_NOT_MEMBER: Int = 192;
const ERR_NOT_TREASURY: Int = 193;
const ERR_WITHDRAW_EMPTY: Int = 194;

const ERR_STOP_SIG_INVALID: Int = 210;
const ERR_STOP_EXPIRED: Int = 211;
const ERR_STOP_NONCE_USED: Int = 212;

// --- Constants ---
// Assumes USDT decimals=6 (1 USDT = 1_000_000 units).
const PENALTY_CAP_UNITS: Int = 100_000; // 0.1 USDT
const MIN_WITHDRAW_GAS: Int = 50_000_000; // 0.05 TON (caller must attach >= this)

struct Config {
  jetton_master: Address;
  guardian_pubkey: Int as uint256;
  treasury_owner: Address;

  n_members: Int as uint16;
  contribution: Int;
  total_cycles: Int as uint16;

  interval_sec: Int as uint32;
  grace_sec: Int as uint32;

  take_rate_bps: Int as uint16;
  collateral_rate_bps: Int as uint16;
  max_discount_bps: Int as uint16;

  vesting_bps_cycle1: Int as uint16;
  early_lock_rate_bps_cycle1: Int as uint16;

  commit_duration_sec: Int as uint32;
  reveal_duration_sec: Int as uint32;

  max_pot_cap: Int;
  min_deposit_units: Int;
}

struct Member {
  active: Bool;
  has_won: Bool;

  collateral: Int;
  prefund: Int;
  credit: Int;

  vesting_locked: Int;
  vesting_released: Int;
  future_locked: Int;

  withdrawable: Int;

  paid_total: Int;
  received_total: Int;
}

struct PendingOut {
  kind: Int as uint8;
  owner: Address;
  amount: Int;

  // Recruiting exit restore (swap-with-last)
  had_swap: Bool;
  removed_index: Int as uint16;
  swapped_in: Address;
  restore_collateral: Int;
  restore_prefund: Int;

  // Treasury restore
  restore_treasury_owed: Int;
}

struct StatusView {
  status: Int as uint8;
  current_cycle: Int as uint16;
  phase: Int as uint8;
  due_at: Int as uint32;
  grace_end_at: Int as uint32;
  commit_end_at: Int as uint32;
  reveal_end_at: Int as uint32;
  funded_count: Int as uint16;
}

struct MemberView {
  active: Bool;
  has_won: Bool;
  collateral: Int;
  prefund: Int;
  credit: Int;
  vesting_locked: Int;
  vesting_released: Int;
  future_locked: Int;
  withdrawable: Int;
  due_remaining: Int;
}

contract CircleContract with Deployable {
  // Immutable config
  config: Config;

  // Global state
  status: Int as uint8;
  members_count: Int as uint16;
  current_cycle: Int as uint16;

  pot: Int;
  collateral_required: Int;

  jetton_wallet: Address?; // set by TEP-89

  // Member ordering is security-critical (fallback rotation). Use a deterministic index map.
  // Indices are [0..members_count-1].
  member_list: map<Int, Address>;
  members: map<Address, Member>;

  treasury_owed: Int;
  used_nonces: map<Int, Bool>; // uint256 -> bool
  recruiting_exit_inflight: Bool;

  // Cycle state (current cycle only)
  phase: Int as uint8;
  cycle_start_at: Int as uint32;
  due_at: Int as uint32;
  grace_end_at: Int as uint32;
  commit_start_at: Int as uint32;
  commit_end_at: Int as uint32;
  reveal_end_at: Int as uint32;

  funded_count: Int as uint16;
  pot_pool: Int;
  settled: Bool;
  winner: Address?;
  payout_gross: Int;

  due_remaining: map<Address, Int>;
  paid_this_cycle: map<Address, Int>;

  late_penalty_applied: map<Address, Bool>;
  non_reveal_penalty_applied: map<Address, Bool>;

  commit_hash: map<Address, Int>; // uint256
  commit_order: map<Address, Int>; // uint16 (stored as Int)
  commit_counter: Int as uint16;

  revealed: map<Address, Bool>;
  payout_wanted: map<Address, Int>;

  // Outbox for bounce-safe jetton transfers
  next_query_id: Int as uint64;
  pending_out: map<Int, PendingOut>; // query_id -> PendingOut

  init(config: Config) {
    self.config = config;

    // Basic config validation (fail-fast at deploy)
    requireOrThrow(config.n_members >= 2, 900);
    requireOrThrow(config.n_members <= 12, 901);
    requireOrThrow(config.contribution > 0, 902);
    requireOrThrow(config.total_cycles >= 1, 903);
    requireOrThrow(config.total_cycles <= config.n_members, 904);
    requireOrThrow(config.take_rate_bps <= 10_000, 905);
    requireOrThrow(config.collateral_rate_bps <= 10_000, 906);
    requireOrThrow(config.max_discount_bps <= 10_000, 907);
    requireOrThrow(config.vesting_bps_cycle1 <= 10_000, 908);
    requireOrThrow(config.early_lock_rate_bps_cycle1 <= 10_000, 909);

    // Precompute invariants
    let pot = config.n_members * config.contribution;
    requireOrThrow(pot <= config.max_pot_cap, 910);
    self.pot = pot;
    self.collateral_required = (pot * config.collateral_rate_bps) / 10000;

    // Global init
    self.status = STATUS_RECRUITING;
    self.members_count = 0;
    self.current_cycle = 0;
    self.treasury_owed = 0;

    self.member_list = emptyMap();
    self.members = emptyMap();
    self.used_nonces = emptyMap();
    self.recruiting_exit_inflight = false;

    // Cycle init (uninitialized until lock)
    self.phase = PHASE_FUNDING;
    self.cycle_start_at = 0;
    self.due_at = 0;
    self.grace_end_at = 0;
    self.commit_start_at = 0;
    self.commit_end_at = 0;
    self.reveal_end_at = 0;
    self.funded_count = 0;
    self.pot_pool = 0;
    self.settled = false;
    self.winner = null;
    self.payout_gross = 0;

    self.due_remaining = emptyMap();
    self.paid_this_cycle = emptyMap();
    self.late_penalty_applied = emptyMap();
    self.non_reveal_penalty_applied = emptyMap();
    self.commit_hash = emptyMap();
    self.commit_order = emptyMap();
    self.commit_counter = 0;
    self.revealed = emptyMap();
    self.payout_wanted = emptyMap();

    // Outbox init
    self.next_query_id = 1;
    self.pending_out = emptyMap();

    self.jetton_wallet = null;
  }

  // --------------------------
  // Helpers
  // --------------------------

  fun _now(): Int {
    return now();
  }

  fun _requireNotEmergency() {
    requireOrThrow(self.status != STATUS_EMERGENCY_STOP, ERR_EMERGENCY_STOP);
  }

  fun _requireMember(addr: Address): Member {
    let m = self.members.get(addr);
    requireOrThrow(m != null, ERR_NOT_MEMBER);
    let member = m!!;
    requireOrThrow(member.active, ERR_NOT_MEMBER);
    return member;
  }

  fun _setMember(addr: Address, member: Member) {
    self.members.set(addr, member);
  }

  fun _syncPhase() {
    if (self.status == STATUS_RECRUITING || self.status == STATUS_COMPLETED || self.status == STATUS_TERMINATED) {
      return;
    }

    let t = self._now();

    if (self.phase == PHASE_FUNDING) {
      // Exclusive grace end: debit allowed due_at <= now < grace_end_at
      if (t >= self.grace_end_at && self.funded_count < self.config.n_members) {
        self.phase = PHASE_DEFAULT_ELIGIBLE;
      }
    }

    if (self.phase == PHASE_COMMIT) {
      if (t >= self.commit_end_at) {
        self.phase = PHASE_REVEAL;
      }
    }
  }

  fun _minPayout(): Int {
    // minPayout = pot * (1 - max_discount_bps/10000)
    let bps = 10000 - self.config.max_discount_bps;
    return (self.pot * bps) / 10000;
  }

  fun _nonceKey(addr: Address, nonce: Int): Int {
    // key = sha256( addr | nonce )
    let c = beginCell().storeAddress(addr).storeUint(nonce, 64).endCell();
    return c.hash();
  }

  fun _hashJoin(addr: Address, exp: Int, nonce: Int): Int {
    // H("MC_JOIN"|contract|wallet|exp|nonce)
    let c = beginCell()
      .storeUint(0x4d43, 16) // "MC"
      .storeUint(0x5f4a4f494e, 40) // "_JOIN"
      .storeAddress(myAddress())
      .storeAddress(addr)
      .storeUint(exp, 32)
      .storeUint(nonce, 64)
      .endCell();
    return c.hash();
  }

  fun _hashBid(addr: Address, cycleIndex: Int, payoutWanted: Int, salt: Int): Int {
    // H("MC_BID"|contract|cycle|wallet|payoutWanted|salt)
    let c = beginCell()
      .storeUint(0x4d43, 16) // "MC"
      .storeUint(0x5f424944, 32) // "_BID"
      .storeAddress(myAddress())
      .storeUint(cycleIndex, 16)
      .storeAddress(addr)
      .storeCoins(payoutWanted)
      .storeUint(salt, 256)
      .endCell();
    return c.hash();
  }

  fun _hashStop(reason: Int, exp: Int, nonce: Int): Int {
    // H("MC_STOP"|contract|reason|exp|nonce)
    let c = beginCell()
      .storeUint(0x4d43, 16) // "MC"
      .storeUint(0x5f53544f50, 40) // "_STOP"
      .storeAddress(myAddress())
      .storeUint(reason, 32)
      .storeUint(exp, 32)
      .storeUint(nonce, 64)
      .endCell();
    return c.hash();
  }

  fun _verifySig(hash: Int, sig: Slice, pubkey: Int): Bool {
    return checkSignature(hash, sig, pubkey);
  }

  fun _initCycle(cycleIndex: Int) {
    self.current_cycle = cycleIndex;
    self.phase = PHASE_FUNDING;

    self.cycle_start_at = self._now();
    self.due_at = self.cycle_start_at + self.config.interval_sec;
    self.grace_end_at = self.due_at + self.config.grace_sec;

    self.commit_start_at = 0;
    self.commit_end_at = 0;
    self.reveal_end_at = 0;

    self.funded_count = 0;
    self.pot_pool = 0;
    self.settled = false;
    self.winner = null;
    self.payout_gross = 0;

    self.due_remaining = emptyMap();
    self.paid_this_cycle = emptyMap();
    self.late_penalty_applied = emptyMap();
    self.non_reveal_penalty_applied = emptyMap();
    self.commit_hash = emptyMap();
    self.commit_order = emptyMap();
    self.commit_counter = 0;
    self.revealed = emptyMap();
    self.payout_wanted = emptyMap();

    // Initialize per-member due state
    let i: Int = 0;
    while (i < self.members_count) {
      let a = self.member_list.get(i);
      requireOrThrow(a != null, 912);
      let m = a!!;
      self.due_remaining.set(m, self.config.contribution);
      self.paid_this_cycle.set(m, 0);
      self.late_penalty_applied.set(m, false);
      self.non_reveal_penalty_applied.set(m, false);
      self.revealed.set(m, false);
      self.payout_wanted.set(m, 0);
      i += 1;
    }
  }

  fun _lockAndInitCycle() {
    requireOrThrow(self.members_count == self.config.n_members, 902);
    self.status = STATUS_LOCKED;
    self._initCycle(1);
  }

  fun _openCommitWindow() {
    requireOrThrow(self.funded_count == self.config.n_members, 903);
    requireOrThrow(self.commit_start_at == 0, 904);
    requireOrThrow(self.pot_pool == self.pot, ERR_POT_NOT_FULL);

    self.status = STATUS_ACTIVE;
    self.phase = PHASE_COMMIT;

    let t = self._now();
    self.commit_start_at = t;
    self.commit_end_at = t + self.config.commit_duration_sec;
    self.reveal_end_at = self.commit_end_at + self.config.reveal_duration_sec;
  }

  fun _applyLatePenalty(addr: Address, member: Member): Member {
    let already = self.late_penalty_applied.get(addr);
    if (already != null && already!!) {
      return member;
    }
    let t = self._now();
    if (t <= self.due_at) {
      return member;
    }
    // penalty = min(0.1 USDT, C*1%)
    let p1 = self.config.contribution / 100;
    let penalty = min(PENALTY_CAP_UNITS, p1);
    let slash = min(penalty, member.collateral);
    if (slash > 0) {
      member.collateral -= slash;
      self.treasury_owed += slash;
    }
    self.late_penalty_applied.set(addr, true);
    return member;
  }

  fun _debitOne(addr: Address) {
    requireOrThrow(self.phase == PHASE_FUNDING, ERR_NOT_FUNDING_PHASE);

    let t = self._now();
    requireOrThrow(t >= self.due_at && t < self.grace_end_at, ERR_DEBIT_OUTSIDE_WINDOW);

    let member = self._requireMember(addr);

    let dueOpt = self.due_remaining.get(addr);
    requireOrThrow(dueOpt != null, 910);
    let due = dueOpt!!;
    if (due <= 0) {
      return;
    }

    // Fix #3: auto-heal collateral before gate (prefund first, then credit)
    if (member.collateral < self.collateral_required) {
      let missing = self.collateral_required - member.collateral;
      if (missing > 0 && member.prefund > 0) {
        let take = min(member.prefund, missing);
        member.prefund -= take;
        member.collateral += take;
        missing -= take;
      }
      if (missing > 0 && member.credit > 0) {
        let take2 = min(member.credit, missing);
        member.credit -= take2;
        member.collateral += take2;
        missing -= take2;
      }
    }

    // Collateral gate: if still short, do not debit
    if (member.collateral < self.collateral_required) {
      self._setMember(addr, member);
      return;
    }

    let dueBefore = due;

    // Debit order: credit -> future_locked -> prefund
    if (due > 0 && member.credit > 0) {
      let useCredit = min(member.credit, due);
      member.credit -= useCredit;
      due -= useCredit;
    }
    if (due > 0 && member.future_locked > 0) {
      let useFuture = min(member.future_locked, due);
      member.future_locked -= useFuture;
      due -= useFuture;
    }
    if (due > 0 && member.prefund > 0) {
      let usePrefund = min(member.prefund, due);
      member.prefund -= usePrefund;
      due -= usePrefund;
    }

    let paid = dueBefore - due;
    if (paid <= 0) {
      self._setMember(addr, member);
      return;
    }

    self.due_remaining.set(addr, due);

    let paidOpt = self.paid_this_cycle.get(addr);
    let paidThis = (paidOpt == null) ? 0 : paidOpt!!;
    paidThis += paid;
    self.paid_this_cycle.set(addr, paidThis);

    self.pot_pool += paid;
    member.paid_total += paid;

    if (due == 0) {
      // count funded only on transition >0 -> 0
      if (dueBefore > 0) {
        self.funded_count += 1;
        // Late penalty only once if funded after due_at
        member = self._applyLatePenalty(addr, member);
      }
    }

    requireOrThrow(self.pot_pool <= self.pot, 911);

    self._setMember(addr, member);
  }

  fun _triggerDebitAll() {
    requireOrThrow(self.phase == PHASE_FUNDING, ERR_NOT_FUNDING_PHASE);
    let t = self._now();
    requireOrThrow(t >= self.due_at && t < self.grace_end_at, ERR_DEBIT_OUTSIDE_WINDOW);

    let i: Int = 0;
    while (i < self.members_count) {
      let a = self.member_list.get(i);
      requireOrThrow(a != null, 913);
      let m = a!!;
      let dueOpt = self.due_remaining.get(m);
      if (dueOpt != null && dueOpt!! > 0) {
        self._debitOne(m);
      }
      i += 1;
    }

    if (self.funded_count == self.config.n_members) {
      self._openCommitWindow();
    }
  }

  fun _nonRevealPenaltyOnce(addr: Address, member: Member) {
    let already = self.non_reveal_penalty_applied.get(addr);
    if (already != null && already!!) {
      return;
    }
    let penalty = min(PENALTY_CAP_UNITS, member.collateral / 100);
    let slash = min(penalty, member.collateral);
    if (slash > 0) {
      member.collateral -= slash;
      self.treasury_owed += slash;
    }
    self.non_reveal_penalty_applied.set(addr, true);
    self._setMember(addr, member);
  }

  fun _selectFallbackWinnerOpt(): Address? {
    let n = self.config.n_members;
    let start = (self.current_cycle - 1) % n;
    let i: Int = 0;
    while (i < n) {
      let idx = (start + i) % n;
      let candOpt = self.member_list.get(idx);
      requireOrThrow(candOpt != null, 914);
      let cand = candOpt!!;
      let m = self._requireMember(cand);
      if (!m.has_won) {
        return cand;
      }
      i += 1;
    }
    return null;
  }

  // --------------------------
  // Entry: internal messages
  // --------------------------

  receive(msg: Slice) {
    let op = msg.loadUint(32);

    // Jetton transfer_notification
    if (op == OP_JETTON_TRANSFER_NOTIFICATION) {
      self._onJettonTransferNotification(msg);
      return;
    }

    // Jetton wallet "excesses" callback (used to clear pending outbox entries)
    if (op == OP_JETTON_EXCESSES) {
      self._onJettonExcesses(msg);
      return;
    }

    // TEP-89 take_wallet_address from jetton master
    if (op == OP_TAKE_WALLET_ADDRESS) {
      self._onTakeWalletAddress(msg);
      return;
    }

    // All remaining ops are frozen during EmergencyStop (except withdraw/treasury/stop)
    if (op != OP_WITHDRAW && op != OP_WITHDRAW_TREASURY && op != OP_EMERGENCY_STOP) {
      self._requireNotEmergency();
    }

    if (op == OP_INIT) {
      self._initJettonWalletDiscovery();
      return;
    }

    if (op == OP_JOIN_WITH_TICKET) {
      self._joinWithTicket(msg);
      return;
    }

    if (op == OP_TRIGGER_DEBIT_ALL) {
      self._syncPhase();
      self._triggerDebitAll();
      return;
    }

    if (op == OP_COMMIT_BID) {
      self._syncPhase();
      self._commitBid(msg);
      return;
    }

    if (op == OP_REVEAL_BID) {
      self._syncPhase();
      self._revealBid(msg);
      return;
    }

    if (op == OP_FINALIZE_AUCTION) {
      self._syncPhase();
      self._finalizeAuction();
      return;
    }

    if (op == OP_TERMINATE_DEFAULT) {
      self._syncPhase();
      self._terminateDefault();
      return;
    }

    if (op == OP_WITHDRAW) {
      self._withdraw(msg);
      return;
    }

    if (op == OP_WITHDRAW_TREASURY) {
      self._withdrawTreasury();
      return;
    }

    if (op == OP_EMERGENCY_STOP) {
      self._emergencyStop(msg);
      return;
    }
  }

  fun _onJettonExcesses(msg: Slice) {
    if (self.jetton_wallet == null) {
      return;
    }
    // Only accept from the contract's own jetton wallet.
    if (sender() != self.jetton_wallet!!) {
      return;
    }
    let qid = msg.loadUint(64);
    let outOpt = self.pending_out.get(qid);
    if (outOpt == null) {
      return;
    }
    let out = outOpt!!;
    self.pending_out.set(qid, null);

    if (out.kind == OUT_RECRUITING_EXIT) {
      self.recruiting_exit_inflight = false;
    }
  }

  // --------------------------
  // INIT / TEP-89
  // --------------------------

  fun _initJettonWalletDiscovery() {
    // Anyone can trigger INIT; it only sends a request to the allowlisted jetton_master.
    // If jetton_wallet already set, do nothing.
    if (self.jetton_wallet != null) {
      return;
    }
    requireOrThrow(context().value >= MIN_WITHDRAW_GAS, 921);
    let qid = self.next_query_id;
    self.next_query_id += 1;

    let body = beginCell()
      .storeUint(OP_PROVIDE_WALLET_ADDRESS, 32)
      .storeUint(qid, 64)
      .storeAddress(myAddress())
      .storeBit(false)
      .endCell();

    send(SendParameters{
      to: self.config.jetton_master,
      value: MIN_WITHDRAW_GAS,
      bounce: true,
      body: body
    });
  }

  fun _onTakeWalletAddress(msg: Slice) {
    // Accept only from jetton master.
    requireOrThrow(sender() == self.config.jetton_master, 920);
    if (self.jetton_wallet != null) {
      return;
    }
    // TEP-89: take_wallet_address#3 query_id:uint64 wallet_address:MsgAddress ...
    let _qid = msg.loadUint(64);
    let walletAddr = msg.loadAddress();
    self.jetton_wallet = walletAddr;
  }

  // --------------------------
  // Join & Recruiting exit
  // --------------------------

  fun _joinWithTicket(msg: Slice) {
    requireOrThrow(self.status == STATUS_RECRUITING, ERR_NOT_RECRUITING);
    requireOrThrow(!self.recruiting_exit_inflight, ERR_RECRUITING_BUSY);

    // Body: wallet:Address exp:uint32 nonce:uint64 sig:bits512
    let wallet = msg.loadAddress();
    let exp = msg.loadUint(32);
    let nonce = msg.loadUint(64);
    let sig = msg.loadBits(512);

    requireOrThrow(sender() == wallet, ERR_WALLET_MISMATCH);
    requireOrThrow(self._now() <= exp, ERR_TICKET_EXPIRED);
    requireOrThrow(self.members_count < self.config.n_members, ERR_CIRCLE_FULL);

    let existing = self.members.get(wallet);
    if (existing != null) {
      // Allow re-join only if the member previously exited during Recruiting.
      let em = existing!!;
      requireOrThrow(!em.active, ERR_MEMBER_EXISTS);
      em.active = true;
      em.has_won = false;
      // Defensive reset (Recruiting should have no non-zero buckets after exit).
      em.collateral = 0;
      em.prefund = 0;
      em.credit = 0;
      em.vesting_locked = 0;
      em.vesting_released = 0;
      em.future_locked = 0;
      em.withdrawable = 0;
      self.members.set(wallet, em);
    }

    let nonceKey = self._nonceKey(wallet, nonce);
    let used = self.used_nonces.get(nonceKey);
    requireOrThrow(used == null || !used!!, ERR_TICKET_NONCE_USED);

    let h = self._hashJoin(wallet, exp, nonce);
    requireOrThrow(self._verifySig(h, sig, self.config.guardian_pubkey), ERR_TICKET_SIG_INVALID);

    self.used_nonces.set(nonceKey, true);

    if (existing == null) {
      let m = Member{
        active: true,
        has_won: false,
        collateral: 0,
        prefund: 0,
        credit: 0,
        vesting_locked: 0,
        vesting_released: 0,
        future_locked: 0,
        withdrawable: 0,
        paid_total: 0,
        received_total: 0
      };
      self.members.set(wallet, m);
    }
    let idx = self.members_count;
    self.member_list.set(idx, wallet);
    self.members_count += 1;

    if (self.members_count == self.config.n_members) {
      self._lockAndInitCycle();
    }
  }

  fun _removeMemberFromList(addr: Address): PendingOut {
    // Swap-with-last removal. Returns PendingOut info to allow bounce restore (recruiting exit).
    let len = self.members_count;
    let i: Int = 0;
    while (i < len) {
      let a = self.member_list.get(i);
      requireOrThrow(a != null, 915);
      if (a!! == addr) {
        let lastIndex = len - 1;
        if (i == lastIndex) {
          self.member_list.set(lastIndex, null);
          return PendingOut{
            kind: OUT_RECRUITING_EXIT,
            owner: addr,
            amount: 0,
            had_swap: false,
            removed_index: i,
            swapped_in: addr,
            restore_collateral: 0,
            restore_prefund: 0,
            restore_treasury_owed: 0
          };
        } else {
          let lastAddrOpt = self.member_list.get(lastIndex);
          requireOrThrow(lastAddrOpt != null, 916);
          let swapped = lastAddrOpt!!;
          self.member_list.set(i, swapped);
          self.member_list.set(lastIndex, null);
          return PendingOut{
            kind: OUT_RECRUITING_EXIT,
            owner: addr,
            amount: 0,
            had_swap: true,
            removed_index: i,
            swapped_in: swapped,
            restore_collateral: 0,
            restore_prefund: 0,
            restore_treasury_owed: 0
          };
        }
      }
      i += 1;
    }
    let ok = false;
    requireOrThrow(ok, ERR_NOT_MEMBER);
    return PendingOut{
      kind: OUT_RECRUITING_EXIT,
      owner: addr,
      amount: 0,
      had_swap: false,
      removed_index: 0,
      swapped_in: addr,
      restore_collateral: 0,
      restore_prefund: 0,
      restore_treasury_owed: 0
    };
  }

  // --------------------------
  // Deposits (Jetton transfer_notification)
  // --------------------------

  fun _onJettonTransferNotification(msg: Slice) {
    // Freeze deposits during EmergencyStop (spec: status not EmergencyStop).
    if (self.status == STATUS_EMERGENCY_STOP) {
      return;
    }

    // Hard security checks:
    // - require jetton_wallet initialized (TEP-89)
    // - require msg.sender == jetton_wallet (anti-spoof)
    if (self.jetton_wallet == null) {
      return;
    }
    requireOrThrow(sender() == self.jetton_wallet!!, ERR_SENDER_NOT_JETTON_WALLET);

    // Parse transfer_notification:
    // query_id:uint64 amount:coins sender:Address forward_payload:Either Cell ^Cell
    let _qid = msg.loadUint(64);
    let amount = msg.loadCoins();
    let from_owner = msg.loadAddress();

    if (amount <= 0) {
      return;
    }
    if (amount < self.config.min_deposit_units) {
      return;
    }

    let memberOpt = self.members.get(from_owner);
    if (memberOpt == null) {
      // Ignore non-member deposits (no refund).
      return;
    }
    let member = memberOpt!!;
    if (!member.active) {
      return;
    }

    // Forward payload purpose: default PREFUND if malformed.
    // Jetton transfer_notification forward_payload: Either Cell ^Cell (1-bit discriminant).
    let purpose = PURPOSE_PREFUND;
    let parsed = false;

    if (msg.bits() >= 1) {
      let eitherRef = msg.loadUint(1);
      if (eitherRef == 0) {
        // Inline payload: parse directly from remaining bits
        if (msg.bits() >= 40) {
          let magic = msg.loadUint(32);
          let p = msg.loadUint(8);
          if (magic == DEPOSIT_MAGIC && (p == PURPOSE_COLLATERAL || p == PURPOSE_PREFUND)) {
            purpose = p;
            parsed = true;
          }
        }
      } else {
        // Ref payload
        if (msg.refs() > 0) {
          let r = msg.loadRef();
          let s = r.beginParse();
          if (s.bits() >= 40) {
            let magic2 = s.loadUint(32);
            let p2 = s.loadUint(8);
            if (magic2 == DEPOSIT_MAGIC && (p2 == PURPOSE_COLLATERAL || p2 == PURPOSE_PREFUND)) {
              purpose = p2;
              parsed = true;
            }
          }
        }
      }
    }

    if (purpose == PURPOSE_COLLATERAL) {
      member.collateral += amount;
    } else {
      member.prefund += amount;
    }
    self._setMember(from_owner, member);

    // Auto-debit-on-deposit (Funding only, inside window)
    self._syncPhase();
    if (self.phase == PHASE_FUNDING) {
      let t = self._now();
      if (t >= self.due_at && t < self.grace_end_at) {
        self._debitOne(from_owner);
        if (self.funded_count == self.config.n_members) {
          self._openCommitWindow();
        }
      }
    }
  }

  // --------------------------
  // Auction
  // --------------------------

  fun _commitBid(msg: Slice) {
    requireOrThrow(self.phase == PHASE_COMMIT, ERR_NOT_COMMIT_PHASE);
    requireOrThrow(self._now() < self.commit_end_at, ERR_COMMIT_CLOSED);

    let addr = sender();
    let member = self._requireMember(addr);
    requireOrThrow(!member.has_won, 930);

    let dueOpt = self.due_remaining.get(addr);
    requireOrThrow(dueOpt != null, 931);
    requireOrThrow(dueOpt!! == 0, 932);

    let existing = self.commit_hash.get(addr);
    requireOrThrow(existing == null, ERR_ALREADY_COMMITTED);

    let commitHash = msg.loadUint(256);
    self.commit_hash.set(addr, commitHash);

    self.commit_counter += 1;
    self.commit_order.set(addr, self.commit_counter);
  }

  fun _revealBid(msg: Slice) {
    requireOrThrow(self.phase == PHASE_REVEAL, ERR_NOT_REVEAL_PHASE);
    requireOrThrow(self._now() < self.reveal_end_at, ERR_REVEAL_CLOSED);

    let addr = sender();
    let member = self._requireMember(addr);
    requireOrThrow(!member.has_won, 940);

    let ch = self.commit_hash.get(addr);
    requireOrThrow(ch != null, ERR_NOT_COMMITTED);

    let was = self.revealed.get(addr);
    if (was != null && was!!) {
      throw(ERR_ALREADY_REVEALED);
    }

    let payout = msg.loadCoins();
    let salt = msg.loadUint(256);

    requireOrThrow(payout <= self.pot, ERR_BID_OUT_OF_BOUNDS);
    requireOrThrow(payout >= self._minPayout(), ERR_BID_OUT_OF_BOUNDS);

    let expected = self._hashBid(addr, self.current_cycle, payout, salt);
    requireOrThrow(expected == ch!!, ERR_HASH_MISMATCH);

    self.revealed.set(addr, true);
    self.payout_wanted.set(addr, payout);
  }

  fun _finalizeAuction() {
    requireOrThrow(self.phase == PHASE_REVEAL, ERR_NOT_REVEAL_PHASE);
    requireOrThrow(self._now() >= self.reveal_end_at, ERR_FINALIZE_TOO_EARLY);
    requireOrThrow(!self.settled, ERR_ALREADY_SETTLED);
    requireOrThrow(self.pot_pool == self.pot, ERR_POT_NOT_FULL);

    // Apply non-reveal penalties once, treat payout_wanted as pot for committed-but-not-revealed
    let iPenalty: Int = 0;
    while (iPenalty < self.members_count) {
      let a = self.member_list.get(iPenalty);
      requireOrThrow(a != null, 940);
      let m = a!!;
      let ch = self.commit_hash.get(m);
      let rev = self.revealed.get(m);
      if (ch != null && (rev == null || !rev!!)) {
        let member = self._requireMember(m);
        self._nonRevealPenaltyOnce(m, member);
        self.payout_wanted.set(m, self.pot);
      }
      iPenalty += 1;
    }

    // Winner selection
    let found = false;
    let bestPayout: Int = 0;
    let bestOrder: Int = 0;
    let bestAddr: Address = myAddress();
    let bestAddrKey: Int = 0;

    let iSel: Int = 0;
    while (iSel < self.members_count) {
      let a = self.member_list.get(iSel);
      requireOrThrow(a != null, 941);
      let m = a!!;
      let rev = self.revealed.get(m);
      if (rev != null && rev!!) {
        let p = self.payout_wanted.get(m);
        let o = self.commit_order.get(m);
        if (p != null && o != null) {
          if (!found) {
            found = true;
            bestPayout = p!!;
            bestOrder = o!!;
            bestAddr = m;
            bestAddrKey = beginCell().storeAddress(m).endCell().hash();
          } else {
            if (p!! < bestPayout) {
              bestPayout = p!!;
              bestOrder = o!!;
              bestAddr = m;
              bestAddrKey = beginCell().storeAddress(m).endCell().hash();
            } else if (p!! == bestPayout && o!! < bestOrder) {
              bestOrder = o!!;
              bestAddr = m;
              bestAddrKey = beginCell().storeAddress(m).endCell().hash();
            } else if (p!! == bestPayout && o!! == bestOrder) {
              // Deterministic tie-break (spec): commit_order, then address.
              // commit_order should already be unique, but keep a stable fallback anyway.
              let k = beginCell().storeAddress(m).endCell().hash();
              if (k < bestAddrKey) {
                bestAddr = m;
                bestAddrKey = k;
              }
            }
          }
        }
      }
      iSel += 1;
    }

    let winner = myAddress();
    let payoutGross = self.pot;
    if (found) {
      winner = bestAddr;
      payoutGross = bestPayout;
    } else {
      let wOpt = self._selectFallbackWinnerOpt();
      requireOrThrow(wOpt != null, ERR_ALL_MEMBERS_ALREADY_WON);
      winner = wOpt!!;
    }

    // Settlement
    let fee = (payoutGross * self.config.take_rate_bps) / 10000;
    self.treasury_owed += fee;

    let payoutNet = payoutGross - fee;

    let w = self._requireMember(winner);

    // Vesting + safety lock only for cycle 1 (per MVP hardening)
    let hold: Int = 0;
    let safety: Int = 0;
    let immediate: Int = payoutNet;

    if (self.current_cycle == 1) {
      hold = (payoutNet * self.config.vesting_bps_cycle1) / 10000;
      w.vesting_locked += hold;
      let afterVesting = payoutNet - hold;

      let remaining = self.config.contribution * (self.config.total_cycles - self.current_cycle);
      let targetLock = (remaining * self.config.early_lock_rate_bps_cycle1) / 10000;
      safety = min(targetLock, afterVesting);
      w.future_locked += safety;

      immediate = afterVesting - safety;
    }

    w.withdrawable += immediate;
    w.received_total += immediate;
    w.has_won = true;
    self._setMember(winner, w);

    // Discount -> credit for others, remainder -> treasury_owed (no orphan dust)
    let discount = self.pot - payoutGross;
    if (discount > 0) {
      let denom = self.config.n_members - 1;
      if (denom > 0) {
        let per = discount / denom;
        let rem = discount % denom;
        let iCred: Int = 0;
        while (iCred < self.members_count) {
          let a = self.member_list.get(iCred);
          requireOrThrow(a != null, 942);
          let m = a!!;
          if (m != winner) {
            let mm = self._requireMember(m);
            mm.credit += per;
            self._setMember(m, mm);
          }
          iCred += 1;
        }
        self.treasury_owed += rem;
      } else {
        // N==1 is not allowed by config, but guard anyway
        self.treasury_owed += discount;
      }
    }

    self.winner = winner;
    self.payout_gross = payoutGross;
    self.settled = true;

    // Rollover or complete
    if (self.current_cycle >= self.config.total_cycles) {
      self.status = STATUS_COMPLETED;
    } else {
      self._initCycle(self.current_cycle + 1);
      self.status = STATUS_ACTIVE;
    }
  }

  // --------------------------
  // Terminate default (fix #2)
  // --------------------------

  fun _isDefaulter(addr: Address): Bool {
    let dueOpt = self.due_remaining.get(addr);
    let due = (dueOpt == null) ? 0 : dueOpt!!;
    let m = self._requireMember(addr);
    return (due > 0) || (m.collateral < self.collateral_required);
  }

  fun _terminateDefault() {
    requireOrThrow(self.phase == PHASE_DEFAULT_ELIGIBLE, ERR_NOT_DEFAULT_ELIGIBLE);
    requireOrThrow(self._now() >= self.grace_end_at, ERR_TERMINATE_TOO_EARLY);
    requireOrThrow(self.funded_count < self.config.n_members, 960);

    // Step 1 refund paid_this_cycle -> prefund
    let iRefund: Int = 0;
    while (iRefund < self.members_count) {
      let aOpt = self.member_list.get(iRefund);
      requireOrThrow(aOpt != null, 960);
      let a = aOpt!!;
      let paidOpt = self.paid_this_cycle.get(a);
      let paid = (paidOpt == null) ? 0 : paidOpt!!;
      if (paid > 0) {
        let m = self._requireMember(a);
        m.prefund += paid;
        self._setMember(a, m);
        self.paid_this_cycle.set(a, 0);
      }
      iRefund += 1;
    }
    self.pot_pool = 0;

    // Step 2 seize from defaulters
    let penaltyPool: Int = 0;
    let iSeize: Int = 0;
    while (iSeize < self.members_count) {
      let aOpt = self.member_list.get(iSeize);
      requireOrThrow(aOpt != null, 961);
      let a = aOpt!!;
      if (self._isDefaulter(a)) {
        let m = self._requireMember(a);

        let slashCollateral = min(m.collateral, self.collateral_required);
        let slashFuture = m.future_locked;
        let slashCredit = m.credit;
        let slashWithdrawable = m.withdrawable;
        let vestingUnreleased = max(0, m.vesting_locked - m.vesting_released);
        let slashVesting = vestingUnreleased;

        m.collateral -= slashCollateral;
        m.future_locked = 0;
        m.credit = 0;
        m.withdrawable = 0;
        m.vesting_locked = 0;
        m.vesting_released = 0;

        self._setMember(a, m);

        penaltyPool += (slashCollateral + slashFuture + slashCredit + slashWithdrawable + slashVesting);
      }
      iSeize += 1;
    }

    // Step 3 distribute to recipients (!defaulter), remainder -> treasury_owed
    let rc: Int = 0;
    let iRc: Int = 0;
    while (iRc < self.members_count) {
      let aOpt = self.member_list.get(iRc);
      requireOrThrow(aOpt != null, 962);
      if (!self._isDefaulter(aOpt!!)) {
        rc += 1;
      }
      iRc += 1;
    }

    if (rc == 0) {
      self.treasury_owed += penaltyPool;
    } else {
      let per = penaltyPool / rc;
      let rem = penaltyPool % rc;
      let iDist: Int = 0;
      while (iDist < self.members_count) {
        let aOpt = self.member_list.get(iDist);
        requireOrThrow(aOpt != null, 963);
        let a = aOpt!!;
        if (!self._isDefaulter(a)) {
          let m = self._requireMember(a);
          m.prefund += per;
          self._setMember(a, m);
        }
        iDist += 1;
      }
      self.treasury_owed += rem;
    }

    self.status = STATUS_TERMINATED;
  }

  // --------------------------
  // Withdrawals (mode-based) + outbox
  // --------------------------

  fun _requireJettonWalletSet() {
    requireOrThrow(self.jetton_wallet != null, ERR_JETTON_WALLET_NOT_SET);
  }

  fun _enqueueOut(queryId: Int, out: PendingOut) {
    self.pending_out.set(queryId, out);
  }

  fun _sendJetton(to: Address, amount: Int, queryId: Int) {
    self._requireJettonWalletSet();
    if (amount <= 0) {
      return;
    }

    let body = beginCell()
      .storeUint(OP_JETTON_TRANSFER, 32)
      .storeUint(queryId, 64)
      .storeCoins(amount)
      .storeAddress(to)
      .storeAddress(myAddress())
      .storeBit(false) // custom_payload = null
      .storeCoins(0) // forward_ton_amount
      .storeBit(true) // forward_payload in ref (Either Cell ^Cell)
      .storeRef(beginCell().endCell())
      .endCell();

    send(SendParameters{
      to: self.jetton_wallet!!,
      value: MIN_WITHDRAW_GAS,
      bounce: true,
      body: body
    });
  }

  fun _withdraw(msg: Slice) {
    let mode = msg.loadUint(8);
    let addr = sender();

    // mode=1: payout-only (allowed in Active + end states)
    if (mode == WITHDRAW_PAYOUT_ONLY) {
      // Caller must attach TON to pay gas for outbound jetton transfer (anti-drain).
      requireOrThrow(context().value >= MIN_WITHDRAW_GAS, 980);
      requireOrThrow(self.status == STATUS_ACTIVE || self.status == STATUS_COMPLETED || self.status == STATUS_TERMINATED || self.status == STATUS_EMERGENCY_STOP, ERR_NOT_WITHDRAWABLE_STATE);
      let m = self._requireMember(addr);
      requireOrThrow(m.withdrawable > 0, ERR_WITHDRAW_EMPTY);

      let qid = self.next_query_id;
      self.next_query_id += 1;

      let amount = m.withdrawable;
      m.withdrawable = 0;
      self._setMember(addr, m);

      self._enqueueOut(qid, PendingOut{
        kind: OUT_USER_PAYOUT_ONLY,
        owner: addr,
        amount: amount,
        had_swap: false,
        removed_index: 0,
        swapped_in: addr,
        restore_collateral: 0,
        restore_prefund: 0,
        restore_treasury_owed: 0
      });

      self._sendJetton(addr, amount, qid);
      return;
    }

    // mode=2: withdraw all (only end states)
    if (mode == WITHDRAW_ALL) {
      // Caller must attach TON to pay gas for outbound jetton transfer (anti-drain).
      requireOrThrow(context().value >= MIN_WITHDRAW_GAS, 980);
      requireOrThrow(self.status == STATUS_COMPLETED || self.status == STATUS_TERMINATED || self.status == STATUS_EMERGENCY_STOP, ERR_NOT_WITHDRAWABLE_STATE);
      let m = self._requireMember(addr);
      let vestingUnreleased = max(0, m.vesting_locked - m.vesting_released);
      let amount = m.collateral + m.prefund + m.credit + m.withdrawable + m.future_locked + vestingUnreleased;
      requireOrThrow(amount > 0, ERR_WITHDRAW_EMPTY);

      let qid = self.next_query_id;
      self.next_query_id += 1;

      // Reset buckets (atomic before transfer)
      m.collateral = 0;
      m.prefund = 0;
      m.credit = 0;
      m.withdrawable = 0;
      m.future_locked = 0;
      m.vesting_locked = 0;
      m.vesting_released = 0;
      self._setMember(addr, m);

      self._enqueueOut(qid, PendingOut{
        kind: OUT_USER_ALL,
        owner: addr,
        amount: amount,
        had_swap: false,
        removed_index: 0,
        swapped_in: addr,
        restore_collateral: 0,
        restore_prefund: amount, // restore to prefund on bounce (safe in end states)
        restore_treasury_owed: 0
      });

      self._sendJetton(addr, amount, qid);
      return;
    }

    // mode=3: recruiting exit (cancel join + withdraw deposits)
    if (mode == WITHDRAW_RECRUITING_EXIT) {
      requireOrThrow(self.status == STATUS_RECRUITING, ERR_NOT_RECRUITING);
      requireOrThrow(!self.recruiting_exit_inflight, ERR_RECRUITING_BUSY);
      let m = self._requireMember(addr);

      let amount = m.collateral + m.prefund;
      // Allow exit even if amount==0

      if (amount > 0) {
        // Caller must attach TON to pay gas for outbound jetton transfer (anti-drain).
        requireOrThrow(context().value >= MIN_WITHDRAW_GAS, 980);
        // Block join/exit races until this refund transfer is confirmed by excesses/bounce.
        self.recruiting_exit_inflight = true;
      }

      let removal = self._removeMemberFromList(addr);
      self.members_count -= 1;

      let restoreCollateral = m.collateral;
      let restorePrefund = m.prefund;

      // Cancel membership + reset buckets
      m.active = false;
      m.has_won = false;
      m.collateral = 0;
      m.prefund = 0;
      m.credit = 0;
      m.withdrawable = 0;
      m.future_locked = 0;
      m.vesting_locked = 0;
      m.vesting_released = 0;
      self._setMember(addr, m);

      if (amount == 0) {
        return;
      }

      // Snapshot for bounce restore
      let qid = self.next_query_id;
      self.next_query_id += 1;

      self._enqueueOut(qid, PendingOut{
        kind: OUT_RECRUITING_EXIT,
        owner: addr,
        amount: amount,
        had_swap: removal.had_swap,
        removed_index: removal.removed_index,
        swapped_in: removal.swapped_in,
        restore_collateral: restoreCollateral,
        restore_prefund: restorePrefund,
        restore_treasury_owed: 0
      });

      self._sendJetton(addr, amount, qid);
      return;
    }

    throw(ERR_WITHDRAW_MODE);
  }

  fun _withdrawTreasury() {
    // Only treasury owner may call.
    requireOrThrow(sender() == self.config.treasury_owner, ERR_NOT_TREASURY);
    requireOrThrow(context().value >= MIN_WITHDRAW_GAS, 981);
    requireOrThrow(self.treasury_owed > 0, ERR_WITHDRAW_EMPTY);

    let qid = self.next_query_id;
    self.next_query_id += 1;

    let amount = self.treasury_owed;
    self.treasury_owed = 0;

    self._enqueueOut(qid, PendingOut{
      kind: OUT_TREASURY,
      owner: self.config.treasury_owner,
      amount: amount,
      had_swap: false,
      removed_index: 0,
      swapped_in: self.config.treasury_owner,
      restore_collateral: 0,
      restore_prefund: 0,
      restore_treasury_owed: amount
    });

    self._sendJetton(self.config.treasury_owner, amount, qid);
  }

  // Bounce handler: restore amounts if jetton transfer fails.
  bounced(msg: Slice) {
    // TON bounced body is commonly: 0xffffffff + 256 bits of original message body,
    // but toolchains may pass either the full bounced body or the kept 256-bit prefix.
    // Accept both forms by treating the first 32 bits as either the bounce prefix or the op.
    let first = msg.loadUint(32);
    let op = first;
    if (first == 0xffffffff) {
      op = msg.loadUint(32);
    }
    if (op != OP_JETTON_TRANSFER) {
      return;
    }
    let qid = msg.loadUint(64);
    let outOpt = self.pending_out.get(qid);
    if (outOpt == null) {
      return;
    }
    let out = outOpt!!;
    self.pending_out.set(qid, null);

    if (out.kind == OUT_USER_PAYOUT_ONLY) {
      let m = self._requireMember(out.owner);
      m.withdrawable += out.amount;
      self._setMember(out.owner, m);
      return;
    }

    if (out.kind == OUT_USER_ALL) {
      let m = self._requireMember(out.owner);
      m.prefund += out.restore_prefund;
      self._setMember(out.owner, m);
      return;
    }

    if (out.kind == OUT_TREASURY) {
      self.treasury_owed += out.restore_treasury_owed;
      return;
    }

    if (out.kind == OUT_RECRUITING_EXIT) {
      // Restore membership list + member balances
      // Recruiting exit uses swap-with-last removal. Restore deterministically:
      // - if removed was last: just push owner back
      // - if swapped: current list has swapped_in at removed_index and missing swapped_in at end;
      //   push swapped_in to end and overwrite removed_index with owner.
      if (!out.had_swap) {
        self.member_list.set(self.members_count, out.owner);
      } else {
        self.member_list.set(self.members_count, out.swapped_in);
        self.member_list.set(out.removed_index, out.owner);
      }
      self.members_count += 1;

      let m = self.members.get(out.owner);
      if (m != null) {
        let mm = m!!;
        mm.active = true;
        mm.has_won = false;
        mm.collateral = out.restore_collateral;
        mm.prefund = out.restore_prefund;
        self._setMember(out.owner, mm);
      }
      self.recruiting_exit_inflight = false;
      return;
    }
  }

  // --------------------------
  // Emergency stop
  // --------------------------

  fun _emergencyStop(msg: Slice) {
    // Body: reason:uint32 exp:uint32 nonce:uint64 sig:bits512
    let reason = msg.loadUint(32);
    let exp = msg.loadUint(32);
    let nonce = msg.loadUint(64);
    let sig = msg.loadBits(512);

    requireOrThrow(self._now() <= exp, ERR_STOP_EXPIRED);

    let key = self._nonceKey(myAddress(), nonce);
    let used = self.used_nonces.get(key);
    requireOrThrow(used == null || !used!!, ERR_STOP_NONCE_USED);

    let h = self._hashStop(reason, exp, nonce);
    requireOrThrow(self._verifySig(h, sig, self.config.guardian_pubkey), ERR_STOP_SIG_INVALID);

    self.used_nonces.set(key, true);
    self.status = STATUS_EMERGENCY_STOP;
  }

  // --------------------------
  // Get methods (UI/Indexer)
  // --------------------------

  get fun get_config(): Config {
    return self.config;
  }

  get fun get_status(): StatusView {
    return StatusView{
      status: self.status,
      current_cycle: self.current_cycle,
      phase: self.phase,
      due_at: self.due_at,
      grace_end_at: self.grace_end_at,
      commit_end_at: self.commit_end_at,
      reveal_end_at: self.reveal_end_at,
      funded_count: self.funded_count
    };
  }

  get fun get_jetton_wallet(): Address? {
    return self.jetton_wallet;
  }

  get fun get_members_count(): Int {
    return self.members_count;
  }

  get fun get_treasury_owed(): Int {
    return self.treasury_owed;
  }

  get fun get_member_at(index: Int): Address {
    let a = self.member_list.get(index);
    requireOrThrow(a != null, 990);
    return a!!;
  }

  get fun get_member(addr: Address): MemberView {
    let m = self.members.get(addr);
    if (m == null) {
      return MemberView{
        active: false,
        has_won: false,
        collateral: 0,
        prefund: 0,
        credit: 0,
        vesting_locked: 0,
        vesting_released: 0,
        future_locked: 0,
        withdrawable: 0,
        due_remaining: 0
      };
    }
    let mm = m!!;
    let dueOpt = self.due_remaining.get(addr);
    let due = (dueOpt == null) ? 0 : dueOpt!!;
    return MemberView{
      active: mm.active,
      has_won: mm.has_won,
      collateral: mm.collateral,
      prefund: mm.prefund,
      credit: mm.credit,
      vesting_locked: mm.vesting_locked,
      vesting_released: mm.vesting_released,
      future_locked: mm.future_locked,
      withdrawable: mm.withdrawable,
      due_remaining: due
    };
  }
}
