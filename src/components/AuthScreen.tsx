import { Globe, Moon, ShieldCheck, Sun } from 'lucide-react';
import { getCopy } from '../i18n/translations';
import { Language, ThemeMode } from '../types/chat';

interface AuthScreenProps {
  language: Language;
  theme: ThemeMode;
  loading: boolean;
  error: string | null;
  onToggleLanguage: () => void;
  onToggleTheme: () => void;
  onSignIn: () => void;
}

export function AuthScreen({
  language,
  theme,
  loading,
  error,
  onToggleLanguage,
  onToggleTheme,
  onSignIn,
}: AuthScreenProps) {
  const t = getCopy(language);

  return (
    <div className="min-h-dvh w-full bg-slate-50 dark:bg-[#0B1118] flex flex-col">
      <header className="w-full max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
        <div className="flex items-center gap-3 shrink-0">
          <img
            src="/src/assets/images/marhaba_brand_mark_1795347732132.jpg"
            alt={t.appName}
            referrerPolicy="no-referrer"
            className="w-9 h-9 rounded-xl object-cover shadow-sm"
          />
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
            {t.appName}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onToggleLanguage}
            className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C26] text-slate-700 dark:text-slate-200 text-sm font-medium flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Globe className="w-4 h-4 text-[#007AFF]" />
            <span>{language === 'ar' ? 'English' : 'العربية'}</span>
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? t.settings.lightMode : t.settings.darkMode}
            className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C26] text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div className="space-y-6">
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-slate-900 dark:text-white leading-tight [text-wrap:balance]">
              {t.signInTitle}
            </h1>
            <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
              {t.signInDesc}
            </p>

            {error && (
              <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-sm">
                {error}
              </div>
            )}

            <div className="pt-2">
              <button
                type="button"
                onClick={onSignIn}
                disabled={loading}
                className="min-h-[48px] px-7 py-3 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] active:scale-[0.99] text-white font-semibold text-base shadow-sm transition-all flex items-center justify-center gap-3 disabled:opacity-60 whitespace-nowrap"
              >
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27c3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10c5.35 0 9.25-3.67 9.25-9.09c0-1.15-.15-1.81-.15-1.81Z"
                  />
                </svg>
                <span>{loading ? t.signingIn : t.signInButton}</span>
              </button>
            </div>

            <div className="flex items-center gap-2.5 text-xs sm:text-sm text-slate-500 dark:text-slate-400 pt-2">
              <ShieldCheck className="w-4 h-4 text-[#00B87C] shrink-0" />
              <span>{t.authNotice}</span>
            </div>
          </div>

          <div className="bg-white dark:bg-[#131C26] border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm">
            <img
              src="/src/assets/images/connect_empty_state_1795347731500.jpg"
              alt={t.appSubtitle}
              referrerPolicy="no-referrer"
              className="w-full aspect-[4/3] object-cover rounded-2xl bg-slate-100 dark:bg-slate-900"
            />
          </div>
        </div>
      </main>
    </div>
  );
}
