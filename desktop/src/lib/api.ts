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

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Shape of GET /api/prompts (see SavedPrompt in backend/schemas.py).
export type SavedPrompt = { id: number; command: string; description: string; instruction: string };

/** Fired after the saved prompts change, so the chat's command menu can reload them. */
export const PROMPTS_CHANGED = "copilot:prompts-changed";
