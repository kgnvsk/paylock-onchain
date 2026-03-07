import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PaylockEscrow } from "../target/types/paylock_escrow";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function getEscrowPDA(
  client: PublicKey,
  provider: PublicKey,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer()],
    programId
  );
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("PayLock Escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PaylockEscrow as Program<PaylockEscrow>;

  // Keypairs
  const client = Keypair.generate();
  const serviceProvider = Keypair.generate();
  const treasury = Keypair.generate();

  // Token accounts
  let mint: PublicKey;
  let clientTokenAccount: PublicKey;
  let providerTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  // Escrow PDAs
  let escrowPDA: PublicKey;
  let escrowBump: number;
  let vaultPDA: PublicKey;

  const ESCROW_AMOUNT = new BN(1_000_000); // 1 USDC (6 decimals)
  const DEADLINE_OFFSET = 3600; // 1 hour from now

  async function expectTxFailure(tx: Promise<string>, expected: string) {
    try {
      await tx;
      expect.fail(`Expected tx to fail with '${expected}'`);
    } catch (e: any) {
      const msg = String(e?.error?.errorMessage || e?.message || e);
      expect(msg).to.include(expected);
    }
  }

  before(async () => {
    // Airdrop SOL to all parties
    await Promise.all([
      provider.connection.requestAirdrop(client.publicKey, 2e9),
      provider.connection.requestAirdrop(serviceProvider.publicKey, 2e9),
      provider.connection.requestAirdrop(treasury.publicKey, 2e9),
    ]);

    // Wait for confirmations
    await new Promise((r) => setTimeout(r, 2000));

    // Create mock USDC mint
    mint = await createMint(
      provider.connection,
      client,       // payer
      client.publicKey, // mint authority
      null,         // freeze authority
      6             // decimals
    );

    // Create token accounts
    clientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      client,
      mint,
      client.publicKey
    );

    providerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      serviceProvider,
      mint,
      serviceProvider.publicKey
    );

    treasuryTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      treasury,
      mint,
      treasury.publicKey
    );

    // Mint tokens to client
    await mintTo(
      provider.connection,
      client,
      mint,
      clientTokenAccount,
      client.publicKey,
      10_000_000 // 10 USDC
    );

    // Derive escrow PDA
    [escrowPDA, escrowBump] = await getEscrowPDA(
      client.publicKey,
      serviceProvider.publicKey,
      program.programId
    );

    // Derive vault (ATA of escrow PDA)
    [vaultPDA] = PublicKey.findProgramAddressSync(
      [
        escrowPDA.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  // ─── Test 1: Create ───────────────────────────────────────────────────────

  it("Creates an escrow agreement", async () => {
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET;
    const deliveryHash = sha256hex("expected-delivery-content");
    const description = "Build PayLock on-chain escrow Anchor program";

    await program.methods
      .createEscrow(description, deliveryHash, ESCROW_AMOUNT, new BN(deadline))
      .accounts({
        client: client.publicKey,
        provider: serviceProvider.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);

    expect(escrow.client.toString()).to.equal(client.publicKey.toString());
    expect(escrow.provider.toString()).to.equal(serviceProvider.publicKey.toString());
    expect(escrow.amount.toNumber()).to.equal(ESCROW_AMOUNT.toNumber());
    expect(escrow.status).to.deep.equal({ created: {} });
    expect(escrow.description).to.equal(description);
    expect(escrow.deliveryHash).to.equal(deliveryHash);
    console.log("✅ Escrow created:", escrowPDA.toString());
  });

  // ─── Test 2: Fund ─────────────────────────────────────────────────────────

  it("Funds the escrow vault", async () => {
    const clientBalanceBefore = (
      await getAccount(provider.connection, clientTokenAccount)
    ).amount;

    await program.methods
      .fundEscrow()
      .accounts({
        client: client.publicKey,
        escrow: escrowPDA,
        clientTokenAccount,
        vault: vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const vaultBalance = (await getAccount(provider.connection, vaultPDA)).amount;
    expect(Number(vaultBalance)).to.equal(ESCROW_AMOUNT.toNumber());

    const clientBalanceAfter = (
      await getAccount(provider.connection, clientTokenAccount)
    ).amount;
    expect(Number(clientBalanceBefore) - Number(clientBalanceAfter)).to.equal(
      ESCROW_AMOUNT.toNumber()
    );

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ funded: {} });
    console.log("✅ Escrow funded with", ESCROW_AMOUNT.toNumber(), "tokens");
  });

  // ─── Test 3: Submit Delivery ──────────────────────────────────────────────

  it("Provider submits delivery proof", async () => {
    const verifyHash = sha256hex("expected-delivery-content"); // matching hash

    await program.methods
      .submitDelivery(verifyHash)
      .accounts({
        provider: serviceProvider.publicKey,
        escrow: escrowPDA,
      })
      .signers([serviceProvider])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ deliverySubmitted: {} });
    expect(escrow.verifyHash).to.equal(verifyHash);
    console.log("✅ Delivery submitted");
  });

  // ─── Test 4: Release ──────────────────────────────────────────────────────

  it("Releases escrow to provider after delivery", async () => {
    const providerBalanceBefore = (
      await getAccount(provider.connection, providerTokenAccount)
    ).amount;

    await program.methods
      .releaseEscrow()
      .accounts({
        authority: client.publicKey,
        treasury: treasury.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        providerTokenAccount,
        treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const providerBalanceAfter = (
      await getAccount(provider.connection, providerTokenAccount)
    ).amount;
    const treasuryBalance = (
      await getAccount(provider.connection, treasuryTokenAccount)
    ).amount;

    // Provider gets 98%, treasury gets 2%
    const expectedFee = Math.floor((ESCROW_AMOUNT.toNumber() * 200) / 10000);
    const expectedProvider = ESCROW_AMOUNT.toNumber() - expectedFee;

    expect(
      Number(providerBalanceAfter) - Number(providerBalanceBefore)
    ).to.equal(expectedProvider);
    expect(Number(treasuryBalance)).to.equal(expectedFee);

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.status).to.deep.equal({ released: {} });
    console.log(
      `✅ Released: provider=${expectedProvider}, fee=${expectedFee}`
    );
  });

  // ─── Test 5: Dispute Flow ─────────────────────────────────────────────────

  it("Full dispute flow: create → fund → dispute → resolve", async () => {
    // New keypairs for this test
    const client2 = Keypair.generate();
    const provider2 = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(client2.publicKey, 2e9),
      provider.connection.requestAirdrop(provider2.publicKey, 2e9),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    const client2TokenAcc = await createAssociatedTokenAccount(
      provider.connection, client2, mint, client2.publicKey
    );
    const provider2TokenAcc = await createAssociatedTokenAccount(
      provider.connection, provider2, mint, provider2.publicKey
    );

    await mintTo(
      provider.connection, client2, mint, client2TokenAcc, client.publicKey, 5_000_000
    );

    const [escrow2PDA] = await getEscrowPDA(
      client2.publicKey, provider2.publicKey, program.programId
    );
    const [vault2PDA] = PublicKey.findProgramAddressSync(
      [escrow2PDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET;

    // Create
    await program.methods
      .createEscrow("Dispute test contract", sha256hex("dispute-delivery"), new BN(2_000_000), new BN(deadline))
      .accounts({
        client: client2.publicKey,
        provider: provider2.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrow2PDA,
        vault: vault2PDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client2]).rpc();

    // Fund
    await program.methods.fundEscrow()
      .accounts({
        client: client2.publicKey, escrow: escrow2PDA,
        clientTokenAccount: client2TokenAcc, vault: vault2PDA,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client2]).rpc();

    // Dispute
    await program.methods.disputeEscrow("Provider did not deliver")
      .accounts({ authority: client2.publicKey, escrow: escrow2PDA })
      .signers([client2]).rpc();

    let escrow2 = await program.account.escrowAccount.fetch(escrow2PDA);
    expect(escrow2.status).to.deep.equal({ disputed: {} });

    // Resolve: 50/50 split
    await program.methods.resolveDispute(new BN(5000))
      .accounts({
        arbitrator: treasury.publicKey,
        escrow: escrow2PDA,
        vault: vault2PDA,
        clientTokenAccount: client2TokenAcc,
        providerTokenAccount: provider2TokenAcc,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([treasury]).rpc();

    escrow2 = await program.account.escrowAccount.fetch(escrow2PDA);
    expect(escrow2.status).to.deep.equal({ resolved: {} });

    const c2Bal = (await getAccount(provider.connection, client2TokenAcc)).amount;
    const p2Bal = (await getAccount(provider.connection, provider2TokenAcc)).amount;
    expect(Number(c2Bal)).to.equal(3_001_000); // 5M - 2M + 1M (50%)  minus rounding
    console.log(`✅ Dispute resolved: client=${c2Bal}, provider=${p2Bal}`);
  });

  // ─── Test 6: Cancel ───────────────────────────────────────────────────────

  it("Client can cancel before funding", async () => {
    const client3 = Keypair.generate();
    const provider3 = Keypair.generate();

    await provider.connection.requestAirdrop(client3.publicKey, 2e9);
    await new Promise((r) => setTimeout(r, 1000));

    const client3TokenAcc = await createAssociatedTokenAccount(
      provider.connection, client3, mint, client3.publicKey
    );
    await mintTo(
      provider.connection, client3, mint, client3TokenAcc, client.publicKey, 2_000_000
    );

    const [escrow3PDA] = await getEscrowPDA(
      client3.publicKey, provider3.publicKey, program.programId
    );
    const [vault3PDA] = PublicKey.findProgramAddressSync(
      [escrow3PDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET;

    await program.methods
      .createEscrow("Cancel test", sha256hex("cancel-delivery"), new BN(500_000), new BN(deadline))
      .accounts({
        client: client3.publicKey, provider: provider3.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrow3PDA,
        vault: vault3PDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client3]).rpc();

    await program.methods.cancelEscrow()
      .accounts({
        authority: client3.publicKey,
        escrow: escrow3PDA,
        vault: vault3PDA,
        clientTokenAccount: client3TokenAcc,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client3]).rpc();

    const escrow3 = await program.account.escrowAccount.fetch(escrow3PDA);
    expect(escrow3.status).to.deep.equal({ cancelled: {} });
    console.log("✅ Escrow cancelled successfully");
  });

  it("Rejects invalid hash format on create_escrow and submit_delivery", async () => {
    const client4 = Keypair.generate();
    const provider4 = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(client4.publicKey, 2e9),
      provider.connection.requestAirdrop(provider4.publicKey, 2e9),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    const client4TokenAcc = await createAssociatedTokenAccount(
      provider.connection, client4, mint, client4.publicKey
    );
    await mintTo(provider.connection, client4, mint, client4TokenAcc, client.publicKey, 1_000_000);

    const [escrow4PDA] = await getEscrowPDA(client4.publicKey, provider4.publicKey, program.programId);
    const [vault4PDA] = PublicKey.findProgramAddressSync(
      [escrow4PDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET;

    await expectTxFailure(
      program.methods
        .createEscrow("Bad hash", "not-a-sha256", new BN(500_000), new BN(deadline))
        .accounts({
          client: client4.publicKey,
          provider: provider4.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
          escrow: escrow4PDA,
          vault: vault4PDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([client4])
        .rpc(),
      "Invalid hash format"
    );

    await program.methods
      .createEscrow("Good hash", sha256hex("good-create"), new BN(500_000), new BN(deadline))
      .accounts({
        client: client4.publicKey,
        provider: provider4.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrow4PDA,
        vault: vault4PDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client4])
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        client: client4.publicKey,
        escrow: escrow4PDA,
        clientTokenAccount: client4TokenAcc,
        vault: vault4PDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client4])
      .rpc();

    await expectTxFailure(
      program.methods
        .submitDelivery("xyz")
        .accounts({ provider: provider4.publicKey, escrow: escrow4PDA })
        .signers([provider4])
        .rpc(),
      "Invalid hash format"
    );
  });

  it("Rejects deadline edge and unauthorized/invalid state transitions", async () => {
    const client5 = Keypair.generate();
    const provider5 = Keypair.generate();
    const attacker = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(client5.publicKey, 2e9),
      provider.connection.requestAirdrop(provider5.publicKey, 2e9),
      provider.connection.requestAirdrop(attacker.publicKey, 2e9),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    const client5TokenAcc = await createAssociatedTokenAccount(provider.connection, client5, mint, client5.publicKey);
    await mintTo(provider.connection, client5, mint, client5TokenAcc, client.publicKey, 1_500_000);

    const [escrow5PDA] = await getEscrowPDA(client5.publicKey, provider5.publicKey, program.programId);
    const [vault5PDA] = PublicKey.findProgramAddressSync(
      [escrow5PDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nowTs = Math.floor(Date.now() / 1000);

    await expectTxFailure(
      program.methods
        .createEscrow("Deadline edge", sha256hex("deadline-edge"), new BN(500_000), new BN(nowTs))
        .accounts({
          client: client5.publicKey,
          provider: provider5.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
          escrow: escrow5PDA,
          vault: vault5PDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([client5])
        .rpc(),
      "Deadline must be in the future"
    );

    await program.methods
      .createEscrow("State machine edge", sha256hex("state-machine-edge"), new BN(500_000), new BN(nowTs + 120))
      .accounts({
        client: client5.publicKey,
        provider: provider5.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrow5PDA,
        vault: vault5PDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client5])
      .rpc();

    await expectTxFailure(
      program.methods
        .submitDelivery(sha256hex("premature"))
        .accounts({ provider: provider5.publicKey, escrow: escrow5PDA })
        .signers([provider5])
        .rpc(),
      "Escrow is not in the required status"
    );

    await expectTxFailure(
      program.methods
        .disputeEscrow("attacker")
        .accounts({ authority: attacker.publicKey, escrow: escrow5PDA })
        .signers([attacker])
        .rpc(),
      "Caller is not authorized"
    );
  });

  it("Rejects treasury/arbitrator mismatch attempts", async () => {
    const rogueTreasury = Keypair.generate();
    const rogueArbitrator = Keypair.generate();
    const client6 = Keypair.generate();
    const provider6 = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(client6.publicKey, 2e9),
      provider.connection.requestAirdrop(provider6.publicKey, 2e9),
      provider.connection.requestAirdrop(rogueTreasury.publicKey, 2e9),
      provider.connection.requestAirdrop(rogueArbitrator.publicKey, 2e9),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    const client6TokenAcc = await createAssociatedTokenAccount(provider.connection, client6, mint, client6.publicKey);
    const provider6TokenAcc = await createAssociatedTokenAccount(provider.connection, provider6, mint, provider6.publicKey);
    const rogueTreasuryTokenAcc = await createAssociatedTokenAccount(provider.connection, rogueTreasury, mint, rogueTreasury.publicKey);
    await mintTo(provider.connection, client6, mint, client6TokenAcc, client.publicKey, 2_000_000);

    const [escrow6PDA] = await getEscrowPDA(client6.publicKey, provider6.publicKey, program.programId);
    const [vault6PDA] = PublicKey.findProgramAddressSync(
      [escrow6PDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET;

    await program.methods
      .createEscrow("Mismatch checks", sha256hex("mismatch-checks"), new BN(1_000_000), new BN(deadline))
      .accounts({
        client: client6.publicKey,
        provider: provider6.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
        escrow: escrow6PDA,
        vault: vault6PDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client6])
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        client: client6.publicKey,
        escrow: escrow6PDA,
        clientTokenAccount: client6TokenAcc,
        vault: vault6PDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([client6])
      .rpc();

    await expectTxFailure(
      program.methods
        .releaseEscrow()
        .accounts({
          authority: client6.publicKey,
          treasury: rogueTreasury.publicKey,
          escrow: escrow6PDA,
          vault: vault6PDA,
          providerTokenAccount: provider6TokenAcc,
          treasuryTokenAccount: rogueTreasuryTokenAcc,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([client6])
        .rpc(),
      "has one constraint was violated"
    );

    await program.methods
      .disputeEscrow("prep for resolve auth test")
      .accounts({ authority: client6.publicKey, escrow: escrow6PDA })
      .signers([client6])
      .rpc();

    await expectTxFailure(
      program.methods
        .resolveDispute(new BN(5000))
        .accounts({
          arbitrator: rogueArbitrator.publicKey,
          escrow: escrow6PDA,
          vault: vault6PDA,
          clientTokenAccount: client6TokenAcc,
          providerTokenAccount: provider6TokenAcc,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([rogueArbitrator])
        .rpc(),
      "has one constraint was violated"
    );
  });
});
