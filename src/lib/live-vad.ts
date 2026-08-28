export type LiveVadState = {
  spoke: boolean;
  lastVoice: number;
  noiseFloor: number;
  voiceFrames: number;
  bargeFrames: number;
  speakerLeakFloor: number;
  speakerLeakFrames: number;
  ttsWasActive: boolean;
  voiceStartedAt: number;
  acceptedFrames: number;
  peakVoiceMargin: number;
};

export type LiveVadFrame = {
  level: number;
  voiceLevel?: number;
  highFrequencyLevel?: number;
  now: number;
  startedAt: number;
  ttsActive: boolean;
  quietUntil: number;
  /** True only when the browser reports that echo cancellation is active. */
  aecEnabled?: boolean;
};

// 1.15s preserves the tested 1.1s mid-sentence pause while removing 650ms
// from the former turn boundary. A zero-Jarvis-billing browser transcript may
// inform this boundary, but authoritative server STT never runs before it.
export const LIVE_END_SILENCE_MS = 1_150;
export const LIVE_COMPLETE_QUESTION_END_SILENCE_MS = 720;
// A strongly-confident browser final is useful only after the same exact VAD
// fence that permits it to replace server STT. This trims the remaining turn
// boundary for a clear question without shortening statements or corrections.
export const LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS = 420;
export const LIVE_UNFINISHED_END_SILENCE_MS = 1_550;
// Do not merely ask VAD to ignore Jarvis's loudspeaker. Do not open an
// utterance recording at all until the room has lost its acoustic tail.
export const LIVE_SPEAKER_TAIL_MS = 1_400;
const VOICE_START_FRAMES = 4;
export const LIVE_BARGE_SAMPLE_MS = 90;
// At the live loop's 90ms cadence these require about 540ms of speaker
// calibration followed by about 450ms of sustained near-field speech. The
// result is an interruption candidate, not proof of intent; the coordinator
// can use it to duck output and confirm that speech remains.
export const LIVE_BARGE_CALIBRATION_FRAMES = 6;
export const LIVE_BARGE_SPEECH_FRAMES = 5;
const BARGE_MIN_VOICE_LEVEL = 30;
const BARGE_AMBIENT_MARGIN = 16;
const BARGE_SPEAKER_LEAK_MARGIN = 14;

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
  return {
    spoke: false,
    lastVoice: now,
    noiseFloor: 5,
    voiceFrames: 0,
    bargeFrames: 0,
    speakerLeakFloor: 0,
    speakerLeakFrames: 0,
    ttsWasActive: false,
    voiceStartedAt: 0,
    acceptedFrames: 0,
    peakVoiceMargin: 0,
  };
}

const UNFINISHED_TRAILING_WORD = /\b(?:and|but|or|because|so|then|if|when|while|although|though|which|who|where|than|as|to|for|with|about|from|into|of|the|a|an)$/i;
const TRAILING_SELF_CORRECTION = /(?:\b(?:no|wait|actually|sorry)\b(?:[, ]+)?|\b(?:i mean|or rather|let me rephrase)\b)[^.!?]{0,24}$/i;
const CLEAR_QUESTION = /^(?:(?:what|why|how|where|when|who|which)\s+(?:is|are|was|were|do|does|did|can|could|would|will|should|has|have|had)\b|(?:is|are|was|were|do|does|did|can|could|would|will|should|has|have|had)\b)/i;

function normalizedTranscript(transcript: string | undefined): string {
  return String(transcript ?? "").trim().replace(/\s+/g, " ");
}

function isUnfinishedPartial(transcript: string): boolean {
  const withoutClosingPunctuation = transcript.replace(/[.!?]+$/, "").trim();
  return /(?:[,;:\-–—]|\.{2,})$/.test(transcript)
    || UNFINISHED_TRAILING_WORD.test(withoutClosingPunctuation)
    || TRAILING_SELF_CORRECTION.test(withoutClosingPunctuation);
}

function isClearCompleteQuestion(transcript: string): boolean {
  const words = transcript.replace(/[^\p{L}\p{N}' ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const punctuatedQuestion = transcript.endsWith("?") && words.length >= 3;
  const syntacticQuestion = words.length >= 4 && CLEAR_QUESTION.test(transcript);
  return punctuatedQuestion || syntacticQuestion;
}

/**
 * A deterministic endpoint policy for an optional authoritative partial.
 * Only an unmistakably complete question gets the shorter pause. Statements
 * keep the proven default, while dangling clauses and corrections get room to
 * finish. Provisional browser text may use this normal policy, but only an
 * exact VAD-fenced final may opt into the faster trusted-final boundary.
 */
export function liveEndpointSilenceMs(authoritativePartialTranscript?: string): number {
  const transcript = normalizedTranscript(authoritativePartialTranscript);
  if (!transcript) return LIVE_END_SILENCE_MS;
  if (isUnfinishedPartial(transcript)) return LIVE_UNFINISHED_END_SILENCE_MS;

  return isClearCompleteQuestion(transcript)
    ? LIVE_COMPLETE_QUESTION_END_SILENCE_MS
    : LIVE_END_SILENCE_MS;
}

export function shouldCloseLiveUtterance(
  state: LiveVadState,
  now: number,
  authoritativePartialTranscript?: string,
  trustedBrowserFinal = false,
): boolean {
  const transcript = normalizedTranscript(authoritativePartialTranscript);
  const trustedQuestionFinal = trustedBrowserFinal
    && !isUnfinishedPartial(transcript)
    && isClearCompleteQuestion(transcript);
  const silenceMs = trustedQuestionFinal
    ? LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS
    : liveEndpointSilenceMs(transcript);
  return state.spoke
    && now - state.lastVoice > silenceMs;
}

const READ_ONLY_RESEARCH_INTENT = /\b(?:research|look up|find out|investigate|compare|explain|tell me about|what|why|how|who|where|when|which)\b/i;
const MUTATING_OR_SENSITIVE_INTENT = /\b(?:send|message|email|post|publish|upload|delete|remove|buy|sell|pay|transfer|book|cancel|deploy|push|commit|execute|run|edit|change|create|download)\b/i;

function previewWords(transcript: string): string[] {
  return normalizedTranscript(transcript)
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Pure, one-shot admission policy for a read-only research preview. Two
 * authoritative revisions must share a stable prefix, preventing a transient
 * partial or an immediate self-correction from spending a search request.
 */
export function shouldStartLiveResearchPreview(args: {
  authoritativePartialTranscript?: string;
  previousAuthoritativePartialTranscript?: string;
  alreadyStarted: boolean;
}): boolean {
  if (args.alreadyStarted) return false;
  const current = normalizedTranscript(args.authoritativePartialTranscript);
  const previous = normalizedTranscript(args.previousAuthoritativePartialTranscript);
  if (!current || !previous || isUnfinishedPartial(current) || TRAILING_SELF_CORRECTION.test(current)) return false;
  if (!READ_ONLY_RESEARCH_INTENT.test(current) || MUTATING_OR_SENSITIVE_INTENT.test(current)) return false;

  const currentWords = previewWords(current);
  const previousWords = previewWords(previous);
  if (currentWords.length < 6 || previousWords.length < 5) return false;
  let commonPrefixWords = 0;
  while (
    commonPrefixWords < currentWords.length
    && commonPrefixWords < previousWords.length
    && currentWords[commonPrefixWords] === previousWords[commonPrefixWords]
  ) commonPrefixWords += 1;
  // The earlier revision must be a complete word-prefix of the newer one.
  // Sharing only an opening phrase is insufficient because a later qualifier
  // can change the subject while the user is still speaking.
  return commonPrefixWords === previousWords.length;
}

/**
 * One frame of the live voice gate. TTS and its acoustic tail remain a hard
 * boundary for ordinary utterance capture. During active TTS only, an
 * explicitly AEC-enabled stream may emit one conservative interruption
 * candidate after calibrating current speaker leakage and then observing
 * sustained speech well above both the room and leakage baselines.
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

  if (frame.ttsActive) {
    const firstSpeakerFrame = !state.ttsWasActive;
    const speakerLeakFrames = firstSpeakerFrame ? 1 : state.speakerLeakFrames + 1;
    let speakerLeakFloor = firstSpeakerFrame
      ? voiceLevel
      : state.speakerLeakFloor;
    if (speakerLeakFrames <= LIVE_BARGE_CALIBRATION_FRAMES) {
      speakerLeakFloor = speakerLeakFloor * 0.75 + voiceLevel * 0.25;
    }

    const calibrated = speakerLeakFrames > LIVE_BARGE_CALIBRATION_FRAMES;
    const bargeThreshold = Math.max(
      BARGE_MIN_VOICE_LEVEL,
      noiseFloor + BARGE_AMBIENT_MARGIN,
      speakerLeakFloor + BARGE_SPEAKER_LEAK_MARGIN,
    );
    const bargeCandidate = frame.aecEnabled === true
      && calibrated
      && speechShaped
      && voiceLevel > bargeThreshold;
    const bargeFrames = bargeCandidate ? state.bargeFrames + 1 : 0;
    const bargeIn = bargeFrames === LIVE_BARGE_SPEECH_FRAMES;
    // Track ordinary leakage slowly after calibration, but never absorb a
    // possible near-field interruption into the baseline.
    if (calibrated && !bargeCandidate) {
      speakerLeakFloor = speakerLeakFloor * 0.96 + voiceLevel * 0.04;
    }
    return {
      state: {
        ...state,
        noiseFloor,
        voiceFrames: 0,
        bargeFrames,
        speakerLeakFloor,
        speakerLeakFrames,
        ttsWasActive: true,
      },
      acceptedSpeech: false,
      bargeIn,
    };
  }

  if (guarded) {
    return {
      state: {
        ...state,
        noiseFloor,
        voiceFrames: 0,
        bargeFrames: 0,
        speakerLeakFloor: 0,
        speakerLeakFrames: 0,
        ttsWasActive: false,
      },
      acceptedSpeech: false,
      bargeIn: false,
    };
  }

  const candidate = speechShaped && voiceLevel > threshold;
  const voiceFrames = candidate ? state.voiceFrames + 1 : 0;
  const voiceStartedAt = state.spoke
    ? state.voiceStartedAt
    : voiceFrames === 1
      ? frame.now
      : voiceFrames === 0
        ? 0
        : state.voiceStartedAt;
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
      speakerLeakFloor: 0,
      speakerLeakFrames: 0,
      ttsWasActive: false,
      voiceStartedAt,
      acceptedFrames: acceptedSpeech
        ? state.spoke ? state.acceptedFrames + 1 : voiceFrames
        : state.acceptedFrames,
      peakVoiceMargin: candidate
        ? Math.max(state.peakVoiceMargin, voiceLevel - threshold)
        : state.peakVoiceMargin,
      spoke: state.spoke || acceptedSpeech,
      lastVoice: acceptedSpeech ? frame.now : state.lastVoice,
    },
    acceptedSpeech,
    bargeIn: false,
  };
}
