import { Language, MessageType } from '../types/chat';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function syncWebPushSubscription(idToken: string, language: Language): Promise<boolean> {
  if (!isWebPushSupported() || Notification.permission !== 'granted' || !idToken) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const keyResp = await fetch('/api/push/vapid-public-key');
    if (!keyResp.ok) return false;
    const keyJson = (await keyResp.json()) as { publicKey?: string };
    const publicKey = (keyJson.publicKey || '').trim();
    if (!publicKey) return false;

    const expectedKeyBytes = urlBase64ToUint8Array(publicKey);
    let subscription = await registration.pushManager.getSubscription();

    if (subscription?.options?.applicationServerKey) {
      const existingBytes = new Uint8Array(subscription.options.applicationServerKey);
      if (!uint8ArraysEqual(existingBytes, expectedKeyBytes)) {
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKeyBytes.buffer as ArrayBuffer,
      });
    }

    const subJson = subscription.toJSON();
    const saveResp = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        subscription: subJson,
        lang: language,
      }),
    });
    return saveResp.ok;
  } catch {
    return false;
  }
}

export async function unsubscribeWebPush(idToken: string): Promise<void> {
  if (!isWebPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    const endpoint = subscription.endpoint;
    if (idToken && endpoint) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ endpoint }),
      }).catch(() => undefined);
    }
    await subscription.unsubscribe().catch(() => false);
  } catch {
    // Ignore unsubscribe errors on sign-out
  }
}

export async function sendBackgroundMessagePush(
  idToken: string,
  params: {
    chatId: string;
    recipientUids: string[];
    senderName: string;
    messageType: MessageType;
    previewText?: string;
    isEncrypted?: boolean;
  }
): Promise<void> {
  if (!idToken || !params.chatId || params.recipientUids.length === 0) return;
  try {
    await fetch('/api/push/notify-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      keepalive: true,
      body: JSON.stringify({
        chatId: params.chatId,
        recipientUids: params.recipientUids,
        senderName: params.senderName,
        messageType: params.messageType,
        previewText: params.isEncrypted ? '' : params.previewText || '',
        isEncrypted: Boolean(params.isEncrypted),
      }),
    });
  } catch {
    // Best-effort background push
  }
}
