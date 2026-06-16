import { postJson } from "./http";
import type { LoginResponse } from "./types";

export async function login(username: string, password: string): Promise<LoginResponse> {
  return postJson<LoginResponse>("/api/auth/login", { username, password });
}
