import { Check, Search, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { searchDiscoverableUsers } from '../lib/chatService';
import { Language, UserContact, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface NewChatModalProps {
  language: Language;
  isOpen: boolean;
  initialMode: 'direct' | 'group';
  currentUid: string;
  myContacts: UserContact[];
  onlineUids: string[];
  onClose: () => void;
  onCreateDirect: (peer: { uid: string; displayName: string; photoURL: string; bio: string }) => void;
  onCreateGroup: (name: string, memberUids: string[]) => void;
}

export function NewChatModal({
  language,
  isOpen,
  initialMode,
  currentUid,
  myContacts,
  onlineUids,
  onClose,
  onCreateDirect,
  onCreateGroup,
}: NewChatModalProps) {
  const t = getCopy(language);
  const [mode, setMode] = useState<'direct' | 'group'>(initialMode);
  const [groupName, setGroupName] = useState('');
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<UserPublic[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setSearch('');
      setSearchResults([]);
    }
  }, [initialMode, isOpen]);

  useEffect(() => {
    const q = search.trim();
    if (!isOpen || q.length < 2) {
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
  }, [currentUid, isOpen, search]);

  const combinedList = useMemo(() => {
    const map = new Map<string, { uid: string; displayName: string; photoURL: string; bio: string; connectCode?: string }>();
    const q = search.trim().toLowerCase();
    for (const c of myContacts) {
      if (c.uid === currentUid) continue;
      if (!q || c.displayName.toLowerCase().includes(q) || c.bio.toLowerCase().includes(q)) {
        map.set(c.uid, c);
      }
    }
    for (const u of searchResults) {
      if (u.uid !== currentUid) {
        map.set(u.uid, u);
      }
    }
    return Array.from(map.values());
  }, [currentUid, myContacts, search, searchResults]);

  if (!isOpen) return null;

  const toggleMember = (uid: string) => {
    setSelectedUids((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const handleGroupSubmit = () => {
    if (!groupName.trim() || selectedUids.length === 0) return;
    onCreateGroup(groupName.trim(), selectedUids);
    setGroupName('');
    setSelectedUids([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-white dark:bg-[#131C26] border border-slate-200 dark:border-slate-800 rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-xl max-h-[85dvh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
            {mode === 'group' ? t.newGroup : t.newChat}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 border-b border-slate-100 dark:border-slate-800">
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-[#192330] rounded-xl">
            <button
              type="button"
              onClick={() => setMode('direct')}
              className={`min-h-[38px] rounded-lg text-xs font-semibold transition-colors ${
                mode === 'direct'
                  ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {t.newChat}
            </button>
            <button
              type="button"
              onClick={() => setMode('group')}
              className={`min-h-[38px] rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                mode === 'group'
                  ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>{t.newGroup}</span>
            </button>
          </div>

          {mode === 'group' && (
            <input
              type="text"
              maxLength={80}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t.groupNamePlaceholder}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
            />
          )}

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchContacts}
              className="w-full min-h-[44px] ps-10 pe-4 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
          {searching ? (
            <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {t.searching}
            </div>
          ) : combinedList.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {search.trim().length >= 2 ? t.noSearchResults : t.searchHint}
            </div>
          ) : (
            combinedList.map((contact) => {
              const selected = selectedUids.includes(contact.uid);
              return (
                <button
                  key={contact.uid}
                  type="button"
                  onClick={() => {
                    if (mode === 'direct') {
                      onCreateDirect(contact);
                      onClose();
                    } else {
                      toggleMember(contact.uid);
                    }
                  }}
                  className="w-full px-5 py-3 min-h-[60px] flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-[#16202D] text-start transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      name={contact.displayName}
                      photoURL={contact.photoURL}
                      isOnline={onlineUids.includes(contact.uid)}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {contact.displayName}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {contact.connectCode ? `${contact.connectCode} · ` : ''}
                        {contact.bio}
                      </div>
                    </div>
                  </div>
                  {mode === 'group' && (
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center border shrink-0 ${
                        selected
                          ? 'bg-[#007AFF] border-[#007AFF] text-white'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      {selected && <Check className="w-3.5 h-3.5" />}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {mode === 'group' && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {t.selectedCount}: {selectedUids.length}
            </span>
            <button
              type="button"
              onClick={handleGroupSubmit}
              disabled={!groupName.trim() || selectedUids.length === 0}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-sm font-semibold disabled:opacity-50 transition-colors"
            >
              {t.createGroup}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
