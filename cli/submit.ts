#!/usr/bin/env npx ts-node
/**
 * PayLock Escrow — Submit Delivery CLI
 * Usage: npx ts-node cli/submit.ts --escrow <PDA> --hash <SHA256_HEX>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { PaylockEscrow } from "../target/types/paylock_escrow";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: any = { cluster: "devnet" };
  for (let i = 0; i < args.length; i += 2) {
    parsed[args[i].replace("--", "")] = args[i + 1];
  }
  return parsed;
}

async function main() {
  const args = parseArgs();
  if (!args.escrow || !args.hash) {
    console.error("Required: --escrow <PDA> --hash <SHA256_HEX>");
    process.exit(1);
  }

  const clusterUrl = `https://api.${args.cluster}.solana.com`;
  const walletPath = args.wallet || `${os.homedir()}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

  const connection = new Connection(clusterUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const program = new anchor.Program(require("../target/idl/paylock_escrow.json"), provider) as unknown as anchor.Program<PaylockEscrow>;

  const escrowPDA = new PublicKey(args.escrow);

  console.log(`\n📦 Submitting delivery for escrow ${escrowPDA.toString().slice(0, 8)}...`);
  console.log(`   Hash: ${args.hash.slice(0, 16)}...\n`);

  const tx = await program.methods.submitDelivery(args.hash).accounts({
    provider: wallet.publicKey,
    escrow: escrowPDA,
  }).rpc();

  console.log(`✅ Delivery submitted!`);
  console.log(`   TX: ${tx}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${args.cluster}`);
}

main().catch(console.error);
