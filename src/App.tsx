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
import { RuntimePermissionsModal } from './components/RuntimePermissionsModal';
import { SettingsPane } from './components/SettingsPane';
import { useRealtimeSignaling } from './hooks/useRealtimeSignaling';
import { getCopy } from './i18n/translations';
import {
  createGroupChat,
  fetchUserProfileByUid,
  getOrCreateDirectChat,
  markMessagesAsRead,
  saveUserContact,
  subscribeCalls,
  subscribeChats,
  subscribeMessages,
  subscribeMyContacts,
  subscribeMyPrivateInfo,
  subscribeMyProfile,
  syncUserProfile,
  updateUserProfile,
} from './lib/chatService';
import { E2eeKeyPairData, getOrCreateMyE2eeKeys } from './lib/e2ee';
import { auth, googleProvider } from './lib/firebase';
import { AppPermissionsState, queryAppPermissions } from './lib/permissions';
import {
  CallRecord,
  CallType,
  Chat,
  ChatMessage,
  Language,
  NavTab,
  ThemeMode,
  UserContact,
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
  const [myE2eeKeys, setMyE2eeKeys] = useState<E2eeKeyPairData | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('chats');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [myProfile, setMyProfile] = useState<UserPublic | null>(null);
  const [myContacts, setMyContacts] = useState<UserContact[]>([]);
  const [peerProfilesMap, setPeerProfilesMap] = useState<Record<string, UserPublic>>({});
  const [privateInfo, setPrivateInfo] = useState<UserPrivate | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);

  const [newChatModal, setNewChatModal] = useState<{ open: boolean; mode: 'direct' | 'group' }>({
    open: false,
    mode: 'direct',
  });
  const [permissions, setPermissions] = useState<AppPermissionsState>({
    microphone: 'prompt',
    camera: 'prompt',
    notifications: 'prompt',
  });
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const t = getCopy(language);

  useEffect(() => {
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
    localStorage.setItem('marhaba_lang', language);
  }, [language]);

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

  // Auth listener with full state reset per user
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      // Immediately clear previous user's state on any auth transition
      setChats([]);
      setMessages([]);
      setCalls([]);
      setMyProfile(null);
      setMyContacts([]);
      setPeerProfilesMap({});
      setPrivateInfo(null);
      setActiveChatId(null);
      setMyE2eeKeys(null);

      setUser(nextUser);
      setAuthReady(true);

      if (nextUser) {
        const keys = await getOrCreateMyE2eeKeys(nextUser.uid);
        setMyE2eeKeys(keys);
        await syncUserProfile(nextUser, language, keys).catch(() => undefined);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe ONLY to the signed-in user's own profile, private info, saved contacts, chats, and calls
  useEffect(() => {
    if (!authReady || !user) return;
    const unsubProfile = subscribeMyProfile(user.uid, setMyProfile);
    const unsubContacts = subscribeMyContacts(user.uid, setMyContacts);
    const unsubChats = subscribeChats(user.uid, setChats);
    const unsubCalls = subscribeCalls(user.uid, setCalls);
    const unsubPrivate = subscribeMyPrivateInfo(user.uid, setPrivateInfo);

    return () => {
      unsubProfile();
      unsubContacts();
      unsubChats();
      unsubCalls();
      unsubPrivate();
    };
  }, [authReady, user]);

  // Query runtime permissions once signed in and prompt inside the app if not yet granted/dismissed
  useEffect(() => {
    if (!authReady || !user) return;
    let cancelled = false;
    void queryAppPermissions().then((state) => {
      if (cancelled) return;
      setPermissions(state);
      const alreadyPrompted = localStorage.getItem('marhaba_perms_prompted_v1') === '1';
      const needsAny =
        state.microphone === 'prompt' ||
        state.camera === 'prompt' ||
        state.notifications === 'prompt';
      if (!alreadyPrompted && needsAny) {
        setShowPermissionsModal(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, user]);

  // Hydrate public profiles ONLY for peers in your active chats, calls, or saved contacts
  useEffect(() => {
    if (!user) return;
    const neededUids = new Set<string>();
    for (const c of chats) {
      for (const id of c.memberIds) {
        if (id !== user.uid) neededUids.add(id);
      }
    }
    for (const c of myContacts) {
      if (c.uid !== user.uid) neededUids.add(c.uid);
    }
    for (const call of calls) {
      for (const id of call.participantIds) {
        if (id !== user.uid) neededUids.add(id);
      }
    }

    const missing = Array.from(neededUids).filter((uid) => !peerProfilesMap[uid]);
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(missing.map((uid) => fetchUserProfileByUid(uid))).then((results) => {
      if (cancelled) return;
      const updates: Record<string, UserPublic> = {};
      for (const p of results) {
        if (p) updates[p.uid] = p;
      }
      if (Object.keys(updates).length > 0) {
        setPeerProfilesMap((prev) => ({ ...prev, ...updates }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [calls, chats, myContacts, peerProfilesMap, user]);

  const activeDirectPeerUid = useMemo(() => {
    if (!user || !activeChatId) return null;
    const currentChat = chats.find((c) => c.id === activeChatId);
    if (!currentChat || currentChat.type !== 'direct') return null;
    return currentChat.memberIds.find((id) => id !== user.uid) || null;
  }, [activeChatId, chats, user]);

  // Refresh direct peer's public E2EE keys when opening a chat
  useEffect(() => {
    if (!activeDirectPeerUid) return;
    let cancelled = false;
    void fetchUserProfileByUid(activeDirectPeerUid).then((freshPeer) => {
      if (!cancelled && freshPeer) {
        setPeerProfilesMap((prev) => ({ ...prev, [freshPeer.uid]: freshPeer }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, activeDirectPeerUid]);

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

  const combinedProfilesMap = useMemo(() => {
    const map: Record<string, UserPublic> = { ...peerProfilesMap };
    if (myProfile) {
      map[myProfile.uid] = myProfile;
    }
    return map;
  }, [myProfile, peerProfilesMap]);

  const currentDisplayName =
    myProfile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'User';

  const {
    onlineUids,
    typingByChat,
    activeCall,
    localStream,
    remoteStream,
    relayVideoFrame,
    isMuted,
    isCameraOff,
    emitTyping,
    startCall,
    acceptIncomingCall,
    declineOrEndCall,
    toggleMute,
    toggleCamera,
    unlockPlaybackAudio,
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

  const handleOpenDirectChat = async (peer: {
    uid: string;
    displayName: string;
    photoURL: string;
    bio: string;
  }) => {
    if (!user) return;
    const fullPeer = peerProfilesMap[peer.uid] || (await fetchUserProfileByUid(peer.uid));
    if (fullPeer) {
      setPeerProfilesMap((prev) => ({ ...prev, [fullPeer.uid]: fullPeer }));
      await saveUserContact(user.uid, fullPeer).catch(() => undefined);
    }
    const chatId = await getOrCreateDirectChat(user.uid, peer.uid);
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
            contactsMap={combinedProfilesMap}
            onlineUids={onlineUids}
            typingByChat={typingByChat}
            activeChatId={activeChatId}
            onSelectChat={(id) => setActiveChatId(id)}
            onStartDirectChatWithUser={(peer) => void handleOpenDirectChat(peer)}
            onOpenNewChat={() => setNewChatModal({ open: true, mode: 'direct' })}
          />
        )}

        {activeTab === 'calls' && (
          <CallsPane
            language={language}
            currentUid={user.uid}
            calls={calls}
            contactsMap={combinedProfilesMap}
            onlineUids={onlineUids}
            onCallBack={(callType, peer) => void handleStartCallWithPeer(callType, peer)}
          />
        )}

        {activeTab === 'contacts' && (
          <ContactsPane
            language={language}
            currentUid={user.uid}
            myContacts={myContacts}
            peerProfilesMap={peerProfilesMap}
            onlineUids={onlineUids}
            onStartDirectChat={(peer) => void handleOpenDirectChat(peer)}
            onAddContactOnly={(peer) => {
              setPeerProfilesMap((prev) => ({ ...prev, [peer.uid]: peer }));
              void saveUserContact(user.uid, peer).catch(() => undefined);
            }}
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
            permissions={permissions}
            onUpdatePermissions={setPermissions}
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
          myE2eeKeys={myE2eeKeys}
          getIdToken={() => user.getIdToken()}
          chat={activeChat}
          messages={messages}
          contactsMap={combinedProfilesMap}
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

      {/* Mobile Fixed Bottom Navigation Bar */}
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
        myContacts={myContacts}
        onlineUids={onlineUids}
        onClose={() => setNewChatModal((prev) => ({ ...prev, open: false }))}
        onCreateDirect={(peer) => void handleOpenDirectChat(peer)}
        onCreateGroup={(name, memberUids) => void handleCreateGroup(name, memberUids)}
      />

      {/* Audio / Video Call Overlay */}
      <CallOverlay
        language={language}
        call={activeCall}
        localStream={localStream}
        remoteStream={remoteStream}
        relayVideoFrame={relayVideoFrame}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        onAccept={() => void acceptIncomingCall()}
        onDeclineOrEnd={() => {
          const targetChat = chats.find((c) => c.id === activeCall?.chatId);
          void declineOrEndCall(targetChat?.memberIds);
        }}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onUnlockAudio={unlockPlaybackAudio}
      />

      {/* Runtime Permissions Prompt Modal */}
      <RuntimePermissionsModal
        language={language}
        isOpen={showPermissionsModal}
        permissions={permissions}
        onUpdatePermissions={setPermissions}
        onClose={() => {
          localStorage.setItem('marhaba_perms_prompted_v1', '1');
          setShowPermissionsModal(false);
        }}
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
