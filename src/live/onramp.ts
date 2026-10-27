/**
 * Card / Apple Pay / Google Pay on-ramp via MoonPay.
 *
 * We build a MoonPay checkout link with the user's Outcry wallet address and
 * amount pre-filled, signed server-side (MoonPay requires a signature whenever
 * the wallet address is pre-filled). MoonPay handles the card, KYC and
 * delivery; the coins land directly in the user's own wallet. Outcry never
 * touches the card or the fiat.
 *
 * Signing (dev.moonpay.com URL signing): base64(HMAC-SHA256(secretKey, "?query")),
 * appended URL-encoded as the last parameter `signature`.
 */
import { createHmac } from "node:crypto";

export const ONRAMP_FIATS = ["usd", "eur", "chf", "gbp"] as const;
export type OnrampFiat = (typeof ONRAMP_FIATS)[number];
export type OnrampAsset = "sol" | "usdc";

export interface MoonPayConfig {
  apiKey: string;
  secretKey: string;
  /** Defaults to sandbox for pk_test keys, production otherwise. */
  baseUrl?: string;
}

export function signMoonPayUrl(url: string, secretKey: string) {
  const sig = createHmac("sha256", secretKey).update(new URL(url).search).digest("base64");
  return `${url}&signature=${encodeURIComponent(sig)}`;
}

export class MoonPayOnramp {
  readonly provider = "moonpay";
  constructor(private cfg: MoonPayConfig) {}

  get sandbox() {
    return this.cfg.apiKey.startsWith("pk_test");
  }

  private get base() {
    return this.cfg.baseUrl ?? (this.sandbox ? "https://buy-sandbox.moonpay.com" : "https://buy.moonpay.com");
  }

  /** A signed checkout link that delivers `asset` to `address`. */
  buyUrl(o: { address: string; asset: OnrampAsset; fiat: OnrampFiat; amount: number; userRef: string; redirectUrl?: string }) {
    const p = new URLSearchParams({
      apiKey: this.cfg.apiKey,
      currencyCode: o.asset === "usdc" ? "usdc_sol" : "sol",
      walletAddress: o.address,
      baseCurrencyCode: o.fiat,
      baseCurrencyAmount: String(Math.round(o.amount)),
      externalCustomerId: o.userRef,
      theme: "dark",
      colorCode: "#2F3CFF",
      showWalletAddressForm: "false",
    });
    if (o.redirectUrl) p.set("redirectURL", o.redirectUrl);
    return signMoonPayUrl(`${this.base}/?${p.toString()}`, this.cfg.secretKey);
  }

  status() {
    return { provider: this.provider, sandbox: this.sandbox };
  }
}

export function onrampFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.MOONPAY_API_KEY?.trim();
  const secretKey = env.MOONPAY_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) return undefined;
  return new MoonPayOnramp({ apiKey, secretKey, baseUrl: env.MOONPAY_BASE_URL?.trim() || undefined });
}
