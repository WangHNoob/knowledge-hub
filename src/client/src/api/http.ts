const TOKEN_KEY = "kh_token";

/** 构建时由 VITE_APP_BASE 注入（nginx /kb/ 前缀部署）；开发环境为 "/"。 */
const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** 把根相对 API 路径补上部署前缀，如 "/api/x" → "/kb/api/x"。 */
export function apiUrl(path: string): string {
  return APP_BASE ? `${APP_BASE}${path}` : path;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** 从本地 JWT 解出当前角色（仅用于 UI 展示/门控，真正权限仍由服务端校验）。 */
export function currentRole(): "admin" | "developer" | "viewer" | null {
  const token = getToken();
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const role = json?.role;
    return role === "admin" || role === "developer" || role === "viewer" ? role : null;
  } catch {
    return null;
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), { headers: authHeaders() });
  return parseResponse(response);
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(url), {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(url), {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(url), {
    method: "PATCH",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function postEmpty<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), { method: "POST", headers: authHeaders() });
  return parseResponse(response);
}

export async function deleteJson<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), { method: "DELETE", headers: authHeaders() });
  return parseResponse(response);
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}
