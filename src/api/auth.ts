/**
 * Accounts with passkeys (WebAuthn).
 *
 * Everyone starts as a guest (a session token tied to a paper wallet). A guest
 * can secure the account with a passkey (Face ID, Touch ID, Windows Hello or
 * a security key), then sign in from any device with it. Once a passkey
 * exists, signing a ticket requires a passkey assertion bound to that ticket.
 *
 * Server only: the in-browser demo build does not include this module.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { sha256Hex } from "../core/hash.js";
import { HttpError } from "./handlers.js";

export interface Credential {
  id: string; // base64url credential id
  userId: string;
  publicKey: string; // base64url COSE key
  counter: number;
  transports?: string[];
  createdAt: string;
  label: string;
}

export interface RequestMeta {
  /** e.g. https://outcry-7yp6.onrender.com */
  origin: string;
  /** e.g. outcry-7yp6.onrender.com */
  rpId: string;
}

const b64u = {
  enc: (b: Uint8Array) => Buffer.from(b).toString("base64url"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64url")),
};

export class AuthService {
  /** Persisted. */
  readonly credentials = new Map<string, Credential>();
  /** Ephemeral: pending challenges, keyed by user id or login id, 5 minute life. */
  private challenges = new Map<string, { challenge: string; at: number; ticketId?: string }>();

  constructor(private rpName = "Outcry by Woodeng") {}

  hasPasskey(userId: string) {
    for (const c of this.credentials.values()) if (c.userId === userId) return true;
    return false;
  }

  listFor(userId: string) {
    return [...this.credentials.values()].filter((c) => c.userId === userId).map((c) => ({ id: c.id.slice(0, 10), label: c.label, createdAt: c.createdAt }));
  }

  private take(key: string) {
    const c = this.challenges.get(key);
    this.challenges.delete(key);
    if (!c || Date.now() - c.at > 5 * 60_000) throw new HttpError(400, "This request expired. Try again.");
    return c;
  }

  // --- register a passkey on the current (guest or signed-in) account ------
  async registerOptions(userId: string, badge: string, meta: RequestMeta) {
    const opts = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: meta.rpId,
      userName: `${badge.toLowerCase()}-${userId.slice(-6)}`,
      userDisplayName: `Outcry ${badge}`,
      userID: new TextEncoder().encode(userId),
      attestationType: "none",
      excludeCredentials: [...this.credentials.values()].filter((c) => c.userId === userId).map((c) => ({ id: c.id, transports: c.transports as never })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    this.challenges.set(`reg:${userId}`, { challenge: opts.challenge, at: Date.now() });
    return opts;
  }

  async registerVerify(userId: string, response: unknown, meta: RequestMeta, label = "Passkey") {
    const { challenge } = this.take(`reg:${userId}`);
    const v = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: meta.origin,
      expectedRPID: meta.rpId,
      requireUserVerification: false,
    });
    if (!v.verified || !v.registrationInfo) throw new HttpError(400, "Passkey could not be verified");
    const c = v.registrationInfo.credential;
    this.credentials.set(c.id, {
      id: c.id,
      userId,
      publicKey: b64u.enc(c.publicKey),
      counter: c.counter,
      transports: c.transports,
      createdAt: new Date().toISOString(),
      label: label.slice(0, 40),
    });
    return { ok: true };
  }

  // --- sign in on any device with a passkey (discoverable credential) -------
  async loginOptions(meta: RequestMeta) {
    const opts = await generateAuthenticationOptions({ rpID: meta.rpId, userVerification: "preferred" });
    const loginId = sha256Hex(opts.challenge).slice(0, 24);
    this.challenges.set(`login:${loginId}`, { challenge: opts.challenge, at: Date.now() });
    return { loginId, options: opts };
  }

  async loginVerify(loginId: string, response: { id?: string }, meta: RequestMeta): Promise<string> {
    const { challenge } = this.take(`login:${loginId}`);
    return this.verifyAssertion(challenge, response, meta);
  }

  // --- approve a ticket: the challenge commits to the ticket id -------------
  async approvalOptions(userId: string, ticketId: string, ticketFingerprint: string, meta: RequestMeta) {
    const creds = [...this.credentials.values()].filter((c) => c.userId === userId);
    if (!creds.length) throw new HttpError(400, "No passkey on this account");
    const challenge = b64u.enc(new TextEncoder().encode(sha256Hex(`${ticketId}:${ticketFingerprint}:${Date.now()}:${Math.random()}`)));
    const opts = await generateAuthenticationOptions({
      rpID: meta.rpId,
      challenge: b64u.dec(challenge),
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })),
      userVerification: "preferred",
    });
    this.challenges.set(`approve:${userId}:${ticketId}`, { challenge: opts.challenge, at: Date.now(), ticketId });
    return opts;
  }

  /** Returns true when a valid passkey assertion for this ticket was supplied. */
  async verifyApproval(userId: string, ticketId: string, response: unknown, meta: RequestMeta) {
    const { challenge } = this.take(`approve:${userId}:${ticketId}`);
    const who = await this.verifyAssertion(challenge, response as { id?: string }, meta);
    if (who !== userId) throw new HttpError(403, "That passkey belongs to another account");
    return true;
  }

  private async verifyAssertion(challenge: string, response: { id?: string }, meta: RequestMeta) {
    const cred = response?.id ? this.credentials.get(response.id) : undefined;
    if (!cred) throw new HttpError(401, "Unknown passkey. Secure an account first, on the device where you created it.");
    const v = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: meta.origin,
      expectedRPID: meta.rpId,
      credential: { id: cred.id, publicKey: b64u.dec(cred.publicKey), counter: cred.counter, transports: cred.transports as never },
      requireUserVerification: false,
    });
    if (!v.verified) throw new HttpError(401, "Passkey check failed");
    cred.counter = v.authenticationInfo.newCounter;
    return cred.userId;
  }
}
