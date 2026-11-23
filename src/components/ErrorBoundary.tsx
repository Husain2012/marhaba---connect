import React from 'react';
import { getCopy } from '../i18n/translations';
import { Language } from '../types/chat';

interface ErrorBoundaryProps {
  language: Language;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || 'Unknown error' };
  }

  render() {
    if (this.state.hasError) {
      const t = getCopy(this.props.language);
      return (
        <div className="min-h-dvh flex items-center justify-center bg-slate-50 dark:bg-[#0B1118] p-6">
          <div className="max-w-md w-full bg-white dark:bg-[#131C26] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 text-center shadow-sm">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">{t.errorTitle}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-5">{t.errorDesc}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl bg-[#007AFF] text-white text-sm font-semibold hover:bg-[#0066D6] transition-colors min-h-[44px]"
            >
              {t.reloadApp}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
