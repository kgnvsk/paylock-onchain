import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PaylockEscrow } from "../target/types/paylock_escrow";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";

function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

describe("PayLock Escrow hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PaylockEscrow as Program<PaylockEscrow>;
  
  // Use provider.wallet.payer where possible
  const wallet = (provider.wallet as anchor.Wallet).payer;

  let mint: PublicKey;
  let treasury: Keypair;
  
  const ESCROW_AMOUNT = new BN(1_000_000);
  const VALID_HASH = sha256hex("test-delivery");

  before(async () => {
    treasury = Keypair.generate();
    
    // Airdrop to treasury
    const sig = await provider.connection.requestAirdrop(treasury.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);

    mint = await createMint(
      provider.connection,
      wallet,
      wallet.publicKey,
      null,
      6
    );
  });

  async function getEscrowPDA(client: PublicKey, provider: PublicKey): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer()],
      program.programId
    );
  }

  async function getVaultAta(escrow: PublicKey, mint: PublicKey): Promise<PublicKey> {
    const [vault] = PublicKey.findProgramAddressSync(
      [escrow.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return vault;
  }

  it("Full happy path with security checks", async () => {
    const client = wallet;
    const serviceProvider = Keypair.generate();
    
    const [escrowPDA] = await getEscrowPDA(client.publicKey, serviceProvider.publicKey);
    const vaultPDA = await getVaultAta(escrowPDA, mint);
    
    const clientAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet,
      mint,
      client.publicKey
    );
    
    const providerAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet,
      mint,
      serviceProvider.publicKey
    );
    
    const treasuryAta = await createAssociatedTokenAccount(
      provider.connection,
      wallet,
      mint,
      treasury.publicKey
    );

    // Fund client ATA
    await mintTo(provider.connection, wallet, mint, clientAta, wallet, 10_000_000);

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // 1. Create
    await program.methods
      .createEscrow("Test escrow", VALID_HASH, ESCROW_AMOUNT, new BN(deadline))
      .accounts({
        client: client.publicKey,
        provider: serviceProvider.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        // escrow and vault are inferred by Anchor if we use seeds, but we specify them for clarity
        // systemProgram, tokenProgram, etc. also inferred
      })
      .rpc();

    let escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ created: {} });

    // 2. Fund
    await program.methods
      .fundEscrow()
      .accounts({
        client: client.publicKey,
        escrow: escrowPDA,
        clientTokenAccount: clientAta,
        vault: vaultPDA,
      })
      .rpc();

    escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ funded: {} });

    // 3. Submit Delivery
    await program.methods
      .submitDelivery(VALID_HASH)
      .accounts({
        provider: serviceProvider.publicKey,
        escrow: escrowPDA,
      })
      .signers([serviceProvider])
      .rpc();

    escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ deliverySubmitted: {} });

    // 4. Release
    await program.methods
      .releaseEscrow()
      .accounts({
        authority: client.publicKey,
        treasury: treasury.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
      })
      .rpc();

    escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ released: {} });
    
    const vaultBal = await provider.connection.getTokenAccountBalance(vaultPDA);
    expect(vaultBal.value.amount).to.equal("0");
    
    console.log("✅ Happy path passed");
  });

  it("Rejects invalid hash format", async () => {
    const serviceProvider = Keypair.generate();
    const [escrowPDA] = await getEscrowPDA(wallet.publicKey, serviceProvider.publicKey);
    const vaultPDA = await getVaultAta(escrowPDA, mint);
    
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const invalidHash = "not-a-sha256-hex";

    try {
      await program.methods
        .createEscrow("Invalid hash test", invalidHash, ESCROW_AMOUNT, new BN(deadline))
        .accounts({
          client: wallet.publicKey,
          provider: serviceProvider.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();
      expect.fail("Should have failed with InvalidHashFormat");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidHashFormat");
    }
  });
});
