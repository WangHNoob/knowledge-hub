# -*- coding: utf-8 -*-
"""Run StarTrail golden evals through Design Agent query mode, then score.

Usage:
  python evals/run_query_mode_eval.py
"""
from __future__ import annotations

import http.cookiejar
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GOLD = ROOT / "golden_evals.json"
ANSWERS_OUT = ROOT / "answers.query_mode.json"
REPORT_MD = ROOT / "query_mode_eval_report.md"
RUN_EVAL = ROOT / "run_eval.py"

DA_BASE = "http://localhost:13000"
ORIGIN = "http://localhost:3001"
EMAIL = "eval.query@admin.com"
PASSWORD = "DevPass123!"
POLL_SEC = 3
TIMEOUT_SEC = 360
# Keep low to avoid queue pile-up / RPM; query mode is serial by default.
CONCURRENCY = 1
PAUSE_SEC = 12


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
        )

    def request(self, method: str, path: str, payload: dict | None = None, extra: dict | None = None, timeout: int = 60):
        data = None
        headers = {"Origin": ORIGIN, "Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if extra:
            headers.update(extra)
        req = urllib.request.Request(f"{self.base}{path}", data=data, headers=headers, method=method)
        with self.opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}

    def sign_in(self, email: str, password: str) -> None:
        status, body = self.request("POST", "/api/auth/sign-in/email", {"email": email, "password": password})
        if status >= 400:
            raise RuntimeError(f"sign-in failed: {status} {body}")


def extract_output(exec_body: dict) -> str:
    payload = exec_body.get("resultPayload")
    if isinstance(payload, dict):
        for key in ("output", "result", "answer", "text"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    for key in ("output", "result", "answer", "text", "errorMessage"):
        val = exec_body.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    nested = exec_body.get("execution")
    if isinstance(nested, dict):
        return extract_output(nested)
    err = exec_body.get("error")
    if err:
        return f"[ERROR] {err}"
    return ""


def run_one(client: Client, qid: str, question: str, pause_sec: float = 8.0) -> dict:
    prompt = (
        "你处于【知识查询模式】。必须通过 Knowledge Hub MCP 工具作答："
        "优先 kb_search / kb_query_table / kb_get_page / kb_get_table_schema；"
        "回答需包含关键 ID 与字段值，并说明来源表或文档；"
        "数值字段必须以配表英文字段名写出，格式如 cdSec=6 / recommendPower=15000 / rarity=5"
        "（禁止只写裸数字）；禁止编造未注册 ID；知识库无结果时明确拒绝。\n\n"
        f"【题目 {qid}】\n{question}"
    )
    idem = f"golden-query-{qid}-{int(time.time())}"
    # retry on TPM rate limit
    for attempt in range(1, 6):
        try:
            status, created = client.request(
                "POST",
                "/api/console/execute",
                {"requirement": prompt, "mode": "query"},
                extra={"Idempotency-Key": f"{idem}-a{attempt}"},
                timeout=60,
            )
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            if e.code == 429 or "RATE_LIMIT" in detail:
                wait = 15 * attempt
                print(f"  rate-limit on create, sleep {wait}s", flush=True)
                time.sleep(wait)
                continue
            return {"id": qid, "ok": False, "status": f"http_{e.code}", "output": detail, "executionId": None}

        execution_id = created.get("executionId")
        if not execution_id:
            return {"id": qid, "ok": False, "status": "no_execution_id", "output": json.dumps(created, ensure_ascii=False), "executionId": None}

        deadline = time.time() + TIMEOUT_SEC
        last: dict = {}
        while time.time() < deadline:
            try:
                _, last = client.request("GET", f"/api/console/executions/{execution_id}", timeout=30)
            except Exception as e:  # noqa: BLE001
                time.sleep(POLL_SEC)
                last = {"status": "poll_error", "error": str(e)}
                continue
            st = last.get("status") or (last.get("execution") or {}).get("status")
            if st in {"completed", "failed", "cancelled", "timed_out"}:
                out = extract_output(last)
                msg = str(last.get("errorMessage") or "")
                if st == "failed" and "RATE_LIMIT_TPM" in msg and attempt < 5:
                    wait = 20 * attempt
                    print(f"  RATE_LIMIT_TPM, retry in {wait}s (attempt {attempt})", flush=True)
                    time.sleep(wait)
                    break
                time.sleep(pause_sec)
                return {
                    "id": qid,
                    "ok": st == "completed" and bool(out),
                    "status": st,
                    "output": out or msg,
                    "executionId": execution_id,
                    "errorMessage": msg,
                }
            time.sleep(POLL_SEC)
        else:
            time.sleep(pause_sec)
            return {"id": qid, "ok": False, "status": "timeout_wait", "output": extract_output(last), "executionId": execution_id}
    return {"id": qid, "ok": False, "status": "rate_limit_exhausted", "output": "", "executionId": None}


def ensure_user(client: Client, email: str, password: str, name: str = "Eval Query") -> None:
    try:
        client.request("POST", "/api/auth/sign-up/email", {"email": email, "password": password, "name": name})
    except urllib.error.HTTPError:
        pass
    client.sign_in(email, password)


def main() -> int:
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    cases = gold["cases"]
    client = Client(DA_BASE)
    ensure_user(client, EMAIL, PASSWORD)
    print(f"signed in as {EMAIL}; cases={len(cases)}; mode=query; pause={PAUSE_SEC}s", flush=True)
    print("cooling TPM window 5s...", flush=True)
    time.sleep(5)

    answers: dict[str, str] = {}
    traces = []
    for i, case in enumerate(cases, 1):
        qid = case["id"]
        print(f"[{i}/{len(cases)}] {qid} ...", flush=True)
        result = run_one(client, qid, case["question"], pause_sec=PAUSE_SEC)
        answers[qid] = result["output"] or ""
        traces.append(result)
        preview = (result["output"] or "")[:160].replace("\n", " ")
        line = f"  -> {result['status']} len={len(result['output'] or '')} {preview}"
        # Windows consoles may be GBK; keep progress printable.
        print(line.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(sys.stdout.encoding or "utf-8", errors="replace"), flush=True)

    ANSWERS_OUT.write_text(json.dumps(answers, ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / "answers.query_mode.traces.json").write_text(json.dumps(traces, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {ANSWERS_OUT}", flush=True)

    # score via run_eval.py
    import subprocess

    proc = subprocess.run(
        [sys.executable, str(RUN_EVAL), "--answers", str(ANSWERS_OUT), "--report", str(REPORT_MD)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)
    print(f"exit={proc.returncode} report={REPORT_MD}", flush=True)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
