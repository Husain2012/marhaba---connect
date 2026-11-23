import { User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCallRecord, generateId, sendChatMessage, updateCallStatus } from '../lib/chatService';
import { ActiveCallSession, CallType } from '../types/chat';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

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
  const activeCallRef = useRef<ActiveCallSession | null>(null);
  const pendingOfferRef = useRef<{ callId: string; sdp: RTCSessionDescriptionInit } | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const ringtoneTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

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

  const startRingtone = useCallback((mode: 'incoming' | 'outgoing') => {
    stopRingtone();
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
  }, [stopRingtone]);

  const cleanupCallMedia = useCallback(() => {
    stopRingtone();
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
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

  const createPeerConnection = useCallback(
    (callId: string, peerUid: string) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      const remote = new MediaStream();
      setRemoteStream(remote);

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          remote.addTrack(track);
        });
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

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          stopRingtone();
          setActiveCall((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'active',
                  startedAtMs: prev.startedAtMs || Date.now(),
                }
              : null
          );
          void updateCallStatus(callId, 'active', 0);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          const cur = activeCallRef.current;
          if (cur && cur.callId === callId) {
            const elapsed = cur.startedAtMs ? Math.round((Date.now() - cur.startedAtMs) / 1000) : 0;
            void updateCallStatus(callId, 'ended', elapsed);
            cleanupCallMedia();
          }
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [cleanupCallMedia, sendWs, stopRingtone]
  );

  // Connect & maintain WebSocket signaling
  useEffect(() => {
    if (!user) {
      cleanupCallMedia();
      setOnlineUids([]);
      return;
    }

    let cancelled = false;
    let reconnectTimeout: number | null = null;

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
          pendingIceRef.current = [];
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
          return;
        }

        if (type === 'call:answer') {
          const callId = String(msg.callId || '');
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          if (pcRef.current && activeCallRef.current?.callId === callId) {
            stopRingtone();
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const cand of pendingIceRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(cand)).catch(() => undefined);
            }
            pendingIceRef.current = [];
            setActiveCall((prev) =>
              prev
                ? {
                    ...prev,
                    status: 'active',
                    startedAtMs: prev.startedAtMs || Date.now(),
                  }
                : null
            );
            void updateCallStatus(callId, 'active', 0);
          }
          return;
        }

        if (type === 'call:ice') {
          const candidate = msg.candidate as RTCIceCandidateInit | undefined;
          if (!candidate) return;
          if (pcRef.current && pcRef.current.remoteDescription) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
          } else {
            pendingIceRef.current.push(candidate);
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
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [cleanupCallMedia, sendWs, startRingtone, stopRingtone, user]);

  // Prune stale typing states every 3s
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

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: params.callType === 'video',
        });
      } catch {
        onMediaError?.('media');
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(false);
      setIsCameraOff(params.callType === 'audio');

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

      const pc = createPeerConnection(callId, params.peerUid);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendWs({
        type: 'call:offer',
        callId,
        chatId: params.chatId,
        toUid: params.peerUid,
        callerName: displayName,
        callerPhoto: user.photoURL || '',
        callType: params.callType,
        sdp: offer,
      });

      startRingtone('outgoing');
    },
    [createPeerConnection, displayName, onMediaError, onPeerOfflineNotice, onlineUids, sendWs, startRingtone, user]
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = activeCallRef.current;
    const offerData = pendingOfferRef.current;
    if (!call || !offerData || call.callId !== offerData.callId) return;

    stopRingtone();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.callType === 'video',
      });
    } catch {
      onMediaError?.('media');
      sendWs({ type: 'call:decline', callId: call.callId, toUid: call.peerUid });
      void updateCallStatus(call.callId, 'declined', 0);
      cleanupCallMedia();
      return;
    }

    localStreamRef.current = stream;
    setLocalStream(stream);
    setActiveCall((prev) => (prev ? { ...prev, status: 'connecting' } : null));

    const pc = createPeerConnection(call.callId, call.peerUid);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
    for (const cand of pendingIceRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => undefined);
    }
    pendingIceRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendWs({
      type: 'call:answer',
      callId: call.callId,
      toUid: call.peerUid,
      sdp: answer,
    });
  }, [cleanupCallMedia, createPeerConnection, onMediaError, sendWs, stopRingtone]);

  const declineOrEndCall = useCallback(
    async (memberIdsForLog?: string[]) => {
      const call = activeCallRef.current;
      if (!call || !user) {
        cleanupCallMedia();
        return;
      }

      const elapsed = call.startedAtMs ? Math.max(1, Math.round((Date.now() - call.startedAtMs) / 1000)) : 0;

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
          const durLabel = elapsed > 0 ? `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : '00:00';
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
