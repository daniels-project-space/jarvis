from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException


def load_app_module():
    app_path = Path(__file__).with_name("app.py")
    spec = importlib.util.spec_from_file_location("jarvis_local_stt_app", app_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load local STT app")
    module = importlib.util.module_from_spec(spec)
    fake_whisper = SimpleNamespace(WhisperModel=object)
    with patch.dict(os.environ, {
        "STT_SHARED_SECRET": "local-test-secret",
        "STT_ALLOWED_ORIGINS": "https://jarvis.example",
    }), patch.dict(sys.modules, {"faster_whisper": fake_whisper}):
        spec.loader.exec_module(module)
    return module


def ticket(secret: str, *, origin: str = "https://jarvis.example", expires_offset_ms: int = 30_000) -> str:
    payload = {
        "v": 1,
        "aud": "jarvis-final-stt",
        "exp": int(time.time() * 1000) + expires_offset_ms,
        "nonce": "ticket_nonce_abcdefghijklmnopqrstuvwxyz",
        "origin": origin,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
    return f"{encoded}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


class BrowserTicketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = load_app_module()
        self.app._used_tickets.clear()

    def test_accepts_one_origin_bound_ticket_once(self) -> None:
        bearer = f"Bearer {ticket('local-test-secret')}"
        self.app.require_authorization(bearer, "https://jarvis.example")
        with self.assertRaises(HTTPException):
            self.app.require_authorization(bearer, "https://jarvis.example")

    def test_rejects_wrong_origin_expiry_and_tampering(self) -> None:
        valid = f"Bearer {ticket('local-test-secret')}"
        with self.assertRaises(HTTPException):
            self.app.require_authorization(valid, "https://attacker.example")
        with self.assertRaises(HTTPException):
            self.app.require_authorization(f"Bearer {ticket('local-test-secret', expires_offset_ms=-1)}", "https://jarvis.example")
        with self.assertRaises(HTTPException):
            self.app.require_authorization(f"{valid}x", "https://jarvis.example")

    def test_keeps_server_to_server_shared_secret_compatible(self) -> None:
        self.app.require_authorization("Bearer local-test-secret", None)

    def test_uses_the_vocabulary_once_as_an_initial_prompt(self) -> None:
        options = self.app.transcription_options("en", "Jarvis, Paul, Maya")
        self.assertEqual(options["initial_prompt"], "Jarvis, Paul, Maya")
        self.assertNotIn("hotwords", options)


if __name__ == "__main__":
    unittest.main()
