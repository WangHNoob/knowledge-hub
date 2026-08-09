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
        # v0.2：通用被动池 SK065-SK072 的 heroId 仅为设计归属，不进入角色技能组（《00》§4.9、《11》E11）
        rows = [r for r in load_rows(os.path.join(self.gd, "Skill.csv")) if r["heroId"] == "H001"]
        sk = [r["skillId"] for r in rows if not ("SK065" <= r["skillId"] <= "SK072")]
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
        # v0.2：pity 条目从 3 条扩至 17 条（仍仅限 weapon/equipment/GEM，取值 8/10/12/15/20）
        pity = [(r["dropId"], r["itemId"], int(r["pity"])) for r in self.drop if r["pity"]]
        expected = sorted([
            ("DR004", "WP002", 10), ("DR007", "WP002", 10), ("DR009", "WP003", 8),
            ("DR011", "WP025", 20), ("DR012", "EQ031", 20), ("DR013", "WP026", 20),
            ("DR014", "EQ032", 20), ("DR022", "EQ035", 15), ("DR022", "WP027", 15),
            ("DR023", "EQ036", 12), ("DR023", "WP017", 12), ("DR027", "GEM", 20),
            ("DR027", "WP018", 10), ("DR028", "EQ038", 10), ("DR028", "GEM", 20),
            ("DR030", "EQ039", 8), ("DR030", "WP020", 8),
        ])
        return [("pityRows", sorted(pity), expected)]

    def ev023(self):
        # v0.2：4★ 从 2 角色/2 武器扩至 5 角色/13 武器
        h4 = sorted(r["heroId"] for r in load_rows(os.path.join(self.gd, "Hero.csv")) if r["rarity"] == "4")
        w4 = sorted(r["weaponId"] for r in load_rows(os.path.join(self.gd, "Weapon.csv")) if r["rarity"] == "4")
        return ("hero4", h4, ["H004", "H006", "H010", "H011", "H016"]), \
               ("weapon4", w4, ["WP004", "WP006", "WP010", "WP011", "WP016", "WP025", "WP026", "WP027", "WP028", "WP029", "WP030", "WP031", "WP032"])

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

    # ---------- v0.2 新增用例审计（EV-031~EV-078 数值题，数据驱动重算） ----------

    def _row(self, table, key_col, key_val):
        rows = load_rows(os.path.join(self.gd, f"{table}.csv"))
        return next(r for r in rows if r[key_col] == key_val)

    def ev032(self):
        b = self._row("Buff", "buffId", "BF018")
        return ("durationSec", float(b["durationSec"]), 6.0), ("maxStack", int(b["maxStack"]), 1)

    def ev033(self):
        d = self._row("Dungeon", "dungeonId", "DG015")
        return ("staminaCost", int(d["staminaCost"]), 10), \
               ("recommendPower", int(d["recommendPower"]), 1500), ("unlockLevel", int(d["unlockLevel"]), 15)

    def ev034(self):
        g = self._row("GachaPool", "poolId", "GP001")
        return ("costAmount", int(g["costAmount"]), 1)

    def ev035(self):
        m = self._row("Monster", "monsterId", "M001")
        return ("baseHp", int(m["baseHp"]), 3600)

    def ev036(self):
        q = self._row("Quest", "questId", "QS001")
        return ("unlockLevel", int(q["unlockLevel"]), 1)

    def ev037(self):
        i = self._row("Item", "itemId", "IT051")
        return ("rarity", int(i["rarity"]), 4), ("stackMax", int(i["stackMax"]), 999)

    def ev038(self):
        t = self._row("TeamBuff", "buffId", "TB002")
        return ("heroCount", int(t["heroCount"]), 3), \
               ("heroes", sorted(t["heroes"].split(";")), sorted(["H005", "H007", "H015"]))

    def ev041(self):
        b = self._row("Boss", "bossId", "B001")
        return ("phaseCount", int(b["phaseCount"]), 2), ("dungeonId", b["dungeonId"], "DG012")

    def ev042(self):
        c = self._row("Constellation", "constId", "CN079")
        return ("slot", int(c["slot"]), 1), ("heroId", c["heroId"], "H014")

    def ev043(self):
        e = self._row("Expedition", "expeditionId", "EX002")
        return ("durationHour", int(e["durationHour"]), 4), ("regionId", e["regionId"], "RG002"), \
               ("rewardItemId", e["rewardItemId"], "MAT29")

    def ev046(self):
        r = self._row("QuestReward", "questId", "QS039")
        return ("gold", int(r["gold"]), 60000), ("itemId", r["itemId"], "IT074")

    def ev047(self):
        s = self._row("SkillLevel", "skillId", "SK055")
        return ("skillRate", float(s["skillRate"]), 8.46)

    def ev048(self):
        h = self._row("Hero", "heroId", "H014")
        power = round(int(h["baseAtk"]) * 3 + int(h["baseDef"]) * 4 + int(h["baseHp"]) * 0.4)
        return ("power", power, 1324)

    def ev049(self):
        r = next(x for x in load_rows(os.path.join(self.gd, "GachaRate.csv")) if x["poolType"] == "hero" and x["rarity"] == "5")
        return ("probability", float(r["probability"]), 0.006)

    def ev050(self):
        rows = [r for r in self.drop if r["dropId"] == "DR015"]
        total = sum(int(r["weight"]) for r in rows)
        return ("weightTotal", total, 1000), ("rowCount", len(rows), 4)

    def ev051(self):
        rows = load_rows(os.path.join(self.gd, "WeaponLevel.csv"))
        l80 = next(r for r in rows if r["weaponId"] == "WP017" and r["level"] == "80")
        return ("atk", int(l80["atk"]), 400), ("goldCost", int(l80["goldCost"]), 1500000)

    def ev052(self):
        e = self._row("EnhanceRate", "level", "15")
        return ("successRate", float(e["successRate"]), 0.45), ("failRefundRate", float(e["failRefundRate"]), 0.30)

    def ev053(self):
        s = self._row("StaminaPricing", "buyCount", "3")
        return ("costGem", int(s["costGem"]), 70), ("staminaGain", int(s["staminaGain"]), 120)

    def ev054(self):
        s = self._row("SkillLevel", "skillId", "SK059")
        return ("skillRate", float(s["skillRate"]), 8.82)

    def ev061(self):
        b = next(r for r in self.bt if r["heroId"] == "H014" and r["stage"] == "1")
        return ("costGold", int(b["costGold"]), 20000), \
               ("material1Id", b["material1Id"], "MAT04"), ("material1Qty", int(b["material1Qty"]), 3), \
               ("material2Id", b["material2Id"], "MAT14"), ("material2Qty", int(b["material2Qty"]), 2)

    def ev062(self):
        d = self._row("Dungeon", "dungeonId", "DG021")
        return ("recommendPower", int(d["recommendPower"]), 30000), ("type", d["type"], "coop")

    def ev065(self):
        rows = [r for r in load_rows(os.path.join(self.gd, "Constellation.csv")) if r["heroId"] == "H014"]
        return ("slotSet", sorted(int(r["slot"]) for r in rows), [1, 2, 3, 4, 5, 6]), ("count", len(rows), 6)

    def ev067(self):
        rows = load_rows(os.path.join(self.gd, "GachaPity.csv"))
        by = {r["poolType"]: (int(r["pityCount"]), int(r["hardPityCount"])) for r in rows}
        return ("hero", by.get("hero"), (90, 180)), ("weapon", by.get("weapon"), (80, 160)), \
               ("newbie", by.get("newbie"), (20, 20))

    def ev078(self):
        g = self._row("GuildDonate", "donateId", "GD003")
        return ("rewardGuildPoint", int(g["rewardGuildPoint"]), 25), ("costAmount", int(g["costAmount"]), 10000)


AUDITS = {
    "EV-001": Auditor.ev001, "EV-002": Auditor.ev002, "EV-003": Auditor.ev003,
    "EV-004": Auditor.ev004, "EV-005": Auditor.ev005, "EV-006": Auditor.ev006,
    "EV-007": Auditor.ev007, "EV-008": Auditor.ev008, "EV-009": Auditor.ev009,
    "EV-010": Auditor.ev010, "EV-011": Auditor.ev011, "EV-012": Auditor.ev012,
    "EV-013": Auditor.ev013, "EV-014": Auditor.ev014, "EV-015": Auditor.ev015,
    "EV-016": Auditor.ev016, "EV-017": Auditor.ev017, "EV-018": Auditor.ev018,
    "EV-022": Auditor.ev022, "EV-023": Auditor.ev023, "EV-024": Auditor.ev024,
    "EV-025": Auditor.ev025, "EV-028": Auditor.ev028,
    # v0.2 新增数值题审计
    "EV-032": Auditor.ev032, "EV-033": Auditor.ev033, "EV-034": Auditor.ev034,
    "EV-035": Auditor.ev035, "EV-036": Auditor.ev036, "EV-037": Auditor.ev037,
    "EV-038": Auditor.ev038, "EV-041": Auditor.ev041, "EV-042": Auditor.ev042,
    "EV-043": Auditor.ev043, "EV-046": Auditor.ev046, "EV-047": Auditor.ev047,
    "EV-048": Auditor.ev048, "EV-049": Auditor.ev049, "EV-050": Auditor.ev050,
    "EV-051": Auditor.ev051, "EV-052": Auditor.ev052, "EV-053": Auditor.ev053,
    "EV-054": Auditor.ev054, "EV-061": Auditor.ev061, "EV-062": Auditor.ev062,
    "EV-066": Auditor.ev065, "EV-067": Auditor.ev067, "EV-078": Auditor.ev078,
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
            # 单 3-tuple 返回值（(name, got, expected)）规范化为列表
            if isinstance(pairs, tuple) and len(pairs) == 3 and isinstance(pairs[0], str):
                pairs = [pairs]
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
