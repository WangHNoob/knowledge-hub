const TOKEN_KEY = "kh_token";

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

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  return parseResponse(response);
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function postEmpty<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: authHeaders() });
  return parseResponse(response);
}

export async function deleteJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE", headers: authHeaders() });
  return parseResponse(response);
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}
