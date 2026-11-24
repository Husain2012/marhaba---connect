import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { generateVAPIDKeys, sendNotification, setVapidDetails } from 'web-push';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const dataDir = path.resolve(process.cwd(), '.data');
const uploadsDir = path.resolve(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Load Firebase web config for ID token verification via Identity Toolkit
const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8')) as {
  apiKey: string;
  projectId: string;
};

interface FileMeta {
  fileName: string;
  mimeType: string;
  size: number;
}
const fileMetaMap = new Map<string, FileMeta>();

const SAFE_INLINE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
]);

async function verifyFirebaseIdToken(idToken: string): Promise<{ uid: string; email?: string; name?: string } | null> {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) {
    return null;
  }
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as {
      users?: Array<{ localId: string; email?: string; displayName?: string; emailVerified?: boolean }>;
    };
    const user = data.users?.[0];
    if (!user?.localId) {
      return null;
    }
    return { uid: user.localId, email: user.email, name: user.displayName };
  } catch {
    return null;
  }
}

app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'marhaba-connect' });
});

// Authenticated WebRTC ICE server configuration (STUN + optional TURN env vars)
app.get('/api/ice-servers', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = await verifyFirebaseIdToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ],
    },
  ];

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  let turnConfigured = false;
  if (turnUrls.length > 0 && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
    turnConfigured = true;
  }

  const meteredDomain = (process.env.METERED_DOMAIN || '').trim();
  const meteredApiKey = (process.env.METERED_API_KEY || '').trim();
  if (meteredDomain && meteredApiKey && /^[a-zA-Z0-9.-]+$/.test(meteredDomain)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const turnResp = await fetch(
        `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredApiKey)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (turnResp.ok) {
        const dynamicServers = (await turnResp.json()) as Array<{
          urls?: string | string[];
          username?: string;
          credential?: string;
        }>;
        if (Array.isArray(dynamicServers)) {
          for (const srv of dynamicServers) {
            if (srv?.urls) {
              iceServers.push({
                urls: srv.urls,
                ...(srv.username ? { username: srv.username } : {}),
                ...(srv.credential ? { credential: srv.credential } : {}),
              });
              if (srv.username && srv.credential) {
                turnConfigured = true;
              }
            }
          }
        }
      }
    } catch {
      // Continue with STUN + any static TURN configured
    }
  }

  res.json({ iceServers, turnConfigured });
});

// --- Web Push (VAPID) setup & subscription store ---
interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  lang: 'ar' | 'en';
  updatedAt: number;
}

const vapidFilePath = path.resolve(dataDir, 'vapid.json');
const pushSubsFilePath = path.resolve(dataDir, 'push-subscriptions.json');

function initVapidKeys(): { publicKey: string; privateKey: string; subject: string } {
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:support@marhabaconnect.app').trim();

  if (envPub && envPriv) {
    return { publicKey: envPub, privateKey: envPriv, subject };
  }

  try {
    if (fs.existsSync(vapidFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(vapidFilePath, 'utf-8')) as {
        publicKey?: string;
        privateKey?: string;
      };
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject };
      }
    }
  } catch {
    // Regenerate below if unreadable
  }

  const generated = generateVAPIDKeys();
  try {
    fs.writeFileSync(vapidFilePath, JSON.stringify(generated, null, 2));
  } catch {
    // Ignore read-only fs errors; keeps keys in memory
  }
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject };
}

const vapidConfig = initVapidKeys();
setVapidDetails(vapidConfig.subject, vapidConfig.publicKey, vapidConfig.privateKey);

const pushSubsByUid = new Map<string, StoredPushSubscription[]>();

function loadPushSubs() {
  try {
    if (!fs.existsSync(pushSubsFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(pushSubsFilePath, 'utf-8')) as Record<string, StoredPushSubscription[]>;
    for (const [uid, list] of Object.entries(raw)) {
      if (Array.isArray(list) && list.length > 0) {
        pushSubsByUid.set(uid, list.slice(0, 8));
      }
    }
  } catch {
    // Ignore corrupt cache
  }
}

function savePushSubs() {
  try {
    const obj: Record<string, StoredPushSubscription[]> = {};
    for (const [uid, list] of pushSubsByUid.entries()) {
      if (list.length > 0) obj[uid] = list;
    }
    fs.writeFileSync(pushSubsFilePath, JSON.stringify(obj));
  } catch {
    // Ignore fs errors
  }
}

loadPushSubs();

function isSafePushEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > 2048) return false;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function sendWebPushToUser(
  targetUid: string,
  buildPayload: (lang: 'ar' | 'en') => Record<string, unknown>,
  options?: { urgency?: 'high' | 'normal'; ttl?: number }
) {
  const subs = pushSubsByUid.get(targetUid);
  if (!subs || subs.length === 0) return;

  const remaining: StoredPushSubscription[] = [];
  let changed = false;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        const payload = JSON.stringify(buildPayload(sub.lang));
        await sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          payload,
          {
            TTL: options?.ttl ?? 60,
            urgency: options?.urgency ?? 'high',
          }
        );
        remaining.push(sub);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          changed = true;
        } else {
          remaining.push(sub);
        }
      }
    })
  );

  if (changed) {
    if (remaining.length > 0) {
      pushSubsByUid.set(targetUid, remaining);
    } else {
      pushSubsByUid.delete(targetUid);
    }
    savePushSubs();
  }
}

// Public VAPID key for browser push subscription
app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidConfig.publicKey });
});

// Save authenticated user's Web Push subscription
app.post('/api/push/subscribe', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = await verifyFirebaseIdToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const body = req.body as {
    subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    lang?: unknown;
  };
  const endpoint = typeof body?.subscription?.endpoint === 'string' ? body.subscription.endpoint.trim() : '';
  const p256dh = typeof body?.subscription?.keys?.p256dh === 'string' ? body.subscription.keys.p256dh.trim() : '';
  const authKey = typeof body?.subscription?.keys?.auth === 'string' ? body.subscription.keys.auth.trim() : '';
  const lang: 'ar' | 'en' = body?.lang === 'en' ? 'en' : 'ar';

  if (!isSafePushEndpoint(endpoint) || !p256dh || p256dh.length > 512 || !authKey || authKey.length > 512) {
    res.status(400).json({ error: 'Invalid push subscription' });
    return;
  }

  const existing = pushSubsByUid.get(verified.uid) || [];
  const filtered = existing.filter((s) => s.endpoint !== endpoint);
  filtered.unshift({
    endpoint,
    keys: { p256dh, auth: authKey },
    lang,
    updatedAt: Date.now(),
  });
  pushSubsByUid.set(verified.uid, filtered.slice(0, 8));
  savePushSubs();
  res.json({ ok: true });
});

// Remove push subscription on sign out
app.post('/api/push/unsubscribe', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = await verifyFirebaseIdToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const body = req.body as { endpoint?: unknown };
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
  if (endpoint) {
    const existing = pushSubsByUid.get(verified.uid) || [];
    const next = existing.filter((s) => s.endpoint !== endpoint);
    if (next.length > 0) {
      pushSubsByUid.set(verified.uid, next);
    } else {
      pushSubsByUid.delete(verified.uid);
    }
    savePushSubs();
  }
  res.json({ ok: true });
});

// Authenticated background push trigger when sending a chat message
app.post('/api/push/notify-message', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = await verifyFirebaseIdToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const body = req.body as {
    chatId?: unknown;
    recipientUids?: unknown;
    senderName?: unknown;
    messageType?: unknown;
    previewText?: unknown;
    isEncrypted?: unknown;
  };

  const chatId = typeof body.chatId === 'string' ? body.chatId.slice(0, 128) : '';
  const senderName =
    typeof body.senderName === 'string' && body.senderName.trim()
      ? body.senderName.trim().slice(0, 80)
      : verified.name || 'Marhaba Connect';
  const messageType = typeof body.messageType === 'string' ? body.messageType : 'text';
  const isEncrypted = Boolean(body.isEncrypted);
  const rawPreview = typeof body.previewText === 'string' ? body.previewText.trim().slice(0, 160) : '';
  const recipientUids = Array.isArray(body.recipientUids)
    ? body.recipientUids
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && id !== verified.uid)
        .slice(0, 50)
    : [];

  if (!chatId || recipientUids.length === 0) {
    res.json({ ok: true, sent: 0 });
    return;
  }

  await Promise.all(
    recipientUids.map((uid) =>
      sendWebPushToUser(
        uid,
        (lang) => {
          let notifBody = rawPreview;
          if (messageType === 'audio') {
            notifBody = lang === 'ar' ? '🎤 رسالة صوتية جديدة' : '🎤 New voice message';
          } else if (messageType === 'image') {
            notifBody = lang === 'ar' ? '📷 أرسل صورة' : '📷 Sent a photo';
          } else if (messageType === 'file') {
            notifBody = lang === 'ar' ? '📎 أرسل ملفاً' : '📎 Sent a file';
          } else if (isEncrypted || !notifBody) {
            notifBody = lang === 'ar' ? '🔒 رسالة جديدة مشفرة' : '🔒 New encrypted message';
          }
          return {
            type: 'message',
            title: senderName,
            body: notifBody,
            tag: `chat_${chatId}`,
            chatId,
            url: `/?chat=${encodeURIComponent(chatId)}`,
            requireInteraction: false,
          };
        },
        { urgency: 'high', ttl: 300 }
      )
    )
  );

  res.json({ ok: true });
});

// Authenticated file/media upload endpoint
app.post('/api/upload', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = await verifyFirebaseIdToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { fileName, mimeType, base64Data } = req.body as {
    fileName?: unknown;
    mimeType?: unknown;
    base64Data?: unknown;
  };

  if (typeof fileName !== 'string' || typeof mimeType !== 'string' || typeof base64Data !== 'string') {
    res.status(400).json({ error: 'Invalid upload payload' });
    return;
  }

  const cleanBaseName = path.basename(fileName).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF ]/g, '_').slice(0, 140) || 'file';
  const extMatch = path.extname(cleanBaseName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  const safeExt = extMatch || '.bin';

  // Strip optional data URL prefix safely
  const rawBase64 = base64Data.includes(',') ? base64Data.split(',')[1] ?? '' : base64Data;
  const buffer = Buffer.from(rawBase64, 'base64');

  if (buffer.length === 0 || buffer.length > 15 * 1024 * 1024) {
    res.status(400).json({ error: 'File size must be between 1 byte and 15 MB' });
    return;
  }

  const fileId = `${crypto.randomUUID()}${safeExt}`;
  const targetPath = path.resolve(uploadsDir, fileId);
  if (!targetPath.startsWith(uploadsDir + path.sep)) {
    res.status(400).json({ error: 'Invalid target path' });
    return;
  }

  try {
    fs.writeFileSync(targetPath, buffer);
    const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    fileMetaMap.set(fileId, {
      fileName: cleanBaseName,
      mimeType: normalizedMime,
      size: buffer.length,
    });
    res.json({
      mediaUrl: `/api/files/${fileId}`,
      fileName: cleanBaseName,
      fileSize: buffer.length,
      mimeType: normalizedMime,
    });
  } catch {
    res.status(500).json({ error: 'Failed to store uploaded file' });
  }
});

// Safe file serving endpoint
app.get('/api/files/:fileId', (req, res) => {
  const { fileId } = req.params;
  if (!/^[a-zA-Z0-9_.\-]+$/.test(fileId) || fileId.includes('..')) {
    res.status(400).json({ error: 'Invalid file identifier' });
    return;
  }

  const resolvedPath = path.resolve(uploadsDir, fileId);
  if (!resolvedPath.startsWith(uploadsDir + path.sep) || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const meta = fileMetaMap.get(fileId);
  const mime = meta?.mimeType || 'application/octet-stream';
  const isSafeInline = SAFE_INLINE_MIMES.has(mime);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', isSafeInline ? mime : 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  if (!isSafeInline) {
    const downloadName = (meta?.fileName || fileId).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  }

  fs.createReadStream(resolvedPath).pipe(res);
});

const server = http.createServer(app);

// WebSocket signaling & presence hub (disable perMessageDeflate for minimal latency on live audio/video)
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
const socketsByUid = new Map<string, Set<WebSocket>>();
const uidBySocket = new Map<WebSocket, string>();

// Short-lived pending call offer buffer (45s TTL) so offline callees opening via push still receive the call
interface PendingCallOffer {
  callId: string;
  toUid: string;
  offerPayload: Record<string, unknown>;
  icePayloads: Array<Record<string, unknown>>;
  createdAt: number;
}
const pendingCallsByCallee = new Map<string, Map<string, PendingCallOffer>>();

function cleanupExpiredPendingCalls() {
  const now = Date.now();
  for (const [calleeUid, map] of pendingCallsByCallee.entries()) {
    for (const [callId, entry] of map.entries()) {
      if (now - entry.createdAt > 45000) {
        map.delete(callId);
      }
    }
    if (map.size === 0) {
      pendingCallsByCallee.delete(calleeUid);
    }
  }
}

function clearPendingCall(callId: string) {
  for (const [calleeUid, map] of pendingCallsByCallee.entries()) {
    if (map.delete(callId) && map.size === 0) {
      pendingCallsByCallee.delete(calleeUid);
    }
  }
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastPresence() {
  const onlineUids = Array.from(socketsByUid.keys());
  const message = JSON.stringify({ type: 'presence:list', onlineUids });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && uidBySocket.has(client)) {
      client.send(message);
    }
  }
}

function sendToUser(targetUid: string, payload: unknown, excludeWs?: WebSocket, maxBufferedBytes?: number) {
  const userSockets = socketsByUid.get(targetUid);
  if (!userSockets) return;
  const serialized = JSON.stringify(payload);
  for (const sock of userSockets) {
    if (excludeWs && sock === excludeWs) continue;
    if (sock.readyState !== WebSocket.OPEN) continue;
    if (maxBufferedBytes !== undefined && sock.bufferedAmount > maxBufferedBytes) {
      continue;
    }
    sock.send(serialized);
  }
}

wss.on('connection', (ws, req) => {
  // Flush small audio packets immediately without Nagle 40-200ms buffering
  req.socket?.setNoDelay?.(true);

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type;
    if (type === 'ping') {
      sendJson(ws, { type: 'pong' });
      return;
    }

    if (type === 'auth') {
      const token = typeof msg.token === 'string' ? msg.token : '';
      const verified = await verifyFirebaseIdToken(token);
      if (!verified) {
        sendJson(ws, { type: 'auth:error', error: 'Invalid token' });
        ws.close();
        return;
      }
      uidBySocket.set(ws, verified.uid);
      if (!socketsByUid.has(verified.uid)) {
        socketsByUid.set(verified.uid, new Set());
      }
      socketsByUid.get(verified.uid)!.add(ws);
      sendJson(ws, { type: 'auth:ok', uid: verified.uid });
      broadcastPresence();

      // Replay any fresh pending incoming call offer + ICE candidates if callee just launched from push notification
      cleanupExpiredPendingCalls();
      const pendingForMe = pendingCallsByCallee.get(verified.uid);
      if (pendingForMe) {
        for (const entry of pendingForMe.values()) {
          sendJson(ws, entry.offerPayload);
          for (const ice of entry.icePayloads) {
            sendJson(ws, ice);
          }
        }
      }
      return;
    }

    const senderUid = uidBySocket.get(ws);
    if (!senderUid) {
      sendJson(ws, { type: 'error', error: 'Unauthenticated' });
      return;
    }

    if (type === 'typing') {
      const chatId = typeof msg.chatId === 'string' ? msg.chatId : '';
      const memberIds = Array.isArray(msg.memberIds) ? msg.memberIds.filter((id): id is string => typeof id === 'string') : [];
      const isTyping = Boolean(msg.isTyping);
      for (const uid of memberIds) {
        if (uid !== senderUid) {
          sendToUser(uid, { type: 'typing', chatId, senderId: senderUid, isTyping });
        }
      }
      return;
    }

    if (
      type === 'call:offer' ||
      type === 'call:answer' ||
      type === 'call:renegotiate' ||
      type === 'call:renegotiate-answer' ||
      type === 'call:ice' ||
      type === 'call:decline' ||
      type === 'call:hangup' ||
      type === 'call:relay-ready'
    ) {
      const toUid = typeof msg.toUid === 'string' ? msg.toUid : '';
      if (!toUid) return;
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      const outbound = {
        ...msg,
        fromUid: senderUid,
      };
      sendToUser(toUid, outbound, ws);

      if (type === 'call:offer' && callId) {
        cleanupExpiredPendingCalls();
        if (!pendingCallsByCallee.has(toUid)) {
          pendingCallsByCallee.set(toUid, new Map());
        }
        pendingCallsByCallee.get(toUid)!.set(callId, {
          callId,
          toUid,
          offerPayload: outbound,
          icePayloads: [],
          createdAt: Date.now(),
        });

        const callerName =
          typeof msg.callerName === 'string' && msg.callerName.trim()
            ? msg.callerName.trim().slice(0, 80)
            : 'Marhaba Connect';
        const callType = msg.callType === 'video' ? 'video' : 'audio';
        const chatId = typeof msg.chatId === 'string' ? msg.chatId : '';

        void sendWebPushToUser(
          toUid,
          (lang) => ({
            type: 'call',
            title: callerName,
            body:
              callType === 'video'
                ? lang === 'ar'
                  ? '📹 مكالمة مرئية واردة — اضغط للرد'
                  : '📹 Incoming video call — tap to answer'
                : lang === 'ar'
                  ? '📞 مكالمة صوتية واردة — اضغط للرد'
                  : '📞 Incoming audio call — tap to answer',
            tag: `call_${callId}`,
            callId,
            chatId,
            url: chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/',
            requireInteraction: true,
          }),
          { urgency: 'high', ttl: 45 }
        );
      } else if (type === 'call:ice' && callId) {
        const entry = pendingCallsByCallee.get(toUid)?.get(callId);
        if (entry && entry.icePayloads.length < 40) {
          entry.icePayloads.push(outbound);
        }
      } else if ((type === 'call:answer' || type === 'call:decline' || type === 'call:hangup') && callId) {
        clearPendingCall(callId);
      }
      return;
    }

    if (type === 'call:relay-audio') {
      const toUid = typeof msg.toUid === 'string' ? msg.toUid : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      const pcm = typeof msg.pcm === 'string' ? msg.pcm : '';
      const sr = typeof msg.sr === 'number' ? msg.sr : 16000;
      if (!toUid || !callId || !pcm || pcm.length > 65536) return;
      sendToUser(
        toUid,
        {
          type: 'call:relay-audio',
          callId,
          fromUid: senderUid,
          sr,
          pcm,
        },
        ws
      );
      return;
    }

    if (type === 'call:relay-video') {
      const toUid = typeof msg.toUid === 'string' ? msg.toUid : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      const frame = typeof msg.frame === 'string' ? msg.frame : '';
      if (!toUid || !callId || !frame || frame.length > 220000 || !frame.startsWith('data:image/jpeg;base64,')) {
        return;
      }
      // Drop video frames only if recipient socket is heavily backed up so audio packets stay real-time
      sendToUser(
        toUid,
        {
          type: 'call:relay-video',
          callId,
          fromUid: senderUid,
          frame,
        },
        ws,
        256 * 1024
      );
    }
  });

  ws.on('close', () => {
    const uid = uidBySocket.get(ws);
    uidBySocket.delete(ws);
    if (uid) {
      const set = socketsByUid.get(uid);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          socketsByUid.delete(uid);
        }
      }
      broadcastPresence();
    }
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (
        req.path.startsWith('/assets/') ||
        req.path.startsWith('/src/assets/') ||
        /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|json|webmanifest)$/i.test(req.path)
      ) {
        res.status(404).end();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Marhaba Connect server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
