export type LiveVadState = {
  spoke: boolean;
  lastVoice: number;
  noiseFloor: number;
  voiceFrames: number;
  bargeFrames: number;
};

export type LiveVadFrame = {
  level: number;
  now: number;
  startedAt: number;
  ttsActive: boolean;
  quietUntil: number;
};

export function createLiveVadState(now: number): LiveVadState {
  return { spoke: false, lastVoice: now, noiseFloor: 5, voiceFrames: 0, bargeFrames: 0 };
}

/**
 * One frame of the full-duplex voice gate. Speaker output is never ordinary
 * speech input: only a sustained, clearly foreground voice may barge in while
 * TTS is playing. The short tail guard also rejects audio still leaving the
 * speakers after playback reports that it ended.
 */
export function advanceLiveVad(state: LiveVadState, frame: LiveVadFrame): {
  state: LiveVadState;
  acceptedSpeech: boolean;
  bargeIn: boolean;
} {
  let noiseFloor = state.noiseFloor;
  const guarded = frame.ttsActive || frame.now < frame.quietUntil;
  if (!state.spoke && !guarded && frame.now - frame.startedAt < 900) {
    noiseFloor = noiseFloor * 0.88 + frame.level * 0.12;
  }
  const threshold = Math.max(14, noiseFloor + 9);

  if (guarded) {
    const foreground = frame.ttsActive && frame.level > Math.max(46, threshold + 24);
    const bargeFrames = foreground ? state.bargeFrames + 1 : 0;
    const bargeIn = !state.spoke && bargeFrames >= 5;
    return {
      state: {
        ...state,
        noiseFloor,
        voiceFrames: 0,
        bargeFrames,
        spoke: state.spoke || bargeIn,
        lastVoice: bargeIn ? frame.now : state.lastVoice,
      },
      acceptedSpeech: bargeIn,
      bargeIn,
    };
  }

  const voiceFrames = frame.level > threshold ? state.voiceFrames + 1 : 0;
  const acceptedSpeech = voiceFrames >= 2;
  return {
    state: {
      ...state,
      noiseFloor,
      voiceFrames,
      bargeFrames: 0,
      spoke: state.spoke || acceptedSpeech,
      lastVoice: acceptedSpeech ? frame.now : state.lastVoice,
    },
    acceptedSpeech,
    bargeIn: false,
  };
}
