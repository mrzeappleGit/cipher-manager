// Desktop notifications. Inside the Tauri app the webview's Notification API
// isn't backed, so we go through tauri-plugin-notification; in a browser
// (web server / dev) we use the standard Notification API.

import { isTauri } from "../api";

export function notifySupported(): boolean {
  return isTauri() || (typeof window !== "undefined" && "Notification" in window);
}

export async function ensureNotifyPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      if (await plugin.isPermissionGranted()) return true;
      return (await plugin.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  if (!notifySupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Show a desktop notification (requesting permission if needed). */
export async function notifyDesktop(
  title: string,
  body: string,
  onClick?: () => void
): Promise<void> {
  if (!(await ensureNotifyPermission())) return;
  if (isTauri()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      // ponytail: the plugin has no click callback on desktop, so onClick
      // (e.g. join-call) only works in browser mode.
      plugin.sendNotification({ title, body });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const n = new Notification(title, { body });
    if (onClick) {
      n.onclick = () => {
        onClick();
        n.close();
      };
    }
  } catch {
    /* ignore */
  }
}
