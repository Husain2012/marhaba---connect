export type Language = 'ar' | 'en';
export type ThemeMode = 'light' | 'dark';
export type NavTab = 'chats' | 'calls' | 'contacts' | 'settings';
export type ChatFilter = 'all' | 'unread' | 'groups';
export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'call';
export type CallType = 'audio' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined';

export interface UserPublic {
  uid: string;
  displayName: string;
  photoURL: string;
  bio: string;
  isOnline: boolean;
  isDiscoverable: boolean;
  language: Language;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserPrivate {
  uid: string;
  email: string;
  phone: string;
  updatedAt: number;
}

export interface Chat {
  id: string;
  type: 'direct' | 'group';
  name: string;
  createdBy: string;
  memberIds: string[];
  lastMessageText: string;
  lastMessageType: MessageType;
  lastMessageSenderId: string;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  memberIds: string[];
  type: MessageType;
  text: string;
  mediaUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  audioDurationSec: number;
  replyToId: string;
  replyToPreview: string;
  readBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CallRecord {
  id: string;
  chatId: string;
  callerId: string;
  callerName: string;
  calleeId: string;
  calleeName: string;
  participantIds: string[];
  callType: CallType;
  status: CallStatus;
  durationSec: number;
  createdAt: number;
  updatedAt: number;
}

export interface ActiveCallSession {
  callId: string;
  chatId: string;
  peerUid: string;
  peerName: string;
  peerPhoto: string;
  callType: CallType;
  direction: 'outgoing' | 'incoming';
  status: 'ringing' | 'connecting' | 'active';
  startedAtMs?: number;
}
