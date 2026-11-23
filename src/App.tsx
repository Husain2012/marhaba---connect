import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { Globe, MessageCircle, Moon, Phone, Settings, Sun, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { Avatar } from './components/Avatar';
import { CallOverlay } from './components/CallOverlay';
import { CallsPane } from './components/CallsPane';
import { ChatListPane } from './components/ChatListPane';
import { ChatThreadPane } from './components/ChatThreadPane';
import { ContactsPane } from './components/ContactsPane';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NewChatModal } from './components/NewChatModal';
import { SettingsPane } from './components/SettingsPane';
import { useRealtimeSignaling } from './hooks/useRealtimeSignaling';
import { getCopy } from './i18n/translations';
import {
  createGroupChat,
  getOrCreateDirectChat,
  markMessagesAsRead,
  subscribeCalls,
  subscribeChats,
  subscribeContacts,
  subscribeMessages,
  subscribeMyPrivateInfo,
  syncUserProfile,
  updateUserProfile,
} from './lib/chatService';
import { auth, googleProvider } from './lib/firebase';
import {
  CallRecord,
  CallType,
  Chat,
  ChatMessage,
  Language,
  NavTab,
  ThemeMode,
  UserPrivate,
  UserPublic,
} from './types/chat';

function MainApp() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('marhaba_lang');
    return saved === 'en' ? 'en' : 'ar';
  });
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('marhaba_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('chats');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<UserPublic[]>([]);
  const [privateInfo, setPrivateInfo] = useState<UserPrivate | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);

  const [newChatModal, setNewChatModal] = useState<{ open: boolean; mode: 'direct' | 'group' }>({
    open: false,
    mode: 'direct',
  });
  const [toast, setToast] = useState<string | null>(null);

  const t = getCopy(language);

  // Sync HTML direction & language
  useEffect(() => {
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
    localStorage.setItem('marhaba_lang', language);
  }, [language]);

  // Sync Tailwind dark class
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('marhaba_theme', theme);
  }, [theme]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => {
      setToast((prev) => (prev === message ? null : prev));
    }, 3500);
  }, []);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        await syncUserProfile(nextUser, language).catch(() => undefined);
      } else {
        setChats([]);
        setMessages([]);
        setCalls([]);
        setContacts([]);
        setPrivateInfo(null);
        setActiveChatId(null);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to Firestore collections once authenticated
  useEffect(() => {
    if (!authReady || !user) return;
    const unsubContacts = subscribeContacts(setContacts);
    const unsubChats = subscribeChats(user.uid, setChats);
    const unsubCalls = subscribeCalls(user.uid, setCalls);
    const unsubPrivate = subscribeMyPrivateInfo(user.uid, setPrivateInfo);

    return () => {
      unsubContacts();
      unsubChats();
      unsubCalls();
      unsubPrivate();
    };
  }, [authReady, user]);

  // Subscribe to messages for active chat
  useEffect(() => {
    if (!authReady || !user || !activeChatId) {
      setMessages([]);
      return;
    }
    const unsubMsgs = subscribeMessages(activeChatId, user.uid, (nextMsgs) => {
      setMessages(nextMsgs);
      void markMessagesAsRead(activeChatId, nextMsgs, user.uid).catch(() => undefined);
    });
    return () => unsubMsgs();
  }, [activeChatId, authReady, user]);

  const contactsMap = useMemo(() => {
    const map: Record<string, UserPublic> = {};
    for (const c of contacts) {
      map[c.uid] = c;
    }
    return map;
  }, [contacts]);

  const myProfile = user ? contactsMap[user.uid] || null : null;
  const currentDisplayName = myProfile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'User';

  const {
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
  } = useRealtimeSignaling({
    user,
    displayName: currentDisplayName,
    onMediaError: (kind) => showToast(kind === 'mic' ? t.micDenied : t.mediaDenied),
    onPeerOfflineNotice: () => showToast(t.peerOfflineNotice),
  });

  const handleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (user) {
      await updateUserProfile(user.uid, { isOnline: false }).catch(() => undefined);
    }
    await signOut(auth);
  };

  const handleOpenDirectChat = async (peerUid: string) => {
    if (!user) return;
    const chatId = await getOrCreateDirectChat(user.uid, peerUid);
    setActiveTab('chats');
    setActiveChatId(chatId);
  };

  const handleCreateGroup = async (name: string, memberUids: string[]) => {
    if (!user) return;
    const chatId = await createGroupChat(user.uid, name, memberUids);
    setActiveTab('chats');
    setActiveChatId(chatId);
  };

  const handleStartCallWithPeer = async (
    callType: CallType,
    peer: { uid: string; name: string; photo: string },
    existingChatId?: string
  ) => {
    if (!user) return;
    const chatId = existingChatId || (await getOrCreateDirectChat(user.uid, peer.uid));
    await startCall({
      chatId,
      peerUid: peer.uid,
      peerName: peer.name,
      peerPhoto: peer.photo,
      callType,
      memberIds: [user.uid, peer.uid],
    });
  };

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [activeChatId, chats]
  );

  const activeChatTypingSenders = useMemo(() => {
    if (!activeChatId || !user) return [];
    return Object.keys(typingByChat[activeChatId] || {}).filter((uid) => uid !== user.uid);
  }, [activeChatId, typingByChat, user]);

  if (!authReady) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50 dark:bg-[#0B1118]">
        <img
          src="/src/assets/images/marhaba_brand_mark_1795347732132.jpg"
          alt={t.appName}
          referrerPolicy="no-referrer"
          className="w-14 h-14 rounded-2xl animate-pulse"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        language={language}
        theme={theme}
        loading={authLoading}
        error={authError}
        onToggleLanguage={() => setLanguage((l) => (l === 'ar' ? 'en' : 'ar'))}
        onToggleTheme={() => setTheme((th) => (th === 'dark' ? 'light' : 'dark'))}
        onSignIn={() => void handleSignIn()}
      />
    );
  }

  const navItems: Array<{ key: NavTab; label: string; icon: typeof MessageCircle }> = [
    { key: 'chats', label: t.tabs.chats, icon: MessageCircle },
    { key: 'calls', label: t.tabs.calls, icon: Phone },
    { key: 'contacts', label: t.tabs.contacts, icon: Users },
    { key: 'settings', label: t.tabs.settings, icon: Settings },
  ];

  const isMobileThreadOpen = Boolean(activeChatId && activeTab === 'chats');

  return (
    <div className="h-dvh w-full overflow-hidden flex flex-col lg:flex-row bg-slate-50 dark:bg-[#0B1118]">
      {/* Desktop Navigation Rail */}
      <nav
        aria-label="Primary navigation"
        className="hidden lg:flex flex-col items-center justify-between w-[72px] py-4 bg-slate-100 dark:bg-[#0E151E] border-e border-slate-200 dark:border-slate-800 shrink-0"
      >
        <div className="flex flex-col items-center gap-4">
          <img
            src="/src/assets/images/marhaba_brand_mark_1795347732132.jpg"
            alt={t.appName}
            referrerPolicy="no-referrer"
            className="w-10 h-10 rounded-xl object-cover shadow-xs"
          />

          <div className="flex flex-col items-center gap-1.5 pt-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  title={item.label}
                  aria-label={item.label}
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                    active
                      ? 'bg-[#007AFF] text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => setLanguage((l) => (l === 'ar' ? 'en' : 'ar'))}
            title={language === 'ar' ? 'English' : 'العربية'}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 text-xs font-bold"
          >
            <Globe className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setTheme((th) => (th === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? t.settings.lightMode : t.settings.darkMode}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            aria-label={t.tabs.settings}
            className="pt-1"
          >
            <Avatar
              name={currentDisplayName}
              photoURL={myProfile?.photoURL || user.photoURL || ''}
              isOnline={true}
              size="sm"
            />
          </button>
        </div>
      </nav>

      {/* Left/Sidebar Panel (List Views) */}
      <aside
        className={`w-full lg:w-[360px] xl:w-[390px] lg:border-e border-slate-200 dark:border-slate-800 flex-1 lg:flex-none h-full overflow-hidden ${
          isMobileThreadOpen ? 'hidden lg:block' : 'block pb-16 lg:pb-0'
        }`}
      >
        {activeTab === 'chats' && (
          <ChatListPane
            language={language}
            currentUid={user.uid}
            chats={chats}
            contactsMap={contactsMap}
            onlineUids={onlineUids}
            typingByChat={typingByChat}
            activeChatId={activeChatId}
            onSelectChat={(id) => setActiveChatId(id)}
            onOpenNewChat={() => setNewChatModal({ open: true, mode: 'direct' })}
          />
        )}

        {activeTab === 'calls' && (
          <CallsPane
            language={language}
            currentUid={user.uid}
            calls={calls}
            contactsMap={contactsMap}
            onlineUids={onlineUids}
            onCallBack={(callType, peer) => void handleStartCallWithPeer(callType, peer)}
          />
        )}

        {activeTab === 'contacts' && (
          <ContactsPane
            language={language}
            currentUid={user.uid}
            contacts={contacts}
            onlineUids={onlineUids}
            onStartDirectChat={(uid) => void handleOpenDirectChat(uid)}
            onStartGroupModal={() => setNewChatModal({ open: true, mode: 'group' })}
            onCallContact={(callType, peer) =>
              void handleStartCallWithPeer(callType, {
                uid: peer.uid,
                name: peer.displayName,
                photo: peer.photoURL,
              })
            }
          />
        )}

        {activeTab === 'settings' && (
          <SettingsPane
            language={language}
            theme={theme}
            profile={myProfile}
            privateInfo={privateInfo}
            email={user.email || ''}
            onChangeLanguage={(lang) => {
              setLanguage(lang);
              void updateUserProfile(user.uid, { language: lang }).catch(() => undefined);
            }}
            onChangeTheme={setTheme}
            onSignOut={() => void handleSignOut()}
          />
        )}
      </aside>

      {/* Main Active Chat Workspace */}
      <main
        className={`flex-1 h-full overflow-hidden ${
          isMobileThreadOpen ? 'flex' : 'hidden lg:flex'
        }`}
      >
        <ChatThreadPane
          language={language}
          theme={theme}
          currentUid={user.uid}
          currentDisplayName={currentDisplayName}
          getIdToken={() => user.getIdToken()}
          chat={activeChat}
          messages={messages}
          contactsMap={contactsMap}
          onlineUids={onlineUids}
          typingSenders={activeChatTypingSenders}
          onBack={() => setActiveChatId(null)}
          onTypingChange={(isTyping) => {
            if (activeChat) {
              emitTyping(activeChat.id, activeChat.memberIds, isTyping);
            }
          }}
          onStartCall={(callType, peer) =>
            void handleStartCallWithPeer(callType, peer, activeChat?.id)
          }
        />
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (4 tabs, 64px height) */}
      {!isMobileThreadOpen && (
        <nav
          aria-label="Mobile navigation"
          className="lg:hidden fixed bottom-0 start-0 end-0 z-30 h-16 pb-safe bg-white/95 dark:bg-[#111822]/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid grid-cols-4 items-center"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active
                    ? 'text-[#007AFF]'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[11px] font-medium whitespace-nowrap truncate max-w-full px-1">
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {/* New Direct / Group Chat Modal */}
      <NewChatModal
        language={language}
        isOpen={newChatModal.open}
        initialMode={newChatModal.mode}
        currentUid={user.uid}
        contacts={contacts}
        onlineUids={onlineUids}
        onClose={() => setNewChatModal((prev) => ({ ...prev, open: false }))}
        onCreateDirect={(peerUid) => void handleOpenDirectChat(peerUid)}
        onCreateGroup={(name, memberUids) => void handleCreateGroup(name, memberUids)}
      />

      {/* Audio / Video Call Overlay */}
      <CallOverlay
        language={language}
        call={activeCall}
        localStream={localStream}
        remoteStream={remoteStream}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        onAccept={() => void acceptIncomingCall()}
        onDeclineOrEnd={() => {
          const targetChat = chats.find((c) => c.id === activeCall?.chatId);
          void declineOrEndCall(targetChat?.memberIds);
        }}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
      />

      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-4 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold shadow-lg max-w-sm text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary language="ar">
      <MainApp />
    </ErrorBoundary>
  );
}
