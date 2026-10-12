import { getJson, message } from "./api";

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

/** Copy text to the clipboard; false if the browser won't (`navigator.clipboard` needs HTTPS or localhost). */
export async function copyText(text: string): Promise<boolean> {
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

function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A `copilot-open:` URL for a remote Windows client's protocol handler (see `protocol-installer` on the backend):
 * carries both the path as linked (`Y:\…`) and the share's UNC path (`\\server\share\…`), so whichever the client
 * reaches opens in its default program or Explorer. With the app's `origin`, a client that reaches neither downloads
 * the file from the server and opens that copy.
 */
export function protocolUrl(path: string, uncPath?: string | null, origin?: string | null): string {
  const parts = [`path=${encodeParam(path)}`];
  if (uncPath && uncPath !== path) parts.push(`unc=${encodeParam(uncPath)}`);
  if (origin) parts.push(`origin=${encodeParam(origin)}`);
  return `copilot-open://open?${parts.join("&")}`;
}

/**
 * Open a linked local file or folder through the `copilot-open:` protocol, on whichever machine the browser runs: the
 * backend registers it on its own machine at startup, and a remote client gets it from the setup script in Space
 * Preferences. Launched from the browser, it opens in the user's visible desktop (unlike a backend started as a
 * background service), straight from the mapped drive or network share; the share's path goes on the clipboard as a
 * fallback, and nothing large crosses HTTP.
 */
export async function openLocalFile(href: string): Promise<void> {
  try {
    // `check`, not `stat`: it doesn't total a folder's size, so it answers at once even for a huge share.
    const found = await getJson<LocalFileCheck>(`/api/local-files/check?path=${encodeURIComponent(href)}`);
    if (!found.exists) throw new Error(found.error ?? "Not found");
    void copyText(found.unc_path || found.path || href);
    const anchor = document.createElement("a");
    anchor.href = protocolUrl(found.path || href, found.unc_path, window.location.origin);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (err) {
    window.alert(`Could not open ${href}: ${message(err)}`);
  }
}
