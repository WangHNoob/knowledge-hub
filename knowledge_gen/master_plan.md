# StarTrail 模拟知识库 v0.2 扩充 · 生成主计划（Generation Master Plan）

> 本文件是 v0.2 扩充的**生成契约**：所有子 Agent 必须只依据本文件 + `knowledge/` 内既有文件生成内容。
> 本文件位于 `knowledge_gen/`，**不属于知识库本体**（`knowledge/` 整体为初始资料，会被导入 knowledge-hub 加工管线）。
> 配套校验脚本：`knowledge_gen/validate.mjs`（自检依据，等价于《10_配表规范与外键约定》§4 的扩展版）。

## 0. 目标与范围

| 项 | v0.1（现状） | v0.2（目标） |
|----|-------------|-------------|
| 策划文档 gamedocs/ | 13 篇（00–12） | **51 篇**（00–50，新增 13–50 共 38 篇） |
| 配表 gamedata/ | 12 张 CSV | **204 张 CSV**（新增 192 张） |
| 角色 | 8（H001–H008） | 16（+H009–H016） |
| 技能 | 32（SK001–SK032） | 72（+SK033–SK064 角色技能，+SK065–SK072 通用被动池） |
| Buff | 15（BF001–BF015） | 30（+BF016–BF030） |
| 武器 | 8（WP001–WP008） | 32（+WP009–WP032） |
| 装备 | 10（EQ001–EQ010）/ 3 套 | 40（+EQ011–EQ040）/ 8 套 |
| 副本 | 10（DG001–DG010） | 40（+DG011–DG040） |
| 掉落组 | 10（DR001–DR010） | 40（+DR011–DR040） |
| 商店 | 12（SH001–SH012） | 48（+SH013–SH048） |
| 材料 | 14（MAT01–MAT14） | 40（+MAT15–MAT40） |
| 怪物 / 精英 / 首领 | — | M001–M080 / EM001–EM016 / B001–B012 |
| 物品 / 任务 / 成就 | — | IT001–IT200 / QS001–QS120 / AC001–AC080 |

**铁律（违反即不合格）**：
1. **只增不改**：既有 13 篇文档与 12 张表的既有行/既有 ID **一律不动**（新增表独立；既有表只在末尾追加新行）。
2. **只引用注册 ID**：所有新内容（文档叙述与表格行）只能使用 §2 注册的 ID，禁止发明未注册 ID。
3. **外键闭合**：子表出现的每个父 ID 必须在父表存在（`validate.mjs` 逐条校验）。
4. **公式唯一**：伤害/战力/能量/成长曲线/经济锚点全部沿用 §1.2，禁止另立新公式或改值。
5. **可追溯**：每篇新文档必须含「配表引用」表（ID 与表真实存在）+ 至少 1 处 `参见《NN_…》` 显式引用。

---

## 1. 全局不变量（所有模块必须遵守）

### 1.1 世界观与产品设定（禁止换世界观）

《星轨猎手》（代号 StarTrail）——第三人称即时制二次元 ARPG 手游。单人主线 + 组队副本 + 轻度 PVP。
核心循环：刷本拿材料 → 养成角色/武器/技能 → 挑战更高难度副本 → 获得更高阶材料。
战斗：即时制，技能有 CD / 能量 / Buff / 元素克制（fire/ice/thunder/phys 四元素三角克制）。
经济：金币、体力、副本掉落、商店兑换，禁止无限膨胀链路。

### 1.2 公式与数值权威（沿用 v0.1，禁止改值）

- **伤害公式 01-1**（《01_战斗框架与伤害公式》§2）：
  `基础伤害 = ATK × skillRate × (1 − DEF/(DEF + defConst)) × elemMul × brokenMul × reactionMul`
  `最终伤害 = 基础伤害 × (crit ? critMul : 1) × Σbuff修正 × (1 − 目标减伤)`
  - `defConst = 1000`；减伤率上限 **80%**；最低伤害保底 **≥ 1**。
  - `elemMul` 唯一数据源 = ElementChart.csv（三角克制：fire→ice→thunder→fire，phys 全中性，数值 1.25/0.80/1.00）。
  - `critMul = 1.5 + 暴击伤害加成`；基础暴击率 5%、暴伤 50%。
  - `brokenMul = 1.25`（破韧【BF011】）；反应修正见【BF012 融化 1.5×】【BF013 超载 0.5×ATK 爆炸】【BF014 超导 −30% 防御】。
  - DoT 不吃 elemMul 与暴击，但吃防御减伤与破韧修正。
- **战力公式 02-1**（《02_属性体系与战力评估》§3.1）：
  `Power = round( ATK×3 + DEF×4 + HP×0.4 + weaponAtk×1.5 + equipPower + breakthroughPower )`
  - 主词条折算系数（表 02-2）：atkFlat=3 / defFlat=2 / atkPct=250 / defPct=300 / hpPct=120 / critRate=300 / critDmg=200 / energyRecharge=100（按 1.00=100% 折算）。
  - **coop 副本 recommendPower 为队伍总战力口径（≈单人×3）**，其余为单人口径。
- **能量循环**（《03_技能系统设计》§2.2）：上限 100；终结技消耗 100；普攻命中 +10、战技释放 +15、受击 +5、击杀 +10。
- **技能类型约束**：normal（cd=0, energy=0, 命中回能）；skill（cd 6–12s, energy 15–25）；ult（cd 22–30s, energy=100）；passive（cd=-, energy=-, skillRate=0，不参与 SkillLevel）。
- **技能成长**（§4.1）：等级 1–10；L1 基准 = Skill.csv.skillRate；`skillRate(L) = base × 1.089^(L-1)`（L10 = L1 × 1.8）；SkillLevel.csv 每主动技能 1 行记录 L10 断点；升级消耗金币 + 技能书（MAT08/09/10），累计消耗段内逐级 ×1.2。
- **角色等级成长**：HeroLevel 采样等级 `1/20/40/60/100`，expToNext `2000/8000/20000/42000/0`（L100 为 0），断点间线性插值。
- **突破**：4 阶段，levelReq `20/40/60/80`，costGold `2万/5万/12万/30万`，statBonus 依次 `+4%/+4%/+6%/+8%`（HP/ATK/DEF 轮换，见既有 Breakthrough.csv 模式）。
- **掉落**：同一 dropId 内 weight 合计 **= 1000**；minQty–maxQty 均匀随机；pity 按 dropId+itemId 独立计数（pity=n 表示连续 n-1 次未中第 n 次必出）。
- **经济锚点**：1 体力 ≈ 500 金币等值；GEM 兑金币汇率 30 GEM = 20000 GOLD（SH002）。
- **战力数量级对照**（Dungeon.recommendPower 必须与战力公式同数量级）：L1 裸装 ≈ 1400–1600；L40 ≈ 4800–5000；L60 ≈ 9000–9500；L100 满配 ≈ 16000–18000。

### 1.3 枚举 token（全库唯一，新增部分加粗）

| 枚举 | token 集合 |
|------|-----------|
| element | fire / ice / thunder / phys |
| class | tank / dps / support |
| skillType | normal / skill / ult / passive |
| slot | head / body / feet / accessory |
| rarity | 4 / 5 |
| dungeonType | main / coop / endgame / pvp / material / **event** |
| itemType | weapon / equipment / material / currency / stamina / **consumable / ticket / collection / box / pet / misc** |
| currency | GOLD / GEM / STAMINA / DUNGEON_TOKEN / ARENA_POINT / **GUILD_POINT / EVENT_TOKEN** |
| questType | **main / side / weekly / companion** |
| monsterType | **normal / elite** |
| buffKind | dot / control / stat / shield / reaction / stance / **energy / lifesteal / immune / counter** |
| gachaType | **hero / weapon / mixed / newbie / rerun** |
| mainStatType | atkFlat / defFlat / atkPct / defPct / hpPct / critRate / critDmg / energyRecharge |
| 突破材料→角色映射 | MAT04=fire 系角色(H002/H008/H010/H014/H016)，MAT05=ice(H001/H005/H007/H011/H015)，MAT06=thunder(H003/H006/H009)，MAT07=phys(H004/H012/H013)（沿用 v0.1 语义扩展） |

### 1.4 文件约定

- CSV：UTF-8（无 BOM）、LF 行尾、表头仅第 1 行且 camelCase、字段分隔半角逗号、多值字段用半角分号 `;`、可空字段留空单元格（禁填 null 字样）、布尔 TRUE/FALSE、小数点号、数值字段禁单位与百分号。
- 行数：普通表 8–200 行；机械性成长表（等级/强化曲线）可超 200 行，但需在模块总结中说明。
- 主键唯一非空（每表在 §3 声明主键）。
- 文档模板（每篇必含 6 节）：背景与目标 / 规则正文（分节含边界）/ 关键公式·状态机·流程（mermaid 或步骤列表）/ 与其他系统的接口 / 配表引用（表名+关键字段+用到的 ID/规则+用途）/ 未决问题与风险（2–4 条）。
- 文档命名：`NN_中文标题.md`（NN 为 §4 编号）；文档标题行 `# NN 中文标题`。
- 正文提到具体对象时写：`角色【H009 苍霆·御】的终结技【SK035 天霆神罚】…`（中文名+ID 成对出现）。

---

## 2. ID 注册表（v0.2 扩展，全库唯一权威）

> v0.1 注册的 H001–H008 / SK001–SK032 / BF001–BF015 / WP001–WP008 / EQ001–EQ010 / S001–S003 / DG001–DG010 / DR001–DR010 / SH001–SH012 / MAT01–MAT14 保持原义，本节省略；只列**新增**部分。完整注册表由「00 文档 v0.2 更新」写入（生成开始时即完成）。

### 2.1 角色 HeroID（新增 H009–H016）

| HeroID | 名称 | class | element | rarity | 突破材料 | 备注 |
|--------|------|-------|---------|--------|----------|------|
| H009 | 苍霆·御 | tank | thunder | 5 | MAT06 | 雷盾坦克，护盾+反伤 |
| H010 | 流火·漪 | dps | fire | 4 | MAT04 | 火法，范围灼烧 |
| H011 | 霜影·雎 | dps | ice | 4 | MAT05 | 冰刺刺客，暴击 |
| H012 | 磐岩·岳 | tank | phys | 5 | MAT07 | 物理坦克，破韧特化 |
| H013 | 圣歌·祈 | support | phys | 5 | MAT07 | 增益+能量辅助 |
| H014 | 燎原·羽 | dps | fire | 5 | MAT04 | 火弓爆发 |
| H015 | 冰棱·朔 | dps | ice | 5 | MAT05 | 冰枪高倍率 |
| H016 | 秘火·莲 | support | fire | 4 | MAT04 | 火奶+护盾 |

### 2.2 技能 SkillID（新增 SK033–SK072）

每个新角色 4 技能（normal/skill/ult/passive），编号连续：

| 角色 | normal | skill | ult | passive |
|------|--------|-------|-----|---------|
| H009 苍霆·御 | SK033 霆御斩(0.88) | SK034 雷纹壁垒(1.25, BF020) | SK035 天霆神罚(3.60, BF016) | SK036 不灭雷躯(BF017 沉默免疫→改 BF020) |
| H010 流火·漪 | SK037 流火弹(0.72) | SK038 焰潮(1.80, BF001) | SK039 星火燎原(4.00, BF001) | SK040 灼热之心(BF005) |
| H011 霜影·雎 | SK041 霜刺(0.95) | SK042 影袭·冰(1.75, BF009) | SK043 冰狱万刃(4.30, BF003) | SK044 霜刃之舞(BF007) |
| H012 磐岩·岳 | SK045 岩锤重击(0.92) | SK046 大地震击(1.50, BF011) | SK047 天崩地裂(3.80, BF016) | SK048 磐石之志(BF020) |
| H013 圣歌·祈 | SK049 圣歌咏叹(0.68) | SK050 祈愿之光(0.95, BF008) | SK051 天启圣咏(2.20, BF005) | SK052 虔诚祷言(BF022) |
| H014 燎原·羽 | SK053 燎原箭(0.90) | SK054 烈焰连珠(1.95, BF001) | SK055 焚天之羽(4.70, BF001) | SK056 燎火之魂(BF007) |
| H015 冰棱·朔 | SK057 冰棱枪(0.93) | SK058 寒枪突刺(2.05, BF009) | SK059 千棱冰狱(4.90, BF003) | SK060 朔风之息(BF007) |
| H016 秘火·莲 | SK061 秘火弹(0.70) | SK062 莲火庇护(0.85, BF006) | SK063 圣莲绽放(2.40, BF008) | SK064 莲心之火(BF025) |

- 技能 CD/能量必须遵守 §1.2 类型约束；新角色 skill 的 cd 6–12s、energy 15–25；ult 的 cd 22–30s、energy 100；倍率与同定位 v0.1 角色同量级（tank 普攻 0.85–0.95、skill 1.1–1.5、ult 3.2–3.8；dps 普攻 0.72–0.95、skill 1.75–2.2、ult 4.0–4.9；support 普攻 0.68–0.75、skill 0.85–1.0、ult 2.2–2.8）。
- **通用被动池 SK065–SK072**（5★ 掉落武器 WP017–WP024 的被动，heroId 填设计归属角色，00 文档注明「通用被动不进入角色技能组」）：

| SkillID | 名称 | 归属(heroId) | 效果 |
|---------|------|-------------|------|
| SK065 | 通用·战意 | H002 | 攻击 +8% |
| SK066 | 通用·锋锐 | H003 | 暴击率 +5% |
| SK067 | 通用·坚韧 | H001 | 防御 +10% |
| SK068 | 通用·疾风 | H007 | 攻速档位 +0.1 |
| SK069 | 通用·重击 | H004 | 暴击伤害 +12% |
| SK070 | 通用·圣护 | H006 | 护盾量 +12% |
| SK071 | 通用·凝霜 | H005 | 冰伤 +6% |
| SK072 | 通用·燃魂 | H008 | 火伤 +6% |

（通用被动：skillType=passive, cdSec=-, energyCost=-, element=归属角色元素, skillRate=0, buffId 可空, description 写明效果）

### 2.3 BuffID（新增 BF016–BF030）

| BuffID | 名称 | kind | 规则 |
|--------|------|------|------|
| BF016 | 眩晕 | control | 不可叠加，2s，不可行动 |
| BF017 | 沉默 | control | 不可叠加，2.5s，禁用战技/终结技 |
| BF018 | 易伤 | stat | 刷新，6s，受伤加深 25% |
| BF019 | 攻击降低 | stat | 刷新，8s，-20% 攻击 |
| BF020 | 防御提升 | stat | 叠层，8s，+12% 防御/层，max 3 |
| BF021 | 元素穿透 | stat | 刷新，6s，+15% 元素穿透 |
| BF022 | 能量回复 | energy | 刷新，5s，每 2s +8 能量 |
| BF023 | 吸血 | lifesteal | 刷新，6s，吸血率 15% |
| BF024 | 无敌 | immune | 不可叠加，3s，免疫伤害与负面 |
| BF025 | 治疗提升 | stat | 刷新，10s，+20% 治疗量 |
| BF026 | 反击 | counter | 刷新，8s，受击时 0.30×ATK 反击 |
| BF027 | 击退 | control | 不可叠加，0.5s，位移 |
| BF028 | 浮空 | control | 不可叠加，1.2s，无法行动 |
| BF029 | 攻速提升 | stat | 叠层，8s，+0.10 攻速/层，max 3 |
| BF030 | 移速提升 | stat | 刷新，6s，+25% 移速 |

### 2.4 武器 WeaponID（新增 WP009–WP032）

签名武器（heroId 绑定）：

| weaponId | 名称 | rarity | baseAtk | subStatType | subStatValue | passiveSkillId | 归属 |
|----------|------|--------|---------|-------------|--------------|----------------|------|
| WP009 | 霆渊雷盾 | 5 | 155 | defPct | 0.18 | SK036 | H009 |
| WP010 | 流火法杖 | 4 | 130 | atkPct | 0.10 | SK040 | H010 |
| WP011 | 霜影双刺 | 4 | 138 | critRate | 0.09 | SK044 | H011 |
| WP012 | 磐岩重锤 | 5 | 165 | hpPct | 0.15 | SK048 | H012 |
| WP013 | 圣歌权杖 | 5 | 115 | energyRecharge | 0.15 | SK052 | H013 |
| WP014 | 燎原长弓 | 5 | 172 | atkPct | 0.14 | SK056 | H014 |
| WP015 | 冰棱长枪 | 5 | 178 | critRate | 0.12 | SK060 | H015 |
| WP016 | 秘火圣铃 | 4 | 122 | defPct | 0.12 | SK064 | H016 |

掉落/卡池武器（5★ 有被动 → 通用被动池；4★ passiveSkillId 留空，行使「可空」语义）：

| weaponId | 名称 | rarity | baseAtk | subStatType | subStatValue | passiveSkillId |
|----------|------|--------|---------|-------------|--------------|----------------|
| WP017 | 赤焰大剑 | 5 | 182 | atkPct | 0.16 | SK065 |
| WP018 | 霜痕长枪 | 5 | 176 | critRate | 0.13 | SK066 |
| WP019 | 玄铁重盾 | 5 | 152 | defPct | 0.20 | SK067 |
| WP020 | 疾风双刃 | 5 | 170 | critRate | 0.11 | SK068 |
| WP021 | 断影匕首 | 5 | 168 | critDmg | 0.14 | SK069 |
| WP022 | 圣辉法典 | 5 | 118 | energyRecharge | 0.18 | SK070 |
| WP023 | 霜华法杖·改 | 5 | 124 | atkPct | 0.13 | SK071 |
| WP024 | 燃魂巨剑 | 5 | 185 | critDmg | 0.16 | SK072 |
| WP025 | 铁脊大剑 | 4 | 140 | atkPct | 0.10 | （空） |
| WP026 | 猎风长弓 | 4 | 138 | critRate | 0.09 | （空） |
| WP027 | 守夜长枪 | 4 | 142 | defPct | 0.12 | （空） |
| WP028 | 短柄双刃 | 4 | 135 | critRate | 0.08 | （空） |
| WP029 | 学徒法杖 | 4 | 118 | atkPct | 0.09 | （空） |
| WP030 | 祈祷铃 | 4 | 120 | energyRecharge | 0.12 | （空） |
| WP031 | 斥候匕首 | 4 | 132 | critDmg | 0.10 | （空） |
| WP032 | 圆盾 | 4 | 128 | hpPct | 0.12 | （空） |

### 2.5 装备 EquipID（新增 EQ011–EQ040）与套装 SetID（新增 S004–S008）

| 套装 | 名称 | rarity | 定位 | 部件（equipId / 槽位 / 主词条） |
|------|------|--------|------|--------------------------------|
| S004 | 雷霆 | 5 | dps | EQ011 雷霆之冠 head critRate 0.08 / EQ012 雷霆战铠 body atkPct 0.14 / EQ013 雷霆战靴 feet critDmg 0.18 / EQ014 雷霆坠饰 accessory energyRecharge 0.15 |
| S005 | 磐岩 | 5 | tank | EQ015 磐岩之盔 head hpPct 0.14 / EQ016 磐岩战铠 body defPct 0.18 / EQ017 磐岩护足 feet defFlat 120 / EQ018 磐岩徽章 accessory hpPct 0.15 |
| S006 | 圣歌 | 5 | support | EQ019 圣歌之冠 head hpPct 0.13 / EQ020 圣歌法袍 body energyRecharge 0.18 / EQ021 圣歌之靴 feet defPct 0.15 / EQ022 圣歌吊坠 accessory atkFlat 55 |
| S007 | 苍焰 | 4 | dps | EQ023 苍焰之冠 head critRate 0.06 / EQ024 苍焰战铠 body atkPct 0.10 / EQ025 苍焰战靴 feet atkFlat 80 / EQ026 苍焰徽记 accessory critDmg 0.12 |
| S008 | 星芒 | 4 | all | EQ027 星芒之冠 head hpPct 0.10 / EQ028 星芒战铠 body defPct 0.12 / EQ029 星芒之靴 feet atkPct 0.08 / EQ030 星芒吊坠 accessory defFlat 70 |

散件（off-set，heroClass 见列）：EQ031 独行护额 4★ head critRate 0.05 all / EQ032 角斗士胸甲 4★ body atkPct 0.09 all / EQ033 疾行护腿 4★ feet defFlat 60 all / EQ034 行者吊坠 4★ accessory hpPct 0.10 all / EQ035 炎狱护额 5★ head atkPct 0.10 dps / EQ036 冰封战甲 5★ body hpPct 0.14 tank / EQ037 雷闪护腿 5★ feet critRate 0.06 dps / EQ038 生命之坠 5★ accessory hpPct 0.16 support / EQ039 狩猎者护额 5★ head critDmg 0.12 dps / EQ040 远征者徽记 5★ accessory energyRecharge 0.16 all

### 2.6 副本 DungeonID（新增 DG011–DG040，含 dropId 映射）

| dungeonId | 名称 | type | staminaCost | recommendPower | dropId | unlockLevel |
|-----------|------|------|-------------|----------------|--------|-------------|
| DG011 | 星轨遗迹·表层 | main | 12 | 5200 | DR011 | 30 |
| DG012 | 旧都废墟·I | main | 12 | 6200 | DR012 | 35 |
| DG013 | 旧都废墟·II | main | 15 | 8600 | DR013 | 42 |
| DG014 | 深渊回廊 | main | 15 | 9800 | DR014 | 48 |
| DG015 | 元素试炼·火 | material | 10 | 1500 | DR015 | 15 |
| DG016 | 元素试炼·冰 | material | 10 | 1500 | DR016 | 15 |
| DG017 | 元素试炼·雷 | material | 10 | 1500 | DR017 | 15 |
| DG018 | 材料本·强化合金 | material | 12 | 6000 | DR018 | 28 |
| DG019 | 材料本·技能书 | material | 12 | 6000 | DR019 | 28 |
| DG020 | 材料本·经验书 | material | 12 | 6000 | DR020 | 28 |
| DG021 | 影渊裂谷·深层 | coop | 20 | 30000 | DR021 | 55 |
| DG022 | 虚境试炼·中层 | endgame | 20 | 22000 | DR022 | 62 |
| DG023 | 虚境试炼·高层 | endgame | 25 | 32000 | DR023 | 75 |
| DG024 | 竞技场·中级 | pvp | 0 | 8000 | DR024 | 30 |
| DG025 | 竞技场·高级 | pvp | 0 | 18000 | DR025 | 55 |
| DG026 | 黄金矿脉·深层 | material | 15 | 5000 | DR026 | 40 |
| DG027 | 深渊讨伐·I | endgame | 25 | 26000 | DR027 | 65 |
| DG028 | 深渊讨伐·II | endgame | 30 | 36000 | DR028 | 75 |
| DG029 | 元素回廊·EX | endgame | 30 | 40000 | DR029 | 85 |
| DG030 | 星轨遗迹·EX-II | main | 30 | 22000 | DR030 | 90 |
| DG031 | 夏日庆典·训练场 | event | 10 | 2000 | DR031 | 5 |
| DG032 | 周年庆·记忆回廊 | event | 15 | 12000 | DR032 | 40 |
| DG033 | 公会试炼场 | coop | 20 | 16000 | DR033 | 35 |
| DG034 | 联机演练·I | coop | 15 | 9000 | DR034 | 25 |
| DG035 | 联机演练·II | coop | 20 | 20000 | DR035 | 50 |
| DG036 | 装备本·词条房 | material | 15 | 14000 | DR036 | 38 |
| DG037 | 装备本·强化房 | material | 15 | 14000 | DR037 | 38 |
| DG038 | 突破本·通用 | material | 12 | 7500 | DR038 | 25 |
| DG039 | 虚境之渊（爬塔入口） | endgame | 10 | 5000 | DR039 | 60 |
| DG040 | 限时·星屑秘境 | event | 20 | 28000 | DR040 | 50 |

（coop 类型 = 队伍总战力口径；pvp staminaCost=0。recommendPower 需与 §1.2 战力数量级一致。）

### 2.7 掉落 DropID（新增 DR011–DR050）

映射见 §2.6（dropId 与 dungeonId 一一对应，DR0NN ↔ DG0NN）。DR 明细行由 M6 设计，规则：weight 合计 1000；itemType 遵守 §1.3；新掉落可含 WP009–WP032 武器、EQ011–EQ040 装备、MAT15–MAT40 材料、IT 物品、货币（含 GUILD_POINT/EVENT_TOKEN）；保底 pity 仅用于武器/装备/星钻。

### 2.8 商店 ShopID（新增 SH013–SH048）

由 M9 设计（36 个新商品），规则：costCurrency ∈ 货币枚举；itemType+itemId 外键闭合；每周限购 weeklyLimit；unlockCondition 写「通关 DGxxx」或「解锁功能 FUxxx」。建议分布：金币商店 8、星钻商店 6、组队代币 6、竞技积分 5、公会点 5、活动代币 4、体力 2。

### 2.9 材料 MaterialID（新增 MAT15–MAT40）

| materialId | 名称 | 用途 |
|------------|------|------|
| MAT15 | 秘银合金 | 武器强化 L51–80 |
| MAT16 | 武器突破晶石 | 武器突破（4/5★） |
| MAT17 | 装备强化晶核 | 装备强化 |
| MAT18 | 词条洗练石 | 装备词条洗练 |
| MAT19 | 命星结晶 | 命座（星魂）升级 |
| MAT20 | 好感信物 | 好感度升级 |
| MAT21 | 远征凭证 | 远征派遣消耗 |
| MAT22 | 公会徽章 | 公会商店兑换 |
| MAT23 | 竞技勋章 | 排位/竞技商店兑换 |
| MAT24 | 庆典代币 | 庆典活动商店 |
| MAT25 | 周年代币 | 周年活动商店 |
| MAT26 | 深渊印记 | 终局兑换（深渊/虚境） |
| MAT27 | 合成催化剂 | 高级合成辅助 |
| MAT28 | 宠物口粮 | 宠物养成 |
| MAT29 | 图鉴碎片 | 图鉴解锁 |
| MAT30 | 强化秘卷 | 装备强化保底道具 |
| MAT31 | 火元素精华 | 元素附魔/觉醒（fire） |
| MAT32 | 冰元素精华 | 元素附魔/觉醒（ice） |
| MAT33 | 雷元素精华 | 元素附魔/觉醒（thunder） |
| MAT34 | 物理元素精华 | 元素附魔/觉醒（phys） |
| MAT35 | 通用技能卷轴 | 技能升级通用材料 |
| MAT36 | 经验结晶·大 | 角色经验 50000/个 |
| MAT37 | 星辉结晶 | 星辉商店兑换 |
| MAT38 | 装备图纸·四星 | 锻造 4★ 装备 |
| MAT39 | 装备图纸·五星 | 锻造 5★ 装备 |
| MAT40 | 传说锻造石 | 锻造 5★ 武器 |

### 2.10 怪物 MonsterID（M001–M080）、精英 EM001–EM016、首领 B001–B012

**普通怪 M001–M080**（每元素 20 只；M009/M010/M019/M020/M029/M030/M039/M040/M049/M050/M059/M060/M069/M070/M079/M080 共 16 只为 elite）：

- fire（M001–M020）：M001 烬火幼狼, M002 熔岩甲虫, M003 火鸦, M004 烈焰行者, M005 爆炎魔像, M006 硫磺守卫, M007 炎鳞蛇, M008 烬火猎手, M009 熔核巨人(精英), M010 炎魔学徒(精英), M011 焚风使, M012 烈阳傀儡, M013 火蜥蜴骑士, M014 赤焰术士, M015 熔火巨兽, M016 爆炎猎犬, M017 灰烬法师, M018 火刑官, M019 深渊炎魔(精英), M020 烬灭领主(精英)
- ice（M021–M040）：M021 霜原狼, M022 冰晶蛛, M023 寒鸦, M024 霜甲卫兵, M025 冻土巨像, M026 冰霜使徒, M027 雪纹蛇, M028 凝霜猎手, M029 冰川巨人(精英), M030 冰魔学徒(精英), M031 寒潮使, M032 冰棱傀儡, M033 霜狼骑士, M034 极寒术士, M035 冰川巨兽, M036 寒霜猎犬, M037 霜语法师, M038 冰刑官, M039 深渊霜魔(精英), M040 凛冬领主(精英)
- thunder（M041–M060）：M041 雷狐, M042 电弧甲虫, M043 雷鸦, M044 雷霆行者, M045 闪电魔像, M046 霆光守卫, M047 电纹蛇, M048 雷暴猎手, M049 雷鸣巨人(精英), M050 雷魔学徒(精英), M051 霆击使, M052 闪电傀儡, M053 雷狼骑士, M054 雷霆术士, M055 雷鸣巨兽, M056 电弧猎犬, M057 霆语法师, M058 雷刑官, M059 深渊雷魔(精英), M060 万雷领主(精英)
- phys（M061–M080）：M061 铁甲兽, M062 影盗, M063 石甲卫兵, M064 战斧兵, M065 巨型石像, M066 暗影使徒, M067 铁鳞蛇, M068 猎影者, M069 磐岩巨人(精英), M070 武斗学徒(精英), M071 疾风使, M072 铁傀儡, M073 铁骑队长, M074 暗影术士, M075 岩甲巨兽, M076 猎犬, M077 影语法师, M078 刑场剑士, M079 深渊魔兵(精英), M080 铁血领主(精英)

**精英 EM001–EM016**：逐一绑定上述 16 只 elite 怪（EM001↔M009、EM002↔M010、EM003↔M019、EM004↔M020、EM005↔M029、EM006↔M030、EM007↔M039、EM008↔M040、EM009↔M049、EM010↔M050、EM011↔M059、EM012↔M060、EM013↔M069、EM014↔M070、EM015↔M079、EM016↔M080）。精英技能（aura/必杀）自行设计命名。

**首领 B001–B012**：

| bossId | 名称 | element | 出现副本 | 阶段数 |
|--------|------|---------|----------|--------|
| B001 | 熔核巨兽 | fire | DG012 | 2 |
| B002 | 冻土君主 | ice | DG013 | 2 |
| B003 | 雷霆霸王 | thunder | DG014 | 2 |
| B004 | 影渊魔主 | phys | DG021 | 3 |
| B005 | 虚境之灵·中层 | ice | DG022 | 2 |
| B006 | 虚境之灵·高层 | thunder | DG023 | 3 |
| B007 | 深渊领主·一 | fire | DG027 | 3 |
| B008 | 深渊领主·二 | ice | DG028 | 3 |
| B009 | 元素回廊守门人 | phys | DG029 | 2 |
| B010 | 星轨古龙·序 | thunder | DG030 | 3 |
| B011 | 公会巨兽·试炼 | fire | DG033 | 2 |
| B012 | 星屑之主 | phys | DG040 | 3 |

**怪物技能 MS001–MS060**：M5 自行命名（每怪 0–3 个主动技能，精英/首领配 2–3 个），skillRate/cdSec 与 §1.2 战斗量级一致。
**怪物 AI AI001–AI020**：M5 自行命名（行为树模板：游荡/追击/远程/冲锋/召唤/狂暴…）。

### 2.11 物品 ItemID（IT001–IT200，Item.csv 全量注册）

分 8 段（M6 必须按此段命名，其他模块引用 IT 时按段取用）：

- IT001–IT030 消耗品（药品/料理/药剂）：IT001 生命药水·小, IT002 生命药水·大, IT003 能量药水·小, IT004 能量药水·大, IT005 复活羽毛, IT006 攻击料理·小, IT007 攻击料理·大, IT008 防御料理·小, IT009 防御料理·大, IT010 暴击料理, IT011 移速药剂, IT012 元素附着药剂·火, IT013 元素附着药剂·冰, IT014 元素附着药剂·雷, IT015 破韧药剂, IT016 护盾药剂, IT017 全恢复药剂, IT018 解毒剂, IT019 解冻剂, IT020 燃烧抑制剂, IT021 净化药剂, IT022 抗雷药剂, IT023 抗冰药剂, IT024 抗火药剂, IT025 组队卷轴·生命, IT026 组队卷轴·攻击, IT027 限时攻击buff·S, IT028 限时防御buff·S, IT029 掉落加成药·小, IT030 掉落加成药·大
- IT031–IT050 功能道具：IT031 改名卡, IT032 体力药·小, IT033 体力药·大, IT034 扫荡券, IT035 双倍掉落券, IT036 双倍经验券, IT037 主线跳过券, IT038 副本重置券, IT039 好友扩位卡, IT040 公会改名卡, IT041 装备锁, IT042 装备解绑券, IT043 词条保底石, IT044 突破重置券, IT045 技能重置券, IT046 天赋重置券, IT047 远征加速券, IT048 训练场门票, IT049 竞技场门票, IT050 组队喇叭
- IT051–IT070 抽卡道具：IT051 常驻招募券, IT052 限定招募券·焰舞, IT053 限定招募券·霜华, IT054 武器招募券, IT055 新手招募券, IT056 复刻招募券, IT057 十连券·常驻, IT058 十连券·限定, IT059 心愿券, IT060 定轨券, IT061 兑换残辉, IT062 星辉凭证, IT063 纪元碎片, IT064 命星拓片, IT065 缘分之证, IT066 赛季招募券, IT067 庆典招募券, IT068 周年招募券, IT069 好友助战券, IT070 组队推荐券
- IT071–IT090 兑换/宝箱：IT071 四星装备自选箱, IT072 五星装备自选箱, IT073 四星武器箱, IT074 五星武器箱, IT075 材料自选箱·小, IT076 材料自选箱·大, IT077 突破材料箱·火, IT078 突破材料箱·冰, IT079 突破材料箱·雷, IT080 突破材料箱·物理, IT081 技能书自选箱, IT082 经验书自选箱, IT083 宠物口粮箱, IT084 图鉴碎片箱, IT085 外观自选箱, IT086 名片自选箱, IT087 表情自选箱, IT088 公会物资箱, IT089 远征补给箱, IT090 星钻礼盒
- IT091–IT110 收藏品：IT091 星轨手办·凌, IT092 星轨手办·玲, IT093 星轨画册·卷一, IT094 星轨画册·卷二, IT095 纪念唱片·起航, IT096 纪念唱片·庆典, IT097 星轨徽章·一周年, IT098 星轨徽章·两周年, IT099 角色立绘卡·H001, IT100 角色立绘卡·H002, IT101 场景明信片·星轨遗迹, IT102 场景明信片·旧都, IT103 音乐盒·霜华, IT104 音乐盒·烈焰, IT105 剧情小说·卷一, IT106 剧情小说·卷二, IT107 拼图·星图, IT108 拼图·列车, IT109 纪念币·首测, IT110 纪念币·公测
- IT111–IT130 活动道具：IT111 庆典烟花, IT112 庆典气球, IT113 庆典蛋糕券, IT114 夏日泳圈, IT115 夏日沙堡材料, IT116 周年彩带, IT117 周年贺卡, IT118 新春红包, IT119 新春灯笼, IT120 元宵花灯, IT121 中秋月饼, IT122 圣诞礼物盒, IT123 万圣糖果, IT124 活动兑换券·庆典, IT125 活动兑换券·周年, IT126 活动抽奖券·庆典, IT127 活动抽奖券·周年, IT128 双倍活动入场券, IT129 限时任务积分凭证, IT130 活动纪念徽章
- IT131–IT150 外观道具：IT131 头像框·星轨, IT132 头像框·烈焰, IT133 头像框·寒霜, IT134 头像框·庆典, IT135 聊天气泡·星尘, IT136 聊天气泡·庆典, IT137 聊天表情·欢呼, IT138 聊天表情·沮丧, IT139 名片·星轨列车, IT140 名片·焰舞, IT141 名片·霜华, IT142 名片·周年, IT143 称号框·传说, IT144 称号框·大师, IT145 头像·凌, IT146 头像·玲, IT147 头像·庆典限定, IT148 头像·周年限定, IT149 主城皮肤·庆典, IT150 主城皮肤·周年
- IT151–IT170 宠物/图鉴：IT151 宠物蛋·星灵, IT152 宠物蛋·火灵, IT153 宠物蛋·冰灵, IT154 宠物蛋·雷灵, IT155 宠物进化石, IT156 宠物技能书, IT157 宠物好感零食, IT158 图鉴·怪物篇残页, IT159 图鉴·角色篇残页, IT160 图鉴·物品篇残页, IT161 图鉴·地图篇残页, IT162 图鉴·剧情篇残页, IT163 图鉴·活动篇残页, IT164 图鉴·成就篇残页, IT165 图鉴·彩蛋篇残页, IT166 收藏册·星轨编年史, IT167 收藏册·怪物百科, IT168 收藏册·世界志, IT169 收藏册·音乐集, IT170 收藏册·立绘集
- IT171–IT200 其他：IT171 星轨月历, IT172 列车车票·纪念, IT173 神秘信函, IT174 谜题钥匙, IT175 宝箱钥匙·青铜, IT176 宝箱钥匙·白银, IT177 宝箱钥匙·黄金, IT178 密道罗盘, IT179 寻宝图·残页, IT180 转盘代币, IT181 抽奖券·幸运, IT182 翻牌券, IT183 锦标赛门票, IT184 迷你游戏入场券, IT185 天赋洗点书, IT186 缘分礼物·花, IT187 缘分礼物·书, IT188 缘分礼物·甜品, IT189 世界Boss门票, IT190 模拟演算门票, IT191 深渊门票, IT192 讨伐战门票, IT193 好友礼物·小, IT194 好友礼物·大, IT195 公会贡献券, IT196 远征支援箱, IT197 限时头像框·夏日, IT198 限时气泡·夏日, IT199 星轨纪念册·完整版, IT200 星轨列车模型

### 2.12 任务 QuestID（QS001–QS120）

- QS001–QS040 主线（8 章 × 5）：章1 起航 QS001 列车启程/QS002 初入星轨城/QS003 第一场战斗/QS004 城郊的异响/QS005 星轨徽章；章2 旧都 QS006 旧都来信/QS007 废墟探秘/QS008 旧都的守卫/QS009 断壁残垣/QS010 旧都之主；章3 熔炉 QS011 赤炎熔炉/QS012 火海突围/QS013 铸剑之约/QS014 烈焰试炼/QS015 熔核之心；章4 寒渊 QS016 寒渊试炼/QS017 霜语者/QS018 冰封王座/QS019 解冻仪式/QS020 寒渊之眼；章5 星轨遗迹 QS021 深层遗迹/QS022 失落的文献/QS023 星轨核心/QS024 守卫者/QS025 星轨的真相；章6 影渊 QS026 影渊入口/QS027 暗影议会/QS028 裂谷突袭/QS029 影渊魔主/QS030 黎明协议；章7 虚境 QS031 虚境之门/QS032 试炼之路/QS033 虚境之灵/QS034 超越试炼/QS035 虚境之主；章8 终章 QS036 星轨之翼/QS037 集结号令/QS038 终战前夜/QS039 星轨决战/QS040 新的旅程
- QS041–QS080 支线（40）：QS041 失物招领, QS042 商人的委托, QS043 迷路的猫咪, QS044 铁匠的烦恼, QS045 药剂师学徒, QS046 图书馆的旧书, QS047 悬赏·城郊盗贼, QS048 悬赏·废弃工厂, QS049 猎人的请求, QS050 厨师的食材, QS051 失踪的旅人, QS052 矿洞里的声音, QS053 报恩的狐狸, QS054 画家的颜料, QS055 琴师的谱子, QS056 老兵的回忆, QS057 科学家的实验, QS058 歌手的演出, QS059 义工的日常, QS060 侦探的委托, QS061 悬赏·深渊魔兵, QS062 收藏家的清单, QS063 试炼者的证明, QS064 冰霜谷的传说, QS065 熔火山的秘密, QS066 影渊的档案, QS067 虚境的回声, QS068 星轨的预言, QS069 庆典筹备, QS070 周年回忆, QS071 宠物训练师, QS072 图鉴收集者, QS073 食材猎人, QS074 隐藏的宝库, QS075 迷宫的守门人, QS076 星屑的约定, QS077 旧友重逢, QS078 传说的锻造师, QS079 最后的信, QS080 谢幕演出
- QS081–QS100 每周（20）：QS081 周常·通关主线本×10, QS082 周常·击败精英×5, QS083 周常·通关组队本×5, QS084 周常·竞技场胜利×10, QS085 周常·完成远征×3, QS086 周常·强化装备×10, QS087 周常·升级技能×5, QS088 周常·消耗体力×500, QS089 周常·公会捐赠×3, QS090 周常·宠物互动×7, QS091 周常·图鉴收集×5, QS092 周常·完成悬赏×10, QS093 周常·爬塔×15层, QS094 周常·合成配方×5, QS095 周常·兑换商店×3, QS096 周常·好友助战×10, QS097 周常·参与活动×3, QS098 周常·深渊讨伐×2, QS099 周常·模拟演算×2, QS100 周常·全部完成奖励
- QS101–QS120 伙伴（20）：QS101 凌的邀约, QS102 玲的训练, QS103 彻的竞速, QS104 薇的暗影, QS105 澈的茶会, QS106 曜的研究, QS107 翎的狩猎, QS108 炎的承诺, QS109 御的守则, QS110 漪的魔法课, QS111 雎的试炼, QS112 岳的岩训, QS113 祈的祈祷, QS114 羽的弓道, QS115 朔的冰原, QS116 莲的花园, QS117 星轨日常·一期, QS118 星轨日常·二期, QS119 星轨日常·三期, QS120 星轨日常·四期

### 2.13 成就 AchievementID（AC001–AC080）

- AC001–AC015 成长：AC001 初来乍到, AC002 等级10, AC003 等级20, AC004 等级30, AC005 等级40, AC006 等级50, AC007 等级60, AC008 等级70, AC009 等级80, AC010 等级90, AC011 等级100, AC012 首次突破, AC013 满突破, AC014 技能满级, AC015 首次获得5星
- AC016–AC030 战斗：AC016 首次战斗, AC017 首次通关主线, AC018 无伤通关, AC019 击败1000怪, AC020 击败10000怪, AC021 首次破韧, AC022 首次元素反应, AC023 10连击, AC024 50连击, AC025 单次伤害10万, AC026 单次伤害50万, AC027 首次击败Boss, AC028 击败10个Boss, AC029 通关EX难度, AC030 全主线三星
- AC031–AC045 收集：AC031 获得10个角色, AC032 获得16个角色, AC033 武器收集10, AC034 武器收集30, AC035 装备收集20, AC036 装备收集60, AC037 图鉴10%, AC038 图鉴50%, AC039 图鉴100%, AC040 收集10个皮肤, AC041 收集20个称号, AC042 收藏品10, AC043 收藏品50, AC044 首次合成, AC045 合成50次
- AC046–AC055 副本：AC046 通关10个副本, AC047 通关全部主线, AC048 爬塔10层, AC049 爬塔30层, AC050 通关组队本10次, AC051 通关深渊讨伐, AC052 击败世界Boss, AC053 模拟演算通关, AC054 全活动副本, AC055 副本速通记录
- AC056–AC065 社交：AC056 加入公会, AC057 公会捐赠10, AC058 公会战首胜, AC059 好友1, AC060 好友10, AC061 助战10次, AC062 竞技场首胜, AC063 竞技场100胜, AC064 排位段位·黄金, AC065 排位段位·王者
- AC066–AC080 特殊：AC066 隐藏任务完成1, AC067 隐藏任务完成10, AC068 谜题解开10, AC069 宝箱打开50, AC070 集齐全部纪念币, AC071 周年限定, AC072 庆典限定, AC073 全宠物收集, AC074 立绘集齐全, AC075 冒险家的证明, AC076 星轨全收集, AC077 老玩家的坚持, AC078 夜猫子, AC079 早鸟, AC080 星轨猎手·完全体

### 2.14 其他 ID 族（范围 + 定义表；命名/明细由归属模块按模式设计）

| 族 | 范围 | 定义表(主键) | 归属 | 命名模式 |
|----|------|--------------|------|----------|
| 命座 CN | CN001–CN096（16 角色 × 6） | Constellation.csv(constId) | M1 | 每角色 6 星，slot 1–6 |
| 天赋 TN | TN001–TN032（16 角色 × 2） | HeroTalent.csv(talentId) | M1 | 每角色 2 天赋（战术/被动系） |
| 皮肤 SN | SN001–SN040 | HeroSkin.csv(skinId) | M1 | 每角色 2–3 款（初始/庆典/限定） |
| 称号 TI | TI001–TI050 | Title.csv(titleId) | M1 | 成长/战斗/收集/活动/排位 |
| 名片 NC | NC001–NC020 | Namecard.csv(namecardId) | M1 | 活动/成就/商店获得 |
| 语音 HV | HV001–HV048（16 角色 × 3） | HeroVoice.csv(heroId+voiceType) | M1 | greet/battle/ult 三类 |
| 技能突破 SB | 每主动技能 3 阶段 | SkillBreakthrough.csv(skillId+stage) | M2 | 48 主动 × 3 = 144 行 |
| 元素反应 ER | ER001–ER012 | ElementReaction.csv(reactionId) | M2 | 3 基础反应 + 衍生组合 |
| 连锁 CC | CC001–CC012 | ComboChain.csv(comboId) | M2 | 每 dps 角色 1–2 套 |
| 护盾 SHL | SHL001–SHL012 | Shield.csv(shieldId) | M2 | 护盾类型参数 |
| 伤害类型 DT | DT001–DT008 | DamageType.csv(damageTypeId) | M2 | 公式参数表 |
| 受击反馈 HF | HF001–HF020 | HitEffect.csv(hitEffectId) | M2 | 硬直/击退/浮空参数 |
| 武器等级 | weaponId+level | WeaponLevel.csv | M3 | 32 武器 × 5 采样(1/20/40/60/80) |
| 武器精炼 | weaponId+refineStage | WeaponRefine.csv | M3 | 32 × 3 阶段 |
| 武器突破 | weaponId+stage | WeaponBreakthrough.csv | M3 | 32 × 4 阶段 |
| 武器类型 WT | WT001–WT008 | WeaponType.csv(weaponTypeId) | M3 | 剑盾/大剑/长枪/双刃/法杖/法典/长弓/巨盾 |
| 套装效果 SB2 | setId+pieceCount | SetBonus.csv | M3 | 2 件/4 件套效果 |
| 装备等级 | rarity+level | EquipmentLevel.csv | M3 | 4/5★ × 10 档 |
| 主词条池 | slot+rarity+mainStatType | EquipmentMainStat.csv | M3 | 4 槽 × 2 稀有度 |
| 副词条 | subStatType | EquipmentSubStat.csv | M3 | 8 类词条基础值 |
| 词条池/权重 | slot+rarity | SubStatPool.csv / SubStatWeight.csv | M3 | 池与权重 |
| 强化/回收/洗练 | 等级/稀有度 | EquipmentEnhance/Recycle/Transmute.csv | M3 | 消耗曲线 |
| 锻造配方 | equipId | EquipRecipe.csv | M3 | 20 条（4★/5★ 装备） |
| 副本关卡 | dungeonId+stageNo | DungeonStage.csv | M4 | 每本 1–3 关 |
| 波次 | waveId | DungeonWave.csv | M4 | 每关 2–4 波 |
| 副本怪物 | dungeonId+monsterId | DungeonMonster.csv | M4 | 每本 2–5 种 |
| 难度档 | dungeonId+difficulty | DungeonDifficulty.csv | M4 | normal/hard/expert |
| 首通奖励 | dungeonId | DungeonFirstClear.csv | M4 | 40 行 |
| 词缀 AF | AF001–AF020 | DungeonAffix.csv(affixId) | M4 | 威胁型/增益型 |
| 塔层 TF | TF001–TF030 | TowerFloor.csv(floorId) | M4 | 30 层，战力 5000–36000 |
| 周挑战 WC | WC001–WC012 | WeeklyChallenge.csv(challengeId) | M4 | 每周轮换 |
| 活动副本 ED | ED001–ED012 | EventDungeon.csv(eventDungeonId) | M4 | 绑定 EV/ED |
| 组队副本 | coopDungeonId | CoopDungeon.csv | M4 | 6 张 |
| 怪物等级 | monsterId+level | MonsterLevel.csv | M5 | 80 × 3 采样(原生/+10/+20) |
| 怪物技能 MS | MS001–MS060 | MonsterSkill.csv(skillId) | M5 | 精英/首领 2–3 个 |
| 怪物AI AI | AI001–AI020 | MonsterAI.csv(aiId) | M5 | 行为模板 |
| 怪物掉落 | monsterId | MonsterDrop.csv | M5 | 精英/Boss 专属 |
| 元素抗性 | monsterId+element | MonsterElementResist.csv | M5 | 稀疏（默认无抗性） |
| Boss阶段 | bossId+phaseNo | BossPhase.csv | M5 | 12 Boss × 2–3 |
| Boss机制 | mechanicId | BossMechanic.csv | M5 | 24 条 |
| 精英 EM | EM001–EM016 | EliteMonster.csv(eliteId) | M5 | 绑定 elite 怪 |
| 机关 TR | TR001–TR020 | Trap.csv(trapId) | M5 | 20 种 |
| 材料来源 | materialId+sourceType | MaterialSource.csv | M6 | 60 行 |
| 配方 RC | RC001–RC060 | Recipe.csv(recipeId) | M6 | 60 条 |
| 物品使用 | itemId | ItemUse.csv | M6 | 60 行 |
| 货币兑换 | exchangeId | CurrencyExchange.csv | M6 | 12 行 |
| 收益上限 | targetId+limitType | FarmLimit.csv | M6 | 16 行 |
| 体力规则/价格 | ruleType / buyCount | StaminaRule.csv / StaminaPricing.csv | M6 | 8+10 行 |
| 离线/在线/签到 | — | OfflineReward/OnlineReward/DailyLoginReward.csv | M6 | 8/8/14 行 |
| 卡池 GP | GP001–GP008 | GachaPool.csv(poolId) | M7 | 常驻/限定/武器/新手/复刻 |
| 卡池概率/保底 | poolType | GachaRate/GachaPity.csv | M7 | 按 poolType |
| 卡池内容 | poolId+itemId | GachaItem.csv | M7 | 80 行 |
| 定轨 GW | poolId | GachaWish.csv | M7 | 8 行 |
| 首充/充值/月卡/战令/基金/礼包 | — | FirstChargeReward/TopUp/MonthlyCard/BattlePass/BattlePassReward/GrowthFund/GiftPack/NewbiePack.csv | M7 | 见 §3.M7 |
| 任务步骤/奖励 | questId | QuestStep/QuestReward.csv | M8 | 100/120 行 |
| 任务链 | chainId | QuestChain.csv | M8 | 20 条 |
| 章节 | chapterId | StoryChapter/StoryChapterReward.csv | M8 | 8 章（对应 QS 主线） |
| 每日/每周任务模板 | — | DailyQuest/WeeklyQuest.csv | M8 | 10/8 行 |
| 成就分类 | categoryId | AchievementCategory.csv | M8 | 6 类 |
| 新手任务/引导 | — | NewbieQuest/Tutorial.csv | M8 | 10/20 行 |
| 功能解锁 FU | FU001–FU030 | FunctionUnlock.csv(unlockId) | M8 | 30 项功能 |
| 商店刷新/分类 | — | ShopRefresh/ShopCategory.csv | M9 | 8/8 行 |
| NPC | NP001–NP020 | Npc.csv(npcId) | M9 | 20 名 |
| NPC商店 | npcId+itemId | NpcShop.csv | M9 | 20 行 |
| 限时/竞技/公会/活动商店 | — | LimitedShop/ArenaShop/GuildShop/EventShop.csv | M9 | 12/12/12/12 行 |
| 兑换规则 | ruleId | ExchangeRule.csv | M9 | 8 行 |
| 竞技赛季/段位/奖励 | — | ArenaSeason/ArenaTier/ArenaReward.csv | M10 | 4/8/16 行 |
| 匹配/榜奖 | — | MatchmakingRule/LeaderboardReward.csv | M10 | 6/10 行 |
| 排位赛季/段位/奖励 | — | RankMatchSeason/RankMatchTier/RankMatchReward.csv | M10 | 4/10/12 行 |
| 公会/公会等级/建筑/任务 | — | Guild/GuildLevel/GuildBuilding/GuildQuest.csv | M11 | 10/10/12/12 行 |
| 公会战/奖励 | — | GuildWar/GuildWarReward.csv | M11 | 8/12 行 |
| 公会Boss/奖励 | — | GuildBoss/GuildBossReward.csv | M11 | 8/8 行 |
| 远征/奖励/派遣 | — | Expedition/ExpeditionReward/ExpeditionHero.csv | M11 | 20/20/12 行 |
| 键值配置 | key | JsonConfig.csv | M12 | 20 行 |
| 世界等级 | worldLevel | WorldLevel.csv | M12 | 8 行 |
| 邮件模板 ML | ML001–ML030 | MailTemplate.csv(mailId) | M12 | 30 条 |
| 加载提示/随机名 | — | LoadingTips/RandomName.csv | M12 | 20/30 行 |
| 区域 RG / 传送点 WY | RG001–RG008 / WY001–WY040 | Region.csv / Waypoint.csv | M12 | 8 区域 / 40 点 |
| 图鉴 CX | CX001–CX050 | Codex.csv(codexId) | M12 | 50 条（角色/怪物/物品/地图/剧情） |
| 图鉴奖励 | categoryId | CodexReward.csv | M12 | 10 行 |
| 版本/公告 | — | VersionConfig/Announcement.csv | M12 | 6/8 行 |
| 公式参数 FP | FP001–FP010 | FormulaParam.csv(paramId) | M12 | 与 §1.2 完全一致 |
| 战力权重 | statType | PowerFormulaWeight.csv | M12 | 与表 02-2 一致 |
| 每日重置 | resetType | DailyReset.csv | M12 | 6 行 |
| 宠物/等级/技能 | — | Pet/PetLevel/PetSkill.csv | M12 | 10/50/20 行 |
| 活动排期 EV | EV001–EV012 | EventSchedule.csv(eventId) | M12 | 12 个活动 |
| 世界Boss/奖励 | — | WorldBoss/WorldBossReward.csv | M13 | 8/8 行 |
| 模拟演算/层/增益 | — | Simulation/SimulationFloor/SimulationBuff.csv | M13 | 12/60/20 行 |
| 寻宝/抽奖/转盘 | — | TreasureHunt/Lottery/Wheel/WheelReward.csv | M13 | 12/8/8/24 行 |
| 随机箱/宝箱/谜题 | — | RandomBox/TreasureChest/Puzzle.csv | M13 | 12/30/12 行 |
| 隐藏任务 | HQ001–HQ020 | HiddenQuest.csv(questId) | M13 | 20 条 |
| 羁绊 TB | TB001–TB012 | TeamBuff.csv(buffId) / TeamBuffHero.csv | M13 | 12 组 |
| 悬赏 | WK001–WK012 / DK001–DK012 | BountyWeekly/BountyDaily.csv | M13 | 12/12 行 |
| 锦标赛/奖励 | — | Tournament/TournamentReward.csv | M13 | 4/8 行 |
| 小游戏/奖励 | — | MiniGame/MiniGameReward.csv | M13 | 8/8 行 |
| 技能解锁 | heroId+skillType | HeroSkillUnlock.csv | M14 | 64 行 |
| 终结技充能 | heroId | UltCharge.csv | M14 | 16 行 |
| UP池/免费抽 | poolId | GachaUpPool/FreeGacha.csv | M14 | 8/6 行 |
| 商店折扣/活动奖励/里程碑 | — | ShopDiscount/ActivityReward/Milestone.csv | M14 | 12/16/10 行 |
| 试炼场 | trialId | CombatTrial.csv | M14 | 8 行 |
| 外观 | — | ChatEmoji/AvatarFrame/ChatBubble/NoviceReward.csv | M14 | 12/12/8/8 行 |
| 护盾参数/闪避 | — | BreakShield/DodgeRule.csv | M14 | 10/5 行 |
| 组队推荐/竞技地图/赛季天平 | — | CoopRecommend/PvpMap/ArenaBuff.csv | M14 | 10/6/6 行 |

---

## 3. 配表模块清单（M1–M14，生成顺序不依赖；每个模块的文件由唯一归属模块独占）

> 每张表格式：`文件名 | 主键 | 列（camelCase） | 外键规则 | 目标行数`。列未注明的按 §1.4 与命名模式自行设计，但**关键外键列必须存在**。所有「物品引用」列遵守：`IT**→Item.csv；MAT**→Material.csv；WP**→Weapon.csv；EQ**→Equipment.csv；货币 token；STAMINA`（多态引用）。

### M1 角色与养成（12 文件；追加 3，新建 9）

1. `Hero.csv`（追加）| PK heroId | 既有列 | heroId 全 16；新行按 §2.1 | 16 行（既有 8 不动）
2. `HeroLevel.csv`（追加）| PK heroId+level | 既有列 | 新角色 5 采样等级(1/20/40/60/100)，数值按 §1.2 量级（4★ 低于 5★） | 80 行
3. `Breakthrough.csv`（追加）| PK heroId+stage | 既有列 | 新角色 4 阶段；材料按 §2.1 映射 | 64 行
4. `Constellation.csv` | PK constId | constId,heroId,slot,name,effectText,unlockCond | heroId→Hero；96 行（每角色 6 星：星1 新被动效果/星2 数值+8%/星3 战技强化/星4 数值+8%/星5 终结技强化/星6 终极效果） | 96
5. `HeroAffinity.csv` | PK heroId+tier | heroId,tier,requiredPoints,rewardItemId,rewardQty | heroId→Hero；reward→物品多态；80 行（16 角色 × 5 阶，奖励 IT/MAT 逐阶升级）
6. `HeroSkin.csv` | PK skinId | skinId,heroId,name,rarity,priceGem,unlockCond,statBonus | heroId→Hero；40 行（SN001–040；每角色 2–3 款；初始 0 元，限定款 unlockCond 写活动 EV 或成就 AC）
7. `HeroTalent.csv` | PK talentId | talentId,heroId,slot,name,effectText,unlockLevel | heroId→Hero；32 行
8. `TalentLevel.csv` | PK talentId+level | talentId,level,effectValue | talentId→HeroTalent；160 行（32 天赋 × 5 级，线性成长）
9. `Title.csv` | PK titleId | titleId,name,obtainType,conditionRef,powerBonus | 50 行（TI001–050；obtainType ∈ achievement/activity/arena/guild/collection）
10. `Namecard.csv` | PK namecardId | namecardId,name,obtainCond,rarity | 20 行（NC001–020）
11. `HeroVoice.csv` | PK heroId+voiceType | heroId,voiceType,audioRef,unlockCond | heroId→Hero；48 行（voiceType ∈ greet/battle/ult）
12. `HeroIntro.csv` | PK heroId | heroId,intro,personality,faction,preferredWeaponType | heroId→Hero；16 行（人物档案文案，供 Agent 检索角色背景）

### M2 战斗与技能（13 文件；追加 3，新建 10）

1. `Skill.csv`（追加）| PK skillId | 既有列 | SK033–SK072 按 §2.2（含通用被动池，description 注明「通用被动」）；技能类型约束见 §1.2 | 72 行
2. `SkillLevel.csv`（追加）| PK skillId+level | 既有列 | 24 个新主动技能（8 角色 × 3）各 1 行 L10；skillRate = L1×1.8；extraEffect/upgradeCost 模式仿既有 | 48 行
3. `Buff.csv`（追加）| PK buffId | 既有列 | BF016–BF030 按 §2.3 | 30 行
4. `SkillBreakthrough.csv` | PK skillId+stage | skillId,stage,levelReq,costGold,material1Id,material1Qty,material2Id,material2Qty | skillId→Skill（仅主动技能 48 个）；材料→MAT；144 行（3 阶段：L4/L7/L10 解锁，消耗逐段 ×3 递增）
5. `SkillEnergyGain.csv` | PK skillType | skillType,hitType,energyGain,note | 8 行（与 §1.2 能量循环一致：普攻命中+10/战技+15/受击+5/击杀+10/终结技消耗100）
6. `ElementReaction.csv` | PK reactionId | reactionId,name,triggerElements,resultBuffId,description | resultBuffId→Buff（可空）；12 行（含既有 BF012/013/014 对应 3 条 + 新组合：冻+雷/火+冰强附着等，规则与《04_Buff与状态机》§3 一致）
7. `PvpBalance.csv` | PK balanceId | balanceId,damageType,modifier,note | 8 行（PVP 伤害修正：直接伤害 0.85、DoT 0.7、护盾 1.1、治疗 0.8 等，全部 ∈ [0.6,1.2]）
8. `PvpBanList.csv` | PK banId | banId,seasonRef,heroId,skillId,reason | heroId→Hero（可空）；skillId→Skill（可空）；8 行（每赛季禁用 0–2 角色/技能）
9. `ComboChain.csv` | PK comboId | comboId,heroId,sequence,effectRef,triggerCond | heroId→Hero；12 行（连击定义，衔接 §1.2 普攻回能）
10. `Shield.csv` | PK shieldId | shieldId,name,absorbFormula,breakFactor,maxStack | 12 行（护盾吸收公式字符串，如 `0.20×施法者ATK+500`；与既有 BF006 语义一致）
11. `DamageType.csv` | PK damageTypeId | damageTypeId,name,canCrit,useElemMul,useDefReduction | 8 行（布尔列 TRUE/FALSE；与《01》§2–§4 边界规则一致：DoT 不吃暴击/元素）
12. `HitEffect.csv` | PK hitEffectId | hitEffectId,name,stunSec,knockbackDist,airborneSec,note | 20 行（受击反馈参数；数值与 Buff 控制类对齐）
13. `ElementResist.csv` | PK heroId+element | heroId,element,resistRate | heroId→Hero；64 行（16 角色 × 4 元素；默认 0，同元素自抗 +0.05~0.10）

### M3 武器与装备（17 文件；追加 2，新建 15）

1. `Weapon.csv`（追加）| PK weaponId | 既有列 | WP009–032 按 §2.4；passiveSkillId→Skill | 32 行
2. `WeaponLevel.csv` | PK weaponId+level | weaponId,level,atk,goldCost | weaponId→Weapon；160 行（32 武器 × 采样 1/20/40/60/80；5★ 满级攻 ≈ base×2.2，4★ ≈ base×1.9；goldCost 累计增长）
3. `WeaponRefine.csv` | PK weaponId+refineStage | weaponId,refineStage,statBonus,refineMaterialId,refineMaterialQty | weaponId→Weapon；材料→MAT；96 行（32 × 3 阶段：+4%/+6%/+8% 主属性或被动强化）
4. `WeaponBreakthrough.csv` | PK weaponId+stage | weaponId,stage,levelReq,costGold,material1Id,material1Qty,material2Id,material2Qty | weaponId→Weapon；材料→MAT；128 行（32 × 4 阶段，levelReq 20/40/60/80）
5. `WeaponType.csv` | PK weaponTypeId | weaponTypeId,name,heroClassHint,note | 8 行（WT001 剑盾/WT002 大剑/WT003 长枪/WT004 双刃/WT005 法杖/WT006 法典/WT007 长弓/WT008 巨盾）
6. `Equipment.csv`（追加）| PK equipId | 既有列 | EQ011–040 按 §2.5；setId→EquipmentSet；heroClass ∈ {tank,dps,support,all} | 40 行
7. `EquipmentSet.csv` | PK setId | setId,name,rarity,targetClass,setBonusRef | 8 行（S001–S008；S001–003 既有信息回填）
8. `SetBonus.csv` | PK setId+pieceCount | setId,pieceCount,bonusStat,bonusValue | setId→EquipmentSet；20 行（每套 2 件/4 件效果；5★ 输出套 4 件含 critDmg 类）
9. `EquipmentLevel.csv` | PK rarity+level | rarity,level,mainStatMul,costGold | 20 行（4/5★ × 10 档(1,10,…,90)；5★ 满级主词条 ≈ ×2.4）
10. `EquipmentMainStat.csv` | PK slot+rarity+mainStatType | slot,rarity,mainStatType,weight | 24 行（head 主 critRate/hpPct；body 主 atkPct/defPct/hpPct；feet 主 atkFlat/defFlat；accessory 主 critDmg/energyRecharge/atkFlat）
11. `EquipmentSubStat.csv` | PK subStatType | subStatType,baseValue,perEnhanceValue | 8 行（atkFlat/defFlat/hpPct/atkPct/defPct/critRate/critDmg/energyRecharge）
12. `SubStatPool.csv` | PK slot+rarity+subStatType | slot,rarity,subStatType | 16 行（每槽可出 4 种副词条）
13. `SubStatWeight.csv` | PK slot+subStatType | slot,subStatType,weight | 16 行（权重合计 100）
14. `EquipmentEnhance.csv` | PK level+rarity | level,rarity,costGold,costMaterialId | 30 行（1–15 级 × 4/5★；材料→MAT17/MAT30）
15. `EquipmentRecycle.csv` | PK rarity | rarity,recycleGold,recycleMaterialId,recycleMaterialQty | 6 行（含 3★ 以下回收）
16. `EquipmentTransmute.csv` | PK slot | slot,costItemId,costQty,unlockLevel | 8 行（词条洗练：cost→IT043 词条保底石/MAT18 洗练石）
17. `EquipRecipe.csv` | PK equipId | equipId,material1Id,material1Qty,material2Id,material2Qty,costGold,unlockLevel | equipId→Equipment；材料→MAT（4★ 用 MAT38，5★ 用 MAT39+MAT40）；20 行

### M4 副本与关卡（14 文件；追加 1，新建 13）

1. `Dungeon.csv`（追加）| PK dungeonId | 既有列 | DG011–040 按 §2.6；dropId→DropTable | 40 行
2. `DungeonStage.csv` | PK dungeonId+stageNo | dungeonId,stageNo,name,clearCond | dungeonId→Dungeon；~80 行（主本 3 关、材料本 1–2 关）
3. `DungeonWave.csv` | PK waveId | waveId,dungeonId,stageNo,waveNo,monsterIds,hpMul,atkMul | dungeonId→Dungeon；monsterIds 为 `;` 分隔的 M** → Monster；~100 行
4. `DungeonMonster.csv` | PK dungeonId+monsterId | dungeonId,monsterId,count,levelOffset | 双外键；~120 行（每本 2–5 种怪，levelOffset 相对副本推荐等级）
5. `DungeonDifficulty.csv` | PK dungeonId+difficulty | dungeonId,difficulty,recommendPower,dropMul,unlockCond | dungeonId→Dungeon；~80 行（normal/hard/expert；dropMul 1.0/1.2/1.5）
6. `DungeonFirstClear.csv` | PK dungeonId | dungeonId,rewardItemId,rewardQty,rewardGem | dungeonId→Dungeon；奖励→物品多态；40 行
7. `DungeonAffix.csv` | PK affixId | affixId,name,effect,riskLevel,unlockCondition | 20 行（AF001–020；如「敌方攻击+20%」「我方回能-30%」「冻结延长」等，威胁/增益混合）
8. `TowerFloor.csv` | PK floorId | floorId,floorNo,recommendPower,affixId,monsterGroup,rewardItemId | affixId→DungeonAffix（可空）；奖励→物品多态；30 行（TF001–030，战力 5000→36000 递增）
9. `TowerReward.csv` | PK floorId | floorId,firstClearItemId,firstClearQty,dailyItemId,dailyQty | floorId→TowerFloor；30 行
10. `WeeklyChallenge.csv` | PK challengeId | challengeId,name,dungeonId,conditionRef,unlockLevel | dungeonId→Dungeon（可空）；12 行（WC001–012）
11. `WeeklyChallengeReward.csv` | PK challengeId+tier | challengeId,tier,rewardItemId,rewardQty | challengeId→WeeklyChallenge；24 行（2 档/挑战）
12. `EventDungeon.csv` | PK eventDungeonId | eventDungeonId,eventId,dungeonId,staminaCost,rewardMul | eventId→EventSchedule；dungeonId→Dungeon；12 行（ED001–012）
13. `CoopDungeon.csv` | PK coopDungeonId | coopDungeonId,dungeonId,teamSize,levelSync,reviveRule | dungeonId→Dungeon；6 行（含 DG021/033/034/035 + 2 张）
14. `CoopReward.csv` | PK coopDungeonId+clearTimeTier | coopDungeonId,clearTimeTier,rewardItemId,rewardQty | coopDungeonId→CoopDungeon；12 行（SS/S/A 档）

### M5 怪物与首领（12 文件，全部新建）

1. `Monster.csv` | PK monsterId | monsterId,name,element,type,baseAtk,baseDef,baseHp,nativeLevel,skillIds,tags | M001–080 按 §2.10；skillIds=`;` 分隔 MS** → MonsterSkill；element ∈ §1.3 | 80 行
2. `MonsterLevel.csv` | PK monsterId+level | monsterId,level,atk,def,hp | monsterId→Monster；240 行（80 怪 × 采样 nativeLevel/+10/+20；数值按 §1.2 战斗量级：杂兵 HP 3000–30000，精英 ×3，随等级递增）
3. `MonsterSkill.csv` | PK skillId | skillId,monsterId,name,skillType,cdSec,skillRate,element,effectRef | monsterId→Monster；60 行（MS001–060；skillType ∈ normal/skill/ult；ult 为精英/首领大技能）
4. `MonsterAI.csv` | PK aiId | aiId,name,moveType,aggroRange,behaviorPattern,tags | 20 行（AI001–020：游荡/追击/远程/冲锋/召唤/狂暴/协同）
5. `MonsterDrop.csv` | PK monsterId+itemId | monsterId,itemType,itemId,dropRate,minQty,maxQty | monsterId→Monster；物品多态；60 行（精英/Boss 专属掉落）
6. `MonsterElementResist.csv` | PK monsterId+element | monsterId,element,resistRate | monsterId→Monster；60 行（稀疏：只写非 0 抗性，默认 0）
7. `Boss.csv` | PK bossId | bossId,name,element,baseHp,dungeonId,aiId,phaseCount,enrageTimerSec | dungeonId→Dungeon；aiId→MonsterAI；12 行（B001–012 按 §2.10）
8. `BossPhase.csv` | PK bossId+phaseNo | bossId,phaseNo,hpThreshold,skillIds,mechanicId | bossId→Boss；skillIds→MonsterSkill；30 行（12 Boss × 2–3 阶段）
9. `BossMechanic.csv` | PK mechanicId | mechanicId,name,description,counterTip | 24 行（机制说明文本：召唤/全屏/转阶段无敌/弱点暴露等）
10. `BossReward.csv` | PK bossId | bossId,dropId,firstClearItemId,firstClearQty | bossId→Boss；dropId→DropTable；12 行
11. `EliteMonster.csv` | PK eliteId | eliteId,monsterId,name,buffId,dropBonus,note | eliteId→EM001–016；monsterId→Monster（只允许 §2.10 标记的 16 只 elite）；buffId→Buff；16 行
12. `Trap.csv` | PK trapId | trapId,name,damageTypeId,damageFormula,avoidTip,dungeonId | damageTypeId→DamageType；dungeonId→Dungeon（可空）；20 行（TR001–020）

### M6 掉落与经济（13 文件；追加 1，新建 12）

1. `DropTable.csv`（追加）| PK dropId+dungeonId? 既有结构 dropId 多行共享 | 既有列 | DR011–050 对应 DG011–040；规则见 §1.2 掉落 | ~120 行（每本 2–4 行）
2. `Material.csv` | PK materialId | materialId,name,rarity,useType,description,sourceHint | 40 行（MAT01–40 全量注册，含既有 14 个回填！useType ∈ weaponEnhance/heroBreakthrough/skillUpgrade/exp/currency/shop/exchange/other）
3. `MaterialSource.csv` | PK materialId+sourceType | materialId,sourceType,sourceId,expectedPerDay | materialId→Material；sourceType ∈ dungeon/shop/recipe/event/exchange；60 行
4. `Item.csv` | PK itemId | itemId,name,itemType,rarity,stackMax,description | 200 行（IT001–200 按 §2.11 全量注册；itemType ∈ consumable/ticket/collection/box/pet/misc）
5. `ItemUse.csv` | PK itemId | itemId,useType,effectValue,cdSec,target | itemId→Item；60 行（useType ∈ heal/stamina/exp/ticket/box/buff）
6. `Recipe.csv` | PK recipeId | recipeId,resultItemId,resultQty,material1Id,material1Qty,material2Id,material2Qty,costGold,unlockLevel | resultItemId→Item 或 Material（多态）；材料→Material；60 行（RC001–060；含 MAT 合成 + IT 道具合成）
7. `CurrencyExchange.csv` | PK exchangeId | exchangeId,fromCurrency,toCurrency,rate,dailyLimit,unlockCond | 12 行（只允许正向兑换：GOLD↔材料、代币→GOLD 等；**禁止 GEM→GOLD 无限链**，SH002 30GEM=20000GOLD 例外）
8. `FarmLimit.csv` | PK targetId+limitType | targetId,limitType,limitCount,note | targetId→Dungeon 或 Material（按 targetType）；16 行（每日/每周次数上限）
9. `StaminaRule.csv` | PK ruleType | ruleType,value,note | 8 行（自然恢复 1点/6分钟、上限 120、等级回满、周卡加成等）
10. `StaminaPricing.csv` | PK buyCount | buyCount,costGem,staminaGain | 10 行（SP001–010：首次 50GEM/120 体力，逐次 +10GEM 递增，第 6 次起上限）
11. `OfflineReward.csv` | PK offlineHours | offlineHours,goldPercent,expPercent,capHour | 8 行（离线收益 0–24h）
12. `OnlineReward.csv` | PK minutes | minutes,rewardItemId,rewardQty | 8 行（在线时长奖励 15–120min）
13. `DailyLoginReward.csv` | PK day | day,itemType,itemId,qty | 14 行（14 天签到：1 天送 IT051 招募券、7 天送 GEM、14 天送 5★ 武器箱 IT074）

### M7 抽卡与付费（13 文件，全部新建）

1. `GachaPool.csv` | PK poolId | poolId,name,type,costItemId,costAmount,upRef,note | 8 行（GP001 常驻·星轨集结 mixed；GP002 限定·焰舞 hero(UP H014)；GP003 限定·霜华 hero(UP H015)；GP004 武器·炽焰 weapon(UP WP017/018)；GP005 武器·冰棱 weapon(UP WP019/020)；GP006 新手·启航 newbie；GP007 常驻·武器 mixed；GP008 复刻·流火 hero(UP H010)）；costItemId→Item（IT051–058）
2. `GachaRate.csv` | PK poolType | poolType,rarity,probability | 6 行（5★ 0.006 / 4★ 0.051 / 3★ 0.943，up 池 5★ 0.006 中 50% up；数值可与真实手游近似但全库唯一）
3. `GachaPity.csv` | PK poolType | poolType,pityCount,guaranteedRarity,hardPityCount | 6 行（hero 池 90 软保底/180 硬保底；weapon 池 80/160；newbie 池 20 必 5★）
4. `GachaItem.csv` | PK poolId+itemId | poolId,itemType,itemId,rarity,weight,isUp | poolId→GachaPool；物品多态（hero→H**、weapon→WP**、equipment→EQ**、material→MAT、item→IT）；80 行（每池 10 项，权重合计 1000）
5. `GachaWish.csv` | PK poolId | poolId,wishItemId,costItemId,costAmount | poolId→GachaPool；wishItemId 多态；8 行（定轨规则）
6. `FirstChargeReward.csv` | PK tier | tier,costGem,bonusGem,rewardItemId,rewardQty | 6 行（首充双倍 + 奖励 IT 道具）
7. `TopUp.csv` | PK topUpId | topUpId,priceCny,gemAmount,firstBonusGem | 8 行（6/30/68/128/198/328/648/1298 档位）
8. `MonthlyCard.csv` | PK cardId | cardId,name,priceGem,durationDay,dailyGem,totalGem | 4 行（月卡 30 天每天 60GEM 等）
9. `BattlePass.csv` | PK bpId | bpId,name,seasonRef,priceGem,freeLineRef,paidLineRef | 4 行（战令赛季制）
10. `BattlePassReward.csv` | PK bpId+level | bpId,level,line,rewardItemId,rewardQty | bpId→BattlePass；40 行（1–20 级 × free/paid 两线）
11. `GrowthFund.csv` | PK fundId | fundId,name,priceGem,conditionRef,rewardItemId,rewardQty | 6 行（等级基金/登基金）
12. `GiftPack.csv` | PK packId | packId,name,priceGem,itemIds,itemQtys,dailyLimit,unlockCond | 20 行（itemIds=`;` 分隔多态物品）
13. `NewbiePack.csv` | PK packId | packId,dayNo,priceGem,itemId,itemQty | 8 行（新手 7 日礼 + 首日免费）

### M8 任务与成就（13 文件，全部新建）

1. `Quest.csv` | PK questId | questId,name,type,chapterId,unlockLevel,description | 120 行（QS001–120 按 §2.12；type ∈ main/side/weekly/companion；主线 chapterId → StoryChapter）
2. `QuestStep.csv` | PK questId+stepNo | questId,stepNo,objective,targetId,targetCount | questId→Quest；targetId 多态（M** 怪/DG** 副本/IT** 物品）；100 行（主线+支线 2–3 步）
3. `QuestReward.csv` | PK questId | questId,itemType,itemId,itemQty,gold,exp | questId→Quest；物品多态；120 行
4. `QuestChain.csv` | PK chainId | chainId,chainName,questIds,unlockCond | 20 行（questIds=`;` 分隔 → Quest）
5. `StoryChapter.csv` | PK chapterId | chapterId,name,regionId,openLevel,questStartId,questEndId | regionId→Region；questStartId/questEndId→Quest；8 行（对应 QS001–040 主线 8 章）
6. `StoryChapterReward.csv` | PK chapterId | chapterId,clearQuestId,rewardItemId,rewardQty | chapterId→StoryChapter；clearQuestId→Quest；8 行
7. `DailyQuest.csv` | PK dailyQuestId | dailyQuestId,name,objective,targetCount,rewardExp,rewardGold,rewardItemId,minLevel | 10 行（日常模板：刷本×3/消耗体力×60/竞技场×1/好友助战×1 等）
8. `WeeklyQuest.csv` | PK weeklyQuestId | weeklyQuestId,name,objective,targetCount,rewardExp,rewardGold,rewardItemId,minLevel | 8 行
9. `Achievement.csv` | PK achievementId | achievementId,name,categoryId,conditionRef,rewardItemId,rewardQty | 80 行（AC001–080 按 §2.13；categoryId→AchievementCategory；奖励多态）
10. `AchievementCategory.csv` | PK categoryId | categoryId,name,sortOrder | 6 行（成长/战斗/收集/副本/社交/特殊）
11. `NewbieQuest.csv` | PK newbieQuestId | newbieQuestId,name,objective,rewardItemId,rewardQty | 10 行（新手引导任务线）
12. `Tutorial.csv` | PK tutorialId | tutorialId,stepNo,featureRef,unlockCond,uiHint | 20 行（featureRef 可空 → FunctionUnlock）
13. `FunctionUnlock.csv` | PK unlockId | unlockId,feature,unlockLevel,unlockQuestId,description | unlockQuestId→Quest（可空）；30 行（FU001–030：商店/竞技场/公会/远征/宠物/图鉴/洗练/爬塔/排位/世界Boss/模拟演算/锦标赛…）

### M9 商店与NPC（10 文件；追加 1，新建 9）

1. `ShopItem.csv`（追加）| PK shopId | 既有列 | SH013–048 按 §2.8；外键同既有 #11/#12 | 48 行
2. `ShopRefresh.csv` | PK shopType | shopType,refreshCycle,resetTime | 8 行（daily/weekly/monthly/event）
3. `Npc.csv` | PK npcId | npcId,name,regionId,role,shopRef | regionId→Region；20 行（NP001–020：铁匠/药剂师/公会管家/竞技场主持/活动司仪…）
4. `NpcShop.csv` | PK npcId+itemId | npcId,itemId,priceType,priceAmount,stockLimit | npcId→Npc；物品多态；20 行
5. `LimitedShop.csv` | PK limitedShopId | limitedShopId,name,itemId,priceGem,stock,eventRef | eventRef→EventSchedule（可空）；12 行（限时商品）
6. `ArenaShop.csv` | PK itemId | itemId,costArenaPoint,stock,unlockTier | 12 行（物品多态；解锁段位→ArenaTier 引用字符串）
7. `GuildShop.csv` | PK itemId | itemId,costGuildPoint,stock,guildLevelReq | 12 行（guildLevelReq → Guild.level）
8. `EventShop.csv` | PK eventId+itemId | eventId,itemId,costEventToken,stock | eventId→EventSchedule；12 行
9. `ShopCategory.csv` | PK categoryId | categoryId,name,sortOrder | 8 行
10. `ExchangeRule.csv` | PK ruleId | ruleId,shopType,conditionType,conditionValue,note | 8 行（兑换条件约束：周限购/等级/段位/活动期）

### M10 PVP与竞技（8 文件，全部新建）

1. `ArenaSeason.csv` | PK seasonId | seasonId,name,durationDay,rankReset,rewardDropId | rewardDropId→DropTable（可空）；4 行（AR001–004；赛季名：星轨赛季·一~四）
2. `ArenaTier.csv` | PK tierId | tierId,tierName,minScore,maxScore,rewardItemId | 8 行（青铜/白银/黄金/铂金/钻石/大师/王者/传说）
3. `ArenaReward.csv` | PK seasonId+tierId | seasonId,tierId,rewardItemId,rewardQty | seasonId→ArenaSeason；tierId→ArenaTier；16 行（赛季结算）
4. `MatchmakingRule.csv` | PK ruleType | ruleType,powerRange,latencyMs,teamSize,note | 6 行（同段位 ±15%、跨段保护等）
5. `LeaderboardReward.csv` | PK rankStart | rankStart,rankEnd,rewardItemId,rewardQty | 10 行（周榜/赛季榜）
6. `RankMatchSeason.csv` | PK seasonId | seasonId,name,durationDay,tierCount | 4 行（RM001–004）
7. `RankMatchTier.csv` | PK tierId | tierId,name,starNeeded,protectRule | 10 行（青铜Ⅳ→王者，晋级星数）
8. `RankMatchReward.csv` | PK seasonId+tierId | seasonId,tierId,rewardType,rewardItemId,rewardQty | seasonId→RankMatchSeason；tierId→RankMatchTier；12 行

### M11 公会与远征（11 文件，全部新建）

1. `Guild.csv` | PK level | level,maxMember,buildingSlots,costGold,expToNext | 10 行（GU001–010 用 level 1–10 作主键）
2. `GuildLevel.csv` | PK level | level,expNeeded,maxMember | 10 行
3. `GuildBuilding.csv` | PK buildingId | buildingId,name,level,effect,costGuildPoint | 12 行（议事厅/锻造坊/药圃/训练场/仓库/雕像）
4. `GuildQuest.csv` | PK guildQuestId | guildQuestId,name,objective,targetCount,rewardGuildPoint | 12 行
5. `GuildWar.csv` | PK warId | warId,name,seasonRef,format,durationDay,rewardPoolRef | 8 行（GV001–008）
6. `GuildWarReward.csv` | PK warId+rank | warId,rank,rewardItemId,rewardQty | warId→GuildWar；12 行
7. `GuildBoss.csv` | PK bossId | bossId,name,element,baseHp,joinLimit,guildLevelReq | 8 行（GB001–008；guildLevelReq→Guild.level）
8. `GuildBossReward.csv` | PK bossId+damageTier | bossId,damageTier,rewardItemId,rewardQty | bossId→GuildBoss；8 行
9. `Expedition.csv` | PK expeditionId | expeditionId,name,regionId,durationHour,recommendPower,rewardItemId | regionId→Region；20 行（EX001–020：委托探索/遗迹考察/护送/采集/讨伐）
10. `ExpeditionReward.csv` | PK expeditionId+successTier | expeditionId,successTier,rewardItemId,rewardQty | expeditionId→Expedition；20 行
11. `ExpeditionHero.csv` | PK expeditionId+heroId | expeditionId,heroId,bonusPercent | 双外键；12 行（推荐/加成角色）

### M12 系统配置（18 文件，全部新建）

1. `JsonConfig.csv` | PK key | key,value,type,description | 20 行（通用键值：新手赠送、默认队伍位、最大好友数、聊天等级限制等）
2. `WorldLevel.csv` | PK worldLevel | worldLevel,unlockCond,monsterLevelOffset,rewardMul,costMul | 8 行（WL1–8；怪物等级偏移 +5/层）
3. `MailTemplate.csv` | PK mailId | mailId,title,contentRef,attachmentType,attachmentId,attachmentQty,expireDay | 30 行（ML001–030：维护补偿/版本更新/活动发放/违规通知/好友礼包）
4. `LoadingTips.csv` | PK tipId | tipId,text,weight | 20 行
5. `RandomName.csv` | PK nameId | nameId,name,usedFor | 30 行（usedFor ∈ hero/npc/guild/pet）
6. `Region.csv` | PK regionId | regionId,name,openLevel,unlockQuestId,exploreRewardRef | unlockQuestId→Quest（可空）；8 行（RG001 星轨城/RG002 旧都废墟/RG003 赤炎熔炉区/RG004 寒渊谷/RG005 星轨遗迹/RG006 影渊裂谷/RG007 虚境浮岛/RG008 星屑边境）
7. `Waypoint.csv` | PK waypointId | waypointId,regionId,name,unlockCond,teleportCost | regionId→Region；40 行（WY001–040；每区域 5 个，teleportCost 0–500 GOLD）
8. `Codex.csv` | PK codexId | codexId,category,targetType,targetId,title,description | targetId 多态（按 targetType：hero→H**、monster→M**、item→IT**、material→MAT**、region→RG**）；50 行（CX001–050）
9. `CodexReward.csv` | PK category+count | category,count,rewardItemId,rewardQty | 10 行（图鉴收集里程碑）
10. `VersionConfig.csv` | PK version | version,feature,note | 6 行（v0.1 基线/v0.2 扩充/v0.3 公会/v0.4 排位/v0.5 周年/v0.6 终局）
11. `Announcement.csv` | PK annId | annId,title,contentRef,startVersion,endVersion | 8 行
12. `PowerFormulaWeight.csv` | PK statType | statType,weight,note | 10 行（**必须与表 02-2 完全一致**：atkFlat 3/defFlat 2/atkPct 250/defPct 300/hpPct 120/critRate 300/critDmg 200/energyRecharge 100）
13. `FormulaParam.csv` | PK paramId | paramId,name,value,description | 10 行（FP001 defConst=1000；FP002 critMulBase=1.5；FP003 减伤上限=0.8；FP004 最低伤害=1；FP005 brokenMul=1.25；FP006 融化倍率=1.5；FP007 超载倍率=0.5；FP008 破韧受击加成=0.25；FP009 能量上限=100；FP010 普攻回能=10 —— **必须与 §1.2 一致**）
14. `DailyReset.csv` | PK resetType | resetType,time,note | 6 行（每日 04:00 刷新体力/商店/日常；每周一 04:00 周常；每月 1 日 04:00 月常）
15. `Pet.csv` | PK petId | petId,name,rarity,effectRef,obtainType | 10 行（PT001 星灵/PT002 火灵/PT003 冰灵/PT004 雷灵/PT005 岩灵/PT006 影灵/PT007 庆典彩灵/PT008 周年金灵/PT009 萌兔/PT010 机械犬）
16. `PetLevel.csv` | PK petId+level | petId,level,statBonus,expToNext | petId→Pet；50 行（10 宠 × 5 采样级）
17. `PetSkill.csv` | PK petSkillId | petSkillId,petId,name,effect,unlockLevel | petId→Pet；20 行
18. `EventSchedule.csv` | PK eventId | eventId,name,type,startVersion,endVersion,ruleRef | 12 行（EV001 夏日庆典/EV002 周年庆典/EV003 新春庆典/EV004 复刻·焰舞/EV005 复刻·霜华/EV006 双倍掉落周/EV007 爬塔冲层赛/EV008 公会协力战/EV009 竞技狂欢周/EV010 新手回馈/EV011 星屑秘境/EV012 限时联动·星轨学院；type ∈ seasonal/rerun/boost/tournament）

### M13 玩法内容（21 文件，全部新建）

1. `WorldBoss.csv` | PK bossId | bossId,name,element,regionId,baseHp,openVersion,rewardRef | regionId→Region；8 行（WB001 熔岩巨神/WB002 霜渊龙王/WB003 雷暴之翼/WB004 暗影巨像/WB005 星轨古龙/WB006 虚境主宰/WB007 庆典巨兽/WB008 深渊化身）
2. `WorldBossReward.csv` | PK bossId+damageTier | bossId,damageTier,rewardItemId,rewardQty | bossId→WorldBoss；8 行
3. `Simulation.csv` | PK simId | simId,name,floorCount,entryCost,recommendPower,rewardRef | 12 行（SM001–012：模拟演算·序章~终局，entryCost 用 IT190 门票或体力）
4. `SimulationFloor.csv` | PK simId+floorNo | simId,floorNo,affixId,monsterGroup,recommendPower | simId→Simulation；affixId→DungeonAffix（可空）；60 行（12 演算 × 5 层）
5. `SimulationBuff.csv` | PK simBuffId | simBuffId,name,effect,rarity | 20 行（演算内增益：攻击+30%/回能+50%/元素穿透…）
6. `TreasureHunt.csv` | PK huntId | huntId,name,regionId,difficulty,rewardRef,unlockLevel | regionId→Region；12 行（TH001–012：寻宝/密藏/古墓）
7. `Lottery.csv` | PK lotteryId | lotteryId,name,costItemId,costQty,rewardPoolRef | 8 行（LT001–008：庆典抽奖/周年抽奖）
8. `Wheel.csv` | PK wheelId | wheelId,name,spinCost,segmentCount,eventRef | eventRef→EventSchedule（可空）；8 行（WH001–008：幸运转盘）
9. `WheelReward.csv` | PK wheelId+rewardId | wheelId,rewardId,itemId,weight | wheelId→Wheel；物品多态；24 行（每盘 3 档 × 权重）
10. `RandomBox.csv` | PK boxId | boxId,name,priceGem,possibleRewardsRef | 12 行（RB001–012：随机宝箱/盲盒）
11. `TreasureChest.csv` | PK chestId | chestId,regionId,rewardType,rewardItemId,rewardQty,respawnDay | regionId→Region；30 行（TC001–030：地图宝箱，respawnDay 0=一次性）
12. `Puzzle.csv` | PK puzzleId | puzzleId,regionId,type,rewardRef,unlockCond | regionId→Region；12 行（PZ001–012：推箱子/点亮/音律/机关）
13. `HiddenQuest.csv` | PK questId | questId,name,triggerCond,rewardItemId,rewardQty | 20 行（HQ001–020：隐藏任务，triggerCond 写触发条件文本）
14. `TeamBuff.csv` | PK buffId | buffId,name,heroCount,effectRef,heroes | 12 行（TB001–012：羁绊名 + heroes=`;` 分隔 H**；如 TB001 星轨守望=H001+H008；TB002 霜华共鸣=H005+H007+H015；TB003 雷鸣协奏=H003+H006+H009；TB004 烈焰审判=H002+H014；TB005 秘火圣歌=H013+H016；其余自拟，保证覆盖 16 角色且无重复）
15. `TeamBuffHero.csv` | PK buffId+heroId | buffId,heroId,required | 双外键；30 行（羁绊构成明细）
16. `BountyDaily.csv` | PK bountyId | bountyId,name,objective,targetCount,rewardItemId,rewardQty | 12 行（DK001–012 每日悬赏）
17. `BountyWeekly.csv` | PK bountyId | bountyId,name,objective,targetCount,rewardItemId,rewardQty | 12 行（WK001–012 每周悬赏）
18. `Tournament.csv` | PK tournamentId | tournamentId,name,format,durationDay,rewardRef | 4 行（TM001–004：星轨锦标赛·春季/夏季/秋季/冬季）
19. `TournamentReward.csv` | PK tournamentId+rank | tournamentId,rank,rewardItemId,rewardQty | tournamentId→Tournament；8 行
20. `MiniGame.csv` | PK miniGameId | miniGameId,name,entryCost,rewardRef,unlockLevel | 8 行（MG001–008：弹幕小游戏/翻牌/钓鱼?→ 改为 打靶/答题/音游/赛跑/宝箱大作战/猜拳）
21. `MiniGameReward.csv` | PK miniGameId+scoreTier | miniGameId,scoreTier,rewardItemId,rewardQty | miniGameId→MiniGame；8 行

### M14 补充系统（17 文件，全部新建）

1. `HeroSkillUnlock.csv` | PK heroId+skillType | heroId,skillType,unlockLevel,unlockCond | 双外键（skillType 见 §1.3）；64 行（16 角色 × 4：normal L1/skill L1/ult L10?/passive L5? —— 自行设计但全库统一规则）
2. `UltCharge.csv` | PK heroId | heroId,ultCost,chargePerNormal,chargePerSkill,chargePerHit | heroId→Hero；16 行（ultCost=100 全库一致，回能参数与 §1.2 一致）
3. `GachaUpPool.csv` | PK poolId | poolId,upHeroId,upWeaponId,upRate,note | poolId→GachaPool；upHeroId→Hero（可空）；upWeaponId→Weapon（可空）；8 行
4. `FreeGacha.csv` | PK poolId | poolId,freePerDay,pityShare | poolId→GachaPool；6 行（每日免费抽）
5. `ShopDiscount.csv` | PK shopId+itemId | shopId,itemId,discount,eventRef | shopId→ShopItem；eventRef→EventSchedule（可空）；12 行（折扣 0.5–0.9）
6. `ActivityReward.csv` | PK eventId+points | eventId,points,rewardItemId,rewardQty | eventId→EventSchedule；16 行（活动积分累计奖励）
7. `Milestone.csv` | PK milestoneId | milestoneId,name,targetType,targetValue,rewardItemId,rewardQty | 10 行（里程碑：战力/等级/通关数/收集数）
8. `CombatTrial.csv` | PK trialId | trialId,name,recommendPower,conditionRef,rewardItemId,rewardQty | 8 行（试炼场：木桩/生存/限时/无伤）
9. `ChatEmoji.csv` | PK emojiId | emojiId,name,unlockCond | 12 行
10. `AvatarFrame.csv` | PK frameId | frameId,name,unlockCond | 12 行
11. `ChatBubble.csv` | PK bubbleId | bubbleId,name,unlockCond | 8 行
12. `NoviceReward.csv` | PK dayNo | dayNo,rewardItemId,rewardQty | 8 行（新手 7 日奖励）
13. `BreakShield.csv` | PK shieldId | shieldId,name,baseValue,breakFactor,regenPerSec | 10 行（韧性/护盾条参数；与《04_Buff与状态机》§2.1 破韧一致）
14. `DodgeRule.csv` | PK dodgeId | dodgeId,cdSec,iframeSec,costStamina,note | 5 行（闪避规则：CD 1.5s/无敌帧 0.3s/消耗 10 体力值? —— 用「dodge 资源」描述，避免与副本体力混淆）
15. `CoopRecommend.csv` | PK coopDungeonId | coopDungeonId,recommendHeroIds,roleHint | coopDungeonId→CoopDungeon；10 行（推荐阵容：tank+dps+support）
16. `PvpMap.csv` | PK mapId | mapId,name,size,buffId,available | buffId→Buff（可空）；6 行（PVP 地图：环形竞技场/平台跳跃/镜像迷宫…）
17. `ArenaBuff.csv` | PK seasonId+buffType | seasonId,buffType,value,note | seasonId→ArenaSeason；6 行（赛季天平：治疗 -10%、护盾 -10% 等）

---

### M15 补充内容配表（11 张，全部新建；父表均已存在）

| 文件 | 主键 | 列 | 外键 | 行数 |
|------|------|----|------|------|
| NpcDialogue.csv | npcId+seqNo | npcId,seqNo,dialogueText | npcId→Npc | 20 |
| StoryDialogue.csv | dialogueId（DIA001–DIA024） | dialogueId,questId,seqNo,speaker,line | questId→Quest（可空） | 24 |
| GachaExchange.csv | exchangeId（GEX001–GEX012） | exchangeId,costItemId,costQty,rewardItemId,rewardQty,weeklyLimit | costItemId→Item；rewardItemId→物品多态 | 12 |
| GuildDonate.csv | donateId（GD001–GD006） | donateId,name,costCurrency,costAmount,rewardGuildPoint,dailyLimit | costCurrency∈货币枚举 | 6 |
| PetEvolution.csv | fromPetId | fromPetId,toPetId,levelReq,materialId,materialQty | fromPetId/toPetId→Pet；materialId→Material | 8 |
| WeaponSkin.csv | skinId（WSK001–WSK012） | skinId,weaponId,name,rarity,priceGem,unlockCond | weaponId→Weapon | 12 |
| EquipmentAwaken.csv | equipId+stage | equipId,stage,levelReq,costGold,materialId,materialQty,statBonus | equipId→Equipment；materialId→Material | 12 |
| EnhanceRate.csv | level | level,successRate,failRefundRate | — | 15 |
| ExpCurve.csv | itemId | itemId,expValue,useType,note | itemId→Material（MAT11/12/13/36 等） | 8 |
| ArenaDailyReward.csv | rewardId（ADR001–ADR006） | rewardId,name,conditionType,rewardItemId,rewardQty | rewardItemId→物品多态 | 6 |
| WorldBossSchedule.csv | scheduleId（WBS001–WBS008） | scheduleId,bossId,openDay,openHourStart,openHourEnd | bossId→WorldBoss | 8 |

> 本模块表由主 Agent 直接生成；行数 4–7 的小配置表按校验器放宽规则（WARN 级）。

---

## 4. 文档模块清单（D1–D4 + M16；51 篇总量）

> 每篇文档必须：6 节模板（§1.4）；「配表引用」表只写**真实存在**的表与 ID；正文对象一律 `中文名+ID` 成对；至少 1 处 `参见《NN_…》` 引用（v0.1 文档与 v0.2 文档皆可）；数值引用 §1.2 公式不重定义。

### D1 战斗与养成文档（7 篇，编号 13–19；覆盖 M1/M2/M3/M5 表格）

| 文档 | 主题 | 必须覆盖的表 |
|------|------|-------------|
| 13_技能突破与养成消耗设计.md | 技能突破 3 阶段、消耗曲线、与技能书材料闭环 | SkillBreakthrough/SkillLevel/Skill/Material |
| 14_命座与星魂系统设计.md | 6 星命座效果、材料 MAT19、获取途径（卡池/活动） | Constellation/Hero/GachaItem |
| 15_好感度与角色档案.md | 好感 5 阶奖励、档案文案、语音解锁 | HeroAffinity/HeroIntro/HeroVoice |
| 16_皮肤与外观系统.md | 皮肤 SN、外观道具 IT131–150、头像框/气泡 | HeroSkin/Namecard/AvatarFrame/ChatBubble/ChatEmoji |
| 17_元素反应与克制扩展.md | 既有 3 反应 + 新组合、附着规则扩展、ElementResist | ElementReaction/ElementChart/Buff/ElementResist |
| 18_怪物设计总纲.md | 怪物数值模板、AI 模板、等级系数、元素抗性 | Monster/MonsterLevel/MonsterSkill/MonsterAI/MonsterDrop/MonsterElementResist |
| 19_Boss设计与阶段机制.md | 12 首领、阶段转换、机制表、Boss 掉落 | Boss/BossPhase/BossMechanic/BossReward |

### D2 内容系统文档（8 篇，编号 20–27；覆盖 M4/M6/M7/M8/M9 表格）

| 文档 | 主题 | 必须覆盖的表 |
|------|------|-------------|
| 20_副本词缀与虚境试炼.md | 词缀 AF、爬塔 TF、周挑战、活动副本 | DungeonAffix/TowerFloor/TowerReward/WeeklyChallenge/EventDungeon |
| 21_世界地图与探索收集.md | 区域 RG、传送点 WY、宝箱/谜题/隐藏任务 | Region/Waypoint/TreasureChest/Puzzle/HiddenQuest |
| 22_任务系统总纲.md | 8 章主线、支线、周常、任务链、奖励结构 | Quest/QuestStep/QuestReward/QuestChain/StoryChapter/StoryChapterReward |
| 23_成就与称号系统.md | 6 类成就、称号、图鉴里程碑 | Achievement/AchievementCategory/Title/Codex/CodexReward |
| 24_抽卡与卡池设计.md | 卡池 GP、概率/保底、定轨、UP | GachaPool/GachaRate/GachaPity/GachaItem/GachaWish/GachaUpPool/FreeGacha |
| 25_付费结构与月卡基金.md | 首充/充值档/月卡/战令/基金/礼包 | FirstChargeReward/TopUp/MonthlyCard/BattlePass/BattlePassReward/GrowthFund/GiftPack/NewbiePack |
| 26_签到与登录奖励.md | 14 天签到、在线/离线收益、新手 7 日 | DailyLoginReward/OnlineReward/OfflineReward/NoviceReward |
| 27_礼包与限时商店.md | 限时商店、折扣、活动商店、兑换规则 | LimitedShop/ShopDiscount/EventShop/ShopItem/ExchangeRule |

### D3 竞技与社交文档（8 篇，编号 28–35；覆盖 M9/M10/M11 表格）

| 文档 | 主题 | 必须覆盖的表 |
|------|------|-------------|
| 28_竞技场与赛季设计.md | 赛季/段位/结算奖励/赛季天平 | ArenaSeason/ArenaTier/ArenaReward/ArenaBuff/PvpMap |
| 29_排位赛与匹配规则.md | 排位赛季、晋级、匹配、榜单 | RankMatchSeason/RankMatchTier/RankMatchReward/MatchmakingRule/LeaderboardReward |
| 30_公会系统设计.md | 公会等级/建筑/任务/商店 | Guild/GuildLevel/GuildBuilding/GuildQuest/GuildShop |
| 31_公会战与公会Boss.md | 公会战赛季、公会Boss | GuildWar/GuildWarReward/GuildBoss/GuildBossReward |
| 32_远征与派遣系统.md | 远征 EX、成功率、加成角色 | Expedition/ExpeditionReward/ExpeditionHero |
| 33_合成锻造与洗练回收.md | 配方 RC、装备锻造/洗练/回收、材料来源 | Recipe/EquipRecipe/EquipmentTransmute/EquipmentRecycle/MaterialSource |
| 34_体力与资源循环总览.md | 体力规则/价格、每日刷新、收益上限 | StaminaRule/StaminaPricing/DailyReset/FarmLimit |
| 35_反刷与收益上限.md | 反刷设计、掉落衰减、每日/每周上限、防膨胀 | FarmLimit/MaterialSource/StaminaPricing/JsonConfig |

### D4 系统框架文档（13 篇，编号 36–48；覆盖 M8/M12/M13/M14 表格）

| 文档 | 主题 | 必须覆盖的表 |
|------|------|-------------|
| 36_新手引导与功能解锁.md | 引导 Tutorial、功能解锁 FU、新手任务 | Tutorial/FunctionUnlock/NewbieQuest/NewbiePack |
| 37_活动框架与排期.md | 活动 EV 排期、活动奖励、商店、副本联动 | EventSchedule/ActivityReward/EventShop/EventDungeon/EventSchedule |
| 38_邮件系统设计.md | 邮件模板、附件、过期 | MailTemplate/Announcement |
| 39_图鉴与收藏.md | 图鉴 CX、收藏品 IT091–110、里程碑 | Codex/CodexReward/Milestone |
| 40_组队与匹配设计.md | 组队副本、推荐阵容、助战 | CoopDungeon/CoopReward/CoopRecommend/MatchmakingRule |
| 41_模拟演算与终局玩法.md | 模拟演算、世界Boss、深渊讨伐 | Simulation/SimulationFloor/SimulationBuff/WorldBoss/WorldBossReward |
| 42_世界Boss与限时玩法.md | 世界Boss 刷新、伤害档位、限时玩法 | WorldBoss/WorldBossReward/TreasureHunt/EventSchedule |
| 43_PVP平衡与禁用表.md | PVP 修正、禁用清单、赛季天平 | PvpBalance/PvpBanList/ArenaBuff |
| 44_成长曲线与数值规划.md | 全养成曲线汇总、数值规划 v0.2–v0.6 | HeroLevel/WeaponLevel/WeaponBreakthrough/EquipmentLevel/FormulaParam/PowerFormulaWeight |
| 45_随机数与保底机制总览.md | 掉落保底/卡池保底/随机箱/转盘/抽奖 | DropTable/GachaPity/GachaRate/RandomBox/Wheel/WheelReward/Lottery |
| 46_队伍羁绊与阵容体系.md | 羁绊 TB、阵容推荐、角色定位 | TeamBuff/TeamBuffHero/CoopRecommend/Hero |
| 47_道具与物品体系总览.md | IT 物品注册、使用效果、堆叠、合成 | Item/ItemUse/Recipe/ShopItem |
| 48_存档与账号规范.md | 存档结构、跨端规则、数据保护 | JsonConfig/VersionConfig/Announcement |

### M16 规范与QA更新（2 篇新文档 + 3 篇更新；在所有配表与文档完成后执行）

- 更新 `10_配表规范与外键约定.md` → v0.2：全库 204 表统计（§5 重写）、外键清单扩至全部规则（§4 摘要 + 指向 `knowledge_gen/validate.mjs` 为机器校验唯一权威）、新增表字段映射（§6 追加，长尾表写「映射见 validate.mjs / 命名模式见 master_plan」）、行数约束放宽说明（8–200，机械表例外）。
- 更新 `11_边界异常与QA检查清单.md` → v0.2：自检清单逐条复检（引用 validate.mjs 输出）、新增证据链（§3 追加链 C：卡池→角色→伤害；链 D：爬塔→词缀→阵容；链 E：远征→材料→锻造）、表↔文档覆盖统计重写（51 文档 204 表）、边界用例扩展（E9–E16：多态物品引用、coop 口径、通用被动不升级、空 passiveSkillId、命座槽位唯一、活动代币过期、爬塔词缀轮换、羁绊重复）。
- 更新 `12_版本变更记录_v0.1.md` → 追加 v0.2 变更段（在既有内容后追加，不删既有行）。
- 新建 `49_QA扩展检查清单_v0.2.md`：v0.2 专属自检（含 validate.mjs 运行结果快照、覆盖统计、证据链全表）。
- 新建 `50_模拟知识库生成说明.md`：说明本库定位（初始资料→knowledge-hub 加工链路）、生成契约（master_plan.md）、校验方式（validate.mjs）、ID 双层命名、消费注意（coop 口径等）。

---

## 5. 校验方案（knowledge_gen/validate.mjs）

校验脚本由主 Agent 编写，规则如下（子 Agent 不得修改）：

1. **表级**：全部 204 张 CSV 存在；表头第 1 行 camelCase（正则 `^[a-z][a-zA-Z0-9]*$`）；主键唯一非空；行数 8–200（机械表 >200 打 WARN）。
2. **枚举**：element/class/skillType/slot/rarity/dungeonType/itemType/currency/questType/monsterType/buffKind 等按 §1.3 校验（识别列名）。
3. **外键**：按「表.列 → 表.列」规则表（内置，等价 §3 各表 FK 列）逐条校验闭合。
4. **多态物品引用**：IT**→Item.csv；MAT**→Material.csv；WP**→Weapon.csv；EQ**→Weapon?（EQ**→Equipment.csv）；货币 token ∈ {GOLD,GEM,STAMINA,DUNGEON_TOKEN,ARENA_POINT,GUILD_POINT,EVENT_TOKEN}；STAMINA。
5. **ID 存在性**：所有 CSV 单元格中出现的 `H\d+ / SK\d+ / BF\d+ / WP\d+ / EQ\d+ / DG\d+ / DR\d+ / SH\d+ / MAT\d+ / M\d+ / B\d+ / EM\d+ / IT\d+ / QS\d+ / AC\d+ / CN\d+ / SN\d+ / TN\d+ / TI\d+ / NC\d+ / HV\d+ / MS\d+ / AI\d+ / AF\d+ / TF\d+ / EV\d+ / NP\d+ / EX\d+ / FU\d+ / TB\d+ / WB\d+ / SM\d+ / TH\d+ / LT\d+ / WH\d+ / RB\d+ / TC\d+ / PZ\d+ / HQ\d+ / WK\d+ / DK\d+ / TM\d+ / MG\d+ / PT\d+ / GB\d+ / GP\d+ / RC\d+ / ML\d+ / CX\d+ / RG\d+ / WY\d+ / FP\d+ / RL\d+ / WT\d+ / CC\d+ / SHL\d+ / DT\d+ / HF\d+ / EM\d+` 必须存在于对应定义表主键（区间写法 `A001–B020` 或 `A001-B020` 跳过）。
6. **文档 ID**：扫描 gamedocs/*.md 中上述正则的 ID token，同样校验（区间跳过），WARN 级（供人工复核）。
7. **文档结构**：每篇含「配表引用」节 + 至少 1 处 `参见《` 引用（WARN 级）。
8. **公式一致性抽查**：SkillLevel.skillRate ≈ Skill.skillRate×1.8（±0.05）；DropTable 每 dropId weight 合计 = 1000（精确）；FormulaParam/PowerFormulaWeight 与 §1.2 常量一致（精确）。
9. **既有行保护**：对 12 张既有表，校验 v0.1 既有行的 PK 集合是 v0.2 的子集（追加检测，检测既有行数值是否被改动按主键抽查）。

输出：PASS/FAIL 汇总 + 错误明细（文件:行），退出码 0/1。

## 6. 最终自检清单（生成完成后逐条 PASS/FAIL）

- [ ] 文档数 ≥ 50（目标 51）
- [ ] 配表数 ≥ 200（目标 204）
- [ ] 所有表 FK 无悬空（validate.mjs 全 PASS）
- [ ] 文档出现的每个 ID 都能在表中找到（validate.mjs §6 无 ERROR/WARN 遗留）
- [ ] 每张表至少被 1 篇文档引用（validate.mjs §7 + M15 覆盖统计）
- [ ] 每篇业务文档至少引用 1 张表 + 1 篇其他文档
- [ ] 伤害公式、战力公式、经济货币枚举全局唯一（§1.2 + FormulaParam/PowerFormulaWeight 对齐）
- [ ] 角色定位差异可从数值读出（H 表 + 战力文档）
- [ ] 存在至少 1 条「跨 3 跳」证据链（11/49 文档写入，≥3 条）
- [ ] v0.1 既有行未被修改（§5.9 校验）
