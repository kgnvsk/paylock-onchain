#!/usr/bin/env npx ts-node
/**
 * PayLock Escrow — Release Escrow CLI
 * Usage: npx ts-node cli/release.ts --escrow <PDA>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
  if (!args.escrow) { console.error("Required: --escrow <PDA>"); process.exit(1); }

  const clusterUrl = `https://api.${args.cluster}.solana.com`;
  const walletPath = args.wallet || `${os.homedir()}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

  const connection = new Connection(clusterUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const program = new anchor.Program(require("../target/idl/paylock_escrow.json"), provider) as unknown as anchor.Program<PaylockEscrow>;

  const escrowPDA = new PublicKey(args.escrow);
  const escrow = await program.account.escrowAccount.fetch(escrowPDA);

  const providerAta = await getAssociatedTokenAddress(escrow.mint, escrow.provider);
  const treasuryAta = await getAssociatedTokenAddress(escrow.mint, escrow.treasury);
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [escrowPDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), escrow.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log(`\n🔓 Releasing escrow ${escrowPDA.toString().slice(0, 8)}...`);
  console.log(`   Provider gets: ${(escrow.amount.toNumber() * (10000 - escrow.feeBps.toNumber()) / 10000)} tokens`);
  console.log(`   Treasury gets: ${(escrow.amount.toNumber() * escrow.feeBps.toNumber() / 10000)} tokens\n`);

  const tx = await program.methods.releaseEscrow().accounts({
    authority: wallet.publicKey,
    treasury: escrow.treasury,
    escrow: escrowPDA,
    vault: vaultPDA,
    providerTokenAccount: providerAta,
    treasuryTokenAccount: treasuryAta,
  }).rpc();

  console.log(`✅ Escrow released!`);
  console.log(`   TX: ${tx}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${args.cluster}`);
}

main().catch(console.error);
