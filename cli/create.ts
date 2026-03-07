#!/usr/bin/env npx ts-node
/**
 * PayLock Escrow — Create Escrow CLI
 * Usage: npx ts-node cli/create.ts \
 *   --provider <PUBKEY> --mint <MINT> --amount 1000000 \
 *   --deadline 86400 --description "Build X" --hash <SHA256_HEX>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PaylockEscrow } from "../target/types/paylock_escrow";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

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

  if (!args.provider || !args.mint || !args.amount) {
    console.error("Required: --provider <PUBKEY> --mint <MINT> --amount <LAMPORTS>");
    console.error("Optional: --deadline <SECONDS> --description <TEXT> --hash <SHA256>");
    console.error("          --arbitrator <PUBKEY> --treasury <PUBKEY> --cluster <devnet|mainnet>");
    process.exit(1);
  }

  const clusterUrl = args.cluster === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : `https://api.${args.cluster}.solana.com`;

  // Load wallet
  const walletPath = args.wallet || `${os.homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  const connection = new Connection(clusterUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );

  const program = new anchor.Program(
    require("../target/idl/paylock_escrow.json"),
    provider
  ) as unknown as anchor.Program<PaylockEscrow>;

  const providerKey = new PublicKey(args.provider);
  const mint = new PublicKey(args.mint);
  const amount = new anchor.BN(args.amount);
  const deadlineSecs = parseInt(args.deadline || "86400");
  const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + deadlineSecs);
  const description = args.description || "PayLock escrow";
  const hash = args.hash || crypto.createHash("sha256").update("default").digest("hex");
  const arbitrator = args.arbitrator ? new PublicKey(args.arbitrator) : wallet.publicKey;
  const treasury = args.treasury ? new PublicKey(args.treasury) : wallet.publicKey;

  const [escrowPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), wallet.publicKey.toBuffer(), providerKey.toBuffer()],
    PROGRAM_ID
  );

  console.log(`\n🔧 Creating escrow...`);
  console.log(`   Client:   ${wallet.publicKey.toString()}`);
  console.log(`   Provider: ${providerKey.toString()}`);
  console.log(`   Amount:   ${amount.toString()}`);
  console.log(`   Deadline: ${new Date(deadline.toNumber() * 1000).toISOString()}`);
  console.log(`   Escrow:   ${escrowPDA.toString()}\n`);

  const tx = await program.methods
    .createEscrow(description, hash, amount, deadline)
    .accounts({
      client: wallet.publicKey,
      provider: providerKey,
      mint,
      arbitrator,
      treasury,
    })
    .rpc();

  console.log(`✅ Escrow created!`);
  console.log(`   TX: ${tx}`);
  console.log(`   PDA: ${escrowPDA.toString()}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${args.cluster}`);
}

main().catch(console.error);
