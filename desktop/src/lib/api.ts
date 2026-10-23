/** The backend's error message (FastAPI `detail`), or the HTTP status. */
export async function errorDetail(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (typeof body?.detail === "string") return body.detail;
  // Validation errors: a list of {loc, msg}.
  if (Array.isArray(body?.detail) && typeof body.detail[0]?.msg === "string") return body.detail[0].msg;
  return `HTTP ${res.status}`;
}

/** GET a JSON endpoint, throwing the backend's error message on failure. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

/** POST/PUT/PATCH/DELETE JSON, throwing the backend's error message on failure. */
export async function sendJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.status === 204 ? (undefined as T) : res.json();
}

/**
 * POST /api/notes/image: store an image or other file in the space, returning the URL it's served from and its name.
 * Sent with XHR rather than fetch, so `onProgress` hears how much of the file has gone (0 to 1).
 */
export function uploadFile(spaceId: number, file: File, onProgress?: (fraction: number) => void): Promise<{ url: string; name: string }> {
  const form = new FormData();
  form.append("space_id", String(spaceId));
  form.append("file", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/notes/image");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      // Wrapped in a Response so errors read the same as the rest of the API's.
      const res = new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText });
      if (!res.ok) return void errorDetail(res).then((detail) => reject(new Error(detail)), reject);
      res.json().then((body: { url: string }) => resolve({ url: body.url, name: file.name }), reject);
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(form);
  });
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Shape of GET /api/prompts (see SavedPrompt in backend/schemas.py).
export type SavedPrompt = { id: number; space_id: number; command: string; description: string; instruction: string };

/** Fired after the saved prompts change, so the chat's command menu can reload them. */
export const PROMPTS_CHANGED = "copilot:prompts-changed";

/** Fired to open the Co-pilot chat with a question written into its input (`detail`: the text), ready to send. */
export const CHAT_PROMPT = "copilot:chat-prompt";

export function promptCopilot(text: string) {
  window.dispatchEvent(new CustomEvent<string>(CHAT_PROMPT, { detail: text }));
}
