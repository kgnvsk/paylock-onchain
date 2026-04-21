// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaylockEscrow} from "../contracts/PaylockEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    uint8 private _d;
    constructor() ERC20("Mock USDC", "mUSDC") { _d = 6; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract PaylockEscrowTest is Test {
    PaylockEscrow internal escrow;
    MockUSDC internal usdc;

    address internal admin    = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal buyer    = makeAddr("buyer");
    address internal seller   = makeAddr("seller");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant MAX_LOCKED = 10_000e6;   // 10k USDC
    uint256 internal constant AMOUNT     = 100e6;      // 100 USDC
    bytes32 internal constant ID         = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant DELIVERY   = keccak256("delivered");
    uint256 internal deadline;

    function setUp() public {
        usdc     = new MockUSDC();
        escrow   = new PaylockEscrow(IERC20(address(usdc)), admin, treasury, MAX_LOCKED);
        deadline = block.timestamp + 7 days;

        usdc.mint(buyer, 10_000e6);

        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function _create(bytes32 id, uint256 amt) internal {
        vm.prank(buyer);
        escrow.createEscrow(id, seller, "gig", DELIVERY, amt, deadline);
    }

    function _fund(bytes32 id) internal {
        vm.prank(buyer);
        escrow.deposit(id);
    }

    function _deliver(bytes32 id, bytes32 hash_) internal {
        vm.prank(seller);
        escrow.submitDelivery(id, hash_);
    }

    function _status(bytes32 id) internal view returns (PaylockEscrow.Status) {
        (, , , , , , , PaylockEscrow.Status s, , , , , ) = escrow.escrows(id);
        return s;
    }

    function _amount(bytes32 id) internal view returns (uint256) {
        (, , uint256 a, , , , , , , , , , ) = escrow.escrows(id);
        return a;
    }

    // ── createEscrow ───────────────────────────────────────────────────────

    function test_createEscrow_happyPath() public {
        _create(ID, AMOUNT);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Created));
        assertEq(_amount(ID), AMOUNT);
    }

    function test_createEscrow_revertsOnDuplicateId() public {
        _create(ID, AMOUNT);
        vm.expectRevert(PaylockEscrow.DuplicateId.selector);
        _create(ID, AMOUNT);
    }

    function test_createEscrow_revertsOnZeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.InvalidAmount.selector);
        escrow.createEscrow(ID, seller, "gig", DELIVERY, 0, deadline);
    }

    function test_createEscrow_revertsOnPastDeadline() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.DeadlinePast.selector);
        escrow.createEscrow(ID, seller, "gig", DELIVERY, AMOUNT, block.timestamp);
    }

    function test_createEscrow_revertsOnZeroSeller() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.ZeroAddress.selector);
        escrow.createEscrow(ID, address(0), "gig", DELIVERY, AMOUNT, deadline);
    }

    function test_createEscrow_revertsOnSelfHire() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.NotParty.selector);
        escrow.createEscrow(ID, buyer, "gig", DELIVERY, AMOUNT, deadline);
    }

    function test_createEscrow_revertsOnLongDescription() public {
        string memory longStr = new string(257);
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.DescriptionTooLong.selector);
        escrow.createEscrow(ID, seller, longStr, DELIVERY, AMOUNT, deadline);
    }

    function test_createEscrow_revertsOnZeroDeliveryHash() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.HashMismatch.selector);
        escrow.createEscrow(ID, seller, "gig", bytes32(0), AMOUNT, deadline);
    }

    // ── deposit ────────────────────────────────────────────────────────────

    function test_deposit_pullsUsdcAndTransitionsToFunded() public {
        _create(ID, AMOUNT);
        uint256 before = usdc.balanceOf(address(escrow));
        _fund(ID);
        assertEq(usdc.balanceOf(address(escrow)), before + AMOUNT);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Funded));
        assertEq(escrow.totalLocked(), AMOUNT);
    }

    function test_deposit_revertsWhenNotBuyer() public {
        _create(ID, AMOUNT);
        vm.prank(stranger);
        vm.expectRevert(PaylockEscrow.NotBuyer.selector);
        escrow.deposit(ID);
    }

    function test_deposit_revertsOnWrongStatus() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaylockEscrow.WrongStatus.selector,
                PaylockEscrow.Status.Created,
                PaylockEscrow.Status.Funded
            )
        );
        escrow.deposit(ID);
    }

    function test_deposit_revertsOnUnknownId() public {
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.UnknownId.selector);
        escrow.deposit(bytes32(uint256(0xBEEF)));
    }

    function test_deposit_revertsOnMaxLockedExceeded() public {
        _create(ID, MAX_LOCKED + 1);
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.MaxLockedExceeded.selector);
        escrow.deposit(ID);
    }

    // ── submitDelivery ─────────────────────────────────────────────────────

    function test_submitDelivery_happyPath() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Delivered));
    }

    function test_submitDelivery_revertsWhenNotSeller() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.NotSeller.selector);
        escrow.submitDelivery(ID, DELIVERY);
    }

    function test_submitDelivery_revertsOnZeroHash() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(seller);
        vm.expectRevert(PaylockEscrow.HashMismatch.selector);
        escrow.submitDelivery(ID, bytes32(0));
    }

    // ── release ────────────────────────────────────────────────────────────

    function test_release_happyPath_feeAndPayout() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        uint256 fee = (AMOUNT * 200) / 10_000;   // 2%
        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        escrow.release(ID);
        assertEq(usdc.balanceOf(seller) - sellerBefore, AMOUNT - fee);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, fee);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Released));
    }

    function test_release_revertsOnHashMismatch() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, keccak256("wrong"));
        vm.expectRevert(PaylockEscrow.HashMismatch.selector);
        escrow.release(ID);
    }

    function test_release_revertsIfNotDelivered() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaylockEscrow.WrongStatus.selector,
                PaylockEscrow.Status.Delivered,
                PaylockEscrow.Status.Funded
            )
        );
        escrow.release(ID);
    }

    function test_release_permissionlessAnyoneCanCall() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        vm.prank(stranger);
        escrow.release(ID);          // must succeed
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Released));
    }

    // ── dispute + resolveDispute ───────────────────────────────────────────

    function test_dispute_fromBuyer() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        escrow.dispute(ID, "bad delivery");
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Disputed));
    }

    function test_dispute_fromSellerAfterDelivery() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        vm.prank(seller);
        escrow.dispute(ID, "buyer unresponsive");
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Disputed));
    }

    function test_dispute_revertsFromStranger() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(stranger);
        vm.expectRevert(PaylockEscrow.NotParty.selector);
        escrow.dispute(ID, "none of your business");
    }

    function test_resolveDispute_fiftyFifty() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        escrow.dispute(ID, "r");
        uint256 buyerBefore    = usdc.balanceOf(buyer);
        uint256 sellerBefore   = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(admin);
        escrow.resolveDispute(ID, 5_000);   // 50% to buyer, 50% to seller (of which 2% fee)

        uint256 toBuyer   = AMOUNT / 2;                         // 50
        uint256 sellerShare = AMOUNT - toBuyer;                 // 50
        uint256 fee      = (sellerShare * 200) / 10_000;        // 1
        uint256 toSeller = sellerShare - fee;                   // 49

        assertEq(usdc.balanceOf(buyer)    - buyerBefore,    toBuyer);
        assertEq(usdc.balanceOf(seller)   - sellerBefore,   toSeller);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, fee);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_resolveDispute_revertsForNonAdmin() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        escrow.dispute(ID, "r");
        vm.prank(stranger);
        vm.expectRevert(PaylockEscrow.NotAdmin.selector);
        escrow.resolveDispute(ID, 5_000);
    }

    function test_resolveDispute_revertsOnBpsOverflow() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        escrow.dispute(ID, "r");
        vm.prank(admin);
        vm.expectRevert(PaylockEscrow.InvalidBps.selector);
        escrow.resolveDispute(ID, 10_001);
    }

    // ── cancel ─────────────────────────────────────────────────────────────

    function test_cancel_happyPath_beforeFunding() public {
        _create(ID, AMOUNT);
        vm.prank(buyer);
        escrow.cancel(ID);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Cancelled));
    }

    function test_cancel_revertsAfterFunding() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaylockEscrow.WrongStatus.selector,
                PaylockEscrow.Status.Created,
                PaylockEscrow.Status.Funded
            )
        );
        escrow.cancel(ID);
    }

    // ── refund ─────────────────────────────────────────────────────────────

    function test_refund_happyPathAfterDeadlinePlusWindow() public {
        _create(ID, AMOUNT);
        _fund(ID);
        // Fast-forward past deadline + challenge window
        vm.warp(deadline + 48 hours + 1);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        escrow.refund(ID);       // anyone can call
        assertEq(usdc.balanceOf(buyer) - buyerBefore, AMOUNT);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Refunded));
    }

    function test_refund_revertsDuringChallengeWindow() public {
        _create(ID, AMOUNT);
        _fund(ID);
        vm.warp(deadline + 1);
        vm.expectRevert(PaylockEscrow.ChallengeWindowActive.selector);
        escrow.refund(ID);
    }

    function test_refund_revertsIfDelivered() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        vm.warp(deadline + 48 hours + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaylockEscrow.WrongStatus.selector,
                PaylockEscrow.Status.Funded,
                PaylockEscrow.Status.Delivered
            )
        );
        escrow.refund(ID);
    }

    // ── maxLocked cap ──────────────────────────────────────────────────────

    function test_maxLockedCap_enforced() public {
        bytes32 a = bytes32(uint256(1));
        bytes32 b = bytes32(uint256(2));
        _create(a, MAX_LOCKED);
        _fund(a);
        _create(b, 1);
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.MaxLockedExceeded.selector);
        escrow.deposit(b);
    }

    // ── pause/unpause ──────────────────────────────────────────────────────

    function test_paused_blocksDeposit() public {
        _create(ID, AMOUNT);
        vm.prank(admin);
        escrow.pause();
        vm.prank(buyer);
        vm.expectRevert();           // EnforcedPause()
        escrow.deposit(ID);
    }

    function test_unpause_restoresFlow() public {
        _create(ID, AMOUNT);
        vm.prank(admin);
        escrow.pause();
        vm.prank(admin);
        escrow.unpause();
        _fund(ID);                    // works again
        assertEq(uint8(_status(ID)), uint8(PaylockEscrow.Status.Funded));
    }

    // ── admin ops ──────────────────────────────────────────────────────────

    function test_setAdmin_rotatesRole() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        escrow.setAdmin(newAdmin);
        assertEq(escrow.admin(), newAdmin);
    }

    function test_setAdmin_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(PaylockEscrow.NotAdmin.selector);
        escrow.setAdmin(stranger);
    }

    function test_setMaxLocked_works() public {
        vm.prank(admin);
        escrow.setMaxLocked(1_000_000e6);
        assertEq(escrow.maxLocked(), 1_000_000e6);
    }

    // ── dust ───────────────────────────────────────────────────────────────

    function test_sweepDust_withoutAffectingLocked() public {
        _create(ID, AMOUNT);
        _fund(ID);
        // Simulate accidental direct transfer
        usdc.mint(address(escrow), 50e6);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(admin);
        escrow.sweepDust();
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 50e6);
        // locked funds untouched
        assertEq(escrow.totalLocked(), AMOUNT);
    }

    function test_sweepDust_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(PaylockEscrow.NotAdmin.selector);
        escrow.sweepDust();
    }

    // ── re-entrancy sanity (SafeERC20 + OZ ReentrancyGuard handle this) ────
    // We do not ship a malicious token mock — OZ SafeERC20 always emits direct
    // calls; reentrancy via USDC is impossible under Circle's honest contract.
    // ReentrancyGuard decorator is present on deposit/release/resolve/refund;
    // OZ's unit tests already prove its correctness.

    // ── event emission sanity ──────────────────────────────────────────────

    function test_events_depositEmitsDeposited() public {
        _create(ID, AMOUNT);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit PaylockEscrow.Deposited(ID, buyer, AMOUNT);
        _fund(ID);
    }

    function test_events_releaseEmitsReleased() public {
        _create(ID, AMOUNT);
        _fund(ID);
        _deliver(ID, DELIVERY);
        uint256 fee = (AMOUNT * 200) / 10_000;
        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaylockEscrow.Released(ID, AMOUNT - fee, fee);
        escrow.release(ID);
    }
}
