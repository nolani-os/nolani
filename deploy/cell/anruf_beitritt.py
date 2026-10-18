#!/usr/bin/env python3
"""Call test part 2 (FROM OUTSIDE): join with the lk-jwt token and send audio.

Runs on a machine outside the cell (real firewall, real internet), e.g.:
    docker run --rm -e LK_DATEI=/t/lk.json -v …:/t python:3.12-slim sh -c \
      "pip install -q livekit numpy && python3 /t/anruf_beitritt.py"
Connects with exactly the token lk-jwt-service issued for the user (like Element Call),
publishes a 440 Hz tone for 15 s and reports whether the connection held. The real proof
is server-side: the cell's LiveKit log must show "participant active" and "track published"
(the call UI alone proves nothing about the media path).
"""
import asyncio
import json
import math
import os

import numpy as np
from livekit import rtc

d = json.load(open(os.environ["LK_DATEI"]))


async def main():
    room = rtc.Room()
    await room.connect(d["url"], d["jwt"])
    print("verbunden als", room.local_participant.identity, "| Raum", room.name)
    quelle = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("ton", quelle)
    pub = await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    print("Track veröffentlicht:", pub.sid)
    n = 480  # 10 ms
    for i in range(1500):  # 15 s
        t = (np.arange(n) + i * n) / 48000
        daten = (np.sin(2 * math.pi * 440 * t) * 8000).astype(np.int16)
        frame = rtc.AudioFrame(daten.tobytes(), 48000, 1, n)
        await quelle.capture_frame(frame)
    print("15 s Ton gesendet, Verbindungszustand:", room.connection_state)
    await room.disconnect()


asyncio.run(main())
