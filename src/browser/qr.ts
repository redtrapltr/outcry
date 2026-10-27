import QRCode from "qrcode";
/** An SVG QR code for a wallet address (used by the "Add funds" sheet). */
export const qrSvg = (text: string) => QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0d2e", light: "#ffffff" } });
