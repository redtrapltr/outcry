/**
 * Withdrawals from a real (Turnkey) wallet: SOL or any SPL / Token-2022 token
 * to an address the user chooses. Builds an unsigned legacy transaction; the
 * pilot signs it with Turnkey after a passkey approval and sends it.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Priority fee so withdrawals land when the network is busy (~0.00002 SOL total). */
const PRIORITY_MICRO_LAMPORTS = 50_000;
const COMPUTE_UNITS = 60_000;
export const WITHDRAW_FEE_SOL = 0.000005 + (PRIORITY_MICRO_LAMPORTS * COMPUTE_UNITS) / 1e15;
export const ATA_RENT_SOL = 0.00204;

/** A normal wallet address (on the ed25519 curve). Rejects token accounts and program addresses. */
export function checkDestination(to: string): PublicKey {
  let pk: PublicKey;
  try {
    pk = new PublicKey(to.trim());
  } catch {
    throw new Error("That isn't a valid Solana address");
  }
  if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error("That address isn't a regular wallet (it looks like a token or program account). Paste the wallet address you'd receive SOL on.");
  return pk;
}

export function buildSolTransfer(p: { from: string; to: string; lamports: bigint; blockhash: string }): string {
  const from = new PublicKey(p.from);
  const tx = new Transaction({ feePayer: from, recentBlockhash: p.blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(p.to), lamports: p.lamports }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export function buildTokenTransfer(p: { from: string; to: string; mint: string; decimals: number; amountRaw: bigint; tokenProgram: string; blockhash: string }): string {
  const from = new PublicKey(p.from), to = new PublicKey(p.to), mint = new PublicKey(p.mint);
  const program = p.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const src = getAssociatedTokenAddressSync(mint, from, false, program);
  const dst = getAssociatedTokenAddressSync(mint, to, false, program);
  const tx = new Transaction({ feePayer: from, recentBlockhash: p.blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
  // Creates the receiver's token account if it doesn't exist yet (paid by the sender, ~0.002 SOL).
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mint, program));
  tx.add(createTransferCheckedInstruction(src, mint, dst, from, p.amountRaw, p.decimals, [], program));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
