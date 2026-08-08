# -*- coding: utf-8 -*-
"""StarTrail 黄金测评集打分脚本 v2（严格版）

用法：
    python run_eval.py --answers answers.json [--report report.md] [--tolerance 0.05]

answers.json 格式：
    { "EV-001": "class=dps，element=fire，weaponId=WP002 焚天大剑，rarity=5", ... }

匹配规则（严格，与 golden_evals.json meta.scoring 一致）：
    - keyFacts 普通 token  : 精确子串匹配（大小写敏感，如 "BF004"、"maxStack=3"）
    - keyFacts 纯数字      : 精确数字匹配 —— 回答的数字集合中必须存在该数（不做容差）
    - keyFacts "≈N" 前缀   : 数字容差匹配（默认 5%），仅用于文档中明确标注「约」的值
    - numPairs [字段, 值]  : 回答须以 "字段=值" / "字段:值" / "字段 值" 形式给出，值精确匹配
    - 未注册 ID 检测       : 出现注册表之外的 ID 计入幻觉记录；anti_hallucination 题直接 FAIL
      （题目自身 fakeId 除外——正确拒答会提及它）
"""
import argparse
import json
import re
import sys
from collections import defaultdict

ID_PATTERNS = {
    "H": (1, 8), "SK": (1, 32), "BF": (1, 15), "WP": (1, 8),
    "EQ": (1, 10), "DG": (1, 10), "DR": (1, 10), "SH": (1, 12),
}


def registered_ids():
    ids = set()
    for prefix, (lo, hi) in ID_PATTERNS.items():
        width = 3 if prefix in ("H", "SK", "BF", "WP", "EQ", "DG", "DR", "SH") else 2
        ids |= {f"{prefix}{i:0{width}d}" for i in range(lo, hi + 1)}
    ids |= {f"MAT{i:02d}" for i in range(1, 15)}
    ids |= {"S001", "S002", "S003"}
    return ids


REG_IDS = registered_ids()
ID_RE = re.compile(r"\b(H\d{3}|SK\d{3}|BF\d{3}|WP\d{3}|EQ\d{3}|DG\d{3}|DR\d{3}|SH\d{3}|MAT\d{2}|S\d{3})\b")
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
FIELD_RE = re.compile(r"(\w+)\s*[=:：]\s*(-?\d+(?:\.\d+)?)|\b(\w+)\s+(-?\d+(?:\.\d+)?)")
RANGE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|~|–|—|至|到)\s*(\d+(?:\.\d+)?)")


def answer_numbers(answer):
    nums = [float(m) for m in NUM_RE.findall(answer)]
    for a, b in RANGE_RE.findall(answer):  # 区间写法（如 8-10 万）两端点都提取，避免 -10 误读
        nums.append(float(a))
        nums.append(float(b))
    return nums


def match_approx(target, candidates, tolerance):
    return any(abs(target - c) <= max(tolerance * abs(target), tolerance) for c in candidates)


def fact_hit(key_fact, answer, numbers, tolerance):
    """三态匹配：≈ 前缀 → 容差；纯数字 → 精确数字；其余 → 精确子串。"""
    if key_fact.startswith("≈"):
        try:
            target = float(key_fact[1:])
        except ValueError:
            return key_fact in answer
        return match_approx(target, numbers, tolerance)
    if NUM_RE.fullmatch(key_fact.strip()):
        return float(key_fact) in numbers  # 精确相等，不做容差
    return key_fact in answer


def num_pairs_hit(num_pairs, answer, numbers, tolerance):
    """校验「字段=值」对。字段必须出现且数值匹配（numPairs 为精确期望，≈ 前缀除外）。"""
    if not num_pairs:
        return None, []
    fields_present = {m.group(1) or m.group(3) for m in FIELD_RE.finditer(answer)}
    miss = []
    for field, value in num_pairs:
        # 字段必须在回答中以「字段=值/字段:值/字段 值」形式出现
        pat = re.compile(r"\b" + re.escape(field) + r"\s*[=:：]\s*(-?\d+(?:\.\d+)?)|\b" + re.escape(field) + r"\s+(-?\d+(?:\.\d+)?)")
        m = pat.search(answer)
        if not m:
            miss.append((field, value, "field missing"))
            continue
        got = float(m.group(1) or m.group(2))
        if isinstance(value, str) and value.startswith("≈"):
            ok = match_approx(float(value[1:]), [got], tolerance)
        else:
            ok = (got == float(value))
        if not ok:
            miss.append((field, value, f"value mismatch: got {got}"))
    return (len(miss) == 0, miss)


def main():
    ap = argparse.ArgumentParser(description="StarTrail 黄金测评集打分（严格版）")
    ap.add_argument("--answers", required=True, help="Agent 回答 JSON（{qid: text}）")
    ap.add_argument("--cases", default="golden_evals.json", help="测评集文件")
    ap.add_argument("--report", default=None, help="输出 Markdown 报告路径（默认打印到 stdout）")
    ap.add_argument("--tolerance", type=float, default=0.05, help="≈ 前缀数值容差（默认 5%）")
    args = ap.parse_args()

    cases = json.load(open(args.cases, encoding="utf-8"))["cases"]
    answers = json.load(open(args.answers, encoding="utf-8"))
    tol = args.tolerance

    results, stats = [], defaultdict(int)
    hallucinated = []

    for case in cases:
        qid, group = case["id"], case["group"]
        answer = answers.get(qid, "")
        if not answer:
            results.append((qid, group, "FAIL", "missing answer"))
            stats["missing"] += 1
            continue

        numbers = answer_numbers(answer)
        hits = [f for f in case["keyFacts"] if fact_hit(f, answer, numbers, tol)]
        np_ok, np_miss = num_pairs_hit(case.get("numPairs", []), answer, numbers, tol)

        # 未注册 ID 检测（防幻觉）；排除题目自身 fakeId
        exclude_fake = {case.get("fakeId", "")}
        fake_ids = [m for m in ID_RE.findall(answer) if m not in REG_IDS and m not in exclude_fake]

        notes = []
        if fake_ids:
            notes.append(f"未注册ID: {sorted(set(fake_ids))}")
            hallucinated.append((qid, sorted(set(fake_ids))))
        if np_miss:
            notes.append("numPairs不符: " + "; ".join(f"{f}={v}({why})" for f, v, why in np_miss))

        key_ratio = len(hits) / len(case["keyFacts"]) if case["keyFacts"] else 1.0
        num_ok = np_ok is not False  # True=通过；None=该题无 numPairs（视为通过）
        hallucination_fail = (group == "anti_hallucination" and fake_ids)
        num_fail = (np_ok is False)

        if hallucination_fail or num_fail or key_ratio == 0.0:
            status = "FAIL"
        elif key_ratio == 1.0 and num_ok:
            status = "PASS"
        else:
            status = "PARTIAL"

        detail = f"keyFacts {len(hits)}/{len(case['keyFacts'])}" + (("; " + "; ".join(notes)) if notes else "")
        results.append((qid, group, status, detail))
        stats[status.lower()] += 1

    total = len(cases)
    passed, partial, failed = stats["pass"], stats["partial"], stats["fail"] + stats["missing"]
    score = (passed + 0.5 * partial) / total * 100

    lines = [
        "# StarTrail 黄金测评集报告（严格版 v2）",
        "",
        f"- 总题数: {total} | PASS: {passed} | PARTIAL: {partial} | FAIL: {failed}",
        f"- 综合得分: {score:.1f} / 100（PASS=1，PARTIAL=0.5）",
        f"- 数值规则: 精确匹配为主；≈ 前缀容差 {tol * 100:.0f}%",
        "",
        "## 分组表现",
        "",
        "| 分组 | PASS | PARTIAL | FAIL |",
        "|------|------|---------|------|",
    ]
    by_group = defaultdict(lambda: [0, 0, 0])
    for qid, group, status, _ in results:
        idx = 0 if status == "PASS" else (1 if status == "PARTIAL" else 2)
        by_group[group][idx] += 1
    for g, (p, pt, f) in sorted(by_group.items()):
        lines.append(f"| {g} | {p} | {pt} | {f} |")

    lines += ["", "## 逐题明细", ""]
    for qid, group, status, detail in results:
        lines.append(f"- **{qid}** [{group}] **{status}** — {detail}")

    if hallucinated:
        lines += ["", "## 幻觉记录", ""]
        for qid, ids in hallucinated:
            lines.append(f"- {qid}: 出现未注册 ID {ids}")

    report = "\n".join(lines)
    if args.report:
        open(args.report, "w", encoding="utf-8").write(report + "\n")
    print(report)
    return 0 if failed == 0 and not hallucinated else 1


if __name__ == "__main__":
    sys.exit(main())
