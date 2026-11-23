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

function downsampleToInt16(input: Float32Array, inputRate: number, targetRate: number): Int16Array {
  if (inputRate <= targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputRate / targetRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += input[i];
      count += 1;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
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

async function hasWebRtcInboundAudioBytes(pc: RTCPeerConnection | null): Promise<boolean> {
  if (!pc || typeof pc.getStats !== 'function') return false;
  try {
    const stats = await pc.getStats();
    let audioBytes = 0;
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        audioBytes += Number((report as { bytesReceived?: number }).bytesReceived || 0);
      }
    });
    return audioBytes > 0;
  } catch {
    return false;
  }
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
  const relayFallbackTimerRef = useRef<number | null>(null);
  const iceRestartedRef = useRef<boolean>(false);
  const webrtcConnectedRef = useRef<boolean>(false);
  const isMutedRef = useRef<boolean>(false);
  const isCameraOffRef = useRef<boolean>(false);

  // Pre-unlocked AudioContexts (created synchronously on user gesture!)
  const isRelayActiveRef = useRef<boolean>(false);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureProcRef = useRef<ScriptProcessorNode | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const relayVideoTimerRef = useRef<number | null>(null);
  const offscreenVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    isMutedRef.current = isMuted;
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

  const sendWs = useCallback((payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const stopRelayMedia = useCallback(() => {
    isRelayActiveRef.current = false;
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
    nextPlayTimeRef.current = 0;
    setRelayVideoFrame(null);
  }, []);

  const startRelayMedia = useCallback(
    (callId: string, peerUid: string, callType: CallType) => {
      if (isRelayActiveRef.current) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      isRelayActiveRef.current = true;
      setCallTransport('relay');
      unlockAudioEngines();

      // 1. Live audio PCM capture -> WebSocket relay (reuses pre-unlocked captureCtx)
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
            const source = captureCtx.createMediaStreamSource(stream);
            const processor = captureCtx.createScriptProcessor(2048, 1, 1);
            const silentGain = captureCtx.createGain();
            silentGain.gain.value = 0;

            processor.onaudioprocess = (ev) => {
              if (!isRelayActiveRef.current || isMutedRef.current) return;
              if (activeCallRef.current?.callId !== callId) return;
              const input = ev.inputBuffer.getChannelData(0);
              const int16 = downsampleToInt16(input, captureCtx.sampleRate, TARGET_SAMPLE_RATE);
              const pcm = int16ToBase64(int16);
              sendWs({
                type: 'call:relay-audio',
                callId,
                toUid: peerUid,
                sr: TARGET_SAMPLE_RATE,
                pcm,
              });
            };

            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(captureCtx.destination);
            captureSourceRef.current = source;
            captureProcRef.current = processor;
          }
        } catch {
          // Ignore if audio capture node fails
        }
      }

      // 2. Live video frame capture -> WebSocket relay (attached to DOM so mobile Chrome/Samsung decodes frames!)
      if (callType === 'video' && stream.getVideoTracks().length > 0) {
        try {
          const hiddenVideo = document.createElement('video');
          hiddenVideo.muted = true;
          hiddenVideo.playsInline = true;
          hiddenVideo.autoplay = true;
          hiddenVideo.style.position = 'fixed';
          hiddenVideo.style.width = '2px';
          hiddenVideo.style.height = '2px';
          hiddenVideo.style.bottom = '0';
          hiddenVideo.style.right = '0';
          hiddenVideo.style.opacity = '0.01';
          hiddenVideo.style.pointerEvents = 'none';
          hiddenVideo.style.zIndex = '-1';
          document.body.appendChild(hiddenVideo);
          hiddenVideo.srcObject = stream;
          void hiddenVideo.play().catch(() => undefined);
          offscreenVideoRef.current = hiddenVideo;

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          relayVideoTimerRef.current = window.setInterval(() => {
            if (!isRelayActiveRef.current || isCameraOffRef.current) return;
            if (activeCallRef.current?.callId !== callId) return;
            if (!ctx || hiddenVideo.readyState < 2 || hiddenVideo.videoWidth === 0) return;

            const maxW = 320;
            const scale = Math.min(1, maxW / hiddenVideo.videoWidth);
            canvas.width = Math.max(1, Math.round(hiddenVideo.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(hiddenVideo.videoHeight * scale));
            ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
            const frame = canvas.toDataURL('image/jpeg', 0.5);
            sendWs({
              type: 'call:relay-video',
              callId,
              toUid: peerUid,
              frame,
            });
          }, 140);
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
    [sendWs, stopRingtone, unlockAudioEngines]
  );

  const playRelayAudio = useCallback(
    (pcmB64: string, sampleRate: number) => {
      const ctx = playbackCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        unlockAudioEngines();
      }
      const activeCtx = playbackCtxRef.current;
      if (!activeCtx || activeCtx.state === 'closed') return;
      if (activeCtx.state === 'suspended') {
        void activeCtx.resume().catch(() => undefined);
      }

      try {
        const float32 = base64ToFloat32(pcmB64);
        if (float32.length === 0) return;
        const safeSr = sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : TARGET_SAMPLE_RATE;
        const audioBuffer = activeCtx.createBuffer(1, float32.length, safeSr);
        audioBuffer.copyToChannel(float32 as Float32Array<ArrayBuffer>, 0);

        const source = activeCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(activeCtx.destination);

        const now = activeCtx.currentTime;
        if (nextPlayTimeRef.current < now || nextPlayTimeRef.current > now + 0.4) {
          nextPlayTimeRef.current = now + 0.06;
        }
        source.start(nextPlayTimeRef.current);
        nextPlayTimeRef.current += audioBuffer.duration;
      } catch {
        // Skip malformed frame
      }
    },
    [unlockAudioEngines]
  );

  const scheduleRelayFallback = useCallback(
    (callId: string, peerUid: string, callType: CallType) => {
      if (relayFallbackTimerRef.current !== null) {
        window.clearTimeout(relayFallbackTimerRef.current);
      }
      relayFallbackTimerRef.current = window.setTimeout(async () => {
        const cur = activeCallRef.current;
        if (!cur || cur.callId !== callId) return;
        const hasRealBytes = await hasWebRtcInboundAudioBytes(pcRef.current);
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
    [sendWs, startRelayMedia]
  );

  const cleanupCallMedia = useCallback(() => {
    stopRingtone();
    stopRelayMedia();
    webrtcConnectedRef.current = false;

    if (iceFailTimerRef.current !== null) {
      window.clearTimeout(iceFailTimerRef.current);
      iceFailTimerRef.current = null;
    }
    iceRestartedRef.current = false;

    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
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
    remoteStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingIceMapRef.current.clear();
    setLocalStream(null);
    setRemoteStream(null);
    setRelayVideoFrame(null);
    setCallTransport('connecting');
    setIsMuted(false);
    setIsCameraOff(false);
    setActiveCall(null);
  }, [stopRelayMedia, stopRingtone]);

  const fetchIceConfiguration = useCallback(async (): Promise<RTCConfiguration> => {
    if (!user) {
      return { iceServers: DEFAULT_ICE_SERVERS, iceCandidatePoolSize: 10 };
    }
    try {
      const token = await user.getIdToken();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 1600);
      const resp = await fetch('/api/ice-servers', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          return { iceServers: data.iceServers, iceCandidatePoolSize: 10 };
        }
      }
    } catch {
      // Fallback to default STUN list
    }
    return { iceServers: DEFAULT_ICE_SERVERS, iceCandidatePoolSize: 10 };
  }, [user]);

  const drainPendingIce = useCallback(async (callId: string, pc: RTCPeerConnection) => {
    const queue = pendingIceMapRef.current.get(callId);
    if (!queue || queue.length === 0) return;
    pendingIceMapRef.current.delete(callId);
    for (const cand of queue) {
      await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => undefined);
    }
  }, []);

  const createPeerConnection = useCallback(
    (callId: string, peerUid: string, callType: CallType, rtcConfig: RTCConfiguration) => {
      const pc = new RTCPeerConnection(rtcConfig);
      const remote = new MediaStream();
      remoteStreamRef.current = remote;
      iceRestartedRef.current = false;
      webrtcConnectedRef.current = false;

      const emitRemoteStream = async () => {
        const tracks = remote.getTracks();
        if (tracks.length > 0) {
          setRemoteStream(new MediaStream(tracks));
          if (webrtcConnectedRef.current && isRelayActiveRef.current) {
            const hasRealBytes = await hasWebRtcInboundAudioBytes(pc);
            if (hasRealBytes) {
              stopRelayMedia();
              setCallTransport('p2p');
            }
          }
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
        webrtcConnectedRef.current = true;
        if (iceFailTimerRef.current !== null) {
          window.clearTimeout(iceFailTimerRef.current);
          iceFailTimerRef.current = null;
        }
        // Only disable relay and mark P2P active once WebRTC actually has inbound audio bytes
        const hasRealBytes = await hasWebRtcInboundAudioBytes(pc);
        if (hasRealBytes) {
          if (isRelayActiveRef.current) {
            stopRelayMedia();
          }
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
        if (!iceRestartedRef.current && typeof pc.restartIce === 'function') {
          iceRestartedRef.current = true;
          pc.restartIce();
        }
        const cur = activeCallRef.current;
        if (cur && cur.callId === callId && !isRelayActiveRef.current) {
          startRelayMedia(callId, peerUid, callType);
          sendWs({ type: 'call:relay-ready', callId, toUid: peerUid });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          void markConnected();
        } else if (pc.connectionState === 'failed') {
          handlePossibleFailure();
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          void markConnected();
        } else if (pc.iceConnectionState === 'failed') {
          handlePossibleFailure();
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendWs, startRelayMedia, stopRelayMedia, stopRingtone]
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

    const connect = async () => {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = async () => {
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
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = msg.type;
        if (type === 'pong') return;

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
          reconnectTimeout = window.setTimeout(() => {
            void connect();
          }, 2500);
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout !== null) {
        window.clearTimeout(reconnectTimeout);
      }
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
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

  const toggleCamera = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextOff = !isCameraOff;
    localStreamRef.current.getVideoTracks().forEach((t) => {
      t.enabled = !nextOff;
    });
    setIsCameraOff(nextOff);
  }, [isCameraOff]);

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
  };
}
