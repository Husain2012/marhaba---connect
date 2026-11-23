import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { ActiveCallSession, Language } from '../types/chat';
import { Avatar } from './Avatar';

interface CallOverlayProps {
  language: Language;
  call: ActiveCallSession | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  isCameraOff: boolean;
  onAccept: () => void;
  onDeclineOrEnd: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
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
  isMuted,
  isCameraOff,
  onAccept,
  onDeclineOrEnd,
  onToggleMute,
  onToggleCamera,
}: CallOverlayProps) {
  const t = getCopy(language);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

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

  const isVideo = call.callType === 'video';
  const statusLabel =
    call.status === 'active'
      ? formatTimer(elapsedSec)
      : call.status === 'connecting'
      ? t.connecting
      : call.direction === 'incoming'
      ? isVideo
        ? t.incomingVideoCall
        : t.incomingAudioCall
      : t.calling;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 text-white flex flex-col justify-between overflow-hidden">
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {isVideo && remoteStream ? (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : null}

      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/30 to-black/80 pointer-events-none" />

      {/* Top Info */}
      <div className="relative z-10 pt-safe px-6 py-8 text-center space-y-3">
        {(!isVideo || call.status !== 'active') && (
          <div className="flex justify-center pb-2">
            <Avatar name={call.peerName} photoURL={call.peerPhoto} size="xl" />
          </div>
        )}
        <h2 className="font-display text-2xl font-bold tracking-tight">{call.peerName}</h2>
        <p className="text-sm text-slate-200 font-mono tabular-nums">{statusLabel}</p>
      </div>

      {/* Local PiP Video */}
      {isVideo && localStream && (
        <div className="relative z-10 self-end mx-5 mb-4 w-28 sm:w-36 aspect-[3/4] rounded-2xl overflow-hidden border border-white/25 bg-slate-900 shadow-lg">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        </div>
      )}

      {/* Bottom Controls */}
      <div className="relative z-10 pb-safe px-6 py-8 flex items-center justify-center gap-5">
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
