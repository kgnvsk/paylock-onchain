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

function findEscrowPda(client: PublicKey, provider: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer()],
    programId
  );
}

function findVaultAta(escrow: PublicKey, mint: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [escrow.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return vault;
}

describe("PayLock Escrow hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PaylockEscrow as Program<PaylockEscrow>;
  const treasury = Keypair.generate();
  const outsider = Keypair.generate();

  let mint: PublicKey;

  async function airdrop(kp: Keypair, sol = 2e9) {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  async function expectTxFailure(tx: Promise<string>, expected: string) {
    try {
      await tx;
      expect.fail(`Expected tx to fail with '${expected}'`);
    } catch (e: any) {
      const msg = String(e?.error?.errorMessage || e?.message || e);
      expect(msg.toLowerCase()).to.include(expected.toLowerCase());
    }
  }

  async function createCase(amount = 1_000_000, deadlineDelta = 3600) {
    const client = Keypair.generate();
    const serviceProvider = Keypair.generate();
    await Promise.all([airdrop(client), airdrop(serviceProvider)]);

    const clientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      client,
      mint,
      client.publicKey
    );
    const providerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      serviceProvider,
      mint,
      serviceProvider.publicKey
    );
    const treasuryTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      treasury,
      mint,
      treasury.publicKey
    );

    await mintTo(
      provider.connection,
      client,
      mint,
      clientTokenAccount,
      provider.wallet.publicKey,
      10_000_000
    );

    const [escrowPDA] = findEscrowPda(client.publicKey, serviceProvider.publicKey, program.programId);
    const vaultPDA = findVaultAta(escrowPDA, mint);

    const deadline = Math.floor(Date.now() / 1000) + deadlineDelta;
    const createSig = await program.methods
      .createEscrow("contract", sha256hex("delivery"), new BN(amount), new BN(deadline))
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

    return {
      client,
      serviceProvider,
      clientTokenAccount,
      providerTokenAccount,
      treasuryTokenAccount,
      escrowPDA,
      vaultPDA,
      amount,
      deadline,
      createSig,
    };
  }

  async function fundEscrow(c: Awaited<ReturnType<typeof createCase>>) {
    await program.methods
      .fundEscrow()
      .accounts({
        client: c.client.publicKey,
        escrow: c.escrowPDA,
        clientTokenAccount: c.clientTokenAccount,
        vault: c.vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([c.client])
      .rpc();
  }

  before(async () => {
    await Promise.all([airdrop(treasury), airdrop(outsider)]);
    mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );
  });

  it("state machine: forbidden transitions fail", async () => {
    const c1 = await createCase();

    await expectTxFailure(
      program.methods.submitDelivery(sha256hex("x")).accounts({ provider: c1.serviceProvider.publicKey, escrow: c1.escrowPDA }).signers([c1.serviceProvider]).rpc(),
      "not in the required status"
    );

    await expectTxFailure(
      program.methods.releaseEscrow().accounts({
        authority: c1.client.publicKey,
        treasury: treasury.publicKey,
        escrow: c1.escrowPDA,
        vault: c1.vaultPDA,
        providerTokenAccount: c1.providerTokenAccount,
        treasuryTokenAccount: c1.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([c1.client]).rpc(),
      "not in the required status"
    );

    await fundEscrow(c1);
    await expectTxFailure(
      program.methods.fundEscrow().accounts({
        client: c1.client.publicKey,
        escrow: c1.escrowPDA,
        clientTokenAccount: c1.clientTokenAccount,
        vault: c1.vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([c1.client]).rpc(),
      "not in the required status"
    );

    await program.methods.submitDelivery(sha256hex("delivery")).accounts({ provider: c1.serviceProvider.publicKey, escrow: c1.escrowPDA }).signers([c1.serviceProvider]).rpc();
    await expectTxFailure(
      program.methods.submitDelivery(sha256hex("delivery")).accounts({ provider: c1.serviceProvider.publicKey, escrow: c1.escrowPDA }).signers([c1.serviceProvider]).rpc(),
      "not in the required status"
    );

    await program.methods.releaseEscrow().accounts({
      authority: c1.client.publicKey,
      treasury: treasury.publicKey,
      escrow: c1.escrowPDA,
      vault: c1.vaultPDA,
      providerTokenAccount: c1.providerTokenAccount,
      treasuryTokenAccount: c1.treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).signers([c1.client]).rpc();

    await expectTxFailure(
      program.methods.disputeEscrow("late dispute").accounts({ authority: c1.client.publicKey, escrow: c1.escrowPDA }).signers([c1.client]).rpc(),
      "not in the required status"
    );
    await expectTxFailure(
      program.methods.cancelEscrow().accounts({
        authority: c1.client.publicKey,
        escrow: c1.escrowPDA,
        vault: c1.vaultPDA,
        clientTokenAccount: c1.clientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([c1.client]).rpc(),
      "not in the required status"
    );
  });

  it("proof schema hardening: malformed payloads rejected", async () => {
    const c = await createCase();

    const invalid = ["", "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65), "a".repeat(62) + "--"];
    for (const bad of invalid) {
      const clientX = Keypair.generate();
      const providerX = Keypair.generate();
      await Promise.all([airdrop(clientX), airdrop(providerX)]);
      const [esc] = findEscrowPda(clientX.publicKey, providerX.publicKey, program.programId);
      const vault = findVaultAta(esc, mint);
      await expectTxFailure(
        program.methods
          .createEscrow("bad", bad, new BN(1000), new BN(Math.floor(Date.now() / 1000) + 100))
          .accounts({
            client: clientX.publicKey,
            provider: providerX.publicKey,
            mint,
            arbitrator: treasury.publicKey,
            treasury: treasury.publicKey,
            escrow: esc,
            vault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([clientX])
          .rpc(),
        "hash must be exactly"
      );
    }

    await fundEscrow(c);
    for (const bad of invalid) {
      await expectTxFailure(
        program.methods.submitDelivery(bad).accounts({ provider: c.serviceProvider.publicKey, escrow: c.escrowPDA }).signers([c.serviceProvider]).rpc(),
        "hash must be exactly"
      );
    }
  });

  it("deadline edge behavior: create/cancel/release/dispute", async () => {
    const now = Math.floor(Date.now() / 1000);

    const clientX = Keypair.generate();
    const providerX = Keypair.generate();
    await Promise.all([airdrop(clientX), airdrop(providerX)]);
    const [esc] = findEscrowPda(clientX.publicKey, providerX.publicKey, program.programId);
    const vault = findVaultAta(esc, mint);

    await expectTxFailure(
      program.methods.createEscrow("now", sha256hex("x"), new BN(1000), new BN(now))
        .accounts({ client: clientX.publicKey, provider: providerX.publicKey, mint, arbitrator: treasury.publicKey, treasury: treasury.publicKey, escrow: esc, vault, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY })
        .signers([clientX]).rpc(),
      "deadline must be in the future"
    );

    await expectTxFailure(
      program.methods.createEscrow("past", sha256hex("x"), new BN(1000), new BN(now - 1))
        .accounts({ client: clientX.publicKey, provider: providerX.publicKey, mint, arbitrator: treasury.publicKey, treasury: treasury.publicKey, escrow: esc, vault, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY })
        .signers([clientX]).rpc(),
      "deadline must be in the future"
    );

    const c = await createCase(1_000_000, 1);
    await fundEscrow(c);
    await expectTxFailure(
      program.methods.cancelEscrow().accounts({ authority: c.client.publicKey, escrow: c.escrowPDA, vault: c.vaultPDA, clientTokenAccount: c.clientTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID }).signers([c.client]).rpc(),
      "not authorized"
    );
    await expectTxFailure(
      program.methods.releaseEscrow().accounts({ authority: outsider.publicKey, treasury: treasury.publicKey, escrow: c.escrowPDA, vault: c.vaultPDA, providerTokenAccount: c.providerTokenAccount, treasuryTokenAccount: c.treasuryTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID }).signers([outsider]).rpc(),
      "not authorized"
    );

    await new Promise((r) => setTimeout(r, 1500));

    await program.methods.disputeEscrow("after deadline still allowed").accounts({ authority: c.client.publicKey, escrow: c.escrowPDA }).signers([c.client]).rpc();
  });

  it("anti-replay: terminal-state repeats fail", async () => {
    const c = await createCase();
    await fundEscrow(c);
    await program.methods.submitDelivery(sha256hex("delivery")).accounts({ provider: c.serviceProvider.publicKey, escrow: c.escrowPDA }).signers([c.serviceProvider]).rpc();
    await program.methods.releaseEscrow().accounts({
      authority: c.client.publicKey,
      treasury: treasury.publicKey,
      escrow: c.escrowPDA,
      vault: c.vaultPDA,
      providerTokenAccount: c.providerTokenAccount,
      treasuryTokenAccount: c.treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).signers([c.client]).rpc();

    await expectTxFailure(
      program.methods.releaseEscrow().accounts({
        authority: c.client.publicKey,
        treasury: treasury.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        providerTokenAccount: c.providerTokenAccount,
        treasuryTokenAccount: c.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([c.client]).rpc(),
      "not in the required status"
    );
  });

  it("authorization matrix negatives: wrong roles", async () => {
    const c = await createCase();
    await fundEscrow(c);

    await expectTxFailure(
      program.methods.disputeEscrow("x").accounts({ authority: outsider.publicKey, escrow: c.escrowPDA }).signers([outsider]).rpc(),
      "not authorized"
    );

    const rogueTreasury = Keypair.generate();
    const rogueArbitrator = Keypair.generate();
    await Promise.all([airdrop(rogueTreasury), airdrop(rogueArbitrator)]);
    const rogueTreasuryTokenAccount = await createAssociatedTokenAccount(provider.connection, rogueTreasury, mint, rogueTreasury.publicKey);

    await expectTxFailure(
      program.methods.releaseEscrow().accounts({
        authority: c.client.publicKey,
        treasury: rogueTreasury.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        providerTokenAccount: c.providerTokenAccount,
        treasuryTokenAccount: rogueTreasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([c.client]).rpc(),
      "has one constraint"
    );

    await program.methods.disputeEscrow("auth").accounts({ authority: c.client.publicKey, escrow: c.escrowPDA }).signers([c.client]).rpc();
    await expectTxFailure(
      program.methods.resolveDispute(new BN(5000)).accounts({
        arbitrator: rogueArbitrator.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        clientTokenAccount: c.clientTokenAccount,
        providerTokenAccount: c.providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([rogueArbitrator]).rpc(),
      "has one constraint"
    );
  });

  it("events emitted for transitions with required fields", async () => {
    const c = await createCase();
    const parser = new anchor.EventParser(program.programId, program.coder);

    const createTx = await provider.connection.getTransaction(c.createSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const createEvents = [...parser.parseLogs(createTx?.meta?.logMessages ?? [])];
    const created = createEvents.find((e) => e.name === "EscrowCreated");
    expect(created).to.not.equal(undefined);
    expect((created as any).data.amount.toNumber()).to.equal(c.amount);
    expect((created as any).data.actor.toString()).to.equal(c.client.publicKey.toString());

    const sig = await program.methods.fundEscrow().accounts({
      client: c.client.publicKey,
      escrow: c.escrowPDA,
      clientTokenAccount: c.clientTokenAccount,
      vault: c.vaultPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).signers([c.client]).rpc();

    const tx = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const events = [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
    const funded = events.find((e) => e.name === "EscrowFunded");
    expect(funded).to.not.equal(undefined);
    expect((funded as any).data.amount.toNumber()).to.equal(c.amount);
    expect((funded as any).data.actor.toString()).to.equal(c.client.publicKey.toString());
  });
});
