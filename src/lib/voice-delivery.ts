export type VoiceDeliveryPlan = Readonly<{
  rate: number;
  pitchHz: number;
  cadence: "brief" | "conversational" | "careful" | "question";
}>;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Keeps one familiar voice while adjusting only small, predictable acoustic
 * controls. This is content-preserving: it never asks a model to paraphrase
 * a reply in the latency-sensitive delivery path.
 */
export function planVoiceDelivery(value: string): VoiceDeliveryPlan {
  const text = value.replace(/\s+/g, " ").trim();
  const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const careful = /\b(?:risk|careful|warning|important|not confirmed|uncertain|decision|legal|medical|financial)\b/i.test(text)
    || /(?:\d{2,}|[$£€]|\b(?:first|second|third)\b|:\s)/i.test(text);
  const question = /\?[”"')\]]?$/.test(text);
  const brief = words > 0 && words <= 11 && !careful;
  const baseRate = careful ? 0.99 : brief ? 1.1 : question ? 1.05 : 1.06;
  const pitchHz = careful ? 2 : brief ? 4 : question ? 4 : 3;
  return Object.freeze({
    rate: Math.round(clamp(baseRate, 0.96, 1.12) * 100) / 100,
    pitchHz: Math.round(clamp(pitchHz, 1, 5)),
    cadence: careful ? "careful" : brief ? "brief" : question ? "question" : "conversational",
  });
}

export function voiceDeliveryCacheKey(plan: VoiceDeliveryPlan): string {
  return `${plan.rate}:${plan.pitchHz}:${plan.cadence}`;
}
