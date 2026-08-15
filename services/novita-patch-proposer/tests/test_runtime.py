from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter.runtime import ModelRuntime, VLLM_PROCESS_ENVIRONMENT  # noqa: E402
from test_policy import environment  # noqa: E402
from adapter.policy import load_config  # noqa: E402


class RuntimeTests(unittest.TestCase):
    def test_model_subprocess_receives_only_the_fixed_environment_allowlist(self) -> None:
        inherited = environment() | {
            "NOVITA_API_KEY": "provider-account-key",
            "HF_TOKEN": "hugging-face-token",
            "AWS_SECRET_ACCESS_KEY": "other-secret",
            "PATH": "/attacker-controlled/path",
        }
        process = MagicMock()
        with (
            patch.dict(os.environ, inherited, clear=False),
            patch("adapter.runtime.Path.mkdir"),
            patch("adapter.runtime.subprocess.Popen", return_value=process) as popen,
        ):
            ModelRuntime(load_config(environment())).start()

        child_environment = popen.call_args.kwargs["env"]
        self.assertEqual(child_environment, VLLM_PROCESS_ENVIRONMENT)
        self.assertNotIn("JARVIS_NOVITA_ENDPOINT_BEARER", child_environment)
        self.assertNotIn("JARVIS_NOVITA_QWEN_ATTESTATION", child_environment)
        self.assertNotIn("NOVITA_API_KEY", child_environment)
        self.assertNotIn("HF_TOKEN", child_environment)
        self.assertFalse(any(key.startswith("HF") for key in child_environment))
        self.assertFalse(any("TOKEN" in key or "SECRET" in key for key in child_environment))


if __name__ == "__main__":
    unittest.main()
