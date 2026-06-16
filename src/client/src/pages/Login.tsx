import { useState } from "react";

import { login } from "../api";

export function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("adminpw");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  return (
    <div className="login-screen">
      <section className="login-panel">
        <div className="brand-mark large">KH</div>
        <h1>Knowledge Hub</h1>
        <p>面向管理员、主开发者和维护者的知识资产协作台。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError("");
            try {
              const response = await login(username, password);
              onLogin(response.token);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <button disabled={loading}>{loading ? "登录中..." : "进入知识库"}</button>
        </form>
      </section>
    </div>
  );
}
