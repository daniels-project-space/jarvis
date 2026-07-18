export type LiveVadState = {
  spoke: boolean;
  lastVoice: number;
  noiseFloor: number;
  voiceFrames: number;
  bargeFrames: number;
};

export type LiveVadFrame = {
  level: number;
  voiceLevel?: number;
  highFrequencyLevel?: number;
  now: number;
  startedAt: number;
  ttsActive: boolean;
  quietUntil: number;
};

// 1.15s preserves the tested 1.1s mid-sentence pause while removing 650ms
// from the former turn boundary. STT begins speculatively during the tail, so
// the network request is normally complete by the time this safe gate closes.
export const LIVE_END_SILENCE_MS = 1_150;
export const LIVE_STT_PREFETCH_SILENCE_MS = 700;
// Do not merely ask VAD to ignore Jarvis's loudspeaker. Do not open an
// utterance recording at all until the room has lost its acoustic tail.
export const LIVE_SPEAKER_TAIL_MS = 1_400;
const VOICE_START_FRAMES = 4;

export function shouldDeferLiveCapture(args: {
  ttsActive: boolean;
  now: number;
  quietUntil: number;
  keyboardQuietUntil: number;
}): boolean {
  return args.ttsActive || args.now < Math.max(args.quietUntil, args.keyboardQuietUntil);
}

export function spectrumBandLevel(
  spectrum: ArrayLike<number>,
  sampleRate: number,
  fromHz: number,
  toHz: number,
): number {
  if (!spectrum.length || sampleRate <= 0) return 0;
  const binHz = sampleRate / 2 / spectrum.length;
  const start = Math.max(0, Math.floor(fromHz / binHz));
  const end = Math.min(spectrum.length, Math.ceil(toHz / binHz));
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += Number(spectrum[index] ?? 0);
  return total / (end - start);
}

export function createLiveVadState(now: number): LiveVadState {
  return { spoke: false, lastVoice: now, noiseFloor: 5, voiceFrames: 0, bargeFrames: 0 };
}

export function shouldCloseLiveUtterance(state: LiveVadState, now: number): boolean {
  return state.spoke && now - state.lastVoice > LIVE_END_SILENCE_MS;
}

export function shouldPrefetchLiveTranscript(
  state: LiveVadState,
  now: number,
  lastPrefetchedVoice: number,
): boolean {
  return state.spoke
    && state.lastVoice !== lastPrefetchedVoice
    && now - state.lastVoice >= LIVE_STT_PREFETCH_SILENCE_MS;
}

/**
 * One frame of the live voice gate. A single laptop microphone cannot
 * reliably distinguish a loud human interruption from the assistant coming
 * out of its own speakers. TTS and its acoustic tail are therefore a hard
 * boundary: no frame can start or extend an utterance while guarded.
 */
export function advanceLiveVad(state: LiveVadState, frame: LiveVadFrame): {
  state: LiveVadState;
  acceptedSpeech: boolean;
  bargeIn: boolean;
} {
  let noiseFloor = state.noiseFloor;
  const voiceLevel = frame.voiceLevel ?? frame.level;
  const highFrequencyLevel = frame.highFrequencyLevel;
  const guarded = frame.ttsActive || frame.now < frame.quietUntil;
  if (!state.spoke && !guarded && frame.now - frame.startedAt < 900) {
    noiseFloor = noiseFloor * 0.88 + voiceLevel * 0.12;
  }
  const threshold = Math.max(14, noiseFloor + 9);
  // Speech carries sustained energy in the vocal band. Keyboard clicks and
  // taps are broadband transients, so their high-frequency energy is usually
  // as strong as their voice-band energy. Missing spectral data preserves the
  // helper's compatibility for non-browser callers.
  const speechShaped = highFrequencyLevel === undefined || voiceLevel >= highFrequencyLevel * 1.1 + 2;

  if (guarded) {
    return {
      state: {
        ...state,
        noiseFloor,
        voiceFrames: 0,
        bargeFrames: 0,
      },
      acceptedSpeech: false,
      bargeIn: false,
    };
  }

  const voiceFrames = speechShaped && voiceLevel > threshold ? state.voiceFrames + 1 : 0;
  // Starting an utterance is deliberately strict so clicks cannot open one.
  // Once Daniel is speaking, even a short connecting word refreshes the end
  // timer so a natural sentence cadence is not cut into separate requests.
  const acceptedSpeech = voiceFrames >= (state.spoke ? 1 : VOICE_START_FRAMES);
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
