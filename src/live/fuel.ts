/**
 * AI fuel packs. Every user gets a free tank each day (OUTCRY_MAX_AI_USD_PER_USER);
 * when it runs dry the chat drops to the basic offline engine. A pack adds paid
 * fuel (USD of model cost) that keeps the full AI on. Paid in USDC or SOL from
 * the user's real wallet to the treasury, signed with their passkey.
 */
export interface FuelPack {
  id: "shout" | "roar" | "riot";
  name: string;
  tagline: string;
  usd: number;
  /** Model cost it covers (the rest pays for hosting and margin). */
  creditUsd: number;
  bonusPct: number;
}

export const FUEL_PACKS: FuelPack[] = [
  { id: "shout", name: "Shout", tagline: "A full tank for a busy day", usd: 5, creditUsd: 4, bonusPct: 0 },
  { id: "roar", name: "Roar", tagline: "For traders who talk to their agents a lot", usd: 15, creditUsd: 13, bonusPct: 8 },
  { id: "riot", name: "Pit riot", tagline: "The whole floor shouting for you", usd: 40, creditUsd: 36, bonusPct: 12 },
];

export const fuelPack = (id: string) => FUEL_PACKS.find((p) => p.id === id);
