import {
  configuredNovitaPatchProposer,
} from "../src/lib/novita-patch-proposer-attestation";
import { novitaPatchProposerRuntimeConfigDigest } from "../src/trigger/novita-qwen-patch-proposer";

const config = configuredNovitaPatchProposer(process.env);

// The adapter is intentionally opt-in. A normal release with no endpoint is
// valid and remains Codex-only; a configured endpoint must be exact before
// Trigger receives the environment value.
if (!process.env.JARVIS_NOVITA_QWEN_ATTESTATION) {
  console.log(JSON.stringify({ enabled: false, reason: "attestation_not_configured" }));
} else if (!config) {
  console.error("Novita patch-proposer attestation is malformed or unsafe.");
  process.exitCode = 1;
} else {
  const runtimeDigest = novitaPatchProposerRuntimeConfigDigest(config);
  if (runtimeDigest !== config.attestation.configDigest) {
    console.error("Novita patch-proposer attestation digest does not match its runtime configuration.");
    process.exitCode = 1;
  } else {
    // Deliberately omit endpoint URL and all auth material from deployment logs.
    console.log(JSON.stringify({
      enabled: true,
      configDigest: runtimeDigest,
      endpointId: config.attestation.endpointId,
      modelId: config.attestation.modelId,
      modelRevision: config.attestation.modelRevision,
      imageDigest: config.attestation.imageDigest,
      limits: config.attestation.requestLimits,
    }));
  }
}
