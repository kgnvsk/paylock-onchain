#!/usr/bin/env npx ts-node
/**
 * PayLock Escrow — CLI Status Checker
 * Usage: npx ts-node cli/status.ts --escrow <ESCROW_PDA>
 *        npx ts-node cli/status.ts --client <CLIENT_PUBKEY> --provider <PROVIDER_PUBKEY>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { PaylockEscrow } from "../target/types/paylock_escrow";

const PROGRAM_ID = new PublicKey("BgWSFpXL2tzGTk2N8ihVF5WdNM3q9e9jRuMLJGKWnBA8");

function parseArgs(): { escrow?: string; client?: string; provider?: string; cluster: string } {
  const args = process.argv.slice(2);
  const parsed: any = { cluster: "devnet" };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace("--", "");
    parsed[key] = args[i + 1];
  }
  return parsed;
}

function statusToString(status: any): string {
  if (status.created) return "Created";
  if (status.funded) return "Funded";
  if (status.deliverySubmitted) return "Delivery Submitted";
  if (status.released) return "Released";
  if (status.disputed) return "Disputed";
  if (status.resolved) return "Resolved";
  if (status.cancelled) return "Cancelled";
  return JSON.stringify(status);
}

async function main() {
  const args = parseArgs();
  const clusterUrl = args.cluster === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : `https://api.${args.cluster}.solana.com`;

  const connection = new Connection(clusterUrl, "confirmed");

  let escrowPDA: PublicKey;

  if (args.escrow) {
    escrowPDA = new PublicKey(args.escrow);
  } else if (args.client && args.provider) {
    [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new PublicKey(args.client).toBuffer(), new PublicKey(args.provider).toBuffer()],
      PROGRAM_ID
    );
  } else {
    console.error("Usage: --escrow <PDA> OR --client <PUBKEY> --provider <PUBKEY>");
    process.exit(1);
  }

  console.log(`\n🔍 Escrow PDA: ${escrowPDA.toString()}`);
  console.log(`   Cluster: ${args.cluster}\n`);

  const accountInfo = await connection.getAccountInfo(escrowPDA);
  if (!accountInfo) {
    console.log("❌ Escrow account not found");
    process.exit(1);
  }

  // Decode using Anchor IDL
  const provider = new anchor.AnchorProvider(connection, {} as any, {});
  const program = new anchor.Program(
    require("../target/idl/paylock_escrow.json"),
    provider
  ) as unknown as anchor.Program<PaylockEscrow>;

  const escrow = await program.account.escrowAccount.fetch(escrowPDA);

  console.log("┌─────────────────────────────────────────────────┐");
  console.log(`│ PayLock Escrow #${escrowPDA.toString().slice(0, 8)}...                      │`);
  console.log("├─────────────────────────────────────────────────┤");
  console.log(`│ Status:      ${statusToString(escrow.status).padEnd(35)}│`);
  console.log(`│ Client:      ${escrow.client.toString().slice(0, 35).padEnd(35)}│`);
  console.log(`│ Provider:    ${escrow.provider.toString().slice(0, 35).padEnd(35)}│`);
  console.log(`│ Amount:      ${escrow.amount.toString().padEnd(35)}│`);
  console.log(`│ Fee BPS:     ${escrow.feeBps.toString().padEnd(35)}│`);
  console.log(`│ Deadline:    ${new Date(escrow.deadline.toNumber() * 1000).toISOString().padEnd(35)}│`);
  console.log(`│ Arbitrator:  ${escrow.arbitrator.toString().slice(0, 35).padEnd(35)}│`);
  console.log(`│ Treasury:    ${escrow.treasury.toString().slice(0, 35).padEnd(35)}│`);
  console.log(`│ Mint:        ${escrow.mint.toString().slice(0, 35).padEnd(35)}│`);
  if (escrow.deliveryHash) {
    console.log(`│ Deliv.Hash:  ${escrow.deliveryHash.slice(0, 35).padEnd(35)}│`);
  }
  if (escrow.verifyHash) {
    console.log(`│ Verify Hash: ${escrow.verifyHash.slice(0, 35).padEnd(35)}│`);
  }
  console.log("└─────────────────────────────────────────────────┘");

  console.log(`\n📎 Explorer: https://explorer.solana.com/address/${escrowPDA.toString()}?cluster=${args.cluster}`);
}

main().catch(console.error);
