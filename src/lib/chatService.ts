import { User } from 'firebase/auth';
import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  CallRecord,
  CallStatus,
  CallType,
  Chat,
  ChatMessage,
  Language,
  MessageType,
  UserPrivate,
  UserPublic,
} from '../types/chat';
import { db, handleFirestoreError, OperationType } from './firebase';

function toMillis(val: unknown): number {
  if (val instanceof Timestamp) {
    return val.toMillis();
  }
  if (typeof val === 'number') {
    return val;
  }
  return Date.now();
}

function sanitizeId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return clean.slice(0, 120) || 'id';
}

export function generateId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return sanitizeId(`${prefix}_${rand}`);
}

export function makeDirectChatId(uid1: string, uid2: string): string {
  const sorted = [sanitizeId(uid1).slice(0, 54), sanitizeId(uid2).slice(0, 54)].sort();
  return `direct_${sorted[0]}_${sorted[1]}`;
}

export async function syncUserProfile(user: User, language: Language): Promise<void> {
  const userRef = doc(db, 'users', user.uid);
  const privateRef = doc(db, 'users', user.uid, 'private', 'info');
  const displayName = (user.displayName || user.email?.split('@')[0] || 'User').trim().slice(0, 80);
  const photoURL = (user.photoURL || '').slice(0, 512);

  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        displayName,
        photoURL,
        bio: language === 'ar' ? 'متاح على مرحبا كونكت' : 'Available on Marhaba Connect',
        isOnline: true,
        isDiscoverable: true,
        language,
        lastSeen: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, {
        isOnline: true,
        lastSeen: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
  }

  try {
    const privSnap = await getDoc(privateRef);
    if (!privSnap.exists()) {
      await setDoc(privateRef, {
        uid: user.uid,
        email: (user.email || '').slice(0, 254),
        phone: '',
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/private/info`);
  }
}

export async function updateUserProfile(
  uid: string,
  updates: {
    displayName?: string;
    bio?: string;
    isOnline?: boolean;
    isDiscoverable?: boolean;
    language?: Language;
  }
): Promise<void> {
  const userRef = doc(db, 'users', uid);
  const payload: Record<string, unknown> = {
    lastSeen: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (updates.displayName !== undefined) {
    payload.displayName = updates.displayName.trim().slice(0, 80) || 'User';
  }
  if (updates.bio !== undefined) {
    payload.bio = updates.bio.trim().slice(0, 160);
  }
  if (updates.isOnline !== undefined) {
    payload.isOnline = updates.isOnline;
  }
  if (updates.isDiscoverable !== undefined) {
    payload.isDiscoverable = updates.isDiscoverable;
  }
  if (updates.language !== undefined) {
    payload.language = updates.language;
  }

  try {
    await updateDoc(userRef, payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function updateUserPrivatePhone(uid: string, email: string, phone: string): Promise<void> {
  const privateRef = doc(db, 'users', uid, 'private', 'info');
  try {
    await updateDoc(privateRef, {
      email: email.slice(0, 254),
      phone: phone.trim().slice(0, 32),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${uid}/private/info`);
  }
}

export function subscribeMyPrivateInfo(uid: string, onChange: (info: UserPrivate | null) => void): () => void {
  const path = `users/${uid}/private/info`;
  return onSnapshot(
    doc(db, 'users', uid, 'private', 'info'),
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }
      const d = snap.data();
      onChange({
        uid: String(d.uid || uid),
        email: String(d.email || ''),
        phone: String(d.phone || ''),
        updatedAt: toMillis(d.updatedAt),
      });
    },
    (err) => handleFirestoreError(err, OperationType.GET, path)
  );
}

export function subscribeContacts(onChange: (users: UserPublic[]) => void): () => void {
  const q = query(collection(db, 'users'), where('isDiscoverable', '==', true));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: UserPublic[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          uid: String(data.uid || d.id),
          displayName: String(data.displayName || 'User'),
          photoURL: String(data.photoURL || ''),
          bio: String(data.bio || ''),
          isOnline: Boolean(data.isOnline),
          isDiscoverable: Boolean(data.isDiscoverable),
          language: data.language === 'en' ? 'en' : 'ar',
          lastSeen: toMillis(data.lastSeen),
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        };
      });
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
      onChange(list);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'users')
  );
}

export function subscribeChats(uid: string, onChange: (chats: Chat[]) => void): () => void {
  const q = query(collection(db, 'chats'), where('memberIds', 'array-contains', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const chats: Chat[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          type: data.type === 'group' ? 'group' : 'direct',
          name: String(data.name || ''),
          createdBy: String(data.createdBy || ''),
          memberIds: Array.isArray(data.memberIds) ? data.memberIds.map(String) : [],
          lastMessageText: String(data.lastMessageText || ''),
          lastMessageType: (data.lastMessageType || 'text') as MessageType,
          lastMessageSenderId: String(data.lastMessageSenderId || ''),
          lastMessageAt: toMillis(data.lastMessageAt),
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        };
      });
      chats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      onChange(chats);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'chats')
  );
}

export function subscribeMessages(chatId: string, uid: string, onChange: (msgs: ChatMessage[]) => void): () => void {
  const q = query(collection(db, 'chats', chatId, 'messages'), where('memberIds', 'array-contains', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const messages: ChatMessage[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          chatId: String(data.chatId || chatId),
          senderId: String(data.senderId || ''),
          senderName: String(data.senderName || ''),
          memberIds: Array.isArray(data.memberIds) ? data.memberIds.map(String) : [],
          type: (data.type || 'text') as MessageType,
          text: String(data.text || ''),
          mediaUrl: String(data.mediaUrl || ''),
          fileName: String(data.fileName || ''),
          fileSize: Number(data.fileSize || 0),
          mimeType: String(data.mimeType || ''),
          audioDurationSec: Number(data.audioDurationSec || 0),
          replyToId: String(data.replyToId || ''),
          replyToPreview: String(data.replyToPreview || ''),
          readBy: Array.isArray(data.readBy) ? data.readBy.map(String) : [],
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        };
      });
      messages.sort((a, b) => a.createdAt - b.createdAt);
      onChange(messages);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, `chats/${chatId}/messages`)
  );
}

export function subscribeCalls(uid: string, onChange: (calls: CallRecord[]) => void): () => void {
  const q = query(collection(db, 'calls'), where('participantIds', 'array-contains', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const calls: CallRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          chatId: String(data.chatId || ''),
          callerId: String(data.callerId || ''),
          callerName: String(data.callerName || ''),
          calleeId: String(data.calleeId || ''),
          calleeName: String(data.calleeName || ''),
          participantIds: Array.isArray(data.participantIds) ? data.participantIds.map(String) : [],
          callType: data.callType === 'video' ? 'video' : 'audio',
          status: (data.status || 'ended') as CallStatus,
          durationSec: Number(data.durationSec || 0),
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        };
      });
      calls.sort((a, b) => b.createdAt - a.createdAt);
      onChange(calls);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'calls')
  );
}

export async function getOrCreateDirectChat(currentUid: string, peerUid: string): Promise<string> {
  const chatId = makeDirectChatId(currentUid, peerUid);
  const chatRef = doc(db, 'chats', chatId);
  try {
    const snap = await getDoc(chatRef);
    if (!snap.exists()) {
      const memberIds = currentUid === peerUid ? [currentUid] : [currentUid, peerUid];
      await setDoc(chatRef, {
        id: chatId,
        type: 'direct',
        name: '',
        createdBy: currentUid,
        memberIds,
        lastMessageText: '',
        lastMessageType: 'text',
        lastMessageSenderId: currentUid,
        lastMessageAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await Promise.all(
        memberIds.map((uid) =>
          setDoc(doc(db, 'chats', chatId, 'members', uid), {
            uid,
            role: uid === currentUid ? 'owner' : 'member',
            muted: false,
            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        )
      );
    }
    return chatId;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `chats/${chatId}`);
  }
}

export async function createGroupChat(currentUid: string, groupName: string, otherUids: string[]): Promise<string> {
  const chatId = generateId('grp');
  const uniqueMembers = Array.from(new Set([currentUid, ...otherUids])).slice(0, 50);
  const cleanName = groupName.trim().slice(0, 80) || 'Group';
  try {
    await setDoc(doc(db, 'chats', chatId), {
      id: chatId,
      type: 'group',
      name: cleanName,
      createdBy: currentUid,
      memberIds: uniqueMembers,
      lastMessageText: '',
      lastMessageType: 'text',
      lastMessageSenderId: currentUid,
      lastMessageAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await Promise.all(
      uniqueMembers.map((uid) =>
        setDoc(doc(db, 'chats', chatId, 'members', uid), {
          uid,
          role: uid === currentUid ? 'owner' : 'member',
          muted: false,
          joinedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      )
    );
    return chatId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `chats/${chatId}`);
  }
}

export async function sendChatMessage(
  chatId: string,
  senderId: string,
  senderName: string,
  memberIds: string[],
  payload: {
    type: MessageType;
    text?: string;
    mediaUrl?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    audioDurationSec?: number;
    replyToId?: string;
    replyToPreview?: string;
    previewLabel?: string;
  }
): Promise<void> {
  const messageId = generateId('msg');
  const cleanText = (payload.text || '').trim().slice(0, 4000);
  const cleanName = senderName.trim().slice(0, 80) || 'User';
  const boundedMembers = memberIds.slice(0, 50);
  const previewText = (payload.previewLabel || cleanText || payload.fileName || payload.type).slice(0, 500);

  try {
    await setDoc(doc(db, 'chats', chatId, 'messages', messageId), {
      id: messageId,
      chatId,
      senderId,
      senderName: cleanName,
      memberIds: boundedMembers,
      type: payload.type,
      text: cleanText,
      mediaUrl: (payload.mediaUrl || '').slice(0, 512),
      fileName: (payload.fileName || '').slice(0, 180),
      fileSize: Math.max(0, Math.min(26214400, Number(payload.fileSize || 0))),
      mimeType: (payload.mimeType || '').slice(0, 120),
      audioDurationSec: Math.max(0, Math.min(3600, Math.round(Number(payload.audioDurationSec || 0)))),
      replyToId: (payload.replyToId || '').slice(0, 128),
      replyToPreview: (payload.replyToPreview || '').slice(0, 160),
      readBy: [senderId],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'chats', chatId), {
      lastMessageText: previewText,
      lastMessageType: payload.type,
      lastMessageSenderId: senderId,
      lastMessageAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `chats/${chatId}/messages/${messageId}`);
  }
}

export async function markMessagesAsRead(chatId: string, messages: ChatMessage[], currentUid: string): Promise<void> {
  const unread = messages.filter((m) => m.senderId !== currentUid && !m.readBy.includes(currentUid));
  if (unread.length === 0) return;

  try {
    await Promise.all(
      unread.slice(-20).map((m) =>
        updateDoc(doc(db, 'chats', chatId, 'messages', m.id), {
          readBy: arrayUnion(currentUid),
          updatedAt: serverTimestamp(),
        })
      )
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `chats/${chatId}/messages`);
  }
}

export async function createCallRecord(params: {
  callId: string;
  chatId: string;
  callerId: string;
  callerName: string;
  calleeId: string;
  calleeName: string;
  callType: CallType;
}): Promise<void> {
  try {
    await setDoc(doc(db, 'calls', params.callId), {
      id: params.callId,
      chatId: params.chatId,
      callerId: params.callerId,
      callerName: params.callerName.slice(0, 80) || 'Caller',
      calleeId: params.calleeId,
      calleeName: params.calleeName.slice(0, 80) || 'User',
      participantIds: [params.callerId, params.calleeId],
      callType: params.callType,
      status: 'ringing',
      durationSec: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `calls/${params.callId}`);
  }
}

export async function updateCallStatus(callId: string, status: CallStatus, durationSec = 0): Promise<void> {
  try {
    await updateDoc(doc(db, 'calls', callId), {
      status,
      durationSec: Math.max(0, Math.min(86400, Math.round(durationSec))),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Call may already be in terminal state from peer
  }
}

export async function uploadMediaFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
  idToken: string
): Promise<{ mediaUrl: string; fileName: string; fileSize: number; mimeType: string }> {
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to encode file'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('File read error'));
    reader.readAsDataURL(blob);
  });

  const resp = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fileName, mimeType, base64Data }),
  });

  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || 'Upload failed');
  }

  return (await resp.json()) as {
    mediaUrl: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
}
