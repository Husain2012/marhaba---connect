import { Users } from 'lucide-react';
import { useState } from 'react';

interface AvatarProps {
  name: string;
  photoURL?: string;
  isGroup?: boolean;
  isOnline?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZE_MAP = {
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-2xl',
};

const PALETTE = [
  'bg-sky-600',
  'bg-emerald-600',
  'bg-indigo-600',
  'bg-teal-600',
  'bg-blue-600',
  'bg-cyan-700',
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function getColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function Avatar({ name, photoURL, isGroup, isOnline, size = 'md' }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const sizeClass = SIZE_MAP[size];

  return (
    <div className="relative shrink-0 inline-flex">
      {photoURL && !imgError && !isGroup ? (
        <img
          src={photoURL}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={`${sizeClass} rounded-full object-cover bg-slate-200 dark:bg-slate-800`}
        />
      ) : (
        <div
          className={`${sizeClass} rounded-full ${
            isGroup ? 'bg-[#007AFF]' : getColorClass(name)
          } text-white font-semibold flex items-center justify-center select-none`}
        >
          {isGroup ? <Users className="w-5 h-5" /> : getInitials(name)}
        </div>
      )}
      {isOnline && !isGroup && (
        <span
          aria-label="Online"
          className="absolute bottom-0 end-0 w-3 h-3 rounded-full bg-[#00B87C] ring-2 ring-white dark:ring-[#131C26]"
        />
      )}
    </div>
  );
}
