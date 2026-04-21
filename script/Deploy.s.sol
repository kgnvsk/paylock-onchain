// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaylockEscrow} from "../contracts/PaylockEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployBaseMainnet is Script {
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        address admin    = vm.envAddress("BASE_ADMIN_ADDRESS");
        address treasury = vm.envAddress("BASE_TREASURY_ADDRESS");
        uint256 maxLocked = 10_000e6;

        vm.startBroadcast();
        PaylockEscrow escrow = new PaylockEscrow(
            IERC20(USDC_BASE), admin, treasury, maxLocked
        );
        vm.stopBroadcast();

        console.log("Deployed PaylockEscrow (Base MAINNET) at:", address(escrow));
    }
}
