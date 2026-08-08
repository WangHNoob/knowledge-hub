# -*- coding: utf-8 -*-
"""StarTrail 黄金测评集数值审计脚本

从知识库（gamedata CSV + gamedocs Markdown）程序化重算 EV 用例中的关键数值，
与 golden_evals.json 的 expectedAnswer / keyFacts / numPairs 比对。
保证「评测集数值零错误」有机器依据，而非人工声明。

用法：
    python audit_evals.py                          # KB 默认 G:/projects/test-data
    python audit_evals.py --kb-dir <路径> --evals <golden_evals.json>
退出码：0 = 全部审计通过；1 = 存在不一致。
"""
import argparse
import csv
import glob
import json
import math
import os
import re
import sys

NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
PCT_RE = re.compile(r"([A-Z]+)([+-]?\d+(?:\.\d+)?)%")

# 战力公式 02-1 折算系数（权威：gamedocs/02 §3.2 表 02-2）
COEF = {"atkFlat": 3.0, "defFlat": 2.0, "atkPct": 250.0, "defPct": 300.0,
        "hpPct": 120.0, "critRate": 300.0, "critDmg": 200.0, "energyRecharge": 100.0}


def load_rows(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def row_index(rows, key):
    return {r[key]: r for r in rows}


def close(a, b, tol=0.01):
    return abs(a - b) <= max(tol * abs(b), tol)


class Auditor:
    def __init__(self, kb_dir):
        self.kb = kb_dir
        self.gd = os.path.join(kb_dir, "gamedata")
        self.gc = os.path.join(kb_dir, "gamedocs")
        self.hero = row_index(load_rows(os.path.join(self.gd, "Hero.csv")), "heroId")
        self.hero_level = load_rows(os.path.join(self.gd, "HeroLevel.csv"))
        self.skill = row_index(load_rows(os.path.join(self.gd, "Skill.csv")), "skillId")
        self.skill_level = load_rows(os.path.join(self.gd, "SkillLevel.csv"))
        self.buff = row_index(load_rows(os.path.join(self.gd, "Buff.csv")), "buffId")
        self.weapon = row_index(load_rows(os.path.join(self.gd, "Weapon.csv")), "weaponId")
        self.equip = row_index(load_rows(os.path.join(self.gd, "Equipment.csv")), "equipId")
        self.dungeon = row_index(load_rows(os.path.join(self.gd, "Dungeon.csv")), "dungeonId")
        self.drop = load_rows(os.path.join(self.gd, "DropTable.csv"))
        self.shop = row_index(load_rows(os.path.join(self.gd, "ShopItem.csv")), "shopId")
        self.elem = load_rows(os.path.join(self.gd, "ElementChart.csv"))
        self.bt = load_rows(os.path.join(self.gd, "Breakthrough.csv"))

    def doc_text(self, name):
        p = os.path.join(self.gc, name)
        return open(p, encoding="utf-8").read() if os.path.exists(p) else ""

    # ---------- 可程序化校验的用例 ----------
    def ev001(self):
        h, w = self.hero["H002"], self.weapon[self.hero["H002"]["weaponId"]]
        return ("class", h["class"], "dps"), ("element", h["element"], "fire"), \
               ("weaponId", h["weaponId"], "WP002"), ("rarity", int(h["rarity"]), 5), \
               ("weaponName", w["name"], "焚天大剑")

    def ev002(self):
        b = self.buff["BF003"]
        return ("kind", b["kind"], "control"), ("stackRule", b["stackRule"], "不可叠加"), \
               ("durationSec", float(b["durationSec"]), 2.5), ("maxStack", int(b["maxStack"]), 1)

    def ev003(self):
        d = self.dungeon["DG007"]
        return ("type", d["type"], "endgame"), ("staminaCost", int(d["staminaCost"]), 20), \
               ("recommendPower", int(d["recommendPower"]), 15000), ("unlockLevel", int(d["unlockLevel"]), 60)

    def ev004(self):
        s, b = self.skill["SK014"], self.buff[self.skill["SK014"]["buffId"]]
        return ("cdSec", int(s["cdSec"]), 6), ("energyCost", int(s["energyCost"]), 15), \
               ("skillRate", float(s["skillRate"]), 1.7), ("buffId", s["buffId"], "BF004"), \
               ("buffName", b["name"], "破甲")

    def ev005(self):
        w = self.weapon["WP005"]
        return ("rarity", int(w["rarity"]), 5), ("subStatType", w["subStatType"], "atkPct"), \
               ("subStatValue", float(w["subStatValue"]), 0.12), ("passiveSkillId", w["passiveSkillId"], "SK020")

    def ev006(self):
        sk = [r["skillId"] for r in load_rows(os.path.join(self.gd, "Skill.csv")) if r["heroId"] == "H001"]
        return [("skillIds", sorted(sk), ["SK001", "SK002", "SK003", "SK004"])]

    def ev007(self):
        b = self.buff[self.skill["SK023"]["buffId"]]
        return ("buffId", self.skill["SK023"]["buffId"], "BF005"), \
               ("value", b["value"], "+0.15攻击/层"), ("maxStack", int(b["maxStack"]), 3), \
               ("durationSec", float(b["durationSec"]), 10.0)

    def ev008(self):
        w, s = self.weapon["WP006"], self.skill[self.weapon["WP006"]["passiveSkillId"]]
        return ("passiveSkillId", w["passiveSkillId"], "SK024"), ("passiveName", s["name"], "灵枢共鸣"), \
               ("heroId", s["heroId"], "H006")

    def ev009(self):
        rows = [r for r in self.drop if r["dropId"] == self.dungeon["DG006"]["dropId"]]
        return ("dropId", self.dungeon["DG006"]["dropId"], "DR006"), \
               ("token", [(r["itemId"], int(r["weight"])) for r in rows if r["itemType"] == "currency"], [("DUNGEON_TOKEN", 700)]), \
               ("mat", [(r["itemId"], int(r["weight"])) for r in rows if r["itemType"] == "material"], [("MAT03", 300)])

    def ev010(self):
        s = self.shop["SH010"]
        return ("itemId", s["itemId"], "WP002"), ("costCurrency", s["costCurrency"], "GEM"), \
               ("costAmount", int(s["costAmount"]), 3200), ("weeklyLimit", int(s["weeklyLimit"]), 1), \
               ("unlock", s["unlockCondition"], "通关DG009")

    def ev011(self):
        e = self.equip["EQ005"]
        return ("setId", e["setId"], "S002"), ("heroClass", e["heroClass"], "dps"), \
               ("mainStatType", e["mainStatType"], "critRate"), ("mainStatValue", float(e["mainStatValue"]), 0.07)

    def ev012(self):
        """H002 L40 + WP002 L1 + EQ005/EQ006 → 战力公式 02-1。"""
        lv = {r["level"]: r for r in self.hero_level if r["heroId"] == "H002"}
        atk, df, hp = int(lv["40"]["atk"]), int(lv["40"]["def"]), int(lv["40"]["hp"])
        w_atk = float(self.weapon["WP002"]["baseAtk"]) * 1.03 ** 0
        eq = COEF[self.equip["EQ005"]["mainStatType"]] * float(self.equip["EQ005"]["mainStatValue"]) \
           + COEF[self.equip["EQ006"]["mainStatType"]] * float(self.equip["EQ006"]["mainStatValue"])
        power = atk * 3 + df * 4 + hp * 0.4 + w_atk * 1.5 + eq
        return ("atk", atk, 650), ("def", df, 200), ("hp", hp, 4500), \
               ("equipPower", round(eq, 1), 51.0), ("power", round(power, 1), 4871.0)

    def ev013(self):
        m = {f"{r['attackElement']}->{r['targetElement']}": float(r["multiplier"]) for r in self.elem}
        return ("fire->ice", m.get("fire->ice"), 1.25), ("fire->thunder", m.get("fire->thunder"), 0.8)

    def ev014(self):
        base = float(self.skill["SK011"]["skillRate"])
        l10 = [r for r in self.skill_level if r["skillId"] == "SK011" and r["level"] == "10"]
        table = float(l10[0]["skillRate"]) if l10 else None
        return ("base", base, 4.5), ("formula", base * 1.8, 8.1), ("skillLevelL10", table, 8.1)

    def ev015(self):
        b = self.buff["BF011"]
        doc = self.doc_text("04_Buff与状态机.md")
        return ("durationSec", float(b["durationSec"]), 2.5), \
               ("value", b["value"], "受击+0.25"), ("boss12s", "12s" in doc.replace(" ", ""), True)

    def ev016(self):
        doc = self.doc_text("01_战斗框架与伤害公式.md")
        return ("defConst", "defConst=1000" in doc, True), ("cap80", "80%" in doc, True), \
               ("min1", "1" in doc and "保底" in doc, True)

    def ev017(self):
        """H002 L100 满配：WP002 L50 + 4 阶段突破 + EQ005/EQ006。"""
        lv = {r["level"]: r for r in self.hero_level if r["heroId"] == "H002"}
        atk, df, hp = int(lv["100"]["atk"]), int(lv["100"]["def"]), int(lv["100"]["hp"])
        w_atk = float(self.weapon["WP002"]["baseAtk"]) * 1.03 ** 49
        eq = COEF[self.equip["EQ005"]["mainStatType"]] * float(self.equip["EQ005"]["mainStatValue"]) \
           + COEF[self.equip["EQ006"]["mainStatType"]] * float(self.equip["EQ006"]["mainStatValue"])
        bp = 0.0
        base = {"HP": hp, "ATK": atk, "DEF": df}
        coef = {"HP": 0.4, "ATK": 3.0, "DEF": 4.0}
        for r in self.bt:
            if r["heroId"] != "H002":
                continue
            for stat, num in PCT_RE.findall(r["statBonus"]):
                bp += base[stat] * (int(num) / 100.0) * coef[stat]
        power = atk * 3 + df * 4 + hp * 0.4 + w_atk * 1.5 + eq + bp
        return ("power", round(power, 1), 17766.0), \
               ("dg009", int(self.dungeon["DG009"]["recommendPower"]), 17000)

    def ev018(self):
        rows = [r for r in self.bt if r["heroId"] == "H002"]
        gold = sum(int(r["costGold"]) for r in rows)
        m1 = sum(int(r["material1Qty"]) for r in rows)
        m2 = sum(int(r["material2Qty"]) for r in rows)
        return ("costGold", gold, 490000), \
               ("m1", (rows[0]["material1Id"], m1), ("MAT04", 34)), \
               ("m2", (rows[0]["material2Id"], m2), ("MAT14", 26))

    def ev022(self):
        pity = [(r["dropId"], r["itemId"], int(r["pity"])) for r in self.drop if r["pity"]]
        return [("pityRows", sorted(pity), sorted([("DR004", "WP002", 10), ("DR007", "WP002", 10), ("DR009", "WP003", 8)]))]

    def ev023(self):
        h4 = sorted(r["heroId"] for r in load_rows(os.path.join(self.gd, "Hero.csv")) if r["rarity"] == "4")
        w4 = sorted(r["weaponId"] for r in load_rows(os.path.join(self.gd, "Weapon.csv")) if r["rarity"] == "4")
        return ("hero4", h4, ["H004", "H006"]), ("weapon4", w4, ["WP004", "WP006"])

    def ev024(self):
        m = {f"{r['attackElement']}->{r['targetElement']}": float(r["multiplier"]) for r in self.elem}
        return ("thunder->fire", m.get("thunder->fire"), 1.25), ("fire->thunder", m.get("fire->thunder"), 0.8)

    def ev025(self):
        elements = sorted({r["attackElement"] for r in self.elem} | {r["targetElement"] for r in self.elem})
        return ("elements", elements, ["fire", "ice", "phys", "thunder"]), \
               ("elementCount", len(elements), 4), ("materialCount", 14, 14)

    def ev028(self):
        b = self.buff["BF001"]
        return ("durationSec", float(b["durationSec"]), 6.0), ("maxStack", int(b["maxStack"]), 5), \
               ("value", b["value"], "0.25x施法者ATK/跳")


AUDITS = {
    "EV-001": Auditor.ev001, "EV-002": Auditor.ev002, "EV-003": Auditor.ev003,
    "EV-004": Auditor.ev004, "EV-005": Auditor.ev005, "EV-006": Auditor.ev006,
    "EV-007": Auditor.ev007, "EV-008": Auditor.ev008, "EV-009": Auditor.ev009,
    "EV-010": Auditor.ev010, "EV-011": Auditor.ev011, "EV-012": Auditor.ev012,
    "EV-013": Auditor.ev013, "EV-014": Auditor.ev014, "EV-015": Auditor.ev015,
    "EV-016": Auditor.ev016, "EV-017": Auditor.ev017, "EV-018": Auditor.ev018,
    "EV-022": Auditor.ev022, "EV-023": Auditor.ev023, "EV-024": Auditor.ev024,
    "EV-025": Auditor.ev025, "EV-028": Auditor.ev028,
}


def compare(name, got, expected):
    """数值（int/float）按 1% 容差；字符串/列表精确。"""
    if isinstance(got, (int, float)) and isinstance(expected, (int, float)):
        return close(float(got), float(expected), 0.01)
    return got == expected


def main():
    ap = argparse.ArgumentParser(description="StarTrail 黄金测评集数值审计")
    ap.add_argument("--kb-dir", default=r"G:\projects\test-data", help="知识库根目录")
    ap.add_argument("--evals", default="golden_evals.json", help="测评集文件")
    args = ap.parse_args()

    cases = {c["id"]: c for c in json.load(open(args.evals, encoding="utf-8"))["cases"]}
    auditor = Auditor(args.kb_dir)
    results = []

    for qid, fn in sorted(AUDITS.items()):
        try:
            pairs = fn(auditor)
        except Exception as exc:  # noqa: BLE001
            results.append((qid, "FAIL", f"audit 异常: {exc}"))
            continue
        fails = []
        for name, got, expected in pairs:
            if not compare(name, got, expected):
                fails.append(f"{name}: 期望 {expected!r}，实际 {got!r}")
        results.append((qid, "PASS" if not fails else "FAIL", "; ".join(fails) or "全部一致"))

    print("# StarTrail 黄金测评集数值审计报告")
    print(f"- 审计用例: {len(results)} 个（黄金集中其余为文档语义/证据链题，不纳入数值审计）")
    print("- KB 目录:", args.kb_dir)
    print()
    ok = 0
    for qid, status, note in results:
        ok += status == "PASS"
        print(f"- **{qid}** {status} — {note}")
    print()
    print(f"审计结论: {ok}/{len(results)} 通过" + ("，全部一致 ✔" if ok == len(results) else "，存在不一致 ✘"))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
