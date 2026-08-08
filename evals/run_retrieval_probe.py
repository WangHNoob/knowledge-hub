# -*- coding: utf-8 -*-
"""Preliminary retrieval eval against published Knowledge Hub using golden_evals.json.

For each case:
  1) kb_search(question, topK=k)
  2) hit if any expected title/path needle appears in top-k titles/sourceRefs/snippets
  3) factCoverage = share of keyFacts found in concatenated hit text

Usage:
  python evals/run_retrieval_probe.py [--base http://localhost:4174] [--k 5] [--report evals/retrieval_probe_report.md]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GOLD = ROOT / "golden_evals.json"

# Map source file stems / tokens → title needles likely present after wiki build
DOC_NEEDLES = {
    "00_项目总览与术语表": ["项目总览", "术语表", "00"],
    "01_战斗框架与伤害公式": ["战斗框架", "伤害公式", "01", "克制", "elemMul"],
    "02_属性体系与战力评估": ["属性体系", "战力评估", "02"],
    "03_技能系统设计": ["技能系统", "03", "技能"],
    "04_Buff与状态机": ["Buff", "状态机", "04", "buff"],
    "05_角色与职业体系": ["角色与职业", "职业体系", "05", "角色"],
    "06_武器与装备系统": ["武器与装备", "装备系统", "06", "武器", "装备"],
    "07_副本与关卡节奏": ["副本与关卡", "关卡节奏", "07", "副本"],
    "08_掉落与经济闭环": ["掉落与经济", "经济闭环", "08", "掉落"],
    "09_商店与兑换规则": ["商店与兑换", "兑换规则", "09", "商店"],
    "10_配表规范与外键约定": ["配表规范", "外键约定", "10"],
    "11_边界异常与QA检查清单": ["边界异常", "QA检查", "qa检查", "11"],
    "12_版本变更记录_v0.1": ["版本变更", "12"],
    # table stems (filename without extension)
    "Hero": ["Hero", "角色", "职业"],
    "HeroLevel": ["HeroLevel", "等级"],
    "Skill": ["Skill", "技能"],
    "SkillLevel": ["SkillLevel"],
    "Buff": ["Buff", "buff", "状态"],
    "Weapon": ["Weapon", "武器"],
    "Equipment": ["Equipment", "装备"],
    "Dungeon": ["Dungeon", "副本"],
    "DropTable": ["DropTable", "掉落"],
    "ShopItem": ["ShopItem", "商店"],
    "Breakthrough": ["Breakthrough", "突破"],
    "ElementChart": ["ElementChart", "元素", "克制", "elemMul", "战斗框架"],
}


def login(base: str, username: str, password: str) -> str:
    req = urllib.request.Request(
        f"{base}/api/auth/login",
        data=json.dumps({"username": username, "password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    token = body.get("token")
    if not token:
        raise RuntimeError(f"login failed: {body}")
    return token


def mcp_query(base: str, token: str, tool: str, payload: dict) -> dict:
    raw = json.dumps({"toolName": tool, "payload": payload}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/mcp/query",
        data=raw,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(raw)),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def needles_for_sources(source_files: list[str]) -> list[str]:
    out: list[str] = []
    for src in source_files:
        name = src.replace("\\", "/").split("/")[-1]
        stem = re.sub(r"\.(md|csv|xlsx)$", "", name, flags=re.I)
        out.extend(DOC_NEEDLES.get(stem, []))
        out.append(stem)
        out.append(name)
    # unique preserve order
    seen = set()
    uniq = []
    for n in out:
        if n and n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


def flatten_hits(envelope: dict) -> tuple[list[str], str]:
    result = envelope.get("result") or {}
    items = result.get("items") or result.get("hits") or []
    titles: list[str] = []
    blobs: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "")
        titles.append(title)
        parts = [
            title,
            str(item.get("snippet") or item.get("summary") or item.get("text") or ""),
            str(item.get("componentId") or ""),
            " ".join(str(x) for x in (item.get("sourceRefs") or [])),
            " ".join(str(x) for x in (item.get("tags") or [])),
        ]
        blobs.append(" ".join(parts))
    return titles, "\n".join(blobs)


def fact_hit(fact: str, text: str, tol: float = 0.05) -> bool:
    if fact in text:
        return True
    nums = [float(m) for m in re.findall(r"-?\d+(?:\.\d+)?", fact)]
    if not nums:
        return False
    ans = [float(m) for m in re.findall(r"-?\d+(?:\.\d+)?", text)]
    return any(abs(a - b) <= max(tol * abs(a), tol) for a in nums for b in ans)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:4174")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="adminpw")
    ap.add_argument("--project", default="default_project")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--report", default=str(ROOT / "retrieval_probe_report.md"))
    ap.add_argument("--json-out", default=str(ROOT / "retrieval_probe_results.json"))
    args = ap.parse_args()

    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    cases = gold["cases"]
    token = login(args.base, args.user, args.password)

    rows = []
    group_stats = defaultdict(lambda: {"hit": 0, "miss": 0, "fact_sum": 0.0, "n": 0})

    for case in cases:
        qid = case["id"]
        group = case["group"]
        question = case["question"]
        sources = case.get("sourceFiles") or []
        needles = needles_for_sources(sources)
        try:
            raw = mcp_query(
                args.base,
                token,
                "kb_search",
                {"projectId": args.project, "query": question, "topK": args.k, "limit": args.k},
            )
            envelope = raw.get("envelope") or raw
            titles, blob = flatten_hits(envelope)
            empty = not titles
            hay = (" | ".join(titles) + "\n" + blob).lower()
            title_hit = (not needles) or any(n.lower() in hay for n in needles)
            # also accept keyFact presence as soft retrieval signal for formula/anti cases
            facts = case.get("keyFacts") or []
            fact_hits = [f for f in facts if fact_hit(f, blob)]
            fact_cov = (len(fact_hits) / len(facts)) if facts else 0.0
            hit = (not empty) and (title_hit or fact_cov >= 0.5)
            err = None
        except urllib.error.HTTPError as e:
            titles, blob, fact_hits, fact_cov, hit, empty = [], "", [], 0.0, False, True
            err = f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}"
        except Exception as e:  # noqa: BLE001
            titles, blob, fact_hits, fact_cov, hit, empty = [], "", [], 0.0, False, True
            err = str(e)

        rows.append(
            {
                "id": qid,
                "group": group,
                "difficulty": case.get("difficulty"),
                "question": question,
                "sourceFiles": sources,
                "needles": needles,
                "hit": hit,
                "empty": empty,
                "factCoverage": round(fact_cov, 3),
                "factHits": fact_hits,
                "topTitles": titles[: args.k],
                "error": err,
            }
        )
        st = group_stats[group]
        st["n"] += 1
        st["hit" if hit else "miss"] += 1
        st["fact_sum"] += fact_cov
        print(f"[{qid}] {'HIT ' if hit else 'MISS'} fact={fact_cov:.0%} titles={titles[:2]}")

    total = len(rows)
    hits = sum(1 for r in rows if r["hit"])
    avg_fact = sum(r["factCoverage"] for r in rows) / total if total else 0
    labels = gold.get("meta", {}).get("groupLabels", {})

    lines = [
        "# StarTrail 检索初测报告（基于黄金测评集）",
        "",
        f"- 发布库: `{args.base}` / project=`{args.project}` / topK={args.k}",
        f"- 用例数: {total}",
        f"- 检索命中率 hit@k: **{hits}/{total} = {hits/total*100:.1f}%**",
        f"- keyFacts 在命中片段中的平均覆盖率: **{avg_fact*100:.1f}%**",
        "",
        "> 判定：topK 结果的 title/sourceRefs/snippet 命中 `sourceFiles` 派生针，或 keyFacts 覆盖 ≥50%。",
        "> 这是**检索初测**，不是完整 Agent 作答打分（完整作答请用 `run_eval.py`）。",
        "",
        "## 分组表现",
        "",
        "| 分组 | HIT | MISS | hit@k | avg factCoverage |",
        "|------|-----|------|-------|------------------|",
    ]
    for group, st in group_stats.items():
        label = labels.get(group, group)
        hk = st["hit"] / st["n"] if st["n"] else 0
        af = st["fact_sum"] / st["n"] if st["n"] else 0
        lines.append(f"| {label} ({group}) | {st['hit']} | {st['miss']} | {hk*100:.0f}% | {af*100:.0f}% |")

    lines += ["", "## 明细", "", "| ID | 分组 | 结果 | factCoverage | topTitles |", "|----|------|------|--------------|-----------|"]
    for r in rows:
        titles = " / ".join(r["topTitles"][:3]) or "(empty)"
        lines.append(
            f"| {r['id']} | {r['group']} | {'HIT' if r['hit'] else 'MISS'} | {r['factCoverage']*100:.0f}% | {titles} |"
        )

    misses = [r for r in rows if not r["hit"]]
    if misses:
        lines += ["", "## MISS 样例（前 8）", ""]
        for r in misses[:8]:
            lines.append(f"### {r['id']} ({r['group']})")
            lines.append(f"- Q: {r['question']}")
            lines.append(f"- sources: {', '.join(r['sourceFiles'])}")
            lines.append(f"- needles: {', '.join(r['needles'][:8])}")
            lines.append(f"- topTitles: {r['topTitles']}")
            if r["error"]:
                lines.append(f"- error: `{r['error']}`")
            lines.append("")

    report = "\n".join(lines) + "\n"
    Path(args.report).write_text(report, encoding="utf-8")
    Path(args.json_out).write_text(json.dumps({"summary": {"hitAtK": hits / total if total else 0, "avgFactCoverage": avg_fact, "total": total, "hits": hits}, "cases": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(report)
    print(f"wrote {args.report}")
    print(f"wrote {args.json_out}")
    return 0 if hits / total >= 0.5 else 1


if __name__ == "__main__":
    sys.exit(main())
