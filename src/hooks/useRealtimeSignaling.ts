import { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCallRecord, generateId, sendChatMessage, updateCallStatus } from '../lib/chatService';
import { ActiveCallSession, CallType } from '../types/chat';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
  },
];

const TARGET_SAMPLE_RATE = 16000;
const AUDIO_PACKET_SAMPLES = 1024; // 64ms exact frames at 16kHz

function downsampleLinear(
  input: Float32Array,
  inputRate: number,
  targetRate: number
): Float32Array {
  if (inputRate <= targetRate) {
    return input;
  }
  const ratio = inputRate / targetRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const len = Math.floor(binary.length / 2);
  const bytes = new Uint8Array(len * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) {
    float32[i] = int16[i] / 0x8000;
  }
  return float32;
}

async function hasWebRtcInboundMediaBytes(
  pc: RTCPeerConnection | null,
  requireVideo: boolean
): Promise<boolean> {
  if (!pc || typeof pc.getStats !== 'function') return false;
  try {
    const stats = await pc.getStats();
    let audioBytes = 0;
    let videoBytes = 0;
    let hasRemoteVideoTrack = false;
    pc.getReceivers().forEach((r) => {
      if (r.track && r.track.kind === 'video') {
        hasRemoteVideoTrack = true;
      }
    });
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        audioBytes += Number((report as { bytesReceived?: number }).bytesReceived || 0);
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        videoBytes += Number((report as { bytesReceived?: number }).bytesReceived || 0);
      }
    });
    if (audioBytes <= 0) return false;
    if (requireVideo && hasRemoteVideoTrack && videoBytes <= 0) return false;
    return true;
  } catch {
    return false;
  }
}

interface PlaybackRingState {
  ring: Float32Array;
  writePos: number;
  readPos: number;
  available: number;
  buffering: boolean;
  lastSample: number;
  prebufferTarget: number;
  maxBuffered: number;
}

interface UseRealtimeSignalingOptions {
  user: User | null;
  displayName: string;
  onMediaError?: (kind: 'mic' | 'media') => void;
  onPeerOfflineNotice?: () => void;
}

export function useRealtimeSignaling({
  user,
  displayName,
  onMediaError,
  onPeerOfflineNotice,
}: UseRealtimeSignalingOptions) {
  const [onlineUids, setOnlineUids] = useState<string[]>([]);
  const [typingByChat, setTypingByChat] = useState<Record<string, Record<string, number>>>({});
  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [relayVideoFrame, setRelayVideoFrame] = useState<string | null>(null);
  const [callTransport, setCallTransport] = useState<'connecting' | 'p2p' | 'relay'>('connecting');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const activeCallRef = useRef<ActiveCallSession | null>(null);
  const pendingOfferRef = useRef<{ callId: string; sdp: RTCSessionDescriptionInit } | null>(null);
  const pendingIceMapRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const ringtoneTimerRef = useRef<number | null>(null);
  const ringtoneCtxRef = useRef<AudioContext | null>(null);
  const iceFailTimerRef = useRef<number | null>(null);
  const iceDisconnectTimerRef = useRef<number | null>(null);
  const relayFallbackTimerRef = useRef<number | null>(null);
  const iceRestartedRef = useRef<boolean>(false);
  const iceRestartInFlightRef = useRef<boolean>(false);
  const iceRestartCountRef = useRef<number>(0);
  const lastIceRestartAtRef = useRef<number>(0);
  const webrtcConnectedRef = useRef<boolean>(false);
  const isMutedRef = useRef<boolean>(false);
  const isCameraOffRef = useRef<boolean>(false);

  // Pre-unlocked AudioContexts & jitter ring buffer
  const isRelayActiveRef = useRef<boolean>(false);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureProcRef = useRef<ScriptProcessorNode | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureSilentGainRef = useRef<GainNode | null>(null);
  const captureQueueRef = useRef<number[]>([]);

  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackProcRef = useRef<ScriptProcessorNode | null>(null);
  const playbackDummyGainRef = useRef<GainNode | null>(null);
  const playbackRingRef = useRef<PlaybackRingState | null>(null);

  const relayVideoTimerRef = useRef<number | null>(null);
  const offscreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const localPreviewVideoElRef = useRef<HTMLVideoElement | null>(null);

  const registerLocalVideoElement = useCallback((el: HTMLVideoElement | null) => {
    localPreviewVideoElRef.current = el;
  }, []);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (isMuted) {
      captureQueueRef.current = [];
    }
  }, [isMuted]);

  useEffect(() => {
    isCameraOffRef.current = isCameraOff;
  }, [isCameraOff]);

  const stopRingtone = useCallback(() => {
    if (ringtoneTimerRef.current !== null) {
      window.clearInterval(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }
    if (ringtoneCtxRef.current) {
      void ringtoneCtxRef.current.close().catch(() => undefined);
      ringtoneCtxRef.current = null;
    }
  }, []);

  const startRingtone = useCallback(
    (mode: 'incoming' | 'outgoing') => {
      stopRingtone();
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        ringtoneCtxRef.current = ctx;

        const playTone = () => {
          if (ctx.state === 'closed') return;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = mode === 'incoming' ? 520 : 440;
          gain.gain.setValueAtTime(0.001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.48);
        };

        playTone();
        ringtoneTimerRef.current = window.setInterval(playTone, mode === 'incoming' ? 1600 : 2200);
      } catch {
        // Ignore autoplay restrictions
      }
    },
    [stopRingtone]
  );

  // Must be called synchronously inside user tap (startCall / acceptIncomingCall)
  const unlockAudioEngines = useCallback(() => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
        playbackCtxRef.current = new AudioCtx();
      }
      if (playbackCtxRef.current.state === 'suspended') {
        void playbackCtxRef.current.resume().catch(() => undefined);
      }
      // Play 1 silent sample to force Android/Samsung/iOS audio unlock
      try {
        const silentBuf = playbackCtxRef.current.createBuffer(1, 1, 22050);
        const src = playbackCtxRef.current.createBufferSource();
        src.buffer = silentBuf;
        src.connect(playbackCtxRef.current.destination);
        src.start(0);
      } catch {
        // ignore
      }

      if (!captureCtxRef.current || captureCtxRef.current.state === 'closed') {
        captureCtxRef.current = new AudioCtx();
      }
      if (captureCtxRef.current.state === 'suspended') {
        void captureCtxRef.current.resume().catch(() => undefined);
      }
    } catch {
      // Ignore if AudioContext unavailable
    }
  }, []);

  const ensurePlaybackRingNode = useCallback(() => {
    const ctx = playbackCtxRef.current;
    if (!ctx || ctx.state === 'closed') return null;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }

    if (playbackRingRef.current && playbackProcRef.current) {
      return playbackRingRef.current;
    }

    const sr = ctx.sampleRate || 48000;
    const ringState: PlaybackRingState = {
      ring: new Float32Array(sr * 3),
      writePos: 0,
      readPos: 0,
      available: 0,
      buffering: true,
      lastSample: 0,
      prebufferTarget: Math.round(sr * 0.26), // 260ms jitter cushion for SIM 4G/5G handoffs
      maxBuffered: Math.round(sr * 0.85),
    };
    playbackRingRef.current = ringState;

    const dummyGain = ctx.createGain();
    dummyGain.gain.value = 0;
    const proc = ctx.createScriptProcessor(2048, 1, 1);

    proc.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      const state = playbackRingRef.current;
      if (!state || !isRelayActiveRef.current) {
        out.fill(0);
        return;
      }

      if (state.buffering) {
        if (state.available < state.prebufferTarget) {
          for (let i = 0; i < out.length; i += 1) {
            state.lastSample *= 0.92;
            out[i] = state.lastSample;
          }
          return;
        }
        state.buffering = false;
      }

      const len = state.ring.length;
      if (state.available >= out.length) {
        for (let i = 0; i < out.length; i += 1) {
          const sample = state.ring[state.readPos];
          out[i] = sample;
          state.lastSample = sample;
          state.readPos = (state.readPos + 1) % len;
        }
        state.available -= out.length;
      } else {
        let i = 0;
        while (i < out.length && state.available > 0) {
          const sample = state.ring[state.readPos];
          out[i] = sample;
          state.lastSample = sample;
          state.readPos = (state.readPos + 1) % len;
          state.available -= 1;
          i += 1;
        }
        while (i < out.length) {
          state.lastSample *= 0.92;
          out[i] = state.lastSample;
          i += 1;
        }
        state.buffering = true;
      }
    };

    dummyGain.connect(proc);
    proc.connect(ctx.destination);
    playbackDummyGainRef.current = dummyGain;
    playbackProcRef.current = proc;
    return ringState;
  }, []);

  const sendWs = useCallback((payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const closePeerConnectionOnly = useCallback(() => {
    webrtcConnectedRef.current = false;
    iceRestartInFlightRef.current = false;
    iceRestartCountRef.current = 0;
    lastIceRestartAtRef.current = 0;
    if (iceFailTimerRef.current !== null) {
      window.clearTimeout(iceFailTimerRef.current);
      iceFailTimerRef.current = null;
    }
    if (iceDisconnectTimerRef.current !== null) {
      window.clearTimeout(iceDisconnectTimerRef.current);
      iceDisconnectTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteStreamRef.current = null;
    setRemoteStream(null);
  }, []);

  const stopRelayMedia = useCallback(() => {
    isRelayActiveRef.current = false;
    captureQueueRef.current = [];
    if (relayFallbackTimerRef.current !== null) {
      window.clearTimeout(relayFallbackTimerRef.current);
      relayFallbackTimerRef.current = null;
    }
    if (relayVideoTimerRef.current !== null) {
      window.clearInterval(relayVideoTimerRef.current);
      relayVideoTimerRef.current = null;
    }
    if (offscreenVideoRef.current) {
      offscreenVideoRef.current.srcObject = null;
      offscreenVideoRef.current.remove();
      offscreenVideoRef.current = null;
    }
    if (captureProcRef.current) {
      captureProcRef.current.onaudioprocess = null;
      try {
        captureProcRef.current.disconnect();
      } catch {
        // ignore
      }
      captureProcRef.current = null;
    }
    if (captureSourceRef.current) {
      try {
        captureSourceRef.current.disconnect();
      } catch {
        // ignore
      }
      captureSourceRef.current = null;
    }
    if (captureSilentGainRef.current) {
      try {
        captureSilentGainRef.current.disconnect();
      } catch {
        // ignore
      }
      captureSilentGainRef.current = null;
    }
    if (playbackProcRef.current) {
      playbackProcRef.current.onaudioprocess = null;
      try {
        playbackProcRef.current.disconnect();
      } catch {
        // ignore
      }
      playbackProcRef.current = null;
    }
    if (playbackDummyGainRef.current) {
      try {
        playbackDummyGainRef.current.disconnect();
      } catch {
        // ignore
      }
      playbackDummyGainRef.current = null;
    }
    playbackRingRef.current = null;
    setRelayVideoFrame(null);
  }, []);

  const startRelayMedia = useCallback(
    (callId: string, peerUid: string, callType: CallType) => {
      if (isRelayActiveRef.current) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      isRelayActiveRef.current = true;
      setCallTransport('relay');

      // Close dead/pending WebRTC PeerConnection so Android releases native VoiceEngine lock
      closePeerConnectionOnly();

      unlockAudioEngines();
      ensurePlaybackRingNode();

      // 1. Live audio PCM capture -> exact 64ms 16kHz frames over WebSocket
      if (stream.getAudioTracks().length > 0) {
        try {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const captureCtx =
            captureCtxRef.current && captureCtxRef.current.state !== 'closed'
              ? captureCtxRef.current
              : AudioCtx
                ? new AudioCtx()
                : null;

          if (captureCtx) {
            captureCtxRef.current = captureCtx;
            if (captureCtx.state === 'suspended') {
              void captureCtx.resume().catch(() => undefined);
            }
            captureQueueRef.current = [];
            const source = captureCtx.createMediaStreamSource(stream);
            const processor = captureCtx.createScriptProcessor(2048, 1, 1);
            const silentGain = captureCtx.createGain();
            silentGain.gain.value = 0;

            processor.onaudioprocess = (ev) => {
              if (!isRelayActiveRef.current || isMutedRef.current) return;
              if (activeCallRef.current?.callId !== callId) return;

              const input = ev.inputBuffer.getChannelData(0);
              const resampled = downsampleLinear(input, captureCtx.sampleRate, TARGET_SAMPLE_RATE);
              const queue = captureQueueRef.current;
              for (let i = 0; i < resampled.length; i += 1) {
                queue.push(resampled[i]);
              }

              while (queue.length >= AUDIO_PACKET_SAMPLES) {
                const chunk = queue.splice(0, AUDIO_PACKET_SAMPLES);
                const int16 = new Int16Array(AUDIO_PACKET_SAMPLES);
                for (let i = 0; i < AUDIO_PACKET_SAMPLES; i += 1) {
                  const s = Math.max(-1, Math.min(1, chunk[i]));
                  int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                const pcm = int16ToBase64(int16);
                sendWs({
                  type: 'call:relay-audio',
                  callId,
                  toUid: peerUid,
                  sr: TARGET_SAMPLE_RATE,
                  pcm,
                });
              }
            };

            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(captureCtx.destination);
            captureSourceRef.current = source;
            captureProcRef.current = processor;
            captureSilentGainRef.current = silentGain;
          }
        } catch {
          // Ignore if audio capture node fails
        }
      }

      // 2. Live video frame capture directly from visible preview <video> (or DOM fallback)
      if (callType === 'video') {
        try {
          let hiddenVideo: HTMLVideoElement | null = null;
          let attachedTrackId: string | null = null;
          const ensureHiddenVideo = (track: MediaStreamTrack) => {
            if (hiddenVideo && attachedTrackId === track.id) return hiddenVideo;
            if (!hiddenVideo) {
              const el = document.createElement('video');
              el.muted = true;
              el.playsInline = true;
              el.autoplay = true;
              el.style.position = 'fixed';
              el.style.width = '24px';
              el.style.height = '24px';
              el.style.bottom = '0';
              el.style.right = '0';
              el.style.opacity = '0.05';
              el.style.pointerEvents = 'none';
              el.style.zIndex = '0';
              document.body.appendChild(el);
              offscreenVideoRef.current = el;
              hiddenVideo = el;
            }
            attachedTrackId = track.id;
            hiddenVideo.srcObject = new MediaStream([track]);
            void hiddenVideo.play().catch(() => undefined);
            return hiddenVideo;
          };

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          relayVideoTimerRef.current = window.setInterval(() => {
            if (!isRelayActiveRef.current || isCameraOffRef.current) return;
            if (activeCallRef.current?.callId !== callId) return;
            if (!ctx) return;
            const liveTrack = localStreamRef.current?.getVideoTracks()[0];
            if (!liveTrack || liveTrack.readyState !== 'live') return;
            // Prioritize audio if WebSocket send queue is heavily backed up
            if (wsRef.current && wsRef.current.bufferedAmount > 120000) return;

            const previewEl = localPreviewVideoElRef.current;
            const sourceEl =
              previewEl && previewEl.readyState >= 2 && previewEl.videoWidth > 0
                ? previewEl
                : ensureHiddenVideo(liveTrack);

            if (!sourceEl || sourceEl.readyState < 2 || sourceEl.videoWidth === 0) {
              return;
            }

            const maxW = 240;
            const scale = Math.min(1, maxW / sourceEl.videoWidth);
            canvas.width = Math.max(1, Math.round(sourceEl.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(sourceEl.videoHeight * scale));
            ctx.drawImage(sourceEl, 0, 0, canvas.width, canvas.height);
            const frame = canvas.toDataURL('image/jpeg', 0.42);
            if (frame && frame.startsWith('data:image/jpeg;base64,')) {
              sendWs({
                type: 'call:relay-video',
                callId,
                toUid: peerUid,
                frame,
              });
            }
          }, 180);
        } catch {
          // Ignore canvas capture error
        }
      }

      stopRingtone();
      setActiveCall((prev) => {
        if (!prev || prev.callId !== callId) return prev;
        return {
          ...prev,
          status: 'active',
          startedAtMs: prev.startedAtMs || Date.now(),
        };
      });
      void updateCallStatus(callId, 'active', 0);
    },
    [closePeerConnectionOnly, ensurePlaybackRingNode, sendWs, stopRingtone, unlockAudioEngines]
  );

  const playRelayAudio = useCallback(
    (pcmB64: string, sampleRate: number) => {
      if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
        unlockAudioEngines();
      }
      const ctx = playbackCtxRef.current;
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }

      const state = ensurePlaybackRingNode();
      if (!state) return;

      try {
        const raw = base64ToFloat32(pcmB64);
        if (raw.length === 0) return;

        const inRate = sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : TARGET_SAMPLE_RATE;
        const outRate = ctx.sampleRate || 48000;
        const ringLen = state.ring.length;

        if (inRate === outRate) {
          for (let i = 0; i < raw.length; i += 1) {
            state.ring[state.writePos] = raw[i];
            state.writePos = (state.writePos + 1) % ringLen;
          }
          state.available = Math.min(ringLen, state.available + raw.length);
        } else {
          const ratio = inRate / outRate;
          const outCount = Math.max(1, Math.round(raw.length / ratio));
          for (let i = 0; i < outCount; i += 1) {
            const pos = i * ratio;
            const idx = Math.floor(pos);
            const frac = pos - idx;
            const s0 = raw[idx] ?? 0;
            const s1 = raw[Math.min(idx + 1, raw.length - 1)] ?? s0;
            state.ring[state.writePos] = s0 + (s1 - s0) * frac;
            state.writePos = (state.writePos + 1) % ringLen;
          }
          state.available = Math.min(ringLen, state.available + outCount);
        }

        // Keep latency bounded smoothly if cellular packets arrive in a burst
        if (state.available > state.maxBuffered) {
          const targetKeep = Math.round(outRate * 0.36);
          const drop = state.available - targetKeep;
          state.readPos = (state.readPos + drop) % ringLen;
          state.available -= drop;
          // Apply a tiny 32-sample micro-fade at the new read head to prevent audible clicks
          const fadeSamples = Math.min(32, state.available);
          for (let f = 0; f < fadeSamples; f += 1) {
            const idx = (state.readPos + f) % ringLen;
            state.ring[idx] *= f / fadeSamples;
          }
        }
      } catch {
        // Skip malformed frame
      }
    },
    [ensurePlaybackRingNode, unlockAudioEngines]
  );

  const scheduleRelayFallback = useCallback(
    (callId: string, peerUid: string, callType: CallType) => {
      if (relayFallbackTimerRef.current !== null) {
        window.clearTimeout(relayFallbackTimerRef.current);
      }
      relayFallbackTimerRef.current = window.setTimeout(async () => {
        const cur = activeCallRef.current;
        if (!cur || cur.callId !== callId) return;
        const hasRealBytes = await hasWebRtcInboundMediaBytes(pcRef.current, callType === 'video');
        if (!webrtcConnectedRef.current || !hasRealBytes) {
          startRelayMedia(callId, peerUid, callType);
          sendWs({ type: 'call:relay-ready', callId, toUid: peerUid });
        } else {
          setCallTransport('p2p');
          stopRingtone();
          setActiveCall((prev) => {
            if (!prev || prev.callId !== callId) return prev;
            return {
              ...prev,
              status: 'active',
              startedAtMs: prev.startedAtMs || Date.now(),
            };
          });
          void updateCallStatus(callId, 'active', 0);
        }
      }, 2800);
    },
    [sendWs, startRelayMedia, stopRingtone]
  );

  const cleanupCallMedia = useCallback(() => {
    stopRingtone();
    stopRelayMedia();
    closePeerConnectionOnly();
    iceRestartedRef.current = false;
    iceRestartInFlightRef.current = false;
    iceRestartCountRef.current = 0;
    lastIceRestartAtRef.current = 0;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (captureCtxRef.current) {
      void captureCtxRef.current.close().catch(() => undefined);
      captureCtxRef.current = null;
    }
    if (playbackCtxRef.current) {
      void playbackCtxRef.current.close().catch(() => undefined);
      playbackCtxRef.current = null;
    }
    pendingOfferRef.current = null;
    pendingIceMapRef.current.clear();
    setLocalStream(null);
    setRemoteStream(null);
    setRelayVideoFrame(null);
    setCallTransport('connecting');
    setIsMuted(false);
    setIsCameraOff(false);
    setActiveCall(null);
  }, [closePeerConnectionOnly, stopRelayMedia, stopRingtone]);

  const fetchIceConfiguration = useCallback(async (): Promise<RTCConfiguration> => {
    const baseOpts: Partial<RTCConfiguration> = {
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
    if (!user) {
      return { iceServers: DEFAULT_ICE_SERVERS, ...baseOpts };
    }
    try {
      const token = await user.getIdToken();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3000);
      const resp = await fetch('/api/ice-servers', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          return { iceServers: data.iceServers, ...baseOpts };
        }
      }
    } catch {
      // Fallback to default STUN list
    }
    return { iceServers: DEFAULT_ICE_SERVERS, ...baseOpts };
  }, [user]);

  const drainPendingIce = useCallback(async (callId: string, pc: RTCPeerConnection) => {
    const queue = pendingIceMapRef.current.get(callId);
    if (!queue || queue.length === 0) return;
    pendingIceMapRef.current.delete(callId);
    for (const cand of queue) {
      await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => undefined);
    }
  }, []);

  const triggerIceRestart = useCallback(
    async (callId: string, peerUid: string): Promise<boolean> => {
      const pc = pcRef.current;
      const cur = activeCallRef.current;
      if (!pc || !cur || cur.callId !== callId || isRelayActiveRef.current) {
        return false;
      }
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (iceRestartInFlightRef.current || iceRestartCountRef.current >= 3) {
        return false;
      }
      const now = Date.now();
      if (now - lastIceRestartAtRef.current < 3000) {
        return false;
      }

      iceRestartInFlightRef.current = true;
      lastIceRestartAtRef.current = now;
      iceRestartCountRef.current += 1;
      iceRestartedRef.current = true;

      try {
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
        const offer = await pc.createOffer({
          iceRestart: true,
          offerToReceiveAudio: true,
          offerToReceiveVideo: cur.callType === 'video',
        });
        if (pcRef.current !== pc || activeCallRef.current?.callId !== callId) {
          return false;
        }
        await pc.setLocalDescription(offer);
        sendWs({
          type: 'call:renegotiate',
          callId,
          toUid: peerUid,
          sdp: pc.localDescription || offer,
        });
        return true;
      } catch {
        return false;
      } finally {
        iceRestartInFlightRef.current = false;
      }
    },
    [sendWs]
  );

  const createPeerConnection = useCallback(
    (callId: string, peerUid: string, callType: CallType, rtcConfig: RTCConfiguration) => {
      const pc = new RTCPeerConnection(rtcConfig);
      const remote = new MediaStream();
      remoteStreamRef.current = remote;
      iceRestartedRef.current = false;
      iceRestartInFlightRef.current = false;
      iceRestartCountRef.current = 0;
      lastIceRestartAtRef.current = 0;
      webrtcConnectedRef.current = false;

      const emitRemoteStream = async () => {
        const tracks = remote.getTracks();
        if (tracks.length > 0 && !isRelayActiveRef.current) {
          setRemoteStream(new MediaStream(tracks));
        }
      };

      pc.ontrack = (event) => {
        const incomingTracks =
          event.streams[0] && event.streams[0].getTracks().length > 0
            ? event.streams[0].getTracks()
            : [event.track];

        for (const track of incomingTracks) {
          if (!remote.getTracks().some((t) => t.id === track.id)) {
            remote.addTrack(track);
            track.onunmute = () => void emitRemoteStream();
          }
        }

        // Raise WebRTC jitter buffer slightly on audio receivers to absorb cellular packet jitter
        pc.getReceivers().forEach((receiver) => {
          if (receiver.track?.kind === 'audio') {
            const r = receiver as RTCRtpReceiver & {
              playoutDelayHint?: number;
              jitterBufferTarget?: number;
            };
            try {
              if ('jitterBufferTarget' in r) r.jitterBufferTarget = 220;
              if ('playoutDelayHint' in r) r.playoutDelayHint = 0.22;
            } catch {
              // Ignore unsupported browser hints
            }
          }
        });

        void emitRemoteStream();
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendWs({
            type: 'call:ice',
            callId,
            toUid: peerUid,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      const markConnected = async () => {
        if (isRelayActiveRef.current) return;
        webrtcConnectedRef.current = true;
        iceRestartCountRef.current = 0;
        if (iceFailTimerRef.current !== null) {
          window.clearTimeout(iceFailTimerRef.current);
          iceFailTimerRef.current = null;
        }
        if (iceDisconnectTimerRef.current !== null) {
          window.clearTimeout(iceDisconnectTimerRef.current);
          iceDisconnectTimerRef.current = null;
        }
        // Only mark P2P active once WebRTC actually has real inbound media bytes
        const hasRealBytes = await hasWebRtcInboundMediaBytes(pc, callType === 'video');
        if (hasRealBytes && !isRelayActiveRef.current) {
          setCallTransport('p2p');
          stopRingtone();
          setActiveCall((prev) => {
            if (!prev || prev.callId !== callId) return prev;
            if (prev.status === 'active' && prev.startedAtMs) return prev;
            return {
              ...prev,
              status: 'active',
              startedAtMs: prev.startedAtMs || Date.now(),
            };
          });
          void updateCallStatus(callId, 'active', 0);
        }
      };

      const handlePossibleFailure = () => {
        const cur = activeCallRef.current;
        if (cur && cur.callId === callId && !isRelayActiveRef.current) {
          startRelayMedia(callId, peerUid, callType);
          sendWs({ type: 'call:relay-ready', callId, toUid: peerUid });
        }
      };

      const handleDisconnectOrFailure = async (isHardFailure: boolean) => {
        const cur = activeCallRef.current;
        if (!cur || cur.callId !== callId || isRelayActiveRef.current || pcRef.current !== pc) {
          return;
        }
        const restarted = await triggerIceRestart(callId, peerUid);
        if (iceFailTimerRef.current !== null) {
          window.clearTimeout(iceFailTimerRef.current);
        }
        if (!restarted && isHardFailure) {
          handlePossibleFailure();
          return;
        }
        iceFailTimerRef.current = window.setTimeout(() => {
          if (
            pcRef.current === pc &&
            !isRelayActiveRef.current &&
            pc.iceConnectionState !== 'connected' &&
            pc.iceConnectionState !== 'completed'
          ) {
            handlePossibleFailure();
          }
        }, isHardFailure ? 4500 : 5500);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          void markConnected();
        } else if (pc.connectionState === 'disconnected') {
          if (iceDisconnectTimerRef.current === null) {
            iceDisconnectTimerRef.current = window.setTimeout(() => {
              iceDisconnectTimerRef.current = null;
              if (
                pcRef.current === pc &&
                (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected')
              ) {
                void handleDisconnectOrFailure(false);
              }
            }, 900);
          }
        } else if (pc.connectionState === 'failed') {
          void handleDisconnectOrFailure(true);
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          void markConnected();
        } else if (pc.iceConnectionState === 'disconnected') {
          if (iceDisconnectTimerRef.current === null) {
            iceDisconnectTimerRef.current = window.setTimeout(() => {
              iceDisconnectTimerRef.current = null;
              if (
                pcRef.current === pc &&
                (pc.iceConnectionState === 'disconnected' || pc.connectionState === 'disconnected')
              ) {
                void handleDisconnectOrFailure(false);
              }
            }, 900);
          }
        } else if (pc.iceConnectionState === 'failed') {
          void handleDisconnectOrFailure(true);
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendWs, startRelayMedia, stopRingtone, triggerIceRestart]
  );

  // Connect & maintain WebSocket signaling + relay
  useEffect(() => {
    if (!user) {
      cleanupCallMedia();
      setOnlineUids([]);
      return;
    }

    let cancelled = false;
    let reconnectTimeout: number | null = null;
    let pingInterval: number | null = null;
    let networkProbeTimeout: number | null = null;
    let lastWsActivityAt = Date.now();

    const connect = async () => {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = async () => {
        lastWsActivityAt = Date.now();
        try {
          const token = await user.getIdToken();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'auth', token }));
          }
          if (pingInterval !== null) window.clearInterval(pingInterval);
          pingInterval = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 25000);
        } catch {
          ws.close();
        }
      };

      ws.onmessage = async (event) => {
        lastWsActivityAt = Date.now();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = msg.type;
        if (type === 'pong') return;

        if (type === 'auth:ok') {
          const cur = activeCallRef.current;
          if (cur && pcRef.current && !isRelayActiveRef.current) {
            void triggerIceRestart(cur.callId, cur.peerUid);
          }
          return;
        }

        if (type === 'presence:list' && Array.isArray(msg.onlineUids)) {
          setOnlineUids(msg.onlineUids.map(String));
          return;
        }

        if (type === 'typing') {
          const chatId = String(msg.chatId || '');
          const senderId = String(msg.senderId || '');
          const isTyping = Boolean(msg.isTyping);
          setTypingByChat((prev) => {
            const chatMap = { ...(prev[chatId] || {}) };
            if (isTyping) {
              chatMap[senderId] = Date.now();
            } else {
              delete chatMap[senderId];
            }
            return { ...prev, [chatId]: chatMap };
          });
          return;
        }

        if (type === 'call:offer') {
          const callId = String(msg.callId || '');
          const chatId = String(msg.chatId || '');
          const fromUid = String(msg.fromUid || '');
          const callerName = String(msg.callerName || 'Caller');
          const callerPhoto = String(msg.callerPhoto || '');
          const callType: CallType = msg.callType === 'video' ? 'video' : 'audio';
          const sdp = msg.sdp as RTCSessionDescriptionInit;

          if (activeCallRef.current) {
            sendWs({ type: 'call:decline', callId, toUid: fromUid, reason: 'busy' });
            return;
          }

          pendingOfferRef.current = { callId, sdp };
          if (!pendingIceMapRef.current.has(callId)) {
            pendingIceMapRef.current.set(callId, []);
          }
          setCallTransport('connecting');
          setActiveCall({
            callId,
            chatId,
            peerUid: fromUid,
            peerName: callerName,
            peerPhoto: callerPhoto,
            callType,
            direction: 'incoming',
            status: 'ringing',
          });
          startRingtone('incoming');
          if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            document.hidden
          ) {
            const title = callerName;
            const body = callType === 'video' ? 'Incoming video call' : 'Incoming audio call';
            if ('serviceWorker' in navigator) {
              void navigator.serviceWorker.ready
                .then((reg) =>
                  reg.showNotification(title, {
                    body,
                    icon: '/pwa-192x192.png',
                    tag: `call_${callId}`,
                  })
                )
                .catch(() => new Notification(title, { body, icon: '/pwa-192x192.png' }));
            } else {
              new Notification(title, { body, icon: '/pwa-192x192.png' });
            }
          }
          return;
        }

        if (type === 'call:answer') {
          const callId = String(msg.callId || '');
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          const cur = activeCallRef.current;
          if (pcRef.current && cur && cur.callId === callId) {
            stopRingtone();
            setActiveCall((prev) =>
              prev && prev.callId === callId && prev.status === 'ringing'
                ? { ...prev, status: 'connecting' }
                : prev
            );
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            await drainPendingIce(callId, pcRef.current);
            scheduleRelayFallback(callId, cur.peerUid, cur.callType);
          }
          return;
        }

        if (type === 'call:renegotiate') {
          const callId = String(msg.callId || '');
          const fromUid = String(msg.fromUid || '');
          const sdp = msg.sdp as RTCSessionDescriptionInit | undefined;
          const pc = pcRef.current;
          const cur = activeCallRef.current;
          if (!pc || !cur || cur.callId !== callId || !sdp || isRelayActiveRef.current) {
            return;
          }
          try {
            const isPolite = Boolean(user?.uid && fromUid && user.uid < fromUid);
            if (pc.signalingState !== 'stable') {
              if (!isPolite) {
                return;
              }
              await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
            }
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            await drainPendingIce(callId, pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWs({
              type: 'call:renegotiate-answer',
              callId,
              toUid: fromUid,
              sdp: pc.localDescription || answer,
            });
          } catch {
            // Ignore transient renegotiation error; relay safety timer still protects call
          }
          return;
        }

        if (type === 'call:renegotiate-answer') {
          const callId = String(msg.callId || '');
          const sdp = msg.sdp as RTCSessionDescriptionInit | undefined;
          const pc = pcRef.current;
          if (!pc || activeCallRef.current?.callId !== callId || !sdp || isRelayActiveRef.current) {
            return;
          }
          try {
            if (pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(sdp));
              await drainPendingIce(callId, pc);
            }
          } catch {
            // Ignore transient answer error
          }
          return;
        }

        if (type === 'call:ice') {
          const callId = String(msg.callId || '');
          const candidate = msg.candidate as RTCIceCandidateInit | undefined;
          if (!candidate || !callId) return;

          if (
            pcRef.current &&
            pcRef.current.remoteDescription &&
            activeCallRef.current?.callId === callId
          ) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
          } else {
            const list = pendingIceMapRef.current.get(callId) || [];
            list.push(candidate);
            pendingIceMapRef.current.set(callId, list);
          }
          return;
        }

        if (type === 'call:relay-ready') {
          const callId = String(msg.callId || '');
          const cur = activeCallRef.current;
          if (cur && cur.callId === callId && !isRelayActiveRef.current) {
            startRelayMedia(callId, cur.peerUid, cur.callType);
          }
          return;
        }

        if (type === 'call:relay-audio') {
          const callId = String(msg.callId || '');
          const cur = activeCallRef.current;
          if (!cur || cur.callId !== callId) return;
          if (!isRelayActiveRef.current) {
            startRelayMedia(callId, cur.peerUid, cur.callType);
          }
          const pcm = typeof msg.pcm === 'string' ? msg.pcm : '';
          const sr = typeof msg.sr === 'number' ? msg.sr : TARGET_SAMPLE_RATE;
          if (pcm) playRelayAudio(pcm, sr);
          return;
        }

        if (type === 'call:relay-video') {
          const callId = String(msg.callId || '');
          const frame = typeof msg.frame === 'string' ? msg.frame : '';
          if (activeCallRef.current?.callId === callId && frame) {
            setRelayVideoFrame(frame);
          }
          return;
        }

        if (type === 'call:decline' || type === 'call:hangup') {
          const callId = String(msg.callId || '');
          if (activeCallRef.current?.callId === callId) {
            cleanupCallMedia();
          }
        }
      };

      ws.onclose = () => {
        if (pingInterval !== null) {
          window.clearInterval(pingInterval);
          pingInterval = null;
        }
        if (!cancelled) {
          const delayMs = activeCallRef.current ? 400 : 2500;
          reconnectTimeout = window.setTimeout(() => {
            void connect();
          }, delayMs);
        }
      };
    };

    const handleNetworkChange = () => {
      const cur = activeCallRef.current;
      if (!cur) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        return;
      }

      // Probe WebSocket liveness: if old IP left TCP half-open, force immediate reconnect on new IP
      const probeSentAt = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        ws.close();
        return;
      }
      if (networkProbeTimeout !== null) {
        window.clearTimeout(networkProbeTimeout);
      }
      networkProbeTimeout = window.setTimeout(() => {
        networkProbeTimeout = null;
        if (!cancelled && wsRef.current === ws && lastWsActivityAt < probeSentAt) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      }, 900);

      if (pcRef.current && !isRelayActiveRef.current) {
        void triggerIceRestart(cur.callId, cur.peerUid);
      }
    };

    const netConn = (
      navigator as Navigator & {
        connection?: {
          addEventListener?: (type: string, listener: () => void) => void;
          removeEventListener?: (type: string, listener: () => void) => void;
        };
      }
    ).connection;

    window.addEventListener('online', handleNetworkChange);
    netConn?.addEventListener?.('change', handleNetworkChange);

    void connect();

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleNetworkChange);
      netConn?.removeEventListener?.('change', handleNetworkChange);
      if (reconnectTimeout !== null) {
        window.clearTimeout(reconnectTimeout);
      }
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
      }
      if (networkProbeTimeout !== null) {
        window.clearTimeout(networkProbeTimeout);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [
    cleanupCallMedia,
    drainPendingIce,
    playRelayAudio,
    scheduleRelayFallback,
    sendWs,
    startRelayMedia,
    startRingtone,
    stopRingtone,
    triggerIceRestart,
    user,
  ]);

  // Prune stale typing states every 2.5s
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTypingByChat((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [chatId, senders] of Object.entries(prev)) {
          const activeSenders: Record<string, number> = {};
          for (const [uid, ts] of Object.entries(senders)) {
            if (now - ts < 4500) {
              activeSenders[uid] = ts;
            } else {
              changed = true;
            }
          }
          if (Object.keys(activeSenders).length > 0) {
            next[chatId] = activeSenders;
          }
        }
        return changed ? next : prev;
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const emitTyping = useCallback(
    (chatId: string, memberIds: string[], isTyping: boolean) => {
      sendWs({ type: 'typing', chatId, memberIds, isTyping });
    },
    [sendWs]
  );

  // Resilient getUserMedia with Samsung / Android constraint fallbacks
  const acquireUserMedia = useCallback(async (wantVideo: boolean): Promise<MediaStream | null> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return null;
    }

    if (wantVideo) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } },
        });
      } catch {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch {
          // Camera blocked or unavailable: continue with audio so voice still works
        }
      }
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        return null;
      }
    }
  }, []);

  const startCall = useCallback(
    async (params: {
      chatId: string;
      peerUid: string;
      peerName: string;
      peerPhoto: string;
      callType: CallType;
      memberIds: string[];
    }) => {
      if (!user || activeCallRef.current) return;
      unlockAudioEngines();
      const callId = generateId('call');

      const stream = await acquireUserMedia(params.callType === 'video');
      if (!stream) {
        onMediaError?.('media');
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setCallTransport('connecting');
      setIsMuted(false);
      setIsCameraOff(params.callType === 'audio' || stream.getVideoTracks().length === 0);

      setActiveCall({
        callId,
        chatId: params.chatId,
        peerUid: params.peerUid,
        peerName: params.peerName,
        peerPhoto: params.peerPhoto,
        callType: params.callType,
        direction: 'outgoing',
        status: 'ringing',
      });

      await createCallRecord({
        callId,
        chatId: params.chatId,
        callerId: user.uid,
        callerName: displayName,
        calleeId: params.peerUid,
        calleeName: params.peerName,
        callType: params.callType,
      });

      const isPeerOnline = onlineUids.includes(params.peerUid);
      if (!isPeerOnline) {
        onPeerOfflineNotice?.();
      }

      const rtcConfig = await fetchIceConfiguration();
      const pc = createPeerConnection(callId, params.peerUid, params.callType, rtcConfig);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: params.callType === 'video',
      });
      await pc.setLocalDescription(offer);

      sendWs({
        type: 'call:offer',
        callId,
        chatId: params.chatId,
        toUid: params.peerUid,
        callerName: displayName,
        callerPhoto: user.photoURL || '',
        callType: params.callType,
        sdp: pc.localDescription || offer,
      });

      startRingtone('outgoing');
    },
    [
      acquireUserMedia,
      createPeerConnection,
      displayName,
      fetchIceConfiguration,
      onMediaError,
      onPeerOfflineNotice,
      onlineUids,
      sendWs,
      startRingtone,
      unlockAudioEngines,
      user,
    ]
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = activeCallRef.current;
    const offerData = pendingOfferRef.current;
    if (!call || !offerData || call.callId !== offerData.callId) return;

    unlockAudioEngines();
    stopRingtone();
    const stream = await acquireUserMedia(call.callType === 'video');
    if (!stream) {
      onMediaError?.('media');
      sendWs({ type: 'call:decline', callId: call.callId, toUid: call.peerUid });
      void updateCallStatus(call.callId, 'declined', 0);
      cleanupCallMedia();
      return;
    }

    localStreamRef.current = stream;
    setLocalStream(stream);
    setCallTransport('connecting');
    setIsMuted(false);
    setIsCameraOff(call.callType === 'audio' || stream.getVideoTracks().length === 0);
    setActiveCall((prev) => (prev ? { ...prev, status: 'connecting' } : null));

    const rtcConfig = await fetchIceConfiguration();
    const pc = createPeerConnection(call.callId, call.peerUid, call.callType, rtcConfig);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
    await drainPendingIce(call.callId, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendWs({
      type: 'call:answer',
      callId: call.callId,
      toUid: call.peerUid,
      sdp: pc.localDescription || answer,
    });

    scheduleRelayFallback(call.callId, call.peerUid, call.callType);
  }, [
    acquireUserMedia,
    cleanupCallMedia,
    createPeerConnection,
    drainPendingIce,
    fetchIceConfiguration,
    onMediaError,
    scheduleRelayFallback,
    sendWs,
    stopRingtone,
    unlockAudioEngines,
  ]);

  const declineOrEndCall = useCallback(
    async (memberIdsForLog?: string[]) => {
      const call = activeCallRef.current;
      if (!call || !user) {
        cleanupCallMedia();
        return;
      }

      const elapsed = call.startedAtMs
        ? Math.max(1, Math.round((Date.now() - call.startedAtMs) / 1000))
        : 0;

      if (call.direction === 'incoming' && call.status === 'ringing') {
        sendWs({ type: 'call:decline', callId: call.callId, toUid: call.peerUid });
        await updateCallStatus(call.callId, 'declined', 0);
      } else {
        sendWs({ type: 'call:hangup', callId: call.callId, toUid: call.peerUid });
        const finalStatus = call.status === 'active' ? 'ended' : 'missed';
        await updateCallStatus(call.callId, finalStatus, elapsed);

        if (memberIdsForLog && memberIdsForLog.length > 0) {
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const durLabel =
            elapsed > 0
              ? `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
              : '00:00';
          await sendChatMessage(call.chatId, user.uid, displayName, memberIdsForLog, {
            type: 'call',
            text: `${call.callType === 'video' ? 'video' : 'audio'} · ${durLabel}`,
            previewLabel: call.callType === 'video' ? 'Video call' : 'Audio call',
          }).catch(() => undefined);
        }
      }

      cleanupCallMedia();
    },
    [cleanupCallMedia, displayName, sendWs, user]
  );

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      // If camera initially failed or wasn't acquired, try acquiring camera now
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        const newTrack = camStream.getVideoTracks()[0];
        if (newTrack) {
          stream.addTrack(newTrack);
          setLocalStream(new MediaStream(stream.getTracks()));
          setIsCameraOff(false);
          if (pcRef.current) {
            pcRef.current.addTrack(newTrack, stream);
          }
        }
      } catch {
        onMediaError?.('media');
      }
      return;
    }
    const nextOff = !isCameraOff;
    videoTracks.forEach((t) => {
      t.enabled = !nextOff;
    });
    setIsCameraOff(nextOff);
  }, [isCameraOff, onMediaError]);

  return {
    onlineUids,
    typingByChat,
    activeCall,
    localStream,
    remoteStream,
    relayVideoFrame,
    callTransport,
    isMuted,
    isCameraOff,
    emitTyping,
    startCall,
    acceptIncomingCall,
    declineOrEndCall,
    toggleMute,
    toggleCamera,
    unlockPlaybackAudio: unlockAudioEngines,
    registerLocalVideoElement,
  };
}
