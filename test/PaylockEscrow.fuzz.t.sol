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
 * @title PaylockEscrowFuzz
 * @notice Property-based tests. Each test asserts invariants under any input
 *         within a reasonable domain. Runs 1000x per test (see foundry.toml).
 */
contract PaylockEscrowFuzzTest is Test {
    PaylockEscrow internal escrow;
    MockUSDC      internal usdc;
    address internal admin    = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal buyer    = makeAddr("buyer");
    address internal seller   = makeAddr("seller");

    uint256 internal constant MAX_LOCKED = type(uint128).max;  // large — let fuzz explore freely

    function setUp() public {
        usdc   = new MockUSDC();
        escrow = new PaylockEscrow(IERC20(address(usdc)), admin, treasury, MAX_LOCKED);
        usdc.mint(buyer, MAX_LOCKED);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // Fuzz 1: any positive amount within cap goes through deposit cleanly.
    function testFuzz_deposit_succeedsForAnyValidAmount(uint256 amount, uint64 deadlineOffset) public {
        amount = bound(amount, 1, MAX_LOCKED);
        deadlineOffset = uint64(bound(deadlineOffset, 1, 365 days));
        bytes32 id = keccak256(abi.encode(amount, deadlineOffset));

        vm.prank(buyer);
        escrow.createEscrow(id, seller, "x", keccak256("d"), amount, block.timestamp + deadlineOffset);

        vm.prank(buyer);
        escrow.deposit(id);

        assertEq(escrow.totalLocked(), amount);
        assertEq(usdc.balanceOf(address(escrow)), amount);
    }

    // Fuzz 2: release math — seller gets (amount - 2%), treasury gets 2%.
    function testFuzz_release_feeMathAlwaysCorrect(uint256 amount) public {
        amount = bound(amount, 100, MAX_LOCKED);             // >=100 so fee >= 2 units
        bytes32 id = keccak256(abi.encode(amount));

        vm.prank(buyer);
        escrow.createEscrow(id, seller, "x", keccak256("d"), amount, block.timestamp + 7 days);
        vm.prank(buyer);
        escrow.deposit(id);
        vm.prank(seller);
        escrow.submitDelivery(id, keccak256("d"));

        uint256 expectedFee = (amount * 200) / 10_000;
        uint256 sellerBefore   = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        escrow.release(id);

        assertEq(usdc.balanceOf(seller)   - sellerBefore,   amount - expectedFee);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, expectedFee);
        assertEq(escrow.totalLocked(), 0);
    }

    // Fuzz 3: resolveDispute BPS split — no over-/under-flow, sum conservation.
    function testFuzz_resolveDispute_bpsSplitConservesFunds(uint256 amount, uint256 buyerBps) public {
        amount   = bound(amount, 100, MAX_LOCKED);
        buyerBps = bound(buyerBps, 0, 10_000);

        bytes32 id = keccak256(abi.encode(amount, buyerBps));
        vm.prank(buyer);
        escrow.createEscrow(id, seller, "x", keccak256("d"), amount, block.timestamp + 7 days);
        vm.prank(buyer);
        escrow.deposit(id);
        vm.prank(buyer);
        escrow.dispute(id, "r");

        uint256 buyerBefore    = usdc.balanceOf(buyer);
        uint256 sellerBefore   = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(admin);
        escrow.resolveDispute(id, buyerBps);

        uint256 toBuyer   = (amount * buyerBps) / 10_000;
        uint256 sShare    = amount - toBuyer;
        uint256 fee       = (sShare * 200) / 10_000;
        uint256 toSeller  = sShare - fee;

        assertEq(usdc.balanceOf(buyer)    - buyerBefore,    toBuyer);
        assertEq(usdc.balanceOf(seller)   - sellerBefore,   toSeller);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, fee);
        // Conservation: sum of outputs equals input.
        assertEq(toBuyer + toSeller + fee, amount);
        assertEq(escrow.totalLocked(), 0);
    }

    // Fuzz 4: refund returns exactly `amount`, not a cent more or less.
    function testFuzz_refund_returnsExactAmount(uint256 amount) public {
        amount = bound(amount, 1, MAX_LOCKED);
        bytes32 id = keccak256(abi.encode(amount));
        uint256 dline = block.timestamp + 7 days;

        vm.prank(buyer);
        escrow.createEscrow(id, seller, "x", keccak256("d"), amount, dline);
        vm.prank(buyer);
        escrow.deposit(id);

        vm.warp(dline + 48 hours + 1);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        escrow.refund(id);
        assertEq(usdc.balanceOf(buyer) - buyerBefore, amount);
        assertEq(escrow.totalLocked(), 0);
    }

    // Fuzz 5: Past-or-present deadline createEscrow always reverts.
    //         Uses unsigned offset + subtraction from current time, so the
    //         deadline is always <= block.timestamp.
    function testFuzz_createEscrow_rejectsPastDeadlines(uint256 pastOffset) public {
        // block.timestamp is at least 1 in forge; keep offset bounded so
        // subtraction never underflows but exercise range 0..(block.timestamp-1)
        // plus the exact-now boundary.
        uint256 dl = block.timestamp - bound(pastOffset, 0, block.timestamp - 1);
        bytes32 id = keccak256(abi.encode(pastOffset));
        vm.prank(buyer);
        vm.expectRevert(PaylockEscrow.DeadlinePast.selector);
        escrow.createEscrow(id, seller, "x", keccak256("d"), 1e6, dl);
    }
}
