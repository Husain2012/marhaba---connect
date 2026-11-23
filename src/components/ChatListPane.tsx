import { FileText, Image as ImageIcon, Lock, Mic, Phone, Plus, Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { searchDiscoverableUsers } from '../lib/chatService';
import { Chat, ChatFilter, Language, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';

interface ChatListPaneProps {
  language: Language;
  currentUid: string;
  chats: Chat[];
  contactsMap: Record<string, UserPublic>;
  onlineUids: string[];
  typingByChat: Record<string, Record<string, number>>;
  activeChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onStartDirectChatWithUser: (peer: UserPublic) => void;
  onOpenNewChat: () => void;
}

function formatChatTime(ms: number, lang: Language): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function ChatListPane({
  language,
  currentUid,
  chats,
  contactsMap,
  onlineUids,
  typingByChat,
  activeChatId,
  onSelectChat,
  onStartDirectChatWithUser,
  onOpenNewChat,
}: ChatListPaneProps) {
  const t = getCopy(language);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
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

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chats.filter((chat) => {
      if (filter === 'groups' && chat.type !== 'group') return false;
      if (filter === 'unread' && chat.lastMessageSenderId === currentUid) return false;

      const peerUid = chat.memberIds.find((id) => id !== currentUid) || currentUid;
      const peer = contactsMap[peerUid];
      const title = chat.type === 'group' ? chat.name : peer?.displayName || chat.name || t.newChat;

      if (!q) return true;
      return (
        title.toLowerCase().includes(q) ||
        chat.lastMessageText.toLowerCase().includes(q)
      );
    });
  }, [chats, contactsMap, currentUid, filter, search, t.newChat]);

  const existingPeerUids = useMemo(() => {
    const set = new Set<string>();
    for (const c of chats) {
      if (c.type === 'direct') {
        for (const id of c.memberIds) {
          if (id !== currentUid) set.add(id);
        }
      }
    }
    return set;
  }, [chats, currentUid]);

  const discoverMatches = useMemo(
    () => searchResults.filter((u) => !existingPeerUids.has(u.uid)),
    [existingPeerUids, searchResults]
  );

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#111822]">
      <div className="px-4 pt-4 pb-3 border-b border-slate-200/80 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white truncate">
            {t.tabs.chats}
          </h2>
          <button
            type="button"
            onClick={onOpenNewChat}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t.newChat}</span>
          </button>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchChats}
            className="w-full min-h-[44px] ps-10 pe-4 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
          />
        </div>

        <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-[#192330] rounded-xl">
          {(['all', 'unread', 'groups'] as ChatFilter[]).map((key) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`min-h-[36px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap truncate ${
                  active
                    ? 'bg-white dark:bg-[#223042] text-[#007AFF] dark:text-sky-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {t.filters[key]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
        {filteredChats.length === 0 && search.trim().length < 2 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {t.noChatsList}
            </p>
            <button
              type="button"
              onClick={onOpenNewChat}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-[#007AFF] hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {t.startChat}
            </button>
          </div>
        ) : (
          filteredChats.map((chat) => {
            const isGroup = chat.type === 'group';
            const peerUid = chat.memberIds.find((id) => id !== currentUid) || currentUid;
            const peer = contactsMap[peerUid];
            const title = isGroup ? chat.name || t.groupChat : peer?.displayName || t.newChat;
            const isOnline = !isGroup && onlineUids.includes(peerUid);
            const isSelected = activeChatId === chat.id;
            const typingSenders = Object.keys(typingByChat[chat.id] || {}).filter((id) => id !== currentUid);

            const previewLabel =
              chat.lastMessageText === '🔒'
                ? t.e2eeEncryptedPreview
                : chat.lastMessageText || (isGroup ? `${chat.memberIds.length} ${t.membersLabel}` : t.startChat);

            return (
              <button
                key={chat.id}
                type="button"
                onClick={() => onSelectChat(chat.id)}
                className={`w-full px-4 py-3.5 min-h-[68px] flex items-center gap-3.5 text-start transition-colors ${
                  isSelected
                    ? 'bg-[#EBF4FF] dark:bg-[#192A3E]'
                    : 'hover:bg-slate-50 dark:hover:bg-[#16202D]'
                }`}
              >
                <Avatar
                  name={title}
                  photoURL={peer?.photoURL}
                  isGroup={isGroup}
                  isOnline={isOnline}
                  size="md"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-sm text-slate-900 dark:text-white truncate flex items-center gap-1.5">
                      {isGroup && <Users className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                      <span className="truncate">{title}</span>
                    </span>
                    <time className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums shrink-0">
                      {formatChatTime(chat.lastMessageAt, language)}
                    </time>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                    {typingSenders.length > 0 ? (
                      <span className="text-[#00B87C] font-medium truncate">{t.typing}</span>
                    ) : (
                      <>
                        {chat.lastMessageText === '🔒' && <Lock className="w-3 h-3 text-[#00B87C] shrink-0" />}
                        {chat.lastMessageType === 'audio' && <Mic className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'image' && <ImageIcon className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'file' && <FileText className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'call' && <Phone className="w-3.5 h-3.5 text-[#00B87C] shrink-0" />}
                        <span className="truncate">{previewLabel}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}

        {/* Search results for new conversations when typing >= 2 chars */}
        {search.trim().length >= 2 && (
          <div className="bg-slate-50/70 dark:bg-[#0E151E]">
            <div className="px-4 py-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              {searching ? t.searching : t.searchResultsTitle}
            </div>
            {!searching && discoverMatches.length === 0 && filteredChats.length === 0 ? (
              <div className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
                {t.noSearchResults}
              </div>
            ) : (
              discoverMatches.map((peer) => (
                <button
                  key={peer.uid}
                  type="button"
                  onClick={() => {
                    setSearch('');
                    onStartDirectChatWithUser(peer);
                  }}
                  className="w-full px-4 py-3 min-h-[62px] flex items-center justify-between gap-3 hover:bg-slate-100 dark:hover:bg-[#16202D] text-start transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      name={peer.displayName}
                      photoURL={peer.photoURL}
                      isOnline={onlineUids.includes(peer.uid)}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {peer.displayName}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                        {peer.connectCode}
                      </div>
                    </div>
                  </div>
                  <UserPlus className="w-4 h-4 text-[#007AFF] shrink-0" />
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
