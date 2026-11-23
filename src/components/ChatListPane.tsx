import { FileText, Image as ImageIcon, Mic, Phone, Plus, Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getCopy } from '../i18n/translations';
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
  onOpenNewChat,
}: ChatListPaneProps) {
  const t = getCopy(language);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');

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
        {filteredChats.length === 0 ? (
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
                        {chat.lastMessageType === 'audio' && <Mic className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'image' && <ImageIcon className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'file' && <FileText className="w-3.5 h-3.5 text-[#007AFF] shrink-0" />}
                        {chat.lastMessageType === 'call' && <Phone className="w-3.5 h-3.5 text-[#00B87C] shrink-0" />}
                        <span className="truncate">
                          {chat.lastMessageText || (isGroup ? `${chat.memberIds.length} ${t.membersLabel}` : t.startChat)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
