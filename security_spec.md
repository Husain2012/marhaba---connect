# Security Specification — Marhaba Connect

## 1. Data Invariants
1. **PII Isolation**: User emails and phone numbers live strictly in `/users/{userId}/private/info` and are readable/writable only by `request.auth.uid == userId`. Public `/users/{userId}` documents contain zero PII.
2. **Master Gate on Subcollections**: `/chats/{chatId}/messages/{messageId}` and `/chats/{chatId}/members/{memberUid}` verify membership against parent `/chats/{chatId}` via `get()` on single-document operations and enforce `incoming().memberIds == parentChat.memberIds`.
3. **Immutable Ownership & Timestamps**: `createdBy`, `senderId`, `callerId`, `createdAt`, `chatId`, and `id` cannot be modified after creation. All `createdAt`/`updatedAt` timestamps must match `request.time`.
4. **Terminal Call Locking**: Once a `/calls/{callId}` document transitions to `'ended'`, `'missed'`, or `'declined'`, no further mutations are permitted.
5. **No Client Delegation on List**: All `allow list` rules explicitly evaluate `resource.data` against `request.auth.uid` (or `isDiscoverable == true` on non-PII `/users`).

## 2. Dirty Dozen Adversarial Payloads
1. Unauthenticated read/write to `/users/u1` -> `PERMISSION_DENIED`.
2. Non-owner reading `/users/u2/private/info` -> `PERMISSION_DENIED`.
3. Creating `/users/u1` with shadow field `isAdmin: true` -> `PERMISSION_DENIED`.
4. Creating `/users/u1` with oversized `bio` (>160 chars) -> `PERMISSION_DENIED`.
5. Creating `/chats/invalid!id` with non-alphanumeric ID -> `PERMISSION_DENIED`.
6. Non-member reading or writing `/chats/c1/messages/m1` -> `PERMISSION_DENIED`.
7. Sender spoofing `senderId: "victim"` in `/chats/c1/messages/m2` -> `PERMISSION_DENIED`.
8. Backdating `createdAt` in a message payload -> `PERMISSION_DENIED`.
9. Injecting a ghost field `verified: true` on chat update -> `PERMISSION_DENIED`.
10. Updating `senderId` or `text` on an existing message -> `PERMISSION_DENIED`.
11. Modifying a `/calls/{callId}` record after `status == 'ended'` -> `PERMISSION_DENIED`.
12. Listing `/chats` without matching `request.auth.uid in resource.data.memberIds` -> `PERMISSION_DENIED`.
