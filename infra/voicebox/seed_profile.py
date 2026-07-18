"""Idempotently seed the audited Jarvis demo clone into persistent Voicebox data."""

import asyncio
from datetime import datetime
import json
import os

from backend import config
from backend.database import ProfileSample, VoiceProfile
from backend.database import session as db_session
from backend.services.profiles import add_profile_sample

PROFILE_ID = "jarvis"
REFERENCE_TEXT = (
    "Sir, I have completed the analysis. Your code has twelve critical "
    "vulnerabilities, your coffee is cold, and frankly your commit messages "
    "could use some work."
)
ROBOT_EFFECT = [
    {
        "type": "chorus",
        "enabled": True,
        "params": {
            "rate_hz": 0.2,
            "depth": 1.0,
            "feedback": 0.35,
            "centre_delay_ms": 7.0,
            "mix": 0.5,
        },
    }
]


async def main() -> None:
    config.set_data_dir(os.environ.get("VOICEBOX_DATA_DIR", "/app/data"))
    db_session.init_db()
    db = db_session.SessionLocal()
    try:
        profile = db.query(VoiceProfile).filter_by(id=PROFILE_ID).first()
        if profile is None:
            profile = VoiceProfile(
                id=PROFILE_ID,
                name="Jarvis",
                description="Dry wit, composed British AI assistant",
                language="en",
                voice_type="cloned",
                default_engine="qwen",
                effects_chain=json.dumps(ROBOT_EFFECT),
                personality=(
                    "A warm, energetic British friend and precise modern butler. "
                    "Dryly funny, candid and willing to be constructively harsh."
                ),
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            db.add(profile)
            db.commit()
        else:
            # Keep effect/personality improvements deterministic across image
            # upgrades without duplicating the reference sample.
            profile.default_engine = "qwen"
            profile.effects_chain = json.dumps(ROBOT_EFFECT)
            db.commit()
        sample = db.query(ProfileSample).filter_by(profile_id=PROFILE_ID).first()
        if sample is None:
            await add_profile_sample(PROFILE_ID, "/app/jarvis.webm", REFERENCE_TEXT, db)
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
