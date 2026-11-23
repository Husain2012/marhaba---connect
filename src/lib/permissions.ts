export type PermissionGrantState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface AppPermissionsState {
  microphone: PermissionGrantState;
  camera: PermissionGrantState;
  notifications: PermissionGrantState;
}

async function queryMediaPermission(name: 'microphone' | 'camera'): Promise<PermissionGrantState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
        return status.state;
      }
    } catch {
      // Safari / some Android WebViews throw on camera/microphone permissions.query
    }
  }
  return 'prompt';
}

export function getNotificationPermissionState(): PermissionGrantState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return 'prompt';
}

export async function queryAppPermissions(): Promise<AppPermissionsState> {
  const [microphone, camera] = await Promise.all([
    queryMediaPermission('microphone'),
    queryMediaPermission('camera'),
  ]);
  const notifications = getNotificationPermissionState();
  return { microphone, camera, notifications };
}

export async function requestMicrophonePermission(): Promise<PermissionGrantState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'unsupported';
    }
    return 'denied';
  }
}

export async function requestCameraPermission(): Promise<PermissionGrantState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'unsupported';
    }
    return 'denied';
  }
}

export async function requestNotificationPermission(): Promise<PermissionGrantState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') return 'granted';
    if (result === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return getNotificationPermissionState();
  }
}

export async function requestAllRuntimePermissions(): Promise<AppPermissionsState> {
  let micState: PermissionGrantState = 'prompt';
  let camState: PermissionGrantState = 'prompt';

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
      micState = 'granted';
      camState = 'granted';
    } catch {
      micState = await requestMicrophonePermission();
      camState = await requestCameraPermission();
    }
  } else {
    micState = 'unsupported';
    camState = 'unsupported';
  }

  const notifState = await requestNotificationPermission();
  const queried = await queryAppPermissions();

  return {
    microphone: micState === 'granted' ? 'granted' : queried.microphone !== 'prompt' ? queried.microphone : micState,
    camera: camState === 'granted' ? 'granted' : queried.camera !== 'prompt' ? queried.camera : camState,
    notifications: notifState !== 'prompt' ? notifState : queried.notifications,
  };
}
