import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const uploadsDir = path.resolve(process.cwd(), '.data', 'uploads');
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
  if (turnUrls.length > 0 && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  res.json({ iceServers });
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
      type === 'call:ice' ||
      type === 'call:decline' ||
      type === 'call:hangup' ||
      type === 'call:relay-ready'
    ) {
      const toUid = typeof msg.toUid === 'string' ? msg.toUid : '';
      if (!toUid) return;
      sendToUser(
        toUid,
        {
          ...msg,
          fromUid: senderUid,
        },
        ws
      );
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
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Marhaba Connect server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
