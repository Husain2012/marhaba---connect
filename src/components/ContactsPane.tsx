import { MessageSquare, Phone, Search, UserPlus, Users, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { searchDiscoverableUsers } from '../lib/chatService';
import { CallType, Language, UserContact, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface ContactsPaneProps {
  language: Language;
  currentUid: string;
  myContacts: UserContact[];
  peerProfilesMap: Record<string, UserPublic>;
  onlineUids: string[];
  onStartDirectChat: (peer: { uid: string; displayName: string; photoURL: string; bio: string }) => void;
  onAddContactOnly: (peer: UserPublic) => void;
  onStartGroupModal: () => void;
  onCallContact: (callType: CallType, peer: { uid: string; displayName: string; photoURL: string }) => void;
}

export function ContactsPane({
  language,
  currentUid,
  myContacts,
  peerProfilesMap,
  onlineUids,
  onStartDirectChat,
  onAddContactOnly,
  onStartGroupModal,
  onCallContact,
}: ContactsPaneProps) {
  const t = getCopy(language);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<UserPublic[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchDiscoverableUsers(q, currentUid);
        if (!cancelled) {
          setSearchResults(found);
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentUid, search]);

  const savedUids = useMemo(() => new Set(myContacts.map((c) => c.uid)), [myContacts]);

  const filteredSaved = useMemo(() => {
    const q = search.trim().toLowerCase();
    return myContacts.filter((c) => {
      if (c.uid === currentUid) return false;
      if (!q) return true;
      return c.displayName.toLowerCase().includes(q) || c.bio.toLowerCase().includes(q);
    });
  }, [currentUid, myContacts, search]);

  const newSearchMatches = useMemo(
    () => searchResults.filter((u) => !savedUids.has(u.uid)),
    [savedUids, searchResults]
  );

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
        {filteredSaved.length === 0 && search.trim().length < 2 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {t.noContacts}
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
              {t.searchHint}
            </p>
          </div>
        ) : (
          filteredSaved.map((contact) => {
            const livePeer = peerProfilesMap[contact.uid];
            const displayName = livePeer?.displayName || contact.displayName;
            const photoURL = livePeer?.photoURL || contact.photoURL;
            const bio = livePeer?.bio || contact.bio;
            const isOnline = onlineUids.includes(contact.uid);

            return (
              <div
                key={contact.uid}
                className="px-4 py-3.5 min-h-[68px] flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-[#16202D] transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onStartDirectChat({ uid: contact.uid, displayName, photoURL, bio })}
                  className="flex items-center gap-3 min-w-0 flex-1 text-start"
                >
                  <Avatar name={displayName} photoURL={photoURL} isOnline={isOnline} size="md" />
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                      {displayName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {isOnline ? t.online : bio || t.offline}
                    </div>
                  </div>
                </button>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onStartDirectChat({ uid: contact.uid, displayName, photoURL, bio })}
                    aria-label={t.startChat}
                    className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCallContact('audio', { uid: contact.uid, displayName, photoURL })}
                    aria-label={t.audioCall}
                    className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-[#007AFF] hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <Phone className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCallContact('video', { uid: contact.uid, displayName, photoURL })}
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

        {search.trim().length >= 2 && (
          <div className="bg-slate-50/70 dark:bg-[#0E151E]">
            <div className="px-4 py-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              {searching ? t.searching : t.searchResultsTitle}
            </div>
            {!searching && newSearchMatches.length === 0 && filteredSaved.length === 0 ? (
              <div className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
                {t.noSearchResults}
              </div>
            ) : (
              newSearchMatches.map((user) => (
                <div
                  key={user.uid}
                  className="px-4 py-3 min-h-[64px] flex items-center justify-between gap-3 hover:bg-slate-100 dark:hover:bg-[#16202D] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onAddContactOnly(user);
                      onStartDirectChat(user);
                      setSearch('');
                    }}
                    className="flex items-center gap-3 min-w-0 flex-1 text-start"
                  >
                    <Avatar
                      name={user.displayName}
                      photoURL={user.photoURL}
                      isOnline={onlineUids.includes(user.uid)}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {user.displayName}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                        {user.connectCode}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onAddContactOnly(user);
                      setSearch('');
                    }}
                    aria-label={t.addContact}
                    title={t.addContact}
                    className="min-h-[44px] px-3 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span>{t.addContact}</span>
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
