// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaylockEscrow} from "../contracts/PaylockEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("m", "m") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title Handler
 * @notice Wraps PaylockEscrow calls for invariant fuzzing. The invariant
 *         runner calls these public functions with random calldata;
 *         the handler guards against obvious reverts so the fuzzer spends
 *         its budget on interesting state transitions.
 */
contract Handler is Test {
    PaylockEscrow public immutable escrow;
    MockUSDC      public immutable usdc;
    address       public immutable admin;
    address       public immutable treasury;

    // Actors used by handler. We keep a small fixed set so the fuzzer
    // re-uses addresses (creates more interesting multi-call sequences).
    address[] public buyers;
    address[] public sellers;

    // Track created IDs so the handler can also exercise downstream funcs.
    bytes32[] public createdIds;

    uint256 public constant MAX_LOCKED = 1_000_000e6;

    constructor(PaylockEscrow e, MockUSDC u, address a, address t) {
        escrow = e; usdc = u; admin = a; treasury = t;

        // Create 3 buyers and 3 sellers — fixed actor pool.
        for (uint256 i = 0; i < 3; i++) {
            address b = address(uint160(uint256(keccak256(abi.encode("buyer", i)))));
            buyers.push(b);
            usdc.mint(b, 10_000_000e6);
            vm.prank(b);
            usdc.approve(address(escrow), type(uint256).max);
        }
        for (uint256 i = 0; i < 3; i++) {
            sellers.push(address(uint160(uint256(keccak256(abi.encode("seller", i))))));
        }
    }

    function idCount() external view returns (uint256) { return createdIds.length; }

    // ── handler actions (randomly called by invariant runner) ──────────────

    function hCreate(uint256 bIdx, uint256 sIdx, uint256 amount, uint256 deadlineOffset) external {
        address b = buyers[bound(bIdx, 0, buyers.length - 1)];
        address s = sellers[bound(sIdx, 0, sellers.length - 1)];
        amount = bound(amount, 1, MAX_LOCKED);
        deadlineOffset = bound(deadlineOffset, 1, 30 days);
        bytes32 id = keccak256(abi.encode(block.timestamp, createdIds.length, b));
        vm.prank(b);
        try escrow.createEscrow(id, s, "g", keccak256(abi.encode(id)), amount, block.timestamp + deadlineOffset) {
            createdIds.push(id);
        } catch {}
    }

    function hDeposit(uint256 idIdx) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        (address buyer_, , , , , , , PaylockEscrow.Status st, , , , , ) = escrow.escrows(id);
        if (st != PaylockEscrow.Status.Created) return;
        vm.prank(buyer_);
        try escrow.deposit(id) {} catch {}
    }

    function hSubmit(uint256 idIdx) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        (, address seller_, , , , bytes32 deliveryHash, , PaylockEscrow.Status st, , , , , ) = escrow.escrows(id);
        if (st != PaylockEscrow.Status.Funded) return;
        vm.prank(seller_);
        try escrow.submitDelivery(id, deliveryHash) {} catch {}
    }

    function hRelease(uint256 idIdx) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        try escrow.release(id) {} catch {}
    }

    function hDispute(uint256 idIdx, uint256 actorPick) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        (address buyer_, address seller_, , , , , , PaylockEscrow.Status st, , , , , ) = escrow.escrows(id);
        if (st != PaylockEscrow.Status.Funded && st != PaylockEscrow.Status.Delivered) return;
        address caller = actorPick % 2 == 0 ? buyer_ : seller_;
        vm.prank(caller);
        try escrow.dispute(id, "r") {} catch {}
    }

    function hResolve(uint256 idIdx, uint256 buyerBps) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        buyerBps = bound(buyerBps, 0, 10_000);
        vm.prank(admin);
        try escrow.resolveDispute(id, buyerBps) {} catch {}
    }

    function hRefund(uint256 idIdx, uint256 warpSecs) external {
        if (createdIds.length == 0) return;
        bytes32 id = createdIds[bound(idIdx, 0, createdIds.length - 1)];
        (, , , , uint256 deadline_, , , PaylockEscrow.Status st, , , , , ) = escrow.escrows(id);
        if (st != PaylockEscrow.Status.Funded) return;
        warpSecs = bound(warpSecs, 48 hours + 1, 90 days);
        vm.warp(deadline_ + warpSecs);
        try escrow.refund(id) {} catch {}
    }
}

contract PaylockEscrowInvariantTest is Test {
    PaylockEscrow internal escrow;
    MockUSDC      internal usdc;
    Handler       internal handler;
    address internal admin    = makeAddr("admin");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        usdc    = new MockUSDC();
        escrow  = new PaylockEscrow(IERC20(address(usdc)), admin, treasury, 1_000_000e6);
        handler = new Handler(escrow, usdc, admin, treasury);

        // Tell invariant runner to only call through the handler (avoids
        // wasted runs on random addresses calling admin-only funcs).
        targetContract(address(handler));
    }

    /// @notice Fund-solvency invariant:
    ///   The contract must always hold at least `totalLocked` USDC.
    function invariant_solvency() public view {
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLocked());
    }

    /// @notice totalLocked must never exceed maxLocked.
    function invariant_maxLockedRespected() public view {
        assertLe(escrow.totalLocked(), escrow.maxLocked());
    }

    /// @notice totalLocked must equal the sum of currently-escrowed amounts
    ///         (only Funded/Delivered/Disputed count as "locked" — others are
    ///         either un-funded or already paid out).
    function invariant_totalLockedMatchesSum() public view {
        uint256 sum;
        uint256 n = handler.idCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.createdIds(i);
            (, , uint256 amount, , , , , PaylockEscrow.Status st, , , , , ) = escrow.escrows(id);
            if (st == PaylockEscrow.Status.Funded ||
                st == PaylockEscrow.Status.Delivered ||
                st == PaylockEscrow.Status.Disputed) {
                sum += amount;
            }
        }
        assertEq(sum, escrow.totalLocked());
    }
}
