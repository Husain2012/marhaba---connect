import { MessageSquare, Phone, Search, Users, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { CallType, Language, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface ContactsPaneProps {
  language: Language;
  currentUid: string;
  contacts: UserPublic[];
  onlineUids: string[];
  onStartDirectChat: (peerUid: string) => void;
  onStartGroupModal: () => void;
  onCallContact: (callType: CallType, peer: UserPublic) => void;
}

export function ContactsPane({
  language,
  currentUid,
  contacts,
  onlineUids,
  onStartDirectChat,
  onStartGroupModal,
  onCallContact,
}: ContactsPaneProps) {
  const t = getCopy(language);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (c.uid === currentUid) return false;
      if (!q) return true;
      return c.displayName.toLowerCase().includes(q) || c.bio.toLowerCase().includes(q);
    });
  }, [contacts, currentUid, search]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#111822]">
      <div className="px-4 pt-4 pb-3 border-b border-slate-200/80 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white truncate">
            {t.tabs.contacts}
          </h2>
          <button
            type="button"
            onClick={onStartGroupModal}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <Users className="w-4 h-4 text-[#007AFF]" />
            <span>{t.newGroup}</span>
          </button>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchContacts}
            className="w-full min-h-[44px] ps-10 pe-4 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {t.noContacts}
          </div>
        ) : (
          filtered.map((contact) => {
            const isOnline = onlineUids.includes(contact.uid);
            return (
              <div
                key={contact.uid}
                className="px-4 py-3.5 min-h-[68px] flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-[#16202D] transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onStartDirectChat(contact.uid)}
                  className="flex items-center gap-3 min-w-0 flex-1 text-start"
                >
                  <Avatar
                    name={contact.displayName}
                    photoURL={contact.photoURL}
                    isOnline={isOnline}
                    size="md"
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                      {contact.displayName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {isOnline ? t.online : contact.bio || t.offline}
                    </div>
                  </div>
                </button>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onStartDirectChat(contact.uid)}
                    aria-label={t.startChat}
                    className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCallContact('audio', contact)}
                    aria-label={t.audioCall}
                    className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <Phone className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCallContact('video', contact)}
                    aria-label={t.videoCall}
                    className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <Video className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
