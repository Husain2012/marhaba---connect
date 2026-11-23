import { Bell, Camera, CheckCircle2, Mic, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { getCopy } from '../i18n/translations';
import {
  AppPermissionsState,
  PermissionGrantState,
  requestAllRuntimePermissions,
  requestCameraPermission,
  requestMicrophonePermission,
  requestNotificationPermission,
} from '../lib/permissions';
import { Language } from '../types/chat';

interface RuntimePermissionsModalProps {
  language: Language;
  isOpen: boolean;
  permissions: AppPermissionsState;
  onUpdatePermissions: (next: AppPermissionsState) => void;
  onClose: () => void;
}

export function RuntimePermissionsModal({
  language,
  isOpen,
  permissions,
  onUpdatePermissions,
  onClose,
}: RuntimePermissionsModalProps) {
  const t = getCopy(language);
  const [requesting, setRequesting] = useState(false);

  if (!isOpen) return null;

  const statusLabel = (state: PermissionGrantState) => {
    if (state === 'granted') return t.permissions.granted;
    if (state === 'denied') return t.permissions.denied;
    if (state === 'unsupported') return t.permissions.unsupported;
    return t.permissions.prompt;
  };

  const statusClass = (state: PermissionGrantState) => {
    if (state === 'granted') return 'bg-emerald-50 dark:bg-emerald-950/50 text-[#00B87C]';
    if (state === 'denied') return 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400';
    return 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
  };

  const handleRequestAll = async () => {
    setRequesting(true);
    try {
      const next = await requestAllRuntimePermissions();
      onUpdatePermissions(next);
      if (
        next.microphone === 'granted' &&
        next.camera === 'granted' &&
        (next.notifications === 'granted' || next.notifications === 'unsupported')
      ) {
        onClose();
      }
    } finally {
      setRequesting(false);
    }
  };

  const handleRequestOne = async (kind: 'microphone' | 'camera' | 'notifications') => {
    setRequesting(true);
    try {
      let state: PermissionGrantState = 'prompt';
      if (kind === 'microphone') state = await requestMicrophonePermission();
      else if (kind === 'camera') state = await requestCameraPermission();
      else state = await requestNotificationPermission();

      onUpdatePermissions({
        ...permissions,
        [kind]: state,
      });
    } finally {
      setRequesting(false);
    }
  };

  const hasDenied =
    permissions.microphone === 'denied' ||
    permissions.camera === 'denied' ||
    permissions.notifications === 'denied';

  const allGranted =
    permissions.microphone === 'granted' &&
    permissions.camera === 'granted' &&
    (permissions.notifications === 'granted' || permissions.notifications === 'unsupported');

  const items: Array<{
    key: 'microphone' | 'camera' | 'notifications';
    icon: typeof Mic;
    title: string;
    desc: string;
    state: PermissionGrantState;
  }> = [
    {
      key: 'microphone',
      icon: Mic,
      title: t.permissions.micTitle,
      desc: t.permissions.micDesc,
      state: permissions.microphone,
    },
    {
      key: 'camera',
      icon: Camera,
      title: t.permissions.camTitle,
      desc: t.permissions.camDesc,
      state: permissions.camera,
    },
    {
      key: 'notifications',
      icon: Bell,
      title: t.permissions.notifTitle,
      desc: t.permissions.notifDesc,
      state: permissions.notifications,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#111822] border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/50 text-[#007AFF] flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="font-display font-bold text-base text-slate-900 dark:text-white truncate">
              {t.permissions.modalTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.cancel}
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {t.permissions.modalDesc}
          </p>

          <div className="space-y-2.5">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.key}
                  className="p-3 rounded-xl bg-slate-50 dark:bg-[#16202D] border border-slate-200/70 dark:border-slate-800 flex items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-white dark:bg-[#1F2C3D] text-[#007AFF] flex items-center justify-center shrink-0 border border-slate-200/60 dark:border-slate-700">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {item.title}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 leading-snug">
                        {item.desc}
                      </div>
                    </div>
                  </div>

                  {item.state === 'prompt' ? (
                    <button
                      type="button"
                      disabled={requesting}
                      onClick={() => void handleRequestOne(item.key)}
                      className="min-h-[36px] px-3 rounded-lg bg-[#007AFF] hover:bg-[#0066D6] text-white text-xs font-semibold shrink-0 disabled:opacity-60"
                    >
                      {t.permissions.requestSingle}
                    </button>
                  ) : (
                    <span
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 shrink-0 ${statusClass(item.state)}`}
                    >
                      {item.state === 'granted' && <CheckCircle2 className="w-3.5 h-3.5" />}
                      <span>{statusLabel(item.state)}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {hasDenied && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
              {t.permissions.deniedHint}
            </div>
          )}

          <div className="flex items-center gap-2.5 pt-1">
            {!allGranted ? (
              <button
                type="button"
                disabled={requesting}
                onClick={() => void handleRequestAll()}
                className="flex-1 min-h-[44px] px-4 py-2.5 rounded-xl bg-[#007AFF] hover:bg-[#0066D6] text-white text-sm font-semibold transition-colors disabled:opacity-60"
              >
                {requesting ? t.permissions.requesting : t.permissions.allowAll}
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="flex-1 min-h-[44px] px-4 py-2.5 rounded-xl bg-[#00B87C] hover:bg-[#009F6B] text-white text-sm font-semibold transition-colors"
              >
                {t.permissions.done}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-[#192330] text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
            >
              {t.permissions.later}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
