import { getJson, message, sendJson } from "./api";

// Shape of GET /api/local-files/stat (see LocalFileStat in backend/schemas.py).
type LocalFileStat = { name: string; type: "file" | "directory"; size: number };

/**
 * True for a link to a file or folder on the backend's machine: a `file:` URL, a Windows drive path (`C:\…`, `C:/…`)
 * or a UNC path (`\\server\share\…`). Shown as a pill (see index.css) and opened with `openLocalFile`.
 */
export function isLocalHref(href: string | null | undefined): href is string {
  return !!href && /^(file:|[a-z]:[\\/]|\\\\)/i.test(href);
}

function isLocalhost(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/**
 * Open a linked local file or folder. On the machine running the backend it opens in its default program; a remote
 * client is asked to confirm, then downloads the file, or a folder as a ZIP.
 */
export async function openLocalFile(href: string): Promise<void> {
  try {
    if (isLocalhost()) {
      await sendJson("POST", "/api/local-files/open", { path: href });
      return;
    }
    const stat = await getJson<LocalFileStat>(`/api/local-files/stat?path=${encodeURIComponent(href)}`);
    const megabytes = (stat.size / (1024 * 1024)).toFixed(stat.size < 1024 * 1024 ? 2 : 1);
    const what = stat.type === "directory" ? `the folder ${stat.name} as a ZIP` : stat.name;
    if (!window.confirm(`Download ${what} (${megabytes} MB)?`)) return;
    const endpoint = stat.type === "directory" ? "download-zip" : "download";
    const anchor = document.createElement("a");
    anchor.href = `/api/local-files/${endpoint}?path=${encodeURIComponent(href)}`;
    anchor.download = stat.type === "directory" ? `${stat.name}.zip` : stat.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (err) {
    window.alert(`Could not open ${href}: ${message(err)}`);
  }
}
