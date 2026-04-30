// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Sonoglyph} from "../src/Sonoglyph.sol";

/**
 * Deploy Sonoglyph to Monad testnet.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $MONAD_RPC_URL \
 *     --broadcast \
 *     --private-key $DEPLOYER_PRIVATE_KEY
 *
 * The deployer address (derived from DEPLOYER_PRIVATE_KEY) is set as the
 * contract owner — i.e. the only address authorized to call mintDescent.
 * The bridge runs from this same wallet (it loads DEPLOYER_PRIVATE_KEY
 * from .env and signs mint transactions on the player's behalf).
 *
 * After deploy, the contract address is printed via console.log; copy it
 * into SONOGLYPH_CONTRACT_ADDRESS in .env so the bridge picks it up on
 * the next restart.
 */
contract Deploy is Script {
    function run() external returns (Sonoglyph nft) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(pk);
        nft = new Sonoglyph(deployer);
        vm.stopBroadcast();

        console.log("Sonoglyph deployed at:", address(nft));
        console.log("Owner (mint-authorized):", nft.owner());
        console.log("Set SONOGLYPH_CONTRACT_ADDRESS in .env, then restart bridge.");
    }
}
