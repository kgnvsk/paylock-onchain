// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaylockEscrow} from "../contracts/PaylockEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployBaseSepolia is Script {
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        address admin    = vm.envAddress("BASE_ADMIN_ADDRESS");
        address treasury = vm.envAddress("BASE_TREASURY_ADDRESS");
        uint256 maxLocked = 10_000e6;

        vm.startBroadcast();
        PaylockEscrow escrow = new PaylockEscrow(
            IERC20(USDC_SEPOLIA), admin, treasury, maxLocked
        );
        vm.stopBroadcast();

        console.log("Deployed PaylockEscrow (Sepolia) at:", address(escrow));
    }
}
