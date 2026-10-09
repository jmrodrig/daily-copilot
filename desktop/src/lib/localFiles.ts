import { getJson, message, sendJson } from "./api";

// Shape of GET /api/local-files/stat (see LocalFileStat in backend/schemas.py).
export type LocalFileStat = { name: string; type: "file" | "directory"; size: number; partial: boolean; unc_path?: string | null };

// Shape of GET /api/local-files/check (see LocalFileCheck in backend/schemas.py).
export type LocalFileCheck = {
  exists: boolean;
  name?: string | null;
  type?: "file" | "directory" | "unknown" | null;
  path: string;
  unc_path?: string | null;
  error?: string | null;
};

/**
 * True for a link to a file or folder on the backend's machine: a `file:` URL, a Windows drive path (`C:\…`, `C:/…`)
 * or a UNC path (`\\server\share\…`). Shown as a pill (see index.css) and opened with `openLocalFile`.
 */
export function isLocalHref(href: string | null | undefined): href is string {
  return !!href && /^(file:|[a-z]:[\\/]|\\\\)/i.test(href);
}

/**
 * Whether a linked file or folder exists on the backend's machine, without looking inside a folder (fast even on a huge
 * network drive). A failed request reads as not found, with its reason; an aborted one throws.
 */
export async function checkLocalFile(href: string, signal?: AbortSignal): Promise<LocalFileCheck> {
  try {
    return await getJson<LocalFileCheck>(`/api/local-files/check?path=${encodeURIComponent(href)}`, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return { exists: false, path: href, error: message(err) };
  }
}

function isLocalhost(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/** Copy text to the clipboard; false if the browser won't (`navigator.clipboard` needs HTTPS or localhost). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied: fall back to the old way below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Open a linked local file or folder. On the machine running the backend it opens in its default program. A remote
 * client downloads a small Windows shortcut (`.url`) to it on the network share, which opens it straight from the share,
 * and gets the share's path on its clipboard in case the shortcut is blocked; nothing large crosses HTTP.
 */
export async function openLocalFile(href: string): Promise<void> {
  try {
    if (isLocalhost()) {
      await sendJson("POST", "/api/local-files/open", { path: href });
      return;
    }
    // `check`, not `stat`: it doesn't total a folder's size, so it answers at once even for a huge share.
    const found = await getJson<LocalFileCheck>(`/api/local-files/check?path=${encodeURIComponent(href)}`);
    if (!found.exists) throw new Error(found.error ?? "Not found");
    const networkPath = found.unc_path || href;
    const copied = await copyText(networkPath);
    const anchor = document.createElement("a");
    anchor.href = `/api/local-files/shortcut?path=${encodeURIComponent(href)}`;
    anchor.download = `${found.name || "Network-Shortcut"}.url`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.alert(
      copied
        ? `Opening via network drive... (Shortcut downloaded. Network path also copied to clipboard: ${networkPath})`
        : `Opening via network drive... (Shortcut downloaded. Network path: ${networkPath})`,
    );
  } catch (err) {
    window.alert(`Could not open ${href}: ${message(err)}`);
  }
}
