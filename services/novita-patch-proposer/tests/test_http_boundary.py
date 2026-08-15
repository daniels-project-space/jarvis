from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import app as adapter_app  # noqa: E402
from adapter.runtime import ModelRuntime  # noqa: E402
from test_policy import environment, request_body  # noqa: E402


class HttpBoundaryTests(unittest.TestCase):
    def test_rejects_tool_calls_before_the_loopback_model_can_run(self) -> None:
        def no_model_start(self: ModelRuntime) -> None:
            # This exercises only the HTTP admission boundary; it must reject
            # before any model process or HTTP egress is needed.
            self.process = None

        with (
            patch.dict(os.environ, environment(), clear=False),
            patch.object(ModelRuntime, "start", no_model_start),
        ):
            with TestClient(adapter_app.app) as client:
                response = client.post(
                    "/v1/chat/completions",
                    content=request_body(tools=[]),
                    headers={
                        "authorization": "Bearer " + "A" * 43,
                        "content-type": "application/json",
                    },
                )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "unsupported_request_shape"})


if __name__ == "__main__":
    unittest.main()
