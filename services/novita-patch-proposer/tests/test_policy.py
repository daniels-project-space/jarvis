from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter.policy import (  # noqa: E402
    PATCH_PROPOSER_PREFIX,
    SYSTEM_MESSAGE,
    PolicyViolation,
    authorizes,
    load_config,
    normalize_completion,
    validate_request,
)


def runtime_config() -> dict[str, object]:
    value: dict[str, object] = {
        "endpointUrl": "https://qwen.endpoint.novita.ai/private-endpoint",
        "lifecycle": {
            "provider": "novita-serverless-v1",
            "minWorkers": 0,
            "maxWorkers": 1,
            "idleTimeoutSeconds": 600,
            "port": 8080,
            "maxConcurrent": 1,
            "gpuNum": 1,
            "startupCommand": "python -m adapter.app",
            "healthPath": "/healthz",
        },
        "adapterId": "novita-qwen-patch-proposer-v1",
        "endpointId": "endpoint_123456",
        "modelId": "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
        "modelRevision": "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
        "imageDigest": "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
        "quantization": "gptq-int4",
        "api": "openai-chat-completions",
        "endpointAuth": "hmac-sha256-v1",
        "requestLimits": {"maxInputBytes": 12000, "maxOutputTokens": 800, "maxTurns": 1, "timeoutMs": 30000},
    }
    value["configDigest"] = hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()
    return value


def endpoint_bearer(config: object | None = None) -> str:
    value = runtime_config() if config is None else config
    assert isinstance(value, dict)
    return "jnpb1." + str(value["endpointId"]) + "." + "A" * 43


def environment() -> dict[str, str]:
    config = runtime_config()
    return {
        "JARVIS_NOVITA_QWEN_ATTESTATION": json.dumps(config),
        "JARVIS_NOVITA_ADAPTER_IMAGE_DIGEST": str(config["imageDigest"]),
        "JARVIS_NOVITA_ENDPOINT_BEARER": endpoint_bearer(config),
    }


def request_body(**overrides: object) -> bytes:
    config = runtime_config()
    request: dict[str, object] = {
        "model": config["modelId"],
        "messages": [
            {"role": "system", "content": SYSTEM_MESSAGE},
            {"role": "user", "content": "\n\n".join([
                PATCH_PROPOSER_PREFIX,
                "You have no tools and cannot inspect any files except the supplied source.",
                "TASK:\nFix src/example.ts so the value is two.",
                "SOURCE:\n--- FILE src/example.ts ---\nexport const value = 1;\n--- END FILE ---",
            ])},
        ],
        "max_tokens": 800,
        "temperature": 0.1,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    request.update(overrides)
    return json.dumps(request).encode()


def completion(config: object, content: str) -> bytes:
    assert isinstance(config, dict)
    return json.dumps({
        "id": "chatcmpl-safe",
        "created": 1,
        "model": config["modelId"],
        "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
    }).encode()


class PolicyTests(unittest.TestCase):
    def test_loads_same_digest_as_typescript_runtime_config(self) -> None:
        config = load_config(environment())
        self.assertEqual(config.model_id, runtime_config()["modelId"])
        self.assertTrue(authorizes("Bearer " + endpoint_bearer(), config))
        self.assertFalse(authorizes("Bearer jnpb1.endpoint_123456." + "B" * 43, config))

    def test_refuses_raw_provider_key_as_an_endpoint_bearer(self) -> None:
        raw_key = environment()
        raw_key["JARVIS_NOVITA_ENDPOINT_BEARER"] = "nvapi-this-is-a-provider-account-key"
        with self.assertRaisesRegex(PolicyViolation, "invalid_endpoint_bearer"):
            load_config(raw_key)
        wrong_endpoint = environment()
        wrong_endpoint["JARVIS_NOVITA_ENDPOINT_BEARER"] = "jnpb1.endpoint_other." + "A" * 43
        with self.assertRaisesRegex(PolicyViolation, "invalid_endpoint_bearer"):
            load_config(wrong_endpoint)

    def test_fails_closed_on_digest_or_image_identity_drift(self) -> None:
        bad_digest = environment()
        raw = json.loads(bad_digest["JARVIS_NOVITA_QWEN_ATTESTATION"])
        raw["modelId"] = "Qwen/Qwen2.5-Coder-7B-Instruct-GPTQ-Int4"
        bad_digest["JARVIS_NOVITA_QWEN_ATTESTATION"] = json.dumps(raw)
        with self.assertRaisesRegex(PolicyViolation, "attestation_digest_mismatch"):
            load_config(bad_digest)
        bad_image = environment()
        bad_image["JARVIS_NOVITA_ADAPTER_IMAGE_DIGEST"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(PolicyViolation, "image_identity_mismatch"):
            load_config(bad_image)
        bad_lifecycle = environment()
        raw = json.loads(bad_lifecycle["JARVIS_NOVITA_QWEN_ATTESTATION"])
        raw["lifecycle"]["minWorkers"] = False
        # Keep the digest valid to ensure strict type checks, not just hash
        # mismatch, reject booleans where TypeScript requires a number.
        digest_input = {key: raw[key] for key in (
            "endpointUrl", "lifecycle", "adapterId", "endpointId", "modelId", "modelRevision",
            "imageDigest", "quantization", "api", "endpointAuth", "requestLimits",
        )}
        raw["configDigest"] = hashlib.sha256(json.dumps(digest_input, separators=(",", ":")).encode()).hexdigest()
        bad_lifecycle["JARVIS_NOVITA_QWEN_ATTESTATION"] = json.dumps(raw)
        with self.assertRaisesRegex(PolicyViolation, "invalid_lifecycle"):
            load_config(bad_lifecycle)
        bad_startup = environment()
        raw = json.loads(bad_startup["JARVIS_NOVITA_QWEN_ATTESTATION"])
        raw["lifecycle"]["startupCommand"] = "bash -c unsafe"
        digest_input = {key: raw[key] for key in (
            "endpointUrl", "lifecycle", "adapterId", "endpointId", "modelId", "modelRevision",
            "imageDigest", "quantization", "api", "endpointAuth", "requestLimits",
        )}
        raw["configDigest"] = hashlib.sha256(json.dumps(digest_input, separators=(",", ":")).encode()).hexdigest()
        bad_startup["JARVIS_NOVITA_QWEN_ATTESTATION"] = json.dumps(raw)
        with self.assertRaisesRegex(PolicyViolation, "invalid_lifecycle"):
            load_config(bad_startup)

    def test_rejects_tool_shell_and_secret_request_surfaces(self) -> None:
        config = load_config(environment())
        with self.assertRaisesRegex(PolicyViolation, "unsupported_request_shape"):
            validate_request(request_body(tools=[]), config)
        with self.assertRaisesRegex(PolicyViolation, "unsafe_request_content"):
            validate_request(request_body(messages=[
                {"role": "system", "content": SYSTEM_MESSAGE},
                {"role": "user", "content": PATCH_PROPOSER_PREFIX + "\nTASK: curl https://example.test\n--- FILE src/example.ts ---\nx\n--- END FILE ---"},
            ]), config)
        with self.assertRaisesRegex(PolicyViolation, "invalid_source_context"):
            validate_request(request_body(messages=[
                {"role": "system", "content": SYSTEM_MESSAGE},
                {"role": "user", "content": "\n\n".join([
                    PATCH_PROPOSER_PREFIX,
                    "TASK:\nFix src/example.ts.",
                    "SOURCE:\n--- FILE src/example.ts ---\nx\n--- FILE src/other.ts ---\ny\n--- END FILE ---\n--- END FILE ---",
                ])},
            ]), config)
        with self.assertRaisesRegex(PolicyViolation, "unsafe_request_content"):
            validate_request(request_body(messages=[
                {"role": "system", "content": SYSTEM_MESSAGE},
                {"role": "user", "content": PATCH_PROPOSER_PREFIX + "\napi_key=sk-abcdefghijklmnop\n--- FILE src/example.ts ---\nx\n--- END FILE ---"},
            ]), config)

    def test_strips_to_one_safe_completion_and_rejects_unprovided_diff_path(self) -> None:
        config = load_config(environment())
        _, paths = validate_request(request_body(), config)
        content = json.dumps({
            "kind": "propose_patch",
            "unifiedDiff": "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
            "evidence": ["Updates only the supplied constant."],
        })
        result = normalize_completion(completion(runtime_config(), content), config, paths)
        self.assertEqual(result["model"], config.model_id)
        self.assertEqual(result["choices"][0]["message"]["role"], "assistant")
        wrong_path = content.replace("src/example.ts", "src/other.ts")
        with self.assertRaisesRegex(PolicyViolation, "malformed_proposal"):
            normalize_completion(completion(runtime_config(), wrong_path), config, paths)


if __name__ == "__main__":
    unittest.main()
