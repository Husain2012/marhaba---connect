import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { ActiveCallSession, Language } from '../types/chat';
import { Avatar } from './Avatar';

interface CallOverlayProps {
  language: Language;
  call: ActiveCallSession | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  relayVideoFrame: string | null;
  callTransport: 'connecting' | 'p2p' | 'relay';
  isMuted: boolean;
  isCameraOff: boolean;
  onAccept: () => void;
  onDeclineOrEnd: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onUnlockAudio: () => void;
}

function formatTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallOverlay({
  language,
  call,
  localStream,
  remoteStream,
  relayVideoFrame,
  callTransport,
  isMuted,
  isCameraOff,
  onAccept,
  onDeclineOrEnd,
  onToggleMute,
  onToggleCamera,
  onUnlockAudio,
}: CallOverlayProps) {
  const t = getCopy(language);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const isVideo = call?.callType === 'video';
  const hasRemoteVideo = Boolean(
    isVideo && remoteStream && remoteStream.getVideoTracks().length > 0
  );
  const hasRelayVideo = Boolean(isVideo && !hasRemoteVideo && relayVideoFrame);
  const hasAnyRemoteVideo = hasRemoteVideo || hasRelayVideo;
  const hasLocalVideo = Boolean(
    isVideo && localStream && localStream.getVideoTracks().length > 0
  );

  // Attach & play local camera stream
  useEffect(() => {
    const videoEl = localVideoRef.current;
    if (!videoEl || !localStream || !hasLocalVideo) return;
    videoEl.muted = true;
    videoEl.srcObject = localStream;
    void videoEl.play().catch(() => undefined);
  }, [localStream, hasLocalVideo, call?.status]);

  // Attach & play WebRTC remote stream when available
  useEffect(() => {
    if (!remoteStream) {
      setAudioBlocked(false);
      return;
    }

    const playMedia = async (el: HTMLMediaElement | null) => {
      if (!el) return;
      el.srcObject = remoteStream;
      el.muted = false;
      el.volume = 1;
      try {
        await el.play();
        setAudioBlocked(false);
      } catch {
        setAudioBlocked(true);
      }
    };

    if (hasRemoteVideo) {
      void playMedia(remoteVideoRef.current);
    } else if (!hasRelayVideo) {
      void playMedia(remoteAudioRef.current);
    }
  }, [remoteStream, hasRemoteVideo, hasRelayVideo, call?.status]);

  useEffect(() => {
    if (!call || call.status !== 'active' || !call.startedAtMs) {
      setElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - (call.startedAtMs || Date.now())) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [call]);

  if (!call) return null;

  const handleUnlockAudio = () => {
    onUnlockAudio();
    const target = hasRemoteVideo ? remoteVideoRef.current : remoteAudioRef.current;
    if (!target) {
      setAudioBlocked(false);
      return;
    }
    target.muted = false;
    target.volume = 1;
    void target
      .play()
      .then(() => setAudioBlocked(false))
      .catch(() => undefined);
  };

  const statusLabel =
    call.status === 'active'
      ? formatTimer(elapsedSec)
      : call.status === 'connecting'
      ? t.mediaConnecting
      : call.direction === 'incoming'
      ? isVideo
        ? t.incomingVideoCall
        : t.incomingAudioCall
      : t.calling;

  return (
    <div
      onClick={() => onUnlockAudio()}
      className="fixed inset-0 z-50 bg-slate-950 text-white flex flex-col justify-between overflow-hidden"
    >
      {!hasRemoteVideo && <audio ref={remoteAudioRef} autoPlay playsInline />}

      {hasRemoteVideo ? (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          onLoadedMetadata={() => {
            void remoteVideoRef.current?.play().catch(() => undefined);
          }}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : hasRelayVideo && relayVideoFrame ? (
        <img
          src={relayVideoFrame}
          alt={call.peerName}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : null}

      <div className="absolute inset-0 bg-gradient-to-b from-black/65 via-transparent to-black/75 pointer-events-none" />

      {/* Top Info */}
      <div className="relative z-10 pt-safe px-6 py-8 text-center space-y-3">
        {!hasAnyRemoteVideo && (
          <div className="flex justify-center pb-2">
            <Avatar name={call.peerName} photoURL={call.peerPhoto} size="xl" />
          </div>
        )}
        <h2 className="font-display text-2xl font-bold tracking-tight drop-shadow-xs">
          {call.peerName}
        </h2>
        <p className="text-sm text-slate-200 font-mono tabular-nums drop-shadow-xs">
          {statusLabel}
        </p>
        {call.status === 'active' && (
          <p className="text-[11px] text-emerald-300/90 font-medium drop-shadow-xs">
            {callTransport === 'relay' ? t.modeRelay : t.modeP2p}
          </p>
        )}

        {audioBlocked && (
          <div className="pt-2 flex justify-center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleUnlockAudio();
              }}
              className="px-4 py-2 rounded-xl bg-[#00B87C] hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-2 shadow-lg"
            >
              <Volume2 className="w-4 h-4" />
              <span>{t.tapToEnableAudio}</span>
            </button>
          </div>
        )}
      </div>

      {/* Local PiP Video */}
      {hasLocalVideo && (
        <div className="relative z-20 self-end mx-5 mb-4 w-28 sm:w-36 aspect-[3/4] rounded-2xl overflow-hidden border border-white/30 bg-slate-900 shadow-lg">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            onLoadedMetadata={() => {
              if (localVideoRef.current) {
                localVideoRef.current.muted = true;
                void localVideoRef.current.play().catch(() => undefined);
              }
            }}
            className={`w-full h-full object-cover scale-x-[-1] ${isCameraOff ? 'opacity-20' : ''}`}
          />
        </div>
      )}

      {/* Bottom Controls */}
      <div className="relative z-20 pb-safe px-6 py-8 flex items-center justify-center gap-5">
        {call.direction === 'incoming' && call.status === 'ringing' ? (
          <>
            <button
              type="button"
              onClick={onDeclineOrEnd}
              className="min-h-[60px] min-w-[60px] px-6 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center gap-2 font-semibold transition-colors"
            >
              <PhoneOff className="w-6 h-6" />
              <span>{t.decline}</span>
            </button>
            <button
              type="button"
              onClick={onAccept}
              className="min-h-[60px] min-w-[60px] px-6 rounded-full bg-[#00B87C] hover:bg-emerald-500 text-white flex items-center justify-center gap-2 font-semibold transition-colors"
            >
              <Phone className="w-6 h-6" />
              <span>{t.accept}</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleMute}
              aria-label={isMuted ? t.unmute : t.mute}
              className={`min-h-[56px] min-w-[56px] rounded-full flex items-center justify-center transition-colors ${
                isMuted ? 'bg-white text-slate-900' : 'bg-white/20 hover:bg-white/30 text-white'
              }`}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>

            {isVideo && (
              <button
                type="button"
                onClick={onToggleCamera}
                aria-label={isCameraOff ? t.cameraOn : t.cameraOff}
                className={`min-h-[56px] min-w-[56px] rounded-full flex items-center justify-center transition-colors ${
                  isCameraOff ? 'bg-white text-slate-900' : 'bg-white/20 hover:bg-white/30 text-white'
                }`}
              >
                {isCameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
              </button>
            )}

            <button
              type="button"
              onClick={onDeclineOrEnd}
              aria-label={t.endCall}
              className="min-h-[56px] px-6 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center gap-2 font-semibold transition-colors"
            >
              <PhoneOff className="w-6 h-6" />
              <span>{t.endCall}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
