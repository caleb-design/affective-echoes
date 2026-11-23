#!/usr/bin/env python3
"""
Plug-in slot for your own affect model (e.g. fine-tuned on CMU-MOSEI).

Run:   pip install websockets
       python model_server_stub.py

The web app connects to ws://localhost:8765 automatically. While this server
sends estimates, they REPLACE the built-in browser estimates (the source shows
as "external" in the experimenter panel and in the logs).

Browser -> this server (JSON messages)
  {"type": "features", "t_epoch_ms": ..., "features": {...built-in estimates...},
   "frame_jpeg_b64": "<224x168 webcam frame>"}           # every 500 ms
  {"type": "transcript", "t_epoch_ms": ..., "text": "..."}  # each participant utterance

This server -> browser (JSON), send as often as you like (>= every 2 s):
  {"valence": -1..1, "arousal": -1..1, "label": "tense", "confidence": 0..1}
  `label` is optional; omit it to let the app derive one from valence/arousal.

Replace `predict()` with your model. Audio is not streamed by the browser; if your
model needs raw audio, capture the mic directly in this process (e.g. sounddevice).
"""
import asyncio
import base64
import json

import websockets  # pip install websockets


class MyModel:
    """Swap this for your CMU-MOSEI model wrapper."""

    def __init__(self):
        self.last_text = ""

    def predict(self, frame_bytes, text, builtin):
        # --- placeholder: echo the browser's own estimate back ---
        # Replace with e.g.:
        #   face_feat = self.face_encoder(decode_jpeg(frame_bytes))
        #   text_feat = self.text_encoder(text)
        #   valence, arousal = self.fusion_head(face_feat, text_feat, audio_feat)
        return {
            "valence": builtin.get("valence", 0.0),
            "arousal": builtin.get("arousal", 0.0),
            "confidence": 0.5,
        }


model = MyModel()


async def handler(ws):
    print("browser connected")
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "transcript":
            model.last_text = msg.get("text", "")
        elif msg.get("type") == "features":
            frame = base64.b64decode(msg["frame_jpeg_b64"]) if msg.get("frame_jpeg_b64") else None
            out = model.predict(frame, model.last_text, msg.get("features", {}))
            await ws.send(json.dumps(out))
    print("browser disconnected")


async def main():
    async with websockets.serve(handler, "localhost", 8765, max_size=2**22):
        print("Model server on ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
