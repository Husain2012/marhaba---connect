import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import { getCopy } from '../i18n/translations';
import { CallRecord, CallType, Language, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface CallsPaneProps {
  language: Language;
  currentUid: string;
  calls: CallRecord[];
  contactsMap: Record<string, UserPublic>;
  onlineUids: string[];
  onCallBack: (callType: CallType, peer: { uid: string; name: string; photo: string }) => void;
}

function formatDuration(sec: number): string {
  if (!sec) return '00:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallsPane({
  language,
  currentUid,
  calls,
  contactsMap,
  onlineUids,
  onCallBack,
}: CallsPaneProps) {
  const t = getCopy(language);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#111822]">
      <div className="px-4 py-4 border-b border-slate-200/80 dark:border-slate-800">
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          {t.tabs.calls}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
        {calls.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {t.noCalls}
          </div>
        ) : (
          calls.map((call) => {
            const isOutgoing = call.callerId === currentUid;
            const peerUid = isOutgoing ? call.calleeId : call.callerId;
            const peer = contactsMap[peerUid];
            const peerName = peer?.displayName || (isOutgoing ? call.calleeName : call.callerName);
            const isMissed = call.status === 'missed' || call.status === 'declined';
            const dateStr = new Date(call.createdAt).toLocaleString(
              language === 'ar' ? 'ar-EG' : 'en-US',
              { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
            );

            return (
              <div
                key={call.id}
                className="px-4 py-3.5 min-h-[68px] flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-[#16202D] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar
                    name={peerName}
                    photoURL={peer?.photoURL}
                    isOnline={onlineUids.includes(peerUid)}
                    size="md"
                  />
                  <div className="min-w-0">
                    <div className={`font-semibold text-sm truncate ${isMissed ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
                      {peerName}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {isMissed ? (
                        <PhoneMissed className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                      ) : isOutgoing ? (
                        <PhoneOutgoing className="w-3.5 h-3.5 text-[#00B87C] shrink-0" />
                      ) : (
                        <PhoneIncoming className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />
                      )}
                      <span>{t.callStatus[call.status]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatDuration(call.durationSec)}</span>
                      <span aria-hidden="true">·</span>
                      <time className="tabular-nums truncate">{dateStr}</time>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    onCallBack(call.callType, {
                      uid: peerUid,
                      name: peerName,
                      photo: peer?.photoURL || '',
                    })
                  }
                  aria-label={call.callType === 'video' ? t.videoCall : t.audioCall}
                  className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors shrink-0"
                >
                  {call.callType === 'video' ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
