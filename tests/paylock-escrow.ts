import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PaylockEscrow } from "../target/types/paylock_escrow";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
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

const VALID_HASH = sha256hex("delivery-proof");
const VALID_HASH_2 = sha256hex("other-delivery");

describe("PayLock Escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PaylockEscrow as Program<PaylockEscrow>;
  const wallet = (provider.wallet as anchor.Wallet).payer;

  let mint: PublicKey;
  const treasury = Keypair.generate();
  const outsider = Keypair.generate();

  async function airdrop(pubkey: PublicKey, sol = 2e9) {
    const sig = await provider.connection.requestAirdrop(pubkey, sol);
    await provider.connection.confirmTransaction(sig);
  }

  before(async () => {
    await Promise.all([airdrop(treasury.publicKey), airdrop(outsider.publicKey)]);
    mint = await createMint(provider.connection, wallet, wallet.publicKey, null, 6);
  });

  // Helper: create a full escrow case with unique provider keypair
  async function createCase(opts: {
    amount?: number;
    deadlineDelta?: number;
    deliveryHash?: string;
  } = {}) {
    const amount = opts.amount ?? 1_000_000;
    const deadlineDelta = opts.deadlineDelta ?? 3600;
    const deliveryHash = opts.deliveryHash ?? VALID_HASH;

    const serviceProvider = Keypair.generate();
    const client = wallet; // wallet is always the client (payer)

    const [escrowPDA, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.publicKey.toBuffer(), serviceProvider.publicKey.toBuffer()],
      program.programId
    );
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [escrowPDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const clientAta = await createAssociatedTokenAccount(provider.connection, wallet, mint, client.publicKey).catch(
      () => getAssociatedTokenAddress(mint, client.publicKey)
    );
    const providerAta = await createAssociatedTokenAccount(
      provider.connection, wallet, mint, serviceProvider.publicKey
    );
    const treasuryAta = await createAssociatedTokenAccount(
      provider.connection, wallet, mint, treasury.publicKey
    ).catch(() => getAssociatedTokenAddress(mint, treasury.publicKey));

    await mintTo(provider.connection, wallet, mint, clientAta, wallet, 10_000_000);

    const deadline = Math.floor(Date.now() / 1000) + deadlineDelta;

    await program.methods
      .createEscrow("test contract", deliveryHash, new BN(amount), new BN(deadline))
      .accounts({
        client: client.publicKey,
        provider: serviceProvider.publicKey,
        mint,
        arbitrator: treasury.publicKey,
        treasury: treasury.publicKey,
      })
      .rpc();

    return {
      client, serviceProvider, escrowPDA, vaultPDA, clientAta, providerAta, treasuryAta,
      amount, deadline, bump,
    };
  }

  async function fundCase(c: Awaited<ReturnType<typeof createCase>>) {
    await program.methods.fundEscrow().accounts({
      client: c.client.publicKey,
      escrow: c.escrowPDA,
      clientTokenAccount: c.clientAta,
      vault: c.vaultPDA,
    }).rpc();
  }

  async function submitDelivery(c: Awaited<ReturnType<typeof createCase>>, hash = VALID_HASH) {
    await program.methods.submitDelivery(hash).accounts({
      provider: c.serviceProvider.publicKey,
      escrow: c.escrowPDA,
    }).signers([c.serviceProvider]).rpc();
  }

  async function releaseCase(c: Awaited<ReturnType<typeof createCase>>) {
    await program.methods.releaseEscrow().accounts({
      authority: c.client.publicKey,
      treasury: treasury.publicKey,
      escrow: c.escrowPDA,
      vault: c.vaultPDA,
      providerTokenAccount: c.providerAta,
      treasuryTokenAccount: c.treasuryAta,
    }).rpc();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. HAPPY PATH
  // ═══════════════════════════════════════════════════════════════════════════
  it("Full happy path: create → fund → submit → release", async () => {
    const c = await createCase();

    let escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ created: {} });

    await fundCase(c);
    escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ funded: {} });

    await submitDelivery(c);
    escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ deliverySubmitted: {} });

    await releaseCase(c);
    escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ released: {} });

    const vaultBal = await provider.connection.getTokenAccountBalance(c.vaultPDA);
    expect(vaultBal.value.amount).to.equal("0");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PROOF SCHEMA HARDENING
  // ═══════════════════════════════════════════════════════════════════════════
  it("Rejects invalid hash format", async () => {
    const sp = Keypair.generate();
    try {
      await program.methods
        .createEscrow("bad hash", "not-a-sha256", new BN(1_000_000), new BN(Math.floor(Date.now()/1000) + 3600))
        .accounts({
          client: wallet.publicKey,
          provider: sp.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();
      expect.fail("Should reject invalid hash");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidHashFormat");
    }
  });

  it("Rejects hash with non-hex characters", async () => {
    const sp = Keypair.generate();
    const badHash = "g".repeat(64);
    try {
      await program.methods
        .createEscrow("bad hex", badHash, new BN(1_000_000), new BN(Math.floor(Date.now()/1000) + 3600))
        .accounts({
          client: wallet.publicKey,
          provider: sp.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();
      expect.fail("Should reject non-hex hash");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidHashFormat");
    }
  });

  it("Rejects zero amount", async () => {
    const sp = Keypair.generate();
    try {
      await program.methods
        .createEscrow("zero", VALID_HASH, new BN(0), new BN(Math.floor(Date.now()/1000) + 3600))
        .accounts({
          client: wallet.publicKey,
          provider: sp.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();
      expect.fail("Should reject zero amount");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidAmount");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STATE MACHINE: FORBIDDEN TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  it("Cannot submit delivery on Created (unfunded) escrow", async () => {
    const c = await createCase();
    try {
      await submitDelivery(c);
      expect.fail("Should reject submitDelivery on Created");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  it("Cannot release on Created (unfunded) escrow", async () => {
    const c = await createCase();
    try {
      await releaseCase(c);
      expect.fail("Should reject release on Created");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  it("Cannot fund twice", async () => {
    const c = await createCase();
    await fundCase(c);
    try {
      await fundCase(c);
      expect.fail("Should reject double fund");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  it("Cannot submit delivery twice", async () => {
    const c = await createCase();
    await fundCase(c);
    await submitDelivery(c);
    try {
      await submitDelivery(c);
      expect.fail("Should reject double delivery");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. ANTI-REPLAY: TERMINAL STATE OPERATIONS BLOCKED
  // ═══════════════════════════════════════════════════════════════════════════
  it("Cannot dispute after release (terminal state)", async () => {
    const c = await createCase();
    await fundCase(c);
    await submitDelivery(c);
    await releaseCase(c);

    try {
      await program.methods.disputeEscrow("late dispute").accounts({
        authority: c.client.publicKey,
        escrow: c.escrowPDA,
      }).rpc();
      expect.fail("Should reject dispute on Released");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  it("Cannot cancel after release (terminal state)", async () => {
    const c = await createCase();
    await fundCase(c);
    await submitDelivery(c);
    await releaseCase(c);

    try {
      await program.methods.cancelEscrow().accounts({
        authority: c.client.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        clientTokenAccount: c.clientAta,
      }).rpc();
      expect.fail("Should reject cancel on Released");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidStatus");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. AUTHORIZATION MATRIX: WRONG ROLES BLOCKED
  // ═══════════════════════════════════════════════════════════════════════════
  it("Outsider cannot dispute", async () => {
    const c = await createCase();
    await fundCase(c);

    try {
      await program.methods.disputeEscrow("attacker dispute").accounts({
        authority: outsider.publicKey,
        escrow: c.escrowPDA,
      }).signers([outsider]).rpc();
      expect.fail("Should reject outsider dispute");
    } catch (e: any) {
      expect(e.toString()).to.include("Unauthorized");
    }
  });

  it("Provider cannot cancel funded escrow before deadline", async () => {
    const c = await createCase();
    await fundCase(c);

    try {
      await program.methods.cancelEscrow().accounts({
        authority: c.serviceProvider.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        clientTokenAccount: c.clientAta,
      }).signers([c.serviceProvider]).rpc();
      expect.fail("Should reject provider cancel");
    } catch (e: any) {
      expect(e.toString()).to.include("Unauthorized");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. CANCEL FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  it("Client can cancel Created escrow (no funds locked)", async () => {
    const c = await createCase();

    await program.methods.cancelEscrow().accounts({
      authority: c.client.publicKey,
      escrow: c.escrowPDA,
      vault: c.vaultPDA,
      clientTokenAccount: c.clientAta,
    }).rpc();

    const escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ cancelled: {} });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DEADLINE EDGE BEHAVIOR
  // ═══════════════════════════════════════════════════════════════════════════
  it("Rejects creating escrow with deadline in the past", async () => {
    const sp = Keypair.generate();
    const pastDeadline = Math.floor(Date.now() / 1000) - 60;

    try {
      await program.methods
        .createEscrow("past deadline", VALID_HASH, new BN(1_000_000), new BN(pastDeadline))
        .accounts({
          client: wallet.publicKey,
          provider: sp.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();
      expect.fail("Should reject past deadline");
    } catch (e: any) {
      expect(e.toString()).to.include("DeadlineInPast");
    }
  });

  it("Client cannot cancel funded escrow before deadline expires", async () => {
    const c = await createCase({ deadlineDelta: 7200 }); // 2 hours from now
    await fundCase(c);

    try {
      await program.methods.cancelEscrow().accounts({
        authority: c.client.publicKey,
        escrow: c.escrowPDA,
        vault: c.vaultPDA,
        clientTokenAccount: c.clientAta,
      }).rpc();
      expect.fail("Should reject cancel before deadline");
    } catch (e: any) {
      expect(e.toString()).to.include("Unauthorized");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. EVENTS EMITTED WITH REQUIRED FIELDS
  // ═══════════════════════════════════════════════════════════════════════════
  it("EscrowCreated event contains all required fields", async () => {
    const serviceProvider = Keypair.generate();
    const amount = 500_000;
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), wallet.publicKey.toBuffer(), serviceProvider.publicKey.toBuffer()],
      program.programId
    );

    const listener = program.addEventListener("escrowCreated", (event: any) => {
      expect(event.escrow.toString()).to.equal(escrowPDA.toString());
      expect(event.client.toString()).to.equal(wallet.publicKey.toString());
      expect(event.provider.toString()).to.equal(serviceProvider.publicKey.toString());
      expect(event.amount.toNumber()).to.equal(amount);
      expect(event.feeBps.toNumber()).to.equal(200);
      expect(event.deadline.toNumber()).to.equal(deadline);
    });

    try {
      await program.methods
        .createEscrow("event test", VALID_HASH, new BN(amount), new BN(deadline))
        .accounts({
          client: wallet.publicKey,
          provider: serviceProvider.publicKey,
          mint,
          arbitrator: treasury.publicKey,
          treasury: treasury.publicKey,
        })
        .rpc();

      // Verify the escrow was created (event listener runs async)
      const escrow = await program.account.escrowAccount.fetch(escrowPDA);
      expect(escrow.amount.toNumber()).to.equal(amount);
      expect(escrow.feeBps.toNumber()).to.equal(200);
      expect(escrow.client.toString()).to.equal(wallet.publicKey.toString());
      expect(escrow.provider.toString()).to.equal(serviceProvider.publicKey.toString());
    } finally {
      await program.removeEventListener(listener);
    }
  });

  it("EscrowFunded and EscrowReleased events fire with correct amounts", async () => {
    const c = await createCase({ amount: 1_000_000 });

    const fundedEvents: any[] = [];
    const releasedEvents: any[] = [];

    const fundListener = program.addEventListener("escrowFunded", (event: any) => {
      fundedEvents.push(event);
    });
    const releaseListener = program.addEventListener("escrowReleased", (event: any) => {
      releasedEvents.push(event);
    });

    try {
      await fundCase(c);
      await submitDelivery(c);
      await releaseCase(c);

      // Check fund event
      expect(fundedEvents.length).to.be.gte(1);
      const fundEvent = fundedEvents.find((e: any) => e.escrow.toString() === c.escrowPDA.toString());
      expect(fundEvent).to.not.be.undefined;
      expect(fundEvent.amount.toNumber()).to.equal(1_000_000);

      // Check release event — provider gets 98%, treasury gets 2%
      expect(releasedEvents.length).to.be.gte(1);
      const releaseEvent = releasedEvents.find((e: any) => e.escrow.toString() === c.escrowPDA.toString());
      expect(releaseEvent).to.not.be.undefined;
      expect(releaseEvent.amount.toNumber()).to.equal(1_000_000);
      expect(releaseEvent.feeAmount.toNumber()).to.equal(20_000); // 2% of 1M
      expect(releaseEvent.providerAmount.toNumber()).to.equal(980_000); // 98% of 1M
    } finally {
      await program.removeEventListener(fundListener);
      await program.removeEventListener(releaseListener);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. DISPUTE FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  it("Client can dispute funded escrow", async () => {
    const c = await createCase();
    await fundCase(c);

    await program.methods.disputeEscrow("quality issue").accounts({
      authority: c.client.publicKey,
      escrow: c.escrowPDA,
    }).rpc();

    const escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ disputed: {} });
  });

  it("Provider can dispute funded escrow", async () => {
    const c = await createCase();
    await fundCase(c);

    await program.methods.disputeEscrow("scope change").accounts({
      authority: c.serviceProvider.publicKey,
      escrow: c.escrowPDA,
    }).signers([c.serviceProvider]).rpc();

    const escrow = await program.account.escrowAccount.fetch(c.escrowPDA);
    expect(escrow.status).to.deep.equal({ disputed: {} });
  });
});
