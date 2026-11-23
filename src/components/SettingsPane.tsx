import { Check, Copy, Globe, LogOut, Moon, Smartphone, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getCopy } from '../i18n/translations';
import { updateUserPrivatePhone, updateUserProfile } from '../lib/chatService';
import { Language, ThemeMode, UserPrivate, UserPublic } from '../types/chat';
import { Avatar } from './Avatar';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsPaneProps {
  language: Language;
  theme: ThemeMode;
  profile: UserPublic | null;
  privateInfo: UserPrivate | null;
  email: string;
  onChangeLanguage: (lang: Language) => void;
  onChangeTheme: (theme: ThemeMode) => void;
  onSignOut: () => void;
}

export function SettingsPane({
  language,
  theme,
  profile,
  privateInfo,
  email,
  onChangeLanguage,
  onChangeTheme,
  onSignOut,
}: SettingsPaneProps) {
  const t = getCopy(language);
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [bio, setBio] = useState(profile?.bio || '');
  const [phone, setPhone] = useState(privateInfo?.phone || '');
  const [discoverable, setDiscoverable] = useState(profile?.isDiscoverable ?? true);
  const [saving, setSaving] = useState(false);
  const [savedFlag, setSavedFlag] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName);
      setBio(profile.bio);
      setDiscoverable(profile.isDiscoverable);
    }
  }, [profile]);

  useEffect(() => {
    if (privateInfo) {
      setPhone(privateInfo.phone);
    }
  }, [privateInfo]);

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    setSavedFlag(false);
    try {
      await updateUserProfile(profile.uid, {
        displayName,
        bio,
        isDiscoverable: discoverable,
        language,
      });
      await updateUserPrivatePhone(profile.uid, email, phone);
      setSavedFlag(true);
      window.setTimeout(() => setSavedFlag(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleCopyConnectCode = () => {
    if (!profile?.connectCode) return;
    void navigator.clipboard.writeText(profile.connectCode);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#111822]">
      <div className="px-4 py-4 border-b border-slate-200/80 dark:border-slate-800">
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          {t.tabs.settings}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Profile Identity */}
        <section className="space-y-4">
          <div className="flex items-center gap-3.5">
            <Avatar
              name={profile?.displayName || email}
              photoURL={profile?.photoURL}
              isOnline={true}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="font-display font-bold text-base text-slate-900 dark:text-white truncate">
                {profile?.displayName || email}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{email}</div>
            </div>
          </div>

          {profile?.connectCode && (
            <div className="p-3 rounded-xl bg-slate-100 dark:bg-[#192330] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t.settings.connectId}
                </div>
                <div className="font-mono text-sm font-bold text-slate-900 dark:text-white">
                  {profile.connectCode}
                </div>
              </div>
              <button
                type="button"
                onClick={handleCopyConnectCode}
                className="min-h-[38px] px-3 rounded-lg bg-white dark:bg-[#223042] text-xs font-semibold text-[#007AFF] flex items-center gap-1.5 shadow-xs shrink-0"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCode ? t.settings.copied : t.settings.copyCode}</span>
              </button>
            </div>
          )}

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                {t.settings.displayName}
              </span>
              <input
                type="text"
                maxLength={80}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                {t.settings.bio}
              </span>
              <input
                type="text"
                maxLength={160}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                {t.settings.phone}
              </span>
              <input
                type="tel"
                maxLength={32}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+971 50 000 0000"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#192330] text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40"
              />
            </label>

            <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
              <span className="text-xs text-slate-700 dark:text-slate-300">
                {t.settings.discoverable}
              </span>
              <input
                type="checkbox"
                checked={discoverable}
                onChange={(e) => setDiscoverable(e.target.checked)}
                className="w-5 h-5 accent-[#007AFF] rounded"
              />
            </label>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
            >
              {savedFlag && <Check className="w-4 h-4" />}
              <span>{saving ? t.settings.saving : savedFlag ? t.settings.saved : t.settings.saveProfile}</span>
            </button>
          </div>
        </section>

        <hr className="border-slate-100 dark:border-slate-800" />

        {/* Language & Theme */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {t.settings.appearance}
          </h3>

          <div className="space-y-1.5">
            <span className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-[#007AFF]" />
              <span>{t.settings.languageLabel}</span>
            </span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-[#192330] rounded-xl">
              <button
                type="button"
                onClick={() => onChangeLanguage('ar')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold transition-colors ${
                  language === 'ar'
                    ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                العربية (RTL)
              </button>
              <button
                type="button"
                onClick={() => onChangeLanguage('en')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold transition-colors ${
                  language === 'en'
                    ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                English (LTR)
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-slate-600 dark:text-slate-400">
              {t.settings.themeLabel}
            </span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-[#192330] rounded-xl">
              <button
                type="button"
                onClick={() => onChangeTheme('light')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                  theme === 'light'
                    ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>{t.settings.lightMode}</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeTheme('dark')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                  theme === 'dark'
                    ? 'bg-white dark:bg-[#223042] text-[#007AFF] shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>{t.settings.darkMode}</span>
              </button>
            </div>
          </div>
        </section>

        <hr className="border-slate-100 dark:border-slate-800" />

        {/* Android Export Readiness */}
        <section className="p-4 rounded-2xl bg-slate-50 dark:bg-[#16202D] border border-slate-200/80 dark:border-slate-800 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
            <Smartphone className="w-4 h-4 text-[#00B87C]" />
            <span>{t.settings.androidReady}</span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {t.settings.androidDesc}
          </p>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 pt-1">
            {t.settings.packageId}: com.marhabaconnect.app
          </div>
          <PWAInstallButton language={language} />
        </section>

        <button
          type="button"
          onClick={onSignOut}
          className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-rose-200 dark:border-rose-900/60 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>{t.settings.signOut}</span>
        </button>
      </div>
    </div>
  );
}
