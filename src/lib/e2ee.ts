/**
 * Client-side End-to-End Encryption (ECDH P-256 + AES-256-GCM)
 * Private keys stay strictly in the user's browser storage (scoped per uid).
 * Only public coordinates (x, y) are shared on /users/{uid}.
 */

export interface E2eeKeyPairData {
  publicKeyX: string;
  publicKeyY: string;
  privateJwk: JsonWebKey;
}

const STORAGE_PREFIX = 'marhaba_e2ee_v1_';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function getOrCreateMyE2eeKeys(uid: string): Promise<E2eeKeyPairData> {
  const storageKey = `${STORAGE_PREFIX}${uid}`;
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as E2eeKeyPairData;
      if (parsed.publicKeyX && parsed.publicKeyY && parsed.privateJwk) {
        return parsed;
      }
    } catch {
      // Regenerate below if corrupted
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );

  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const data: E2eeKeyPairData = {
    publicKeyX: String(publicJwk.x || ''),
    publicKeyY: String(publicJwk.y || ''),
    privateJwk,
  };

  localStorage.setItem(storageKey, JSON.stringify(data));
  return data;
}

async function deriveSharedAesKey(
  myPrivateJwk: JsonWebKey,
  peerKeyX: string,
  peerKeyY: string
): Promise<CryptoKey> {
  const myPrivateKey = await crypto.subtle.importKey(
    'jwk',
    myPrivateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );

  const peerPublicKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: peerKeyX,
      y: peerKeyY,
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptDirectText(
  plaintext: string,
  myKeys: E2eeKeyPairData,
  peerKeyX: string,
  peerKeyY: string
): Promise<{
  ciphertext: string;
  iv: string;
  senderKeyX: string;
  senderKeyY: string;
  recipientKeyX: string;
  recipientKeyY: string;
}> {
  const aesKey = await deriveSharedAesKey(myKeys.privateJwk, peerKeyX, peerKeyY);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    aesKey,
    encoded
  );

  return {
    ciphertext: toBase64(new Uint8Array(encryptedBuf)),
    iv: toBase64(ivBytes),
    senderKeyX: myKeys.publicKeyX,
    senderKeyY: myKeys.publicKeyY,
    recipientKeyX: peerKeyX,
    recipientKeyY: peerKeyY,
  };
}

export async function decryptDirectText(
  params: {
    ciphertext: string;
    iv: string;
    senderId: string;
    senderKeyX: string;
    senderKeyY: string;
    recipientKeyX: string;
    recipientKeyY: string;
  },
  currentUid: string,
  myKeys: E2eeKeyPairData
): Promise<string | null> {
  if (!params.ciphertext || !params.iv) return null;

  const isMine = params.senderId === currentUid;
  const peerX = isMine ? params.recipientKeyX : params.senderKeyX;
  const peerY = isMine ? params.recipientKeyY : params.senderKeyY;
  const myUsedX = isMine ? params.senderKeyX : params.recipientKeyX;

  if (!peerX || !peerY) return null;
  if (myUsedX && myUsedX !== myKeys.publicKeyX) {
    return null;
  }

  try {
    const aesKey = await deriveSharedAesKey(myKeys.privateJwk, peerX, peerY);
    const ivBytes = fromBase64(params.iv);
    const cipherBytes = fromBase64(params.ciphertext);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes as BufferSource },
      aesKey,
      cipherBytes as BufferSource
    );
    return new TextDecoder().decode(decryptedBuf);
  } catch {
    return null;
  }
}
