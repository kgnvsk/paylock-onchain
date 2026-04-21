// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PaylockEscrow
 * @notice EVM parity of the PayLock Solana Anchor program. Holds USDC between
 *         a buyer and seller, releases on matching delivery-hash proof, with
 *         admin dispute resolution and permissionless post-deadline refund.
 *
 * @dev State machine (parity with Solana program statuses):
 *          Created -> Funded -> Delivered -> Released
 *                  \        \-> Disputed -> Resolved
 *                   \-> Cancelled                      (pre-funding)
 *                       Funded -> Refunded             (post-deadline timeout)
 *
 *      Security primitives: ReentrancyGuard on all token-moving paths;
 *      SafeERC20 for USDC (USDC returns bool, not revert); Pausable for
 *      emergency halt; admin role (single address, no renounce); maxLocked
 *      cap to bound blast-radius on admin-key compromise.
 *
 *      Fee: 2% of amount (FEE_BPS = 200 / 10_000) -- parity with Solana.
 *
 *      ID: bytes32, off-chain generated (UUID-derived). No MEV / front-run
 *      value since IDs are private to the requester.
 */
contract PaylockEscrow is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ────────────────────────────────────────────────────────────────────────
    // Constants (parity with Solana program)
    // ────────────────────────────────────────────────────────────────────────

    uint256 public constant FEE_BPS = 200;                    // 2%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_DESCRIPTION_LEN = 256;
    uint256 public constant CHALLENGE_WINDOW = 48 hours;      // post-deadline grace

    // ────────────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────────────

    enum Status {
        None,        // 0 — id never used (sentinel for non-existent)
        Created,     // 1 — createEscrow called, awaiting deposit
        Funded,      // 2 — USDC locked, awaiting delivery
        Delivered,   // 3 — seller submitted verifyHash
        Released,    // 4 — paid out to seller
        Disputed,    // 5 — buyer or seller opened dispute
        Resolved,    // 6 — admin settled dispute (funds out)
        Cancelled,   // 7 — pre-funding cancellation (no funds moved)
        Refunded     // 8 — post-deadline timeout refund to buyer
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;           // USDC 6-decimal base units
        uint256 feeBps;           // snapshot at create time (future-proofs rate changes)
        uint256 deadline;         // unix seconds
        bytes32 deliveryHash;     // sha256 of expected delivery (set by buyer)
        bytes32 verifyHash;       // submitted by seller; equal to deliveryHash => release
        Status  status;
        uint64  createdAt;
        uint64  fundedAt;
        uint64  deliveredAt;
        uint64  closedAt;         // set at Released/Resolved/Cancelled/Refunded
        string  description;      // <= 256 chars
    }

    IERC20  public immutable usdc;
    address public admin;
    address public treasury;
    uint256 public maxLocked;                              // cap on sum(amount) over Funded+Delivered+Disputed
    uint256 public totalLocked;                            // current locked amount (invariant: <= usdc.balanceOf(this))

    mapping(bytes32 => Escrow) public escrows;

    // ────────────────────────────────────────────────────────────────────────
    // Events (one per status transition — indexer relies on these)
    // ────────────────────────────────────────────────────────────────────────

    event EscrowCreated(
        bytes32 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 deadline,
        bytes32 deliveryHash
    );
    event Deposited(bytes32 indexed id, address indexed buyer, uint256 amount);
    event DeliverySubmitted(bytes32 indexed id, bytes32 verifyHash);
    event Released(bytes32 indexed id, uint256 paidToSeller, uint256 fee);
    event Disputed(bytes32 indexed id, address indexed actor, string reason);
    event Resolved(bytes32 indexed id, uint256 buyerShareBps, uint256 toBuyer, uint256 toSeller, uint256 fee);
    event Cancelled(bytes32 indexed id);
    event Refunded(bytes32 indexed id, uint256 returnedToBuyer);

    event AdminChanged(address indexed from, address indexed to);
    event TreasuryChanged(address indexed from, address indexed to);
    event MaxLockedChanged(uint256 from, uint256 to);

    // ────────────────────────────────────────────────────────────────────────
    // Errors (cheaper than require strings; explicit for caller)
    // ────────────────────────────────────────────────────────────────────────

    error NotAdmin();
    error ZeroAddress();
    error InvalidAmount();
    error DescriptionTooLong();
    error DeadlinePast();
    error DuplicateId();
    error UnknownId();
    error WrongStatus(Status expected, Status actual);
    error MaxLockedExceeded();
    error NotBuyer();
    error NotSeller();
    error NotParty();
    error HashMismatch();
    error DeadlineNotReached();
    error ChallengeWindowActive();
    error InvalidBps();

    // ────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ────────────────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Constructor
    // ────────────────────────────────────────────────────────────────────────

    constructor(IERC20 usdc_, address admin_, address treasury_, uint256 maxLocked_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        admin = admin_;
        treasury = treasury_;
        maxLocked = maxLocked_;
        emit AdminChanged(address(0), admin_);
        emit TreasuryChanged(address(0), treasury_);
        emit MaxLockedChanged(0, maxLocked_);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Admin ops
    // ────────────────────────────────────────────────────────────────────────

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    function setTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setMaxLocked(uint256 newMaxLocked) external onlyAdmin {
        emit MaxLockedChanged(maxLocked, newMaxLocked);
        maxLocked = newMaxLocked;
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Core flows — parity with Solana instructions
    // ────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a new escrow record. No tokens move here; buyer must call
     *         {deposit} next. Parity with Solana `create_escrow`.
     * @param id              caller-provided unique identifier
     * @param seller          recipient on release
     * @param description     free-text (≤ 256 bytes)
     * @param deliveryHash    sha256 of expected delivery (buyer-authored)
     * @param amount          USDC base units (6 decimals)
     * @param deadline        unix timestamp; refund permissionless after deadline + CHALLENGE_WINDOW
     */
    function createEscrow(
        bytes32 id,
        address seller,
        string calldata description,
        bytes32 deliveryHash,
        uint256 amount,
        uint256 deadline
    ) external whenNotPaused {
        if (escrows[id].status != Status.None) revert DuplicateId();
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender) revert NotParty();          // self-hire
        if (amount == 0) revert InvalidAmount();
        if (bytes(description).length > MAX_DESCRIPTION_LEN) revert DescriptionTooLong();
        if (deadline <= block.timestamp) revert DeadlinePast();
        if (deliveryHash == bytes32(0)) revert HashMismatch();

        escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            feeBps: FEE_BPS,
            deadline: deadline,
            deliveryHash: deliveryHash,
            verifyHash: bytes32(0),
            status: Status.Created,
            createdAt: uint64(block.timestamp),
            fundedAt: 0,
            deliveredAt: 0,
            closedAt: 0,
            description: description
        });

        emit EscrowCreated(id, msg.sender, seller, amount, deadline, deliveryHash);
    }

    /**
     * @notice Pull USDC from buyer and lock into the contract. Parity with
     *         Solana `fund_escrow`. Buyer must {approve} first.
     */
    function deposit(bytes32 id) external nonReentrant whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Created) revert WrongStatus(Status.Created, e.status);
        if (msg.sender != e.buyer) revert NotBuyer();

        // Cap check BEFORE pulling funds.
        if (totalLocked + e.amount > maxLocked) revert MaxLockedExceeded();

        // Effects first (CEI pattern).
        e.status = Status.Funded;
        e.fundedAt = uint64(block.timestamp);
        totalLocked += e.amount;

        // Interaction last.
        usdc.safeTransferFrom(msg.sender, address(this), e.amount);

        emit Deposited(id, msg.sender, e.amount);
    }

    /**
     * @notice Seller submits proof-of-delivery hash. Parity with Solana
     *         `submit_delivery`. Moves Funded -> Delivered; does NOT release
     *         yet — admin or automatic trigger calls {release}.
     */
    function submitDelivery(bytes32 id, bytes32 verifyHash) external whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Funded) revert WrongStatus(Status.Funded, e.status);
        if (msg.sender != e.seller) revert NotSeller();
        if (verifyHash == bytes32(0)) revert HashMismatch();

        e.verifyHash = verifyHash;
        e.status = Status.Delivered;
        e.deliveredAt = uint64(block.timestamp);

        emit DeliverySubmitted(id, verifyHash);
    }

    /**
     * @notice Release funds to seller once verifyHash matches deliveryHash.
     *         Anyone can call (permissionless) — the hash check is the gate.
     *         Parity with Solana `release_escrow`. Fee goes to treasury.
     */
    function release(bytes32 id) external nonReentrant whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Delivered) revert WrongStatus(Status.Delivered, e.status);
        if (e.verifyHash != e.deliveryHash) revert HashMismatch();

        uint256 fee = (e.amount * e.feeBps) / BPS_DENOMINATOR;
        uint256 paidToSeller = e.amount - fee;

        // Effects.
        e.status = Status.Released;
        e.closedAt = uint64(block.timestamp);
        totalLocked -= e.amount;

        // Interactions (treasury first — smaller amount; then seller — larger).
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        usdc.safeTransfer(e.seller, paidToSeller);

        emit Released(id, paidToSeller, fee);
    }

    /**
     * @notice Buyer or seller opens a dispute. Funds stay locked until admin
     *         resolves. Parity with Solana `dispute_escrow`. Valid from
     *         Funded or Delivered.
     */
    function dispute(bytes32 id, string calldata reason) external whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Funded && e.status != Status.Delivered) {
            revert WrongStatus(Status.Funded, e.status);   // expected = Funded OR Delivered (report one)
        }
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParty();
        if (bytes(reason).length > MAX_DESCRIPTION_LEN) revert DescriptionTooLong();

        e.status = Status.Disputed;
        emit Disputed(id, msg.sender, reason);
    }

    /**
     * @notice Admin resolves a dispute by splitting funds. Parity with Solana
     *         `resolve_dispute`. `buyerShareBps` + seller share = 10_000.
     *         Fee still deducted (from seller portion).
     */
    function resolveDispute(bytes32 id, uint256 buyerShareBps) external onlyAdmin nonReentrant whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Disputed) revert WrongStatus(Status.Disputed, e.status);
        if (buyerShareBps > BPS_DENOMINATOR) revert InvalidBps();

        uint256 toBuyer = (e.amount * buyerShareBps) / BPS_DENOMINATOR;
        uint256 sellerShare = e.amount - toBuyer;
        uint256 fee = (sellerShare * e.feeBps) / BPS_DENOMINATOR;
        uint256 toSeller = sellerShare - fee;

        // Effects.
        e.status = Status.Resolved;
        e.closedAt = uint64(block.timestamp);
        totalLocked -= e.amount;

        // Interactions.
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        if (toSeller > 0) usdc.safeTransfer(e.seller, toSeller);
        if (toBuyer > 0) usdc.safeTransfer(e.buyer, toBuyer);

        emit Resolved(id, buyerShareBps, toBuyer, toSeller, fee);
    }

    /**
     * @notice Cancel before funding. Only from Created. Parity with Solana
     *         `cancel_escrow`. Either party can call.
     */
    function cancel(bytes32 id) external whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Created) revert WrongStatus(Status.Created, e.status);
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParty();

        e.status = Status.Cancelled;
        e.closedAt = uint64(block.timestamp);
        emit Cancelled(id);
    }

    /**
     * @notice Permissionless refund after deadline + challenge window.
     *         Only valid from Funded (buyer hasn't received delivery).
     *         Not in original Solana instruction set as a separate ix — there
     *         it happens via `cancel_escrow` deadline check; here we split
     *         pre-fund cancel from post-deadline refund for clarity.
     */
    function refund(bytes32 id) external nonReentrant whenNotPaused {
        Escrow storage e = escrows[id];
        if (e.status == Status.None) revert UnknownId();
        if (e.status != Status.Funded) revert WrongStatus(Status.Funded, e.status);
        if (block.timestamp <= e.deadline + CHALLENGE_WINDOW) revert ChallengeWindowActive();

        // Effects.
        e.status = Status.Refunded;
        e.closedAt = uint64(block.timestamp);
        totalLocked -= e.amount;

        // Interaction.
        usdc.safeTransfer(e.buyer, e.amount);

        emit Refunded(id, e.amount);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Views
    // ────────────────────────────────────────────────────────────────────────

    /**
     * @notice Free USDC balance held by this contract that is NOT backing a
     *         current escrow (e.g. accidental direct transfers). Admin can
     *         sweep via {sweepDust}.
     */
    function dust() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > totalLocked ? bal - totalLocked : 0;
    }

    /**
     * @notice Sweep dust USDC to treasury. Cannot touch locked funds because
     *         `dust()` subtracts totalLocked.
     */
    function sweepDust() external onlyAdmin nonReentrant {
        uint256 d = dust();
        if (d > 0) usdc.safeTransfer(treasury, d);
    }
}
