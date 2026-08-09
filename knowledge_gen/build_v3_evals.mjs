// 构建 StarTrail 黄金评测集 v3（kbVersion v0.2）：
// 保留 EV-001~030（v0.1 回归）+ 新增 EV-031~078（v0.2 新模式覆盖）。
// 所有数值已与 knowledge/gamedata/ 实际 CSV 逐项核对（2026-08-09）。
import fs from "node:fs";

const KB = "C:/Users/aaaab/Desktop/个人项目/knowledge-hub/knowledge";
const OUT = "C:/Users/aaaab/Desktop/个人项目/knowledge-hub/evals/golden_evals.json";

const gold = JSON.parse(fs.readFileSync(OUT, "utf8"));

const NEW_CASES = [
  // ============ basic_retrieval：v0.2 新单表检索 ============
  {
    id: "EV-031", group: "basic_retrieval", difficulty: 1,
    question: "H009 苍霆·御的职业、元素、专属武器分别是什么？稀有度多少？",
    expectedAnswer: "class=tank（坦克），element=thunder（雷），weaponId=WP009 霆渊雷盾，rarity=5",
    keyFacts: ["tank", "thunder", "WP009", "霆渊雷盾"],
    numPairs: [["rarity", 5]],
    sourceFiles: ["gamedata/Hero.csv", "gamedata/Weapon.csv"],
    notes: "v0.2 新增角色行定位；答案必须给 ID 而非仅中文名。"
  },
  {
    id: "EV-032", group: "basic_retrieval", difficulty: 1,
    question: "BF018 易伤的类型、叠层规则、持续时间和受伤加深幅度？",
    expectedAnswer: "kind=stat（属性），stackRule=刷新，durationSec=6，value=+0.25受伤，maxStack=1",
    keyFacts: ["stat", "刷新"],
    numPairs: [["durationSec", 6], ["maxStack", 1]],
    sourceFiles: ["gamedata/Buff.csv"],
    notes: "v0.2 新增 Buff 行；durationSec/maxStack 精确。"
  },
  {
    id: "EV-033", group: "basic_retrieval", difficulty: 1,
    question: "DG015 元素试炼·火的类型、体力消耗、推荐战力和解锁等级？",
    expectedAnswer: "type=material，staminaCost=10，recommendPower=1500，unlockLevel=15，dropId=DR015",
    keyFacts: ["material"],
    numPairs: [["staminaCost", 10], ["recommendPower", 1500], ["unlockLevel", 15]],
    sourceFiles: ["gamedata/Dungeon.csv"],
    notes: "v0.2 新增副本；单人口径。"
  },
  {
    id: "EV-034", group: "basic_retrieval", difficulty: 1,
    question: "GP001 常驻·星轨集结卡池的类型和消耗道具是什么？",
    expectedAnswer: "type=mixed（混合池），costItemId=IT051 常驻招募券，costAmount=1",
    keyFacts: ["mixed", "IT051", "常驻招募券"],
    numPairs: [["costAmount", 1]],
    sourceFiles: ["gamedata/GachaPool.csv", "gamedata/Item.csv"],
    notes: "v0.2 新增卡池表；costItemId 多态引用 Item。"
  },
  {
    id: "EV-035", group: "basic_retrieval", difficulty: 1,
    question: "M001 烬火幼狼的元素、类型和基础生命值？",
    expectedAnswer: "element=fire（火），type=normal（普通怪），baseHp=3600，nativeLevel=24",
    keyFacts: ["fire", "normal"],
    numPairs: [["baseHp", 3600]],
    sourceFiles: ["gamedata/Monster.csv"],
    notes: "v0.2 新增怪物表；baseHp 精确。"
  },
  {
    id: "EV-036", group: "basic_retrieval", difficulty: 1,
    question: "QS001 列车启程的任务类型和解锁等级？",
    expectedAnswer: "type=main（主线），unlockLevel=1，章一 起航（StoryChapter CH001）",
    keyFacts: ["main", "CH001"],
    numPairs: [["unlockLevel", 1]],
    sourceFiles: ["gamedata/Quest.csv", "gamedata/StoryChapter.csv"],
    notes: "v0.2 新增任务表；主线首任务。"
  },
  {
    id: "EV-037", group: "basic_retrieval", difficulty: 1,
    question: "IT051 常驻招募券的物品类型、稀有度和最大堆叠？",
    expectedAnswer: "itemType=ticket（凭证），rarity=4，stackMax=999",
    keyFacts: ["ticket"],
    numPairs: [["rarity", 4], ["stackMax", 999]],
    sourceFiles: ["gamedata/Item.csv"],
    notes: "v0.2 新增物品总表；stackMax 精确。"
  },
  {
    id: "EV-038", group: "basic_retrieval", difficulty: 1,
    question: "TB002 霜华共鸣羁绊由哪些角色组成？效果是什么？",
    expectedAnswer: "成员 H005 霜语·澈、H007 岚翼·翎、H015 冰棱·朔（heroCount=3）：全队冰元素伤害+18%，冻结时间延长20%",
    keyFacts: ["H005", "H007", "H015", "冰元素伤害+18%"],
    numPairs: [["heroCount", 3]],
    sourceFiles: ["gamedata/TeamBuff.csv", "gamedata/Hero.csv"],
    notes: "v0.2 新增羁绊表；heroes 分号列表导航。"
  },

  // ============ cross_table：v0.2 外键导航 ============
  {
    id: "EV-039", group: "cross_table", difficulty: 2,
    question: "H009 苍霆·御的完整技能组（4 个技能 ID 及类型）？",
    expectedAnswer: "SK033 霆御斩(normal) / SK034 雷纹壁垒(skill) / SK035 天霆神罚(ult) / SK036 不灭雷躯(passive)",
    keyFacts: ["SK033", "SK034", "SK035", "SK036", "passive"],
    sourceFiles: ["gamedata/Hero.csv", "gamedata/Skill.csv"],
    notes: "Skill.heroId → H009 一对多导航；4 个 ID 缺一即 PARTIAL。"
  },
  {
    id: "EV-040", group: "cross_table", difficulty: 2,
    question: "WP017 赤焰大剑的被动技能是什么？该被动的 heroId 归属谁（注意归属语义）？",
    expectedAnswer: "passiveSkillId=SK065 通用·战意（攻击+8%，skillType=passive、skillRate=0）；其 heroId=H002 仅为设计归属，不进入 H002 技能组（通用被动池）",
    keyFacts: ["SK065", "通用·战意", "H002", "通用被动"],
    sourceFiles: ["gamedata/Weapon.csv", "gamedata/Skill.csv"],
    notes: "考核 Weapon.passiveSkillId → 通用被动池 SK065-072；通用被动的 heroId 语义是设计归属。"
  },
  {
    id: "EV-041", group: "cross_table", difficulty: 2,
    question: "B001 熔核巨兽出现在哪个副本？有几个阶段？",
    expectedAnswer: "出现于 DG012 旧都废墟·I，phaseCount=2（阶段阈值 100/50，技能见 BossPhase）",
    keyFacts: ["DG012", "旧都废墟·I"],
    numPairs: [["phaseCount", 2]],
    sourceFiles: ["gamedata/Boss.csv", "gamedata/BossPhase.csv", "gamedata/Dungeon.csv"],
    notes: "Boss.dungeonId → Dungeon + BossPhase 阶段数。"
  },
  {
    id: "EV-042", group: "cross_table", difficulty: 2,
    question: "H014 燎原·羽的星 1 命座（CN079）效果是什么？槽位是几？",
    expectedAnswer: "CN079 火羽初燃（slot=1）：新增被动——蓄力满层后额外发射 1 枚 0.20×ATK 火元素箭矢",
    keyFacts: ["CN079", "火羽初燃", "0.20"],
    numPairs: [["slot", 1]],
    sourceFiles: ["gamedata/Constellation.csv", "gamedata/Hero.csv"],
    notes: "Constellation.heroId → H014；slot 为命座槽位（1-6），勿与装备槽位混淆。"
  },
  {
    id: "EV-043", group: "cross_table", difficulty: 2,
    question: "EX002 旧都遗迹考察远征的区域、时长和奖励？",
    expectedAnswer: "regionId=RG002 旧都废墟，durationHour=4，rewardItemId=MAT29 图鉴碎片×3（ExpeditionReward 成功档）",
    keyFacts: ["RG002", "MAT29", "图鉴碎片"],
    numPairs: [["durationHour", 4]],
    sourceFiles: ["gamedata/Expedition.csv", "gamedata/ExpeditionReward.csv", "gamedata/Region.csv"],
    notes: "远征→区域 + 奖励表；注意 EX002 奖励是 MAT29 而非 MAT38（实测）。"
  },
  {
    id: "EV-044", group: "cross_table", difficulty: 2,
    question: "WB001 熔岩巨神的元素、所在区域和刷新排期？",
    expectedAnswer: "element=fire，regionId=RG003 赤炎熔炉区，baseHp=2000000；WBS001 每周一 20:00-22:00 刷新",
    keyFacts: ["fire", "RG003", "WBS001", "星期一"],
    sourceFiles: ["gamedata/WorldBoss.csv", "gamedata/WorldBossSchedule.csv", "gamedata/Region.csv"],
    notes: "WorldBoss → Region + Schedule 排期导航。"
  },
  {
    id: "EV-045", group: "cross_table", difficulty: 2,
    question: "GP002 限定·焰舞池的 up 角色是谁？消耗什么道具？定轨目标是什么？",
    expectedAnswer: "upRef=H014 燎原·羽（GachaItem isUp=TRUE，5★ weight=3）；消耗 IT052 限定招募券；GachaWish 定轨 wishItemId=H014（costItemId=IT060 定轨券）",
    keyFacts: ["H014", "IT052", "IT060"],
    sourceFiles: ["gamedata/GachaPool.csv", "gamedata/GachaItem.csv", "gachaWish".length ? "gamedata/GachaWish.csv" : "gamedata/GachaWish.csv", "gamedata/Item.csv"],
    notes: "卡池→UP 内容→定轨三段导航；IT052/IT060 为抽卡道具段注册物品。"
  },
  {
    id: "EV-046", group: "cross_table", difficulty: 2,
    question: "QS039 星轨决战的通关奖励是什么？",
    expectedAnswer: "QuestReward：IT074 五星武器箱×1 + gold=60000 + exp=12000（主线终章奖励）",
    keyFacts: ["IT074", "五星武器箱"],
    numPairs: [["gold", 60000]],
    sourceFiles: ["gamedata/Quest.csv", "gamedata/QuestReward.csv", "gamedata/Item.csv"],
    notes: "Quest → QuestReward 一对多；gold 精确。"
  },

  // ============ formula_calc：v0.2 数值公式 ============
  {
    id: "EV-047", group: "formula_calc", difficulty: 2,
    question: "SK055 焚天之羽升到 L10 的倍率是多少（按技能成长规则 L10 = L1×1.8）？",
    expectedAnswer: "skillRate L1=4.70，L10=4.70×1.8=8.46（SkillLevel.csv 实测 8.46，升级消耗含 MAT08/09/10）",
    keyFacts: ["4.70", "8.46"],
    numPairs: [["skillRate", 8.46]],
    sourceFiles: ["gamedata/Skill.csv", "gamedata/SkillLevel.csv"],
    notes: "技能成长公式复现：L10 = L1×1.8；8.46 精确。"
  },
  {
    id: "EV-048", group: "formula_calc", difficulty: 2,
    question: "H014 燎原·羽 1 级裸装战力按公式 02-1 是多少？公式为 Power = round(ATK×3 + DEF×4 + HP×0.4)。",
    expectedAnswer: "176×3 + 58×4 + 1410×0.4 = 528 + 232 + 564 = 1324",
    keyFacts: ["528", "232", "564"],
    numPairs: [["power", 1324]],
    sourceFiles: ["gamedata/Hero.csv", "gamedata/HeroLevel.csv"],
    notes: "战力公式 02-1 复现；答案须给出计算过程或 power=1324。"
  },
  {
    id: "EV-049", group: "formula_calc", difficulty: 2,
    question: "GP002 限定·焰舞池 5★ 角色单抽概率是多少？换算成百分比是多少？",
    expectedAnswer: "probability=0.006，即 0.6%（GachaRate 全池型统一；up 池中 5★ 出率的 50% 为 up 目标 H014）",
    keyFacts: ["0.006", "0.6%"],
    numPairs: [["probability", 0.006]],
    sourceFiles: ["gamedata/GachaRate.csv", "gamedata/GachaPool.csv"],
    notes: "概率换算；注意 0.006 是单抽概率，不要与保底综合概率混淆。"
  },
  {
    id: "EV-050", group: "formula_calc", difficulty: 2,
    question: "DR015 元素试炼·火的掉落组权重合计是多少？各条目权重是什么？",
    expectedAnswer: "MAT04 权重 500 + MAT14 300 + GOLD 150 + MAT03 50 = 1000（每 dropId 权重合计必须为 1000）",
    keyFacts: ["500", "300", "150", "50"],
    numPairs: [["weight", 1000]],
    sourceFiles: ["gamedata/DropTable.csv"],
    notes: "掉落权重守恒规则；合计精确 1000。"
  },
  {
    id: "EV-051", group: "formula_calc", difficulty: 2,
    question: "WP017 赤焰大剑强化到 L80 的攻击力是多少？累计金币消耗呢？",
    expectedAnswer: "atk=400（L1 182 → L80 400，5★ 满级 ≈ baseAtk×2.2），goldCost 累计 1500000",
    keyFacts: ["400"],
    numPairs: [["atk", 400], ["goldCost", 1500000]],
    sourceFiles: ["gamedata/Weapon.csv", "gamedata/WeaponLevel.csv"],
    notes: "武器等级曲线取值；两个数值均精确。"
  },
  {
    id: "EV-052", group: "formula_calc", difficulty: 2,
    question: "装备强化到 15 级的成功率是多少？失败返还材料比例呢？",
    expectedAnswer: "EnhanceRate L15：successRate=0.45（45%），failRefundRate=0.30（L1-2 为 100%）",
    keyFacts: ["0.45"],
    numPairs: [["successRate", 0.45], ["failRefundRate", 0.3]],
    sourceFiles: ["gamedata/EnhanceRate.csv"],
    notes: "强化成功率曲线末端取值。"
  },
  {
    id: "EV-053", group: "formula_calc", difficulty: 2,
    question: "体力购买第 3 次的价格是多少？前 7 次的价格曲线如何？",
    expectedAnswer: "第 3 次 costGem=70（1-6 次 50/60/70/80/90/100，第 7 次起 150 封顶；每次 staminaGain=120）",
    keyFacts: ["70"],
    numPairs: [["costGem", 70], ["staminaGain", 120]],
    sourceFiles: ["gamedata/StaminaPricing.csv"],
    notes: "体力购买曲线；第 7 次起 150GEM 封顶。"
  },
  {
    id: "EV-054", group: "formula_calc", difficulty: 2,
    question: "SK059 千棱冰狱升到 L10 的倍率是多少？",
    expectedAnswer: "L1=4.90，L10=4.90×1.8=8.82（SkillLevel 实测 8.82，extraEffect 冻结时间+0.5秒）",
    keyFacts: ["4.90", "8.82"],
    numPairs: [["skillRate", 8.82]],
    sourceFiles: ["gamedata/Skill.csv", "gamedata/SkillLevel.csv"],
    notes: "技能成长公式复现（最高单体倍率技能）。"
  },

  // ============ economy_loop：v0.2 经济闭环 ============
  {
    id: "EV-055", group: "economy_loop", difficulty: 3,
    question: "抽卡副产物兑换残辉（IT061）如何参与武器强化材料循环？",
    expectedAnswer: "GEX001：IT061×10 → MAT01 基础合金×5（周限 30）→ 武器强化 L1-30 消耗；GEX002/003 可换 MAT02/MAT15 覆盖更高强化段",
    keyFacts: ["GEX001", "IT061", "MAT01"],
    numPairs: [["costQty", 10], ["rewardQty", 5], ["weeklyLimit", 30]],
    sourceFiles: ["gamedata/GachaExchange.csv", "gamedata/Item.csv", "gamedata/Material.csv"],
    notes: "抽卡→副产物→材料→强化的跨表闭环；注意 GachaExchange 是独立于商店的兑换出口。"
  },
  {
    id: "EV-056", group: "economy_loop", difficulty: 3,
    question: "公会点（GUILD_POINT）如何产出与消耗？",
    expectedAnswer: "产出：GD003 大额捐赠 GOLD10000 → 25 公会点（日限 3 次）；消耗：GuildShop 兑换（如 IT051 常驻招募券 300 点/公会 4 级、MAT19 命星结晶 800 点/6 级）",
    keyFacts: ["GD003", "GuildShop", "GUILD_POINT", "MAT19"],
    numPairs: [["rewardGuildPoint", 25]],
    sourceFiles: ["gamedata/GuildDonate.csv", "gamedata/GuildShop.csv"],
    notes: "公会点货币闭环：捐赠产出 → 商店消耗；GuildShop 商品带公会等级门槛。"
  },
  {
    id: "EV-057", group: "economy_loop", difficulty: 3,
    question: "远征 EX020 如何接入五星装备锻造与强化链条？",
    expectedAnswer: "EX020 星屑边境星屑研究（12h，RG008）→ 成功档 MAT39 装备图纸·五星×1 → EquipRecipe EQ011 雷霆之冠 = MAT39×1+MAT40×1（60 级解锁，180000 GOLD）→ EquipmentEnhance 消耗 MAT17/MAT30",
    keyFacts: ["EX020", "MAT39", "EQ011", "MAT40"],
    sourceFiles: ["gamedata/Expedition.csv", "gamedata/ExpeditionReward.csv", "gamedata/EquipRecipe.csv", "gamedata/EquipmentEnhance.csv"],
    notes: "远征→图纸→锻造→强化五段链路（《11》链 E 实测版本）；MAT40 传说锻造石配合使用。"
  },
  {
    id: "EV-058", group: "economy_loop", difficulty: 3,
    question: "活动代币 EVENT_TOKEN 的产出与消耗闭环是什么？",
    expectedAnswer: "产出：DG040 限时·星屑秘境（EVENT_TOKEN 权重 500，8-12 个/次）；消耗：EventShop 活动商店（如 IT124/IT125 活动兑换券）；活动结束（EventSchedule.endVersion）后下架、余额作废",
    keyFacts: ["DG040", "EVENT_TOKEN", "EventShop", "作废"],
    sourceFiles: ["gamedata/DropTable.csv", "gamedata/EventShop.csv", "gamedata/EventSchedule.csv"],
    notes: "活动代币闭环 + 过期规则（《00》R6、《11》E14）。"
  },
  {
    id: "EV-059", group: "economy_loop", difficulty: 3,
    question: "14 天签到奖励的关键节点是什么？",
    expectedAnswer: "day1 IT051 常驻招募券×1 → day7 GEM×100 → day14 IT074 五星武器箱×1；其余天数 GOLD/体力药/扫荡券等",
    keyFacts: ["IT051", "GEM", "IT074", "五星武器箱"],
    numPairs: [["day", 14]],
    sourceFiles: ["gamedata/DailyLoginReward.csv", "gamedata/Item.csv"],
    notes: "签到奖励链；day14 为五星武器箱（与新手 day8 的 IT074 重复投放是已知风险，见《26》R3）。"
  },
  {
    id: "EV-060", group: "economy_loop", difficulty: 3,
    question: "武器满强化的金币需求是多少？对应多少体力产出（按 1 体力≈500 金币锚点）？",
    expectedAnswer: "WP017 L80 累计 goldCost=1500000；按 DG010 期望 2000 GOLD/10 体力 ≈ 7500 体力 ≈ 约 63 天自然恢复（120 上限/天）",
    keyFacts: ["1500000", "500"],
    sourceFiles: ["gamedata/WeaponLevel.csv", "gamedata/DropTable.csv"],
    notes: "经济闭环量级题：强化需求 vs 产出锚点（《08》§4 约 150 万对齐）。"
  },
  {
    id: "EV-061", group: "economy_loop", difficulty: 3,
    question: "H014 燎原·羽突破阶段 1 的消耗是什么？",
    expectedAnswer: "Breakthrough H014 stage1：levelReq=20，costGold=20000，MAT04 燃焰之核×3 + MAT14 突破石×2，statBonus=HP+4%",
    keyFacts: ["MAT04", "MAT14"],
    numPairs: [["costGold", 20000], ["material1Qty", 3], ["material2Qty", 2]],
    sourceFiles: ["gamedata/Breakthrough.csv", "gamedata/Material.csv"],
    notes: "突破材料映射：H014 为 fire 系 → MAT04（与《00》§2.1 映射一致）。"
  },

  // ============ consistency：口径与一致性 ============
  {
    id: "EV-062", group: "consistency", difficulty: 2,
    question: "DG021 影渊裂谷·深层的推荐战力 30000 是什么口径？",
    expectedAnswer: "type=coop 副本，recommendPower=30000 为队伍总战力口径（≈单人×3）；禁止与单人口径混算（同 DG006=24000/DG033=16000/DG034=9000/DG035=20000）",
    keyFacts: ["队伍总战力", "30000"],
    numPairs: [["recommendPower", 30000]],
    sourceFiles: ["gamedata/Dungeon.csv"],
    notes: "coop 口径陷阱（《11》E5/E10）；解析器须按 type 区分。"
  },
  {
    id: "EV-063", group: "consistency", difficulty: 2,
    question: "通用被动 SK065-SK072 是否参与技能升级？是否出现在角色技能组？",
    expectedAnswer: "不参与：SkillLevel.csv 无 SK065-072 行、HeroSkillUnlock 仅覆盖角色 4 技能；heroId 仅为设计归属，不进入角色技能面板",
    keyFacts: ["SK065", "SK072", "不参与"],
    sourceFiles: ["gamedata/SkillLevel.csv", "gamedata/HeroSkillUnlock.csv", "gamedata/Skill.csv"],
    notes: "通用被动池语义（《00》§4.9、《11》E11）：skillType=passive、skillRate=0、无等级成长。"
  },
  {
    id: "EV-064", group: "consistency", difficulty: 2,
    question: "WP025 铁脊大剑有被动技能吗？4★ 掉落武器的 passiveSkillId 语义是什么？",
    expectedAnswer: "WP025-032（4★ 掉落武器）passiveSkillId 留空 = 无被动；5★ 掉落武器 WP017-024 接通用被动池 SK065-072",
    keyFacts: ["WP025", "留空", "SK065"],
    sourceFiles: ["gamedata/Weapon.csv", "gamedata/Skill.csv"],
    notes: "passiveSkillId 可空语义（《10》§4 #6、《11》E12）；空单元格非 null。"
  },
  {
    id: "EV-065", group: "consistency", difficulty: 2,
    question: "掉落组 DR 与副本的对应关系是什么？DG040 对应哪个掉落组？",
    expectedAnswer: "DR0NN ↔ DG0NN 一一对应：DG040 → DR040；不存在 DR041（掉落组仅 DR001-DR040）",
    keyFacts: ["DR040", "DG040"],
    sourceFiles: ["gamedata/Dungeon.csv", "gamedata/DropTable.csv"],
    notes: "DR 与 DG 一对一（v0.2 结构，替代 v0.1 一表多组）；DR041 不存在。"
  },
  {
    id: "EV-066", group: "consistency", difficulty: 2,
    question: "H014 燎原·羽的 6 个命座槽位是如何分布的？",
    expectedAnswer: "CN079-CN084，slot 1-6 各 1 个（星 2/4 为数值 +8%，星 3/5 为技能强化，星 1/6 为机制效果）；每角色 6 星槽位唯一",
    keyFacts: ["CN079", "CN084", "slot"],
    numPairs: [["slot", 6]],
    sourceFiles: ["gamedata/Constellation.csv"],
    notes: "命座槽位唯一性（《11》E13）；勿与装备 slot 枚举混淆。"
  },
  {
    id: "EV-067", group: "consistency", difficulty: 2,
    question: "各卡池的 5★ 单抽概率是否一致？保底数是多少？",
    expectedAnswer: "GachaRate 全池型 5★ 均 0.006（0.6%）；保底按池型：hero/mixed/rerun 90/180、weapon 80/160、newbie 20/20，保底计数跨池不继承",
    keyFacts: ["0.006", "90", "180", "80", "160", "20"],
    sourceFiles: ["gamedata/GachaRate.csv", "gamedata/GachaPity.csv"],
    notes: "概率全库唯一 + 保底池型差异（《11》E15 类似语义）。"
  },
  {
    id: "EV-068", group: "consistency", difficulty: 2,
    question: "H014 燎原·羽的元素抗性分布是什么？",
    expectedAnswer: "ElementResist：fire +0.05（同元素自抗）、ice 0.00、thunder -0.05（被克制弱点）、phys 0.00",
    keyFacts: ["0.05", "-0.05", "thunder"],
    sourceFiles: ["gamedata/ElementResist.csv"],
    notes: "元素抗性稀疏表（默认 0，只写非 0 与弱点）；三角克制方向一致性。"
  },

  // ============ anti_hallucination：拒绝编造 ============
  {
    id: "EV-069", group: "anti_hallucination", difficulty: 1,
    question: "H017 角色存在吗？他的职业是什么？",
    expectedAnswer: "不存在：角色注册表仅 H001-H016（16 名）；应明确拒绝并说明范围，不得编造职业",
    keyFacts: ["H001", "H016"],
    fakeId: "H017",
    sourceFiles: ["gamedata/Hero.csv"],
    notes: "越界 ID 拒绝；回答中出现 H017 即 FAIL。"
  },
  {
    id: "EV-070", group: "anti_hallucination", difficulty: 1,
    question: "SK073 是什么技能？属于哪个角色？",
    expectedAnswer: "不存在：技能注册表仅 SK001-SK072（含 SK065-072 通用被动池）；应拒绝并说明",
    keyFacts: ["SK072"],
    fakeId: "SK073",
    sourceFiles: ["gamedata/Skill.csv"],
    notes: "越界技能 ID；不得编造技能名。"
  },
  {
    id: "EV-071", group: "anti_hallucination", difficulty: 1,
    question: "DG041 星轨遗迹·EX-III 的推荐战力是多少？",
    expectedAnswer: "不存在：副本仅 DG001-DG040；应拒绝并说明注册范围",
    keyFacts: ["DG040"],
    fakeId: "DG041",
    sourceFiles: ["gamedata/Dungeon.csv"],
    notes: "越界副本 ID + 编造的副本名（题目给出中文名也不得采信）。"
  },
  {
    id: "EV-072", group: "anti_hallucination", difficulty: 2,
    question: "限定卡池 5★ 单抽概率是 6% 还是 0.6%？",
    expectedAnswer: "0.6%（0.006）：GachaRate 全池型 5★ 概率 0.006；6% 是错误值（4★ 为 5.1%），须以配表为准",
    keyFacts: ["0.006", "0.6%"],
    sourceFiles: ["gamedata/GachaRate.csv"],
    notes: "概率数值防幻觉；不得采信未经配表支持的 6%。"
  },
  {
    id: "EV-073", group: "anti_hallucination", difficulty: 1,
    question: "BF031 狂暴的效果是什么？",
    expectedAnswer: "不存在：Buff 仅 BF001-BF030；应拒绝并说明范围",
    keyFacts: ["BF030"],
    fakeId: "BF031",
    sourceFiles: ["gamedata/Buff.csv"],
    notes: "越界 Buff ID。"
  },
  {
    id: "EV-074", group: "anti_hallucination", difficulty: 1,
    question: "GP009 星辉常驻池的消耗道具是什么？",
    expectedAnswer: "不存在：卡池仅 GP001-GP008；应拒绝并说明",
    keyFacts: ["GP008"],
    fakeId: "GP009",
    sourceFiles: ["gamedata/GachaPool.csv"],
    notes: "越界卡池 ID。"
  },

  // ============ evidence_chain：v0.2 多跳证据链 ============
  {
    id: "EV-075", group: "evidence_chain", difficulty: 3,
    question: "从 GP002 限定·焰舞池抽到 H014 燎原·羽后，她如何影响对 DG022 虚境试炼·中层的通关能力？请给出完整证据链。",
    expectedAnswer: "GP002（GachaItem H014 isUp=TRUE）→ 获得 H014（fire dps，WP014 燎原长弓）→ 终结技 SK055 焚天之羽 skillRate=4.70（L10=8.46）→ 伤害公式 01-1（ATK×skillRate×elemMul…）→ 对 DG022（recommendPower 22000，endgame）输出达标",
    keyFacts: ["GP002", "H014", "SK055", "8.46", "DG022"],
    sourceFiles: ["gamedata/GachaPool.csv", "gamedata/GachaItem.csv", "gamedata/Hero.csv", "gamedata/Skill.csv", "gamedata/SkillLevel.csv", "gamedata/Dungeon.csv"],
    notes: "链 C（卡池→角色→伤害，4 跳）；与《11》§3 链 C 一致。"
  },
  {
    id: "EV-076", group: "evidence_chain", difficulty: 3,
    question: "爬塔 TF015 的词缀是什么？用什么阵容对策？给出完整证据链。",
    expectedAnswer: "TF015（floorNo 15，recommendPower 19500，怪物 M009/M010）→ affixId=AF013 元素亲和·雷（敌方雷伤+30%）→ 对策：TB002 霜华共鸣（H005+H007+H015，冰伤+18%、冻结延长 20%）→ 冻结控场应对雷系强化",
    keyFacts: ["TF015", "AF013", "元素亲和·雷", "TB002", "19500"],
    sourceFiles: ["gamedata/TowerFloor.csv", "gamedata/DungeonAffix.csv", "gamedata/TeamBuff.csv"],
    notes: "链 D（爬塔→词缀→阵容，3 跳）；与《11》§3 链 D 一致。"
  },
  {
    id: "EV-077", group: "evidence_chain", difficulty: 3,
    question: "从远征到挑战 DG029 元素回廊·EX，材料如何流转？给出完整证据链。",
    expectedAnswer: "EX020 星屑边境星屑研究（RG008，12h）→ 成功档 MAT39 装备图纸·五星×1 → EquipRecipe EQ011 雷霆之冠（MAT39×1+MAT40×1，60 级）→ EquipmentEnhance 强化（MAT17/MAT30）→ 装备主词条成长 → 战力（公式 02-1）→ 挑战 DG029（recommendPower 40000）",
    keyFacts: ["EX020", "MAT39", "EQ011", "MAT40", "DG029"],
    sourceFiles: ["gamedata/Expedition.csv", "gamedata/ExpeditionReward.csv", "gamedata/EquipRecipe.csv", "gamedata/EquipmentEnhance.csv", "gamedata/Dungeon.csv"],
    notes: "链 E（远征→锻造→强化→关卡，5 跳）；与《11》§3 链 E 一致。"
  },
  {
    id: "EV-078", group: "evidence_chain", difficulty: 3,
    question: "公会捐赠如何转化为角色养成资源？给出完整证据链。",
    expectedAnswer: "GD003 大额捐赠（GOLD10000 → 25 GUILD_POINT，日限 3）→ GuildShop 兑换（MAT19 命星结晶 800 点/公会 6 级）→ Constellation 命座升级 → 角色机制强化 → 副本通关效率提升",
    keyFacts: ["GD003", "GUILD_POINT", "MAT19", "Constellation"],
    numPairs: [["rewardGuildPoint", 25]],
    sourceFiles: ["gamedata/GuildDonate.csv", "gamedata/GuildShop.csv", "gamedata/Constellation.csv", "gamedata/Material.csv"],
    notes: "公会→货币→商店→命座四段链；注意 GuildShop 中 MAT14 不可兑换，命星结晶才是命座材料（防幻觉点）。"
  },
];

// ---------- meta 更新 ----------
gold.meta.name = "StarTrail 知识库黄金测评集 (Golden Evaluation Set) v3 扩充版";
gold.meta.version = "3.0.0";
gold.meta.kbVersion = "v0.2";
gold.meta.description =
  "用于评测 AI Agent 对《星轨猎手》(StarTrail) 模拟知识库（gamedocs 49 篇 + gamedata 204 张 CSV，v0.2 扩充）的检索/推理/防幻觉能力。v3 在 v2 严格规则（数值精确、字段=值格式、容差仅 ≈ 前缀）基础上，新增 v0.2 系统覆盖：卡池/命座/通用被动/怪物首领/爬塔词缀/公会远征/竞技排位/羁绊/物品总表/多态引用/coop 口径。配套 audit_evals.py 程序化重算所有关键数值。";
gold.meta.idRegistry = [
  "H001-H016", "SK001-SK072", "BF001-BF030", "WP001-WP032", "EQ001-EQ040",
  "DG001-DG040", "DR001-DR040", "SH001-SH048", "MAT01-MAT40", "S001-S008",
  "M001-M080", "B001-B012", "EM001-EM016", "IT001-IT200", "QS001-QS120",
  "AC001-AC080", "CN001-CN096", "TN001-TN032", "SN001-SN040", "TI001-TI050",
  "GP001-GP008", "TF001-TF030", "AF001-AF020", "TB001-TB012", "EX001-EX020",
  "EV001-EV012", "WB001-WB008", "SM001-SM012", "RG001-RG008", "NP001-NP020",
  "FU001-FU030", "AR001-AR004", "RM001-RM004", "GB001-GB008", "PT001-PT010",
  "WC001-WC012", "ED001-ED012", "CD001-CD006", "MS001-MS060", "AI001-AI020",
  "RC001-RC060", "ML001-ML030", "CX001-CX050", "WY001-WY040", "LS001-LS012",
  "TH001-TH012", "LT001-LT008", "WH001-WH008", "RB001-RB012", "TC001-TC030",
  "PZ001-PZ012", "HQ001-HQ020", "WK001-WK012", "DK001-DK012", "TM001-TM004",
  "MG001-MG008", "FP001-FP010", "GEX001-GEX012", "GD001-GD006", "WSK001-WSK012",
  "WBS001-WBS008", "ADR001-ADR006", "DIA001-DIA024", "NC001-NC020", "TN001-TN032",
];
gold.meta.auditedBy = "audit_evals.py 从知识库 v0.2 配表程序化重算（含 v0.1 回归与 v0.2 新增），详见 audit 报告";

// 去重（防手滑重复 id）
const seen = new Set();
gold.cases = [...gold.cases, ...NEW_CASES].filter((c) => {
  if (seen.has(c.id)) return false;
  seen.add(c.id);
  return true;
});

fs.writeFileSync(OUT, JSON.stringify(gold, null, 2) + "\n", "utf8");
console.log(`OK: ${gold.cases.length} cases (${NEW_CASES.length} new) → ${OUT}`);
console.log("分组统计:", JSON.stringify(gold.cases.reduce((a, c) => ((a[c.group] = (a[c.group] || 0) + 1), a), {})));
