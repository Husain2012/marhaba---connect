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
  const audioCtxRef = useRef<AudioContext | null>(null);
  const iceFailTimerRef = useRef<number | null>(null);
  const iceRestartedRef = useRef<boolean>(false);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const stopRingtone = useCallback(() => {
    if (ringtoneTimerRef.current !== null) {
      window.clearInterval(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
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
        audioCtxRef.current = ctx;

        const playTone = () => {
          if (ctx.state === 'closed') return;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = mode === 'incoming' ? 520 : 440;
          gain.gain.setValueAtTime(0.001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.48);
        };

        playTone();
        ringtoneTimerRef.current = window.setInterval(playTone, mode === 'incoming' ? 1600 : 2200);
      } catch {
        // Ignore Web Audio autoplay restrictions
      }
    },
    [stopRingtone]
  );

  const cleanupCallMedia = useCallback(() => {
    stopRingtone();
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
    remoteStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingIceMapRef.current.clear();
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setIsCameraOff(false);
    setActiveCall(null);
  }, [stopRingtone]);

  const sendWs = useCallback((payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const fetchIceConfiguration = useCallback(async (): Promise<RTCConfiguration> => {
    if (!user) {
      return { iceServers: DEFAULT_ICE_SERVERS, iceCandidatePoolSize: 10 };
    }
    try {
      const token = await user.getIdToken();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 1800);
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
      // Fallback cleanly to default STUN servers
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
    (callId: string, peerUid: string, rtcConfig: RTCConfiguration) => {
      const pc = new RTCPeerConnection(rtcConfig);
      const remote = new MediaStream();
      remoteStreamRef.current = remote;
      iceRestartedRef.current = false;

      const emitRemoteStream = () => {
        const tracks = remote.getTracks();
        if (tracks.length > 0) {
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
            track.onunmute = () => emitRemoteStream();
          }
        }
        emitRemoteStream();
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

      const markConnected = () => {
        if (iceFailTimerRef.current !== null) {
          window.clearTimeout(iceFailTimerRef.current);
          iceFailTimerRef.current = null;
        }
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
      };

      const handlePossibleFailure = (state: string) => {
        if (state === 'failed') {
          if (!iceRestartedRef.current && typeof pc.restartIce === 'function') {
            iceRestartedRef.current = true;
            pc.restartIce();
          }
          if (iceFailTimerRef.current === null) {
            iceFailTimerRef.current = window.setTimeout(() => {
              const cur = activeCallRef.current;
              if (
                cur &&
                cur.callId === callId &&
                (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed')
              ) {
                const elapsed = cur.startedAtMs
                  ? Math.round((Date.now() - cur.startedAtMs) / 1000)
                  : 0;
                void updateCallStatus(callId, 'ended', elapsed);
                cleanupCallMedia();
              }
            }, 6000);
          }
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          markConnected();
        } else if (pc.connectionState === 'failed') {
          handlePossibleFailure('failed');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          markConnected();
        } else if (pc.iceConnectionState === 'failed') {
          handlePossibleFailure('failed');
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [cleanupCallMedia, sendWs, stopRingtone]
  );

  // Connect & maintain WebSocket signaling with keepalive ping
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
          if (pcRef.current && activeCallRef.current?.callId === callId) {
            stopRingtone();
            setActiveCall((prev) =>
              prev && prev.callId === callId && prev.status === 'ringing'
                ? { ...prev, status: 'connecting' }
                : prev
            );
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            await drainPendingIce(callId, pcRef.current);
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
  }, [cleanupCallMedia, drainPendingIce, sendWs, startRingtone, stopRingtone, user]);

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

  const acquireUserMedia = useCallback(async (wantVideo: boolean): Promise<MediaStream | null> => {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    if (!wantVideo) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch {
        return null;
      }
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch {
      // Fallback to audio-only if camera hardware is unavailable or busy
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
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
      const callId = generateId('call');

      const stream = await acquireUserMedia(params.callType === 'video');
      if (!stream) {
        onMediaError?.('media');
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
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
      const pc = createPeerConnection(callId, params.peerUid, rtcConfig);
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
      user,
    ]
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = activeCallRef.current;
    const offerData = pendingOfferRef.current;
    if (!call || !offerData || call.callId !== offerData.callId) return;

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
    setIsMuted(false);
    setIsCameraOff(call.callType === 'audio' || stream.getVideoTracks().length === 0);
    setActiveCall((prev) => (prev ? { ...prev, status: 'connecting' } : null));

    const rtcConfig = await fetchIceConfiguration();
    const pc = createPeerConnection(call.callId, call.peerUid, rtcConfig);
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
  }, [
    acquireUserMedia,
    cleanupCallMedia,
    createPeerConnection,
    drainPendingIce,
    fetchIceConfiguration,
    onMediaError,
    sendWs,
    stopRingtone,
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
    isMuted,
    isCameraOff,
    emitTyping,
    startCall,
    acceptIncomingCall,
    declineOrEndCall,
    toggleMute,
    toggleCamera,
  };
}
