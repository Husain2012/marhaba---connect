import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Download,
  FileText,
  Image as ImageIcon,
  Info,
  Mic,
  Paperclip,
  Pause,
  Phone,
  Play,
  Reply,
  Send,
  Smile,
  Square,
  Video,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { sendChatMessage, uploadMediaFile } from '../lib/chatService';
import { CallType, Chat, ChatMessage, Language, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface ChatThreadPaneProps {
  language: Language;
  theme: 'light' | 'dark';
  currentUid: string;
  currentDisplayName: string;
  getIdToken: () => Promise<string>;
  chat: Chat | null;
  messages: ChatMessage[];
  contactsMap: Record<string, UserPublic>;
  onlineUids: string[];
  typingSenders: string[];
  onBack: () => void;
  onTypingChange: (isTyping: boolean) => void;
  onStartCall: (callType: CallType, peer: { uid: string; name: string; photo: string }) => void;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🙏', '🔥', '👏', '😊', '🎉', '✅', '📞', '🇸🇦', '🇦🇪'];

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function VoicePlayer({ src, durationSec, isMine }: { src: string; durationSec: number; isMine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  return (
    <div className="flex items-center gap-3 min-w-[210px] py-1">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurrentSec(0);
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (!audio) return;
          const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationSec || 1;
          setCurrentSec(audio.currentTime);
          setProgress(Math.min(100, (audio.currentTime / total) * 100));
        }}
      />
      <button
        type="button"
        onClick={togglePlay}
        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
          isMine
            ? 'bg-white/20 hover:bg-white/30 text-white'
            : 'bg-[#007AFF] hover:bg-[#0066D6] text-white'
        }`}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ms-0.5" />}
      </button>

      <div className="flex-1 space-y-1.5">
        <div className={`h-1.5 rounded-full overflow-hidden ${isMine ? 'bg-white/25' : 'bg-slate-200 dark:bg-slate-700'}`}>
          <div
            className={`h-full rounded-full transition-all ${isMine ? 'bg-white' : 'bg-[#007AFF]'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className={`text-[11px] tabular-nums ${isMine ? 'text-white/85' : 'text-slate-500 dark:text-slate-400'}`}>
          {formatDuration(playing ? currentSec : durationSec)}
        </div>
      </div>
    </div>
  );
}

export function ChatThreadPane({
  language,
  theme,
  currentUid,
  currentDisplayName,
  getIdToken,
  chat,
  messages,
  contactsMap,
  onlineUids,
  typingSenders,
  onBack,
  onTypingChange,
  onStartCall,
}: ChatThreadPaneProps) {
  const t = getCopy(language);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordSecondsRef = useRef(0);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, chat?.id]);

  useEffect(() => {
    setReplyTo(null);
    setShowAttachMenu(false);
    setShowEmoji(false);
    setShowInfo(false);
    setUploadError(null);
  }, [chat?.id]);

  if (!chat) {
    return (
      <div className="hidden lg:flex flex-1 flex-col items-center justify-center bg-[#F4F7FA] dark:bg-[#0B1118] p-8 text-center">
        <div className="max-w-md space-y-5">
          <img
            src="/src/assets/images/connect_empty_state_1795347731500.jpg"
            alt={t.noChatsTitle}
            referrerPolicy="no-referrer"
            className="w-72 mx-auto aspect-[4/3] object-cover rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm"
          />
          <h3 className="font-display text-xl font-bold text-slate-900 dark:text-white">
            {t.noChatsTitle}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            {t.noChatsDesc}
          </p>
        </div>
      </div>
    );
  }

  const isGroup = chat.type === 'group';
  const peerUid = chat.memberIds.find((id) => id !== currentUid) || currentUid;
  const peer = contactsMap[peerUid];
  const headerTitle = isGroup ? chat.name || t.groupChat : peer?.displayName || t.newChat;
  const isPeerOnline = !isGroup && onlineUids.includes(peerUid);

  const handleTextChange = (val: string) => {
    setDraft(val);
    onTypingChange(true);
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      onTypingChange(false);
    }, 2200);
  };

  const handleSendText = async () => {
    const clean = draft.trim();
    if (!clean) return;
    setDraft('');
    onTypingChange(false);
    const currentReply = replyTo;
    setReplyTo(null);

    await sendChatMessage(chat.id, currentUid, currentDisplayName, chat.memberIds, {
      type: 'text',
      text: clean,
      replyToId: currentReply?.id || '',
      replyToPreview: currentReply ? (currentReply.text || currentReply.fileName || currentReply.type).slice(0, 140) : '',
      previewLabel: clean,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendText();
    }
  };

  const handleUploadSelectedFile = async (file: File, kind: 'image' | 'file') => {
    setShowAttachMenu(false);
    setUploadError(null);
    if (file.size > 15 * 1024 * 1024) {
      setUploadError(t.uploadError);
      return;
    }

    setUploading(true);
    try {
      const token = await getIdToken();
      const uploaded = await uploadMediaFile(file, file.name, file.type || 'application/octet-stream', token);
      await sendChatMessage(chat.id, currentUid, currentDisplayName, chat.memberIds, {
        type: kind,
        text: '',
        mediaUrl: uploaded.mediaUrl,
        fileName: uploaded.fileName,
        fileSize: uploaded.fileSize,
        mimeType: uploaded.mimeType,
        previewLabel: kind === 'image' ? `📷 ${t.imageLabel}` : `📎 ${uploaded.fileName}`,
      });
    } catch {
      setUploadError(t.uploadError);
    } finally {
      setUploading(false);
    }
  };

  const startVoiceRecording = async () => {
    setUploadError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setUploadError(t.micDenied);
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
    const recorder = new MediaRecorder(stream, { mimeType });
    recordChunksRef.current = [];
    recordSecondsRef.current = 0;
    setRecordSeconds(0);
    setRecording(true);

    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        recordChunksRef.current.push(ev.data);
      }
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      const duration = Math.max(1, recordSecondsRef.current);
      const blob = new Blob(recordChunksRef.current, { type: mimeType });
      setRecording(false);

      if (blob.size < 200) return;
      setUploading(true);
      try {
        const token = await getIdToken();
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
        const uploaded = await uploadMediaFile(blob, `voice_${Date.now()}.${ext}`, mimeType, token);
        await sendChatMessage(chat.id, currentUid, currentDisplayName, chat.memberIds, {
          type: 'audio',
          text: '',
          mediaUrl: uploaded.mediaUrl,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
          mimeType: uploaded.mimeType,
          audioDurationSec: duration,
          previewLabel: `🎤 ${t.voiceMessageLabel} (${formatDuration(duration)})`,
        });
      } catch {
        setUploadError(t.uploadError);
      } finally {
        setUploading(false);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    recordTimerRef.current = window.setInterval(() => {
      recordSecondsRef.current += 1;
      setRecordSeconds(recordSecondsRef.current);
    }, 1000);
  };

  const stopAndSendVoice = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const cancelVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = () => {
        mediaRecorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
      };
      mediaRecorderRef.current.stop();
    }
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setRecordSeconds(0);
  };

  const BackIcon = language === 'ar' ? ArrowRight : ArrowLeft;

  return (
    <div className="flex-1 flex h-full overflow-hidden relative bg-[#F4F7FA] dark:bg-[#0B1118]">
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Sticky Top Chat Bar */}
        <header className="h-16 px-3 sm:px-5 bg-white/95 dark:bg-[#111822]/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0 z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="lg:hidden min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <BackIcon className="w-5 h-5" />
            </button>

            <Avatar
              name={headerTitle}
              photoURL={peer?.photoURL}
              isGroup={isGroup}
              isOnline={isPeerOnline}
              size="md"
            />

            <div className="min-w-0">
              <h3 className="font-display font-bold text-sm sm:text-base text-slate-900 dark:text-white truncate">
                {headerTitle}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {typingSenders.length > 0 ? (
                  <span className="text-[#00B87C] font-medium">{t.typing}</span>
                ) : isGroup ? (
                  `${chat.memberIds.length} ${t.membersLabel}`
                ) : isPeerOnline ? (
                  <span className="text-[#00B87C] font-medium">{t.online}</span>
                ) : (
                  t.offline
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {!isGroup && peerUid !== currentUid && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    onStartCall('audio', {
                      uid: peerUid,
                      name: headerTitle,
                      photo: peer?.photoURL || '',
                    })
                  }
                  aria-label={t.audioCall}
                  title={t.audioCall}
                  className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <Phone className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onStartCall('video', {
                      uid: peerUid,
                      name: headerTitle,
                      photo: peer?.photoURL || '',
                    })
                  }
                  aria-label={t.videoCall}
                  title={t.videoCall}
                  className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <Video className="w-5 h-5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowInfo((s) => !s)}
              aria-label={t.chatInfo}
              title={t.chatInfo}
              className={`min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center transition-colors ${
                showInfo
                  ? 'bg-sky-50 dark:bg-slate-800 text-[#007AFF]'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Info className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Scrollable Message Stream */}
        <div
          className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-2.5 bg-cover bg-center"
          style={
            theme === 'light'
              ? { backgroundImage: 'url("/src/assets/images/chat_wallpaper_light_1795347733045.jpg")' }
              : undefined
          }
        >
          {messages.map((msg) => {
            const isMine = msg.senderId === currentUid;
            const isReadByPeer = msg.readBy.length > 1;
            const timeStr = new Date(msg.createdAt).toLocaleTimeString(
              language === 'ar' ? 'ar-EG' : 'en-US',
              { hour: '2-digit', minute: '2-digit' }
            );

            if (msg.type === 'call') {
              return (
                <div key={msg.id} className="flex justify-center my-2">
                  <div className="px-4 py-1.5 rounded-xl bg-white/90 dark:bg-[#16202D]/90 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2 shadow-xs">
                    <Phone className="w-3.5 h-3.5 text-[#00B87C]" />
                    <span>{msg.text}</span>
                    <span aria-hidden="true">·</span>
                    <time className="tabular-nums text-slate-400">{timeStr}</time>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-end gap-1.5 max-w-[85%] sm:max-w-[70%]">
                  {!isMine && (
                    <button
                      type="button"
                      onClick={() => setReplyTo(msg)}
                      aria-label={t.replyingTo}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity"
                    >
                      <Reply className="w-4 h-4" />
                    </button>
                  )}

                  <div
                    className={`rounded-2xl px-3.5 py-2.5 shadow-xs ${
                      isMine
                        ? 'bg-[#007AFF] text-white rounded-ee-sm'
                        : 'bg-white dark:bg-[#16202D] text-slate-900 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800 rounded-es-sm'
                    }`}
                  >
                    {isGroup && !isMine && (
                      <div className="text-[11px] font-semibold text-[#007AFF] dark:text-sky-400 mb-1">
                        {msg.senderName}
                      </div>
                    )}

                    {msg.replyToPreview && (
                      <div
                        className={`mb-2 px-2.5 py-1.5 rounded-lg text-xs truncate ${
                          isMine
                            ? 'bg-white/15 text-white/90'
                            : 'bg-slate-100 dark:bg-[#1D2A3B] text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {msg.replyToPreview}
                      </div>
                    )}

                    {msg.type === 'image' && msg.mediaUrl && (
                      <button
                        type="button"
                        onClick={() => setLightboxImage(msg.mediaUrl)}
                        className="block mb-1.5 overflow-hidden rounded-xl focus:outline-none"
                      >
                        <img
                          src={msg.mediaUrl}
                          alt={msg.fileName || t.imageLabel}
                          referrerPolicy="no-referrer"
                          className="max-h-72 w-auto object-cover rounded-xl"
                        />
                      </button>
                    )}

                    {msg.type === 'audio' && msg.mediaUrl && (
                      <VoicePlayer src={msg.mediaUrl} durationSec={msg.audioDurationSec} isMine={isMine} />
                    )}

                    {msg.type === 'file' && msg.mediaUrl && (
                      <a
                        href={msg.mediaUrl}
                        download={msg.fileName || 'file'}
                        className={`flex items-center gap-3 p-2.5 rounded-xl transition-colors ${
                          isMine
                            ? 'bg-white/15 hover:bg-white/25 text-white'
                            : 'bg-slate-100 dark:bg-[#1D2A3B] hover:bg-slate-200 dark:hover:bg-[#25354A] text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        <FileText className="w-7 h-7 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold truncate">{msg.fileName}</div>
                          <div className={`text-[11px] tabular-nums ${isMine ? 'text-white/80' : 'text-slate-500'}`}>
                            {formatBytes(msg.fileSize)}
                          </div>
                        </div>
                        <Download className="w-4 h-4 shrink-0" />
                      </a>
                    )}

                    {msg.text && (
                      <p className="text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                        {msg.text}
                      </p>
                    )}

                    <div
                      className={`mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums ${
                        isMine ? 'text-white/80' : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      <time>{timeStr}</time>
                      {isMine &&
                        (isReadByPeer ? (
                          <CheckCheck className="w-3.5 h-3.5 text-sky-200" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        ))}
                    </div>
                  </div>

                  {isMine && (
                    <button
                      type="button"
                      onClick={() => setReplyTo(msg)}
                      aria-label={t.replyingTo}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity"
                    >
                      <Reply className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Reply / Error / Upload Status Strip */}
        {(replyTo || uploadError || uploading) && (
          <div className="px-4 py-2 bg-white dark:bg-[#111822] border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 text-xs">
            {uploadError ? (
              <span className="text-rose-600 dark:text-rose-400 font-medium">{uploadError}</span>
            ) : uploading ? (
              <span className="text-[#007AFF] font-medium">{t.uploading}</span>
            ) : replyTo ? (
              <div className="min-w-0 flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <Reply className="w-4 h-4 text-[#007AFF] shrink-0" />
                <span className="font-semibold shrink-0">{t.replyingTo}:</span>
                <span className="truncate">{replyTo.text || replyTo.fileName || replyTo.type}</span>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setReplyTo(null);
                setUploadError(null);
              }}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Composer Bar */}
        <div className="px-3 sm:px-4 py-2.5 pb-safe bg-white dark:bg-[#111822] border-t border-slate-200 dark:border-slate-800 relative shrink-0">
          {showEmoji && (
            <div className="absolute bottom-full mb-2 start-3 bg-white dark:bg-[#192330] border border-slate-200 dark:border-slate-700 rounded-2xl p-2.5 shadow-lg flex flex-wrap gap-1.5 max-w-[260px] z-20">
              {QUICK_EMOJIS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    handleTextChange(draft + em);
                    setShowEmoji(false);
                  }}
                  className="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 text-lg flex items-center justify-center"
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          {showAttachMenu && (
            <div className="absolute bottom-full mb-2 start-12 bg-white dark:bg-[#192330] border border-slate-200 dark:border-slate-700 rounded-2xl p-2 shadow-lg flex flex-col gap-1 min-w-[180px] z-20">
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="min-h-[44px] px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium text-slate-800 dark:text-slate-100 flex items-center gap-2.5"
              >
                <ImageIcon className="w-4 h-4 text-[#007AFF]" />
                <span>{t.attachPhoto}</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[44px] px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium text-slate-800 dark:text-slate-100 flex items-center gap-2.5"
              >
                <FileText className="w-4 h-4 text-[#00B87C]" />
                <span>{t.attachFile}</span>
              </button>
            </div>
          )}

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUploadSelectedFile(f, 'image');
              e.target.value = '';
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUploadSelectedFile(f, 'file');
              e.target.value = '';
            }}
          />

          {recording ? (
            <div className="flex items-center justify-between gap-3 min-h-[48px] px-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900">
              <div className="flex items-center gap-2.5 text-rose-600 dark:text-rose-400">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-600 animate-pulse" />
                <span className="text-sm font-semibold">{t.recording}</span>
                <span className="font-mono text-sm tabular-nums">{formatDuration(recordSeconds)}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancelVoiceRecording}
                  className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  onClick={stopAndSendVoice}
                  className="min-h-[40px] px-4 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>{t.stopAndSend}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowEmoji((v) => !v);
                  setShowAttachMenu(false);
                }}
                aria-label="Emoji"
                className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              >
                <Smile className="w-5 h-5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowAttachMenu((v) => !v);
                  setShowEmoji(false);
                }}
                aria-label={t.attachFile}
                className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              >
                <Paperclip className="w-5 h-5" />
              </button>

              <textarea
                rows={1}
                value={draft}
                onChange={(e) => handleTextChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t.typeMessage}
                className="flex-1 min-h-[44px] max-h-32 px-4 py-2.5 rounded-2xl bg-slate-100 dark:bg-[#192330] text-sm sm:text-[15px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40 resize-none"
              />

              {draft.trim().length > 0 ? (
                <button
                  type="button"
                  onClick={() => void handleSendText()}
                  aria-label={t.send}
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <Send className="w-5 h-5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startVoiceRecording()}
                  aria-label={t.recordVoice}
                  title={t.recordVoice}
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <Mic className="w-5 h-5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Chat Details Side Drawer */}
      {showInfo && (
        <aside className="w-72 border-s border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111822] p-5 overflow-y-auto shrink-0 hidden md:block">
          <div className="flex items-center justify-between mb-6">
            <h4 className="font-display font-bold text-sm text-slate-900 dark:text-white">
              {t.chatInfo}
            </h4>
            <button
              type="button"
              onClick={() => setShowInfo(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-col items-center text-center space-y-2 pb-5 border-b border-slate-100 dark:border-slate-800">
            <Avatar name={headerTitle} photoURL={peer?.photoURL} isGroup={isGroup} isOnline={isPeerOnline} size="xl" />
            <div className="font-display font-bold text-base text-slate-900 dark:text-white pt-1">
              {headerTitle}
            </div>
            {!isGroup && peer?.bio && (
              <p className="text-xs text-slate-500 dark:text-slate-400">{peer.bio}</p>
            )}
          </div>

          <div className="pt-5 space-y-3">
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              {t.membersLabel} ({chat.memberIds.length})
            </div>
            <div className="space-y-2">
              {chat.memberIds.map((uid) => {
                const m = contactsMap[uid];
                const label = uid === currentUid ? `${m?.displayName || currentDisplayName} (${t.you})` : m?.displayName || uid.slice(0, 8);
                return (
                  <div key={uid} className="flex items-center gap-2.5 py-1">
                    <Avatar name={label} photoURL={m?.photoURL} isOnline={onlineUids.includes(uid)} size="sm" />
                    <span className="text-sm text-slate-800 dark:text-slate-200 truncate">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      )}

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <button
            type="button"
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 end-4 min-h-[44px] min-w-[44px] rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightboxImage}
            alt="Preview"
            referrerPolicy="no-referrer"
            className="max-h-[85dvh] max-w-full rounded-2xl object-contain"
          />
        </div>
      )}
    </div>
  );
}
