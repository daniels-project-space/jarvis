from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import numpy as np


class FakeStream:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def accept_waveform(self, sample_rate: int, samples: np.ndarray) -> None:
        self.calls.append(("accept", (sample_rate, samples.copy())))

    def input_finished(self) -> None:
        self.calls.append(("finished", None))


class FakeRecognizer:
    def __init__(self) -> None:
        self.ready = [True, False]

    def is_ready(self, _stream: FakeStream) -> bool:
        return self.ready.pop(0)

    def decode_stream(self, stream: FakeStream) -> None:
        stream.calls.append(("decode", None))

    def get_result(self, _stream: FakeStream) -> str:
        return "final words"

    def create_stream(self) -> FakeStream:
        return FakeStream()


class FakeWebSocket:
    def __init__(self) -> None:
        self.headers = {"origin": "https://jarvis.example"}
        self.sent: list[dict[str, object]] = []
        self.closed: list[int] = []

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        return '{"type":"auth","ticket":"valid"}'

    async def receive(self) -> dict[str, object]:
        return {"text": '{"type":"end"}'}

    async def send_json(self, value: dict[str, object]) -> None:
        self.sent.append(value)

    async def close(self, code: int) -> None:
        self.closed.append(code)


def load_app_module():
    app_path = Path(__file__).with_name("app.py")
    spec = importlib.util.spec_from_file_location("jarvis_streaming_stt_app", app_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load streaming STT app")
    module = importlib.util.module_from_spec(spec)
    fake_sherpa = SimpleNamespace(OnlineRecognizer=object, OnlineStream=object)
    with patch.dict(os.environ, {"STREAMING_STT_TICKET_SECRET": "test-secret"}), patch.dict(
        sys.modules, {"sherpa_onnx": fake_sherpa}
    ):
        spec.loader.exec_module(module)
    return module


class FinalizeDecodeTests(unittest.TestCase):
    def test_final_decode_feeds_tail_before_input_finished(self) -> None:
        app = load_app_module()
        model = FakeRecognizer()
        stream = FakeStream()

        with patch.object(app, "recognizer", return_value=model):
            result = app._decode(stream, done=True)

        self.assertEqual(result, "final words")
        self.assertEqual([call[0] for call in stream.calls], ["accept", "finished", "decode"])
        sample_rate, samples = stream.calls[0][1]
        self.assertEqual(sample_rate, 16_000)
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.shape, (4_800,))
        self.assertTrue(np.all(samples == 0))

    def test_lifecycle_probe_exercises_real_finalization_path(self) -> None:
        app = load_app_module()
        model = FakeRecognizer()

        with patch.object(app, "recognizer", return_value=model), patch.object(
            app, "_decode"
        ) as decode:
            app._verify_recognizer_lifecycle()

        stream = decode.call_args.args[0]
        self.assertTrue(decode.call_args.kwargs["done"])
        self.assertEqual(stream.calls[0][0], "accept")
        sample_rate, samples = stream.calls[0][1]
        self.assertEqual(sample_rate, 16_000)
        self.assertEqual(samples.shape, (1_600,))


class StreamingProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_end_control_sends_final_and_clean_close(self) -> None:
        app = load_app_module()
        app._active_connections = 0
        socket = FakeWebSocket()
        model = SimpleNamespace(create_stream=lambda: FakeStream())

        with patch.object(app, "_claim_ticket", AsyncMock(return_value=True)), patch.object(
            app, "recognizer", return_value=model
        ), patch.object(app, "_decode", return_value="final words"):
            await app.stream(socket)

        self.assertEqual(
            socket.sent,
            [
                {"type": "ready", "sampleRate": 16_000},
                {"type": "final", "text": "final words"},
            ],
        )
        self.assertEqual(socket.closed, [1000])
        self.assertEqual(app._active_connections, 0)


if __name__ == "__main__":
    unittest.main()
