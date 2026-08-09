#!/usr/bin/env node
/**
 * StarTrail 模拟知识库 v0.2 校验器（机器权威，对应《10_配表规范与外键约定》§4 的扩展版）
 * 用法: node knowledge_gen/validate.mjs
 * 规则契约: knowledge_gen/master_plan.md §5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'knowledge');
const GAMEDATA = path.join(ROOT, 'gamedata');
const GAMEDOCS = path.join(ROOT, 'gamedocs');

const errors = [];
const warnings = [];
const info = [];

/* ================= 基础工具 ================= */

function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) warnings.push(`${path.basename(filePath)}: 含 BOM（应无 BOM）`);
  const lines = raw.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l.trim() === ''));
  if (lines.length === 0) return { headers: [], rows: [], lineCount: 0 };
  const parseLine = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]).map((c) => c.trim());
    const obj = {};
    let ok = true;
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cells[j] ?? '';
    if (cells.length !== headers.length) {
      errors.push(`${path.basename(filePath)}:第${i + 1}行 列数(${cells.length})≠表头(${headers.length}) 原始: ${lines[i].slice(0, 80)}`);
      ok = false;
    }
    if (ok) rows.push(obj);
  }
  return { headers, rows, lineCount: lines.length };
}

const tableCache = {};
function loadTable(name) {
  if (tableCache[name] !== undefined) return tableCache[name];
  const fp = path.join(GAMEDATA, `${name}.csv`);
  if (!fs.existsSync(fp)) { tableCache[name] = null; return null; }
  const parsed = parseCSV(fp);
  tableCache[name] = parsed;
  return parsed;
}

function pkSet(tableName, pkCols) {
  const t = loadTable(tableName);
  if (!t) return new Set();
  const s = new Set();
  for (const r of t.rows) s.add(pkCols.map((c) => r[c] ?? '').join('|'));
  return s;
}

/* ================= 配置：期望表清单 ================= */

const EXPECTED_TABLES = [
  // v0.1 既有 12
  'Hero', 'HeroLevel', 'Skill', 'SkillLevel', 'Buff', 'Weapon', 'Equipment',
  'Dungeon', 'DropTable', 'ShopItem', 'ElementChart', 'Breakthrough',
  // M1
  'Constellation', 'HeroAffinity', 'HeroSkin', 'HeroTalent', 'TalentLevel', 'Title', 'Namecard', 'HeroVoice', 'HeroIntro',
  // M2
  'SkillBreakthrough', 'SkillEnergyGain', 'ElementReaction', 'PvpBalance', 'PvpBanList', 'ComboChain', 'Shield', 'DamageType', 'HitEffect', 'ElementResist',
  // M3
  'WeaponLevel', 'WeaponRefine', 'WeaponBreakthrough', 'WeaponType', 'EquipmentSet', 'SetBonus', 'EquipmentLevel', 'EquipmentMainStat', 'EquipmentSubStat', 'SubStatPool', 'SubStatWeight', 'EquipmentEnhance', 'EquipmentRecycle', 'EquipmentTransmute', 'EquipRecipe',
  // M4
  'DungeonStage', 'DungeonWave', 'DungeonMonster', 'DungeonDifficulty', 'DungeonFirstClear', 'DungeonAffix', 'TowerFloor', 'TowerReward', 'WeeklyChallenge', 'WeeklyChallengeReward', 'EventDungeon', 'CoopDungeon', 'CoopReward',
  // M5
  'Monster', 'MonsterLevel', 'MonsterSkill', 'MonsterAI', 'MonsterDrop', 'MonsterElementResist', 'Boss', 'BossPhase', 'BossMechanic', 'BossReward', 'EliteMonster', 'Trap',
  // M6
  'Material', 'MaterialSource', 'Item', 'ItemUse', 'Recipe', 'CurrencyExchange', 'FarmLimit', 'StaminaRule', 'StaminaPricing', 'OfflineReward', 'OnlineReward', 'DailyLoginReward',
  // M7
  'GachaPool', 'GachaRate', 'GachaPity', 'GachaItem', 'GachaWish', 'FirstChargeReward', 'TopUp', 'MonthlyCard', 'BattlePass', 'BattlePassReward', 'GrowthFund', 'GiftPack', 'NewbiePack',
  // M8
  'Quest', 'QuestStep', 'QuestReward', 'QuestChain', 'StoryChapter', 'StoryChapterReward', 'DailyQuest', 'WeeklyQuest', 'Achievement', 'AchievementCategory', 'NewbieQuest', 'Tutorial', 'FunctionUnlock',
  // M9
  'ShopRefresh', 'Npc', 'NpcShop', 'LimitedShop', 'ArenaShop', 'GuildShop', 'EventShop', 'ShopCategory', 'ExchangeRule',
  // M10
  'ArenaSeason', 'ArenaTier', 'ArenaReward', 'MatchmakingRule', 'LeaderboardReward', 'RankMatchSeason', 'RankMatchTier', 'RankMatchReward',
  // M11
  'Guild', 'GuildLevel', 'GuildBuilding', 'GuildQuest', 'GuildWar', 'GuildWarReward', 'GuildBoss', 'GuildBossReward', 'Expedition', 'ExpeditionReward', 'ExpeditionHero',
  // M12
  'JsonConfig', 'WorldLevel', 'MailTemplate', 'LoadingTips', 'RandomName', 'Region', 'Waypoint', 'Codex', 'CodexReward', 'VersionConfig', 'Announcement', 'PowerFormulaWeight', 'FormulaParam', 'DailyReset', 'Pet', 'PetLevel', 'PetSkill', 'EventSchedule',
  // M13
  'WorldBoss', 'WorldBossReward', 'Simulation', 'SimulationFloor', 'SimulationBuff', 'TreasureHunt', 'Lottery', 'Wheel', 'WheelReward', 'RandomBox', 'TreasureChest', 'Puzzle', 'HiddenQuest', 'TeamBuff', 'TeamBuffHero', 'BountyDaily', 'BountyWeekly', 'Tournament', 'TournamentReward', 'MiniGame', 'MiniGameReward',
  // M14
  'HeroSkillUnlock', 'UltCharge', 'GachaUpPool', 'FreeGacha', 'ShopDiscount', 'ActivityReward', 'Milestone', 'CombatTrial', 'ChatEmoji', 'AvatarFrame', 'ChatBubble', 'NoviceReward', 'BreakShield', 'DodgeRule', 'CoopRecommend', 'PvpMap', 'ArenaBuff',
  // M15 补充配表
  'NpcDialogue', 'StoryDialogue', 'GachaExchange', 'GuildDonate', 'PetEvolution', 'WeaponSkin', 'EquipmentAwaken', 'EnhanceRate', 'ExpCurve', 'ArenaDailyReward', 'WorldBossSchedule',
];

const PK = {
  Hero: ['heroId'], HeroLevel: ['heroId', 'level'], Breakthrough: ['heroId', 'stage'],
  Constellation: ['constId'], HeroAffinity: ['heroId', 'tier'], HeroSkin: ['skinId'],
  HeroTalent: ['talentId'], TalentLevel: ['talentId', 'level'], Title: ['titleId'],
  Namecard: ['namecardId'], HeroVoice: ['heroId', 'voiceType'], HeroIntro: ['heroId'],
  Skill: ['skillId'], SkillLevel: ['skillId', 'level'], Buff: ['buffId'],
  SkillBreakthrough: ['skillId', 'stage'], SkillEnergyGain: ['skillType', 'hitType', 'energyGain'],
  ElementReaction: ['reactionId'], PvpBalance: ['balanceId'], PvpBanList: ['banId'],
  ComboChain: ['comboId'], Shield: ['shieldId'], DamageType: ['damageTypeId'],
  HitEffect: ['hitEffectId'], ElementResist: ['heroId', 'element'],
  Weapon: ['weaponId'], WeaponLevel: ['weaponId', 'level'], WeaponRefine: ['weaponId', 'refineStage'],
  WeaponBreakthrough: ['weaponId', 'stage'], WeaponType: ['weaponTypeId'],
  Equipment: ['equipId'], EquipmentSet: ['setId'], SetBonus: ['setId', 'pieceCount'],
  EquipmentLevel: ['rarity', 'level'], EquipmentMainStat: ['slot', 'rarity', 'mainStatType'],
  EquipmentSubStat: ['subStatType'], SubStatPool: ['slot', 'rarity', 'subStatType'],
  SubStatWeight: ['slot', 'subStatType'], EquipmentEnhance: ['level', 'rarity'],
  EquipmentRecycle: ['rarity', 'recycleMaterialId'], EquipmentTransmute: ['slot', 'costItemId'], EquipRecipe: ['equipId'],
  Dungeon: ['dungeonId'], DungeonStage: ['dungeonId', 'stageNo'], DungeonWave: ['waveId'],
  DungeonMonster: ['dungeonId', 'monsterId'], DungeonDifficulty: ['dungeonId', 'difficulty'],
  DungeonFirstClear: ['dungeonId'], DungeonAffix: ['affixId'], TowerFloor: ['floorId'],
  TowerReward: ['floorId'], WeeklyChallenge: ['challengeId'],
  WeeklyChallengeReward: ['challengeId', 'tier'], EventDungeon: ['eventDungeonId'],
  CoopDungeon: ['coopDungeonId'], CoopReward: ['coopDungeonId', 'clearTimeTier'],
  Monster: ['monsterId'], MonsterLevel: ['monsterId', 'level'], MonsterSkill: ['skillId'],
  MonsterAI: ['aiId'], MonsterDrop: ['monsterId', 'itemId'],
  MonsterElementResist: ['monsterId', 'element'], Boss: ['bossId'],
  BossPhase: ['bossId', 'phaseNo'], BossMechanic: ['mechanicId'], BossReward: ['bossId'],
  EliteMonster: ['eliteId'], Trap: ['trapId'],
  DropTable: ['dropId', 'itemType', 'itemId'], Material: ['materialId'],
  MaterialSource: ['materialId', 'sourceType', 'sourceId'], Item: ['itemId'], ItemUse: ['itemId'],
  Recipe: ['recipeId'], CurrencyExchange: ['exchangeId'], FarmLimit: ['targetId', 'limitType'],
  StaminaRule: ['ruleType'], StaminaPricing: ['buyCount'], OfflineReward: ['offlineHours'],
  OnlineReward: ['minutes'], DailyLoginReward: ['day'],
  ShopItem: ['shopId'], ShopRefresh: ['shopType'], Npc: ['npcId'],
  NpcShop: ['npcId', 'itemId'], LimitedShop: ['limitedShopId'], ArenaShop: ['itemId'],
  GuildShop: ['itemId'], EventShop: ['eventId', 'itemId'], ShopCategory: ['categoryId'],
  ExchangeRule: ['ruleId'], GachaPool: ['poolId'], GachaRate: ['poolType', 'rarity'],
  GachaPity: ['poolType'], GachaItem: ['poolId', 'itemId'], GachaWish: ['poolId'],
  FirstChargeReward: ['tier'], TopUp: ['topUpId'], MonthlyCard: ['cardId'],
  BattlePass: ['bpId'], BattlePassReward: ['bpId', 'level', 'line'], GrowthFund: ['fundId'],
  GiftPack: ['packId'], NewbiePack: ['packId'], Quest: ['questId'],
  QuestStep: ['questId', 'stepNo'], QuestReward: ['questId'], QuestChain: ['chainId'],
  StoryChapter: ['chapterId'], StoryChapterReward: ['chapterId'], DailyQuest: ['dailyQuestId'],
  WeeklyQuest: ['weeklyQuestId'], Achievement: ['achievementId'],
  AchievementCategory: ['categoryId'], NewbieQuest: ['newbieQuestId'], Tutorial: ['tutorialId'],
  FunctionUnlock: ['unlockId'], ArenaSeason: ['seasonId'], ArenaTier: ['tierId'],
  ArenaReward: ['seasonId', 'tierId'], MatchmakingRule: ['ruleType'],
  LeaderboardReward: ['rankStart'], RankMatchSeason: ['seasonId'], RankMatchTier: ['tierId'],
  RankMatchReward: ['seasonId', 'tierId'], Guild: ['level'], GuildLevel: ['level'],
  GuildBuilding: ['buildingId'], GuildQuest: ['guildQuestId'], GuildWar: ['warId'],
  GuildWarReward: ['warId', 'rank'], GuildBoss: ['bossId'],
  GuildBossReward: ['bossId', 'damageTier'], Expedition: ['expeditionId'],
  ExpeditionReward: ['expeditionId', 'successTier'], ExpeditionHero: ['expeditionId', 'heroId'],
  JsonConfig: ['key'], WorldLevel: ['worldLevel'], MailTemplate: ['mailId'],
  LoadingTips: ['tipId'], RandomName: ['nameId'], Region: ['regionId'],
  Waypoint: ['waypointId'], Codex: ['codexId'], CodexReward: ['category', 'count'],
  VersionConfig: ['version'], Announcement: ['annId'], PowerFormulaWeight: ['statType'],
  FormulaParam: ['paramId'], DailyReset: ['resetType'], Pet: ['petId'],
  PetLevel: ['petId', 'level'], PetSkill: ['petSkillId'], EventSchedule: ['eventId'],
  WorldBoss: ['bossId'], WorldBossReward: ['bossId', 'damageTier'], Simulation: ['simId'],
  SimulationFloor: ['simId', 'floorNo'], SimulationBuff: ['simBuffId'],
  TreasureHunt: ['huntId'], Lottery: ['lotteryId'], Wheel: ['wheelId'],
  WheelReward: ['wheelId', 'rewardId'], RandomBox: ['boxId'], TreasureChest: ['chestId'],
  Puzzle: ['puzzleId'], HiddenQuest: ['questId'], TeamBuff: ['buffId'],
  TeamBuffHero: ['buffId', 'heroId'], BountyDaily: ['bountyId'], BountyWeekly: ['bountyId'],
  Tournament: ['tournamentId'], TournamentReward: ['tournamentId', 'rank'],
  MiniGame: ['miniGameId'], MiniGameReward: ['miniGameId', 'scoreTier'],
  HeroSkillUnlock: ['heroId', 'skillType'], UltCharge: ['heroId'], GachaUpPool: ['poolId'],
  FreeGacha: ['poolId'], ShopDiscount: ['shopId', 'itemId'],
  ActivityReward: ['eventId', 'points'], Milestone: ['milestoneId'], CombatTrial: ['trialId'],
  ChatEmoji: ['emojiId'], AvatarFrame: ['frameId'], ChatBubble: ['bubbleId'],
  NoviceReward: ['dayNo'], BreakShield: ['shieldId'], DodgeRule: ['dodgeId'],
  CoopRecommend: ['coopDungeonId', 'recommendHeroIds'], PvpMap: ['mapId'], ArenaBuff: ['seasonId', 'buffType'],
  ElementChart: ['attackElement', 'targetElement'],
  NpcDialogue: ['npcId', 'seqNo'], StoryDialogue: ['dialogueId'], GachaExchange: ['exchangeId'],
  GuildDonate: ['donateId'], PetEvolution: ['fromPetId'], WeaponSkin: ['skinId'],
  EquipmentAwaken: ['equipId', 'stage'], EnhanceRate: ['level'], ExpCurve: ['itemId'],
  ArenaDailyReward: ['rewardId'], WorldBossSchedule: ['scheduleId'],
};

/* ================= 配置：枚举 ================= */

const CURRENCY_TOKENS = new Set(['GOLD', 'GEM', 'STAMINA', 'DUNGEON_TOKEN', 'ARENA_POINT', 'GUILD_POINT', 'EVENT_TOKEN']);
// 枚举规则：[表名, 列名, 允许值]；表名 '*' 表示任意表
const ENUM_RULES = [
  ['*', 'element', ['fire', 'ice', 'thunder', 'phys']],
  ['*', 'class', ['tank', 'dps', 'support']],
  ['*', 'skillType', ['normal', 'skill', 'ult', 'passive']],
  ['*', 'gachaType', ['hero', 'weapon', 'mixed', 'newbie', 'rerun']],
  ['*', 'questType', ['main', 'side', 'weekly', 'companion']],
  ['*', 'monsterType', ['normal', 'elite']],
  ['*', 'buffKind', ['dot', 'control', 'stat', 'shield', 'reaction', 'stance', 'energy', 'lifesteal', 'immune', 'counter']],
  ['*', 'mainStatType', ['atkFlat', 'defFlat', 'atkPct', 'defPct', 'hpPct', 'critRate', 'critDmg', 'energyRecharge']],
  ['*', 'voiceType', ['greet', 'battle', 'ult']],
  ['*', 'difficulty', ['easy', 'normal', 'hard', 'expert']],
  ['BattlePassReward', 'line', ['free', 'paid']],
  ['*', 'rarity', ['1', '2', '3', '4', '5']],
  ['*', 'itemType', ['weapon', 'equipment', 'material', 'currency', 'stamina', 'consumable', 'ticket', 'collection', 'box', 'pet', 'misc', 'hero', 'item']],
  ['Equipment', 'slot', ['head', 'body', 'feet', 'accessory']],
  ['EquipmentMainStat', 'slot', ['head', 'body', 'feet', 'accessory']],
  ['SubStatPool', 'slot', ['head', 'body', 'feet', 'accessory']],
  ['SubStatWeight', 'slot', ['head', 'body', 'feet', 'accessory']],
  ['EquipmentTransmute', 'slot', ['head', 'body', 'feet', 'accessory']],
  ['HeroTalent', 'slot', ['tactical', 'passive']],
  ['Constellation', 'slot', ['1', '2', '3', '4', '5', '6']],
  ['Dungeon', 'type', ['main', 'coop', 'endgame', 'pvp', 'material', 'event']],
  ['Equipment', 'heroClass', ['tank', 'dps', 'support', 'all']],
  ['EquipmentSet', 'targetClass', ['tank', 'dps', 'support', 'all']],
];
const CURRENCY_COLS = ['costCurrency', 'currency', 'fromCurrency', 'toCurrency', 'priceType'];

/* ================= 配置：外键规则 ================= */
// 普通外键
const FK = [
  { child: 'Hero', cols: ['weaponId'], parent: 'Weapon', pk: 'weaponId', nullable: false },
  { child: 'Skill', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'Skill', cols: ['buffId'], parent: 'Buff', pk: 'buffId', nullable: true },
  { child: 'SkillLevel', cols: ['skillId'], parent: 'Skill', pk: 'skillId', nullable: false },
  { child: 'HeroLevel', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'Weapon', cols: ['passiveSkillId'], parent: 'Skill', pk: 'skillId', nullable: true },
  { child: 'Dungeon', cols: ['dropId'], parent: 'DropTable', pk: 'dropId', nullable: false },
  { child: 'DropTable', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'Breakthrough', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'Breakthrough', cols: ['material1Id', 'material2Id'], parent: 'Material', pk: 'materialId', nullable: false },
  { child: 'Constellation', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'HeroAffinity', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'HeroSkin', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'HeroTalent', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'TalentLevel', cols: ['talentId'], parent: 'HeroTalent', pk: 'talentId', nullable: false },
  { child: 'HeroVoice', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'HeroIntro', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'SkillBreakthrough', cols: ['skillId'], parent: 'Skill', pk: 'skillId', nullable: false },
  { child: 'ElementReaction', cols: ['resultBuffId'], parent: 'Buff', pk: 'buffId', nullable: true },
  { child: 'PvpBanList', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: true },
  { child: 'PvpBanList', cols: ['skillId'], parent: 'Skill', pk: 'skillId', nullable: true },
  { child: 'ComboChain', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'ElementResist', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'WeaponLevel', cols: ['weaponId'], parent: 'Weapon', pk: 'weaponId', nullable: false },
  { child: 'WeaponRefine', cols: ['weaponId'], parent: 'Weapon', pk: 'weaponId', nullable: false },
  { child: 'WeaponBreakthrough', cols: ['weaponId'], parent: 'Weapon', pk: 'weaponId', nullable: false },
  { child: 'Equipment', cols: ['setId'], parent: 'EquipmentSet', pk: 'setId', nullable: true },
  { child: 'SetBonus', cols: ['setId'], parent: 'EquipmentSet', pk: 'setId', nullable: false },
  { child: 'EquipRecipe', cols: ['equipId'], parent: 'Equipment', pk: 'equipId', nullable: false },
  { child: 'DungeonStage', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'DungeonWave', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'DungeonMonster', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'DungeonMonster', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'DungeonDifficulty', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'DungeonFirstClear', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'TowerFloor', cols: ['affixId'], parent: 'DungeonAffix', pk: 'affixId', nullable: true },
  { child: 'TowerReward', cols: ['floorId'], parent: 'TowerFloor', pk: 'floorId', nullable: false },
  { child: 'WeeklyChallenge', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: true },
  { child: 'WeeklyChallengeReward', cols: ['challengeId'], parent: 'WeeklyChallenge', pk: 'challengeId', nullable: false },
  { child: 'EventDungeon', cols: ['eventId'], parent: 'EventSchedule', pk: 'eventId', nullable: false },
  { child: 'EventDungeon', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'CoopDungeon', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'CoopReward', cols: ['coopDungeonId'], parent: 'CoopDungeon', pk: 'coopDungeonId', nullable: false },
  { child: 'MonsterLevel', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'MonsterSkill', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'MonsterDrop', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'MonsterElementResist', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'Boss', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: false },
  { child: 'Boss', cols: ['aiId'], parent: 'MonsterAI', pk: 'aiId', nullable: false },
  { child: 'BossPhase', cols: ['bossId'], parent: 'Boss', pk: 'bossId', nullable: false },
  { child: 'BossPhase', cols: ['mechanicId'], parent: 'BossMechanic', pk: 'mechanicId', nullable: true },
  { child: 'BossReward', cols: ['bossId'], parent: 'Boss', pk: 'bossId', nullable: false },
  { child: 'BossReward', cols: ['dropId'], parent: 'DropTable', pk: 'dropId', nullable: false },
  { child: 'EliteMonster', cols: ['monsterId'], parent: 'Monster', pk: 'monsterId', nullable: false },
  { child: 'EliteMonster', cols: ['buffId'], parent: 'Buff', pk: 'buffId', nullable: true },
  { child: 'Trap', cols: ['damageTypeId'], parent: 'DamageType', pk: 'damageTypeId', nullable: false },
  { child: 'Trap', cols: ['dungeonId'], parent: 'Dungeon', pk: 'dungeonId', nullable: true },
  { child: 'MaterialSource', cols: ['materialId'], parent: 'Material', pk: 'materialId', nullable: false },
  { child: 'ItemUse', cols: ['itemId'], parent: 'Item', pk: 'itemId', nullable: false },
  { child: 'GachaItem', cols: ['poolId'], parent: 'GachaPool', pk: 'poolId', nullable: false },
  { child: 'GachaWish', cols: ['poolId'], parent: 'GachaPool', pk: 'poolId', nullable: false },
  { child: 'BattlePassReward', cols: ['bpId'], parent: 'BattlePass', pk: 'bpId', nullable: false },
  { child: 'QuestStep', cols: ['questId'], parent: 'Quest', pk: 'questId', nullable: false },
  { child: 'QuestReward', cols: ['questId'], parent: 'Quest', pk: 'questId', nullable: false },
  { child: 'StoryChapter', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'StoryChapter', cols: ['questStartId', 'questEndId'], parent: 'Quest', pk: 'questId', nullable: false },
  { child: 'StoryChapterReward', cols: ['chapterId'], parent: 'StoryChapter', pk: 'chapterId', nullable: false },
  { child: 'StoryChapterReward', cols: ['clearQuestId'], parent: 'Quest', pk: 'questId', nullable: false },
  { child: 'Achievement', cols: ['categoryId'], parent: 'AchievementCategory', pk: 'categoryId', nullable: false },
  { child: 'FunctionUnlock', cols: ['unlockQuestId'], parent: 'Quest', pk: 'questId', nullable: true },
  { child: 'Npc', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'NpcShop', cols: ['npcId'], parent: 'Npc', pk: 'npcId', nullable: false },
  { child: 'EventShop', cols: ['eventId'], parent: 'EventSchedule', pk: 'eventId', nullable: false },
  { child: 'ArenaReward', cols: ['seasonId'], parent: 'ArenaSeason', pk: 'seasonId', nullable: false },
  { child: 'ArenaReward', cols: ['tierId'], parent: 'ArenaTier', pk: 'tierId', nullable: false },
  { child: 'RankMatchReward', cols: ['seasonId'], parent: 'RankMatchSeason', pk: 'seasonId', nullable: false },
  { child: 'RankMatchReward', cols: ['tierId'], parent: 'RankMatchTier', pk: 'tierId', nullable: false },
  { child: 'ArenaSeason', cols: ['rewardDropId'], parent: 'DropTable', pk: 'dropId', nullable: true },
  { child: 'GuildWarReward', cols: ['warId'], parent: 'GuildWar', pk: 'warId', nullable: false },
  { child: 'GuildBossReward', cols: ['bossId'], parent: 'GuildBoss', pk: 'bossId', nullable: false },
  { child: 'Expedition', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'ExpeditionReward', cols: ['expeditionId'], parent: 'Expedition', pk: 'expeditionId', nullable: false },
  { child: 'ExpeditionHero', cols: ['expeditionId'], parent: 'Expedition', pk: 'expeditionId', nullable: false },
  { child: 'ExpeditionHero', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'Waypoint', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'Region', cols: ['unlockQuestId'], parent: 'Quest', pk: 'questId', nullable: true },
  { child: 'PetLevel', cols: ['petId'], parent: 'Pet', pk: 'petId', nullable: false },
  { child: 'PetSkill', cols: ['petId'], parent: 'Pet', pk: 'petId', nullable: false },
  { child: 'WorldBoss', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'WorldBossReward', cols: ['bossId'], parent: 'WorldBoss', pk: 'bossId', nullable: false },
  { child: 'SimulationFloor', cols: ['simId'], parent: 'Simulation', pk: 'simId', nullable: false },
  { child: 'SimulationFloor', cols: ['affixId'], parent: 'DungeonAffix', pk: 'affixId', nullable: true },
  { child: 'Wheel', cols: ['eventRef'], parent: 'EventSchedule', pk: 'eventId', nullable: true },
  { child: 'WheelReward', cols: ['wheelId'], parent: 'Wheel', pk: 'wheelId', nullable: false },
  { child: 'TreasureChest', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'Puzzle', cols: ['regionId'], parent: 'Region', pk: 'regionId', nullable: false },
  { child: 'TeamBuffHero', cols: ['buffId'], parent: 'TeamBuff', pk: 'buffId', nullable: false },
  { child: 'TeamBuffHero', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'TournamentReward', cols: ['tournamentId'], parent: 'Tournament', pk: 'tournamentId', nullable: false },
  { child: 'MiniGameReward', cols: ['miniGameId'], parent: 'MiniGame', pk: 'miniGameId', nullable: false },
  { child: 'HeroSkillUnlock', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'UltCharge', cols: ['heroId'], parent: 'Hero', pk: 'heroId', nullable: false },
  { child: 'GachaUpPool', cols: ['poolId'], parent: 'GachaPool', pk: 'poolId', nullable: false },
  { child: 'GachaUpPool', cols: ['upHeroId'], parent: 'Hero', pk: 'heroId', nullable: true },
  { child: 'GachaUpPool', cols: ['upWeaponId'], parent: 'Weapon', pk: 'weaponId', nullable: true },
  { child: 'FreeGacha', cols: ['poolId'], parent: 'GachaPool', pk: 'poolId', nullable: false },
  { child: 'ShopDiscount', cols: ['shopId'], parent: 'ShopItem', pk: 'shopId', nullable: false },
  { child: 'ShopDiscount', cols: ['eventRef'], parent: 'EventSchedule', pk: 'eventId', nullable: true },
  { child: 'ActivityReward', cols: ['eventId'], parent: 'EventSchedule', pk: 'eventId', nullable: false },
  { child: 'CoopRecommend', cols: ['coopDungeonId'], parent: 'CoopDungeon', pk: 'coopDungeonId', nullable: false },
  { child: 'PvpMap', cols: ['buffId'], parent: 'Buff', pk: 'buffId', nullable: true },
  { child: 'ArenaBuff', cols: ['seasonId'], parent: 'ArenaSeason', pk: 'seasonId', nullable: false },
  { child: 'NpcDialogue', cols: ['npcId'], parent: 'Npc', pk: 'npcId', nullable: false },
  { child: 'StoryDialogue', cols: ['questId'], parent: 'Quest', pk: 'questId', nullable: true },
  { child: 'PetEvolution', cols: ['fromPetId', 'toPetId'], parent: 'Pet', pk: 'petId', nullable: false },
  { child: 'WeaponSkin', cols: ['weaponId'], parent: 'Weapon', pk: 'weaponId', nullable: false },
  { child: 'EquipmentAwaken', cols: ['equipId'], parent: 'Equipment', pk: 'equipId', nullable: false },
  { child: 'EquipmentAwaken', cols: ['materialId'], parent: 'Material', pk: 'materialId', nullable: false },
  { child: 'WorldBossSchedule', cols: ['bossId'], parent: 'WorldBoss', pk: 'bossId', nullable: false },
];

// 多态物品引用（itemType 列决定指向）
const POLY = [
  { child: 'DropTable', typeCol: 'itemType', idCol: 'itemId' },
  { child: 'ShopItem', typeCol: 'itemType', idCol: 'itemId' },
  { child: 'GachaItem', typeCol: 'itemType', idCol: 'itemId' },
  { child: 'MonsterDrop', typeCol: 'itemType', idCol: 'itemId' },
  { child: 'QuestReward', typeCol: 'itemType', idCol: 'itemId' },
  { child: 'DailyLoginReward', typeCol: 'itemType', idCol: 'itemId' },
];
// 单列多态物品引用（前缀判定）
const POLY_COL = [
  ['HeroAffinity', 'rewardItemId'], ['DungeonFirstClear', 'rewardItemId'],
  ['TowerFloor', 'rewardItemId'], ['TowerReward', 'firstClearItemId'], ['TowerReward', 'dailyItemId'],
  ['WeeklyChallengeReward', 'rewardItemId'], ['CoopReward', 'rewardItemId'],
  ['BossReward', 'firstClearItemId'], ['OnlineReward', 'rewardItemId'],
  ['DailyLoginReward', 'itemId'], ['GachaWish', 'wishItemId'], ['GachaWish', 'costItemId'],
  ['FirstChargeReward', 'rewardItemId'], ['GrowthFund', 'rewardItemId'],
  ['BattlePassReward', 'rewardItemId'], ['NewbiePack', 'itemId'],
  ['QuestReward', 'itemId'], ['StoryChapterReward', 'rewardItemId'],
  ['Achievement', 'rewardItemId'], ['NewbieQuest', 'rewardItemId'],
  ['NpcShop', 'itemId'], ['LimitedShop', 'itemId'], ['ArenaShop', 'itemId'],
  ['GuildShop', 'itemId'], ['EventShop', 'itemId'],
  ['ArenaTier', 'rewardItemId'], ['ArenaReward', 'rewardItemId'],
  ['LeaderboardReward', 'rewardItemId'], ['RankMatchReward', 'rewardItemId'],
  ['Expedition', 'rewardItemId'], ['ExpeditionReward', 'rewardItemId'],
  ['GuildWarReward', 'rewardItemId'], ['GuildBossReward', 'rewardItemId'],
  ['MailTemplate', 'attachmentId'], ['CodexReward', 'rewardItemId'],
  ['WorldBossReward', 'rewardItemId'], ['WheelReward', 'itemId'],
  ['TreasureChest', 'rewardItemId'], ['HiddenQuest', 'rewardItemId'],
  ['BountyDaily', 'rewardItemId'], ['BountyWeekly', 'rewardItemId'],
  ['TournamentReward', 'rewardItemId'], ['MiniGameReward', 'rewardItemId'],
  ['ActivityReward', 'rewardItemId'], ['Milestone', 'rewardItemId'], ['CombatTrial', 'rewardItemId'],
  ['NoviceReward', 'rewardItemId'], ['GachaPool', 'costItemId'],
  ['Recipe', 'resultItemId'], ['EquipmentTransmute', 'costItemId'],
  ['GachaExchange', 'rewardItemId'], ['ArenaDailyReward', 'rewardItemId'],
  ['PetEvolution', 'materialId'],
];
// 分号分隔的 ID 列表外键
const LIST_FK = [
  { child: 'Monster', col: 'skillIds', parent: 'MonsterSkill', pk: 'skillId' },
  { child: 'DungeonWave', col: 'monsterIds', parent: 'Monster', pk: 'monsterId' },
  { child: 'BossPhase', col: 'skillIds', parent: 'MonsterSkill', pk: 'skillId' },
  { child: 'QuestChain', col: 'questIds', parent: 'Quest', pk: 'questId' },
  { child: 'TeamBuff', col: 'heroes', parent: 'Hero', pk: 'heroId' },
  { child: 'CoopRecommend', col: 'recommendHeroIds', parent: 'Hero', pk: 'heroId' },
  { child: 'GiftPack', col: 'itemIds', parent: null, pk: null }, // 多态列表，用 POLY 逻辑
];

/* ================= 配置：ID 族 → 定义表 ================= */

const ID_FAMILIES = [
  ['EM', 'EliteMonster', 'eliteId'], ['H', 'Hero', 'heroId'], ['SK', 'Skill', 'skillId'],
  ['BF', 'Buff', 'buffId'], ['WP', 'Weapon', 'weaponId'], ['EQ', 'Equipment', 'equipId'],
  ['S', 'EquipmentSet', 'setId'], ['DG', 'Dungeon', 'dungeonId'], ['DR', 'DropTable', 'dropId'],
  ['SH', 'ShopItem', 'shopId'], ['MAT', 'Material', 'materialId'], ['M', 'Monster', 'monsterId'],
  ['B', 'Boss', 'bossId'], ['IT', 'Item', 'itemId'], ['QS', 'Quest', 'questId'],
  ['AC', 'Achievement', 'achievementId'], ['CN', 'Constellation', 'constId'],
  ['TN', 'HeroTalent', 'talentId'], ['SN', 'HeroSkin', 'skinId'], ['TI', 'Title', 'titleId'],
  ['NC', 'Namecard', 'namecardId'], ['MS', 'MonsterSkill', 'skillId'], ['AI', 'MonsterAI', 'aiId'],
  ['AF', 'DungeonAffix', 'affixId'], ['TF', 'TowerFloor', 'floorId'], ['EV', 'EventSchedule', 'eventId'],
  ['NP', 'Npc', 'npcId'], ['EX', 'Expedition', 'expeditionId'], ['FU', 'FunctionUnlock', 'unlockId'],
  ['TB', 'TeamBuff', 'buffId'], ['WB', 'WorldBoss', 'bossId'], ['SM', 'Simulation', 'simId'],
  ['TH', 'TreasureHunt', 'huntId'], ['LT', 'Lottery', 'lotteryId'], ['WH', 'Wheel', 'wheelId'],
  ['RB', 'RandomBox', 'boxId'], ['TC', 'TreasureChest', 'chestId'], ['PZ', 'Puzzle', 'puzzleId'],
  ['HQ', 'HiddenQuest', 'questId'], ['WK', 'BountyWeekly', 'bountyId'], ['DK', 'BountyDaily', 'bountyId'],
  ['TM', 'Tournament', 'tournamentId'], ['MG', 'MiniGame', 'miniGameId'], ['PT', 'Pet', 'petId'],
  ['GB', 'GuildBoss', 'bossId'], ['GP', 'GachaPool', 'poolId'], ['RC', 'Recipe', 'recipeId'],
  ['ML', 'MailTemplate', 'mailId'], ['CX', 'Codex', 'codexId'], ['RG', 'Region', 'regionId'],
  ['WY', 'Waypoint', 'waypointId'], ['FP', 'FormulaParam', 'paramId'], ['WT', 'WeaponType', 'weaponTypeId'],
  ['CC', 'ComboChain', 'comboId'], ['SHL', 'Shield', 'shieldId'], ['DT', 'DamageType', 'damageTypeId'],
  ['HF', 'HitEffect', 'hitEffectId'], ['ER', 'ElementReaction', 'reactionId'],
  ['WC', 'WeeklyChallenge', 'challengeId'], ['ED', 'EventDungeon', 'eventDungeonId'],
  ['AR', 'ArenaSeason', 'seasonId'], ['RM', 'RankMatchSeason', 'seasonId'],
  ['BM', 'BossMechanic', 'mechanicId'], ['TR', 'Trap', 'trapId'], ['LS', 'LimitedShop', 'limitedShopId'],
  ['CD', 'CoopDungeon', 'coopDungeonId'], ['CH', 'StoryChapter', 'chapterId'],
  ['CAT', 'AchievementCategory', 'categoryId'], ['PS', 'PetSkill', 'petSkillId'],
  ['SB', 'SimulationBuff', 'simBuffId'], ['TRL', 'CombatTrial', 'trialId'],
  ['EMO', 'ChatEmoji', 'emojiId'], ['AFR', 'AvatarFrame', 'frameId'], ['CB', 'ChatBubble', 'bubbleId'],
  ['BS', 'BreakShield', 'shieldId'], ['PM', 'PvpMap', 'mapId'], ['GV', 'GuildWar', 'warId'],
  ['GBL', 'GuildBuilding', 'buildingId'], ['SC', 'ShopCategory', 'categoryId'],
  ['MILE', 'Milestone', 'milestoneId'], ['DGR', 'DodgeRule', 'dodgeId'],
  ['GEX', 'GachaExchange', 'exchangeId'], ['GD', 'GuildDonate', 'donateId'],
  ['WSK', 'WeaponSkin', 'skinId'], ['WBS', 'WorldBossSchedule', 'scheduleId'],
  ['ADR', 'ArenaDailyReward', 'rewardId'], ['DIA', 'StoryDialogue', 'dialogueId'],
];
// 前缀按长度降序（长前缀优先匹配）
ID_FAMILIES.sort((a, b) => b[0].length - a[0].length);

function familyLookup(id) {
  for (const [prefix, table, col] of ID_FAMILIES) {
    if (id.startsWith(prefix) && id.length === prefix.length + 3) return { table, col };
  }
  return null;
}
const RANGE_RE = /[A-Z]+\d{3,}(?:[–—-]\d{3,})+/;

/* ================= 检查 1：文件完备性 ================= */

function checkFiles() {
  const files = fs.existsSync(GAMEDATA) ? fs.readdirSync(GAMEDATA).filter((f) => f.endsWith('.csv')) : [];
  const present = new Set(files.map((f) => f.replace(/\.csv$/, '')));
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  const extra = files.map((f) => f.replace(/\.csv$/, '')).filter((t) => !EXPECTED_TABLES.includes(t));
  if (missing.length) errors.push(`缺少配表 ${missing.length} 张: ${missing.join(', ')}`);
  info.push(`配表文件数: ${present.size} / 期望 ${EXPECTED_TABLES.length}`);
  if (extra.length) warnings.push(`多余配表文件（不在清单中）: ${extra.join(', ')}`);
  return present.size;
}

/* ================= 检查 2：表级（表头/主键/行数） ================= */

function checkTableLevel() {
  let okCount = 0;
  for (const name of EXPECTED_TABLES) {
    const t = loadTable(name);
    if (!t) continue;
    okCount++;
    // 表头 camelCase
    for (const h of t.headers) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(h)) errors.push(`${name}.csv: 表头非法(非 camelCase): ${h}`);
    }
    // 主键唯一
    const pkCols = PK[name];
    if (pkCols) {
      const seen = new Map();
      for (const r of t.rows) {
        const key = pkCols.map((c) => r[c] ?? '').join('|');
        if (key.includes('|')) { /* 复合键正常 */ }
        if (seen.has(key)) errors.push(`${name}.csv: 主键重复 ${pkCols.join('+')}=${key}`);
        else seen.set(key, true);
        for (const c of pkCols) {
          if (!r[c] || r[c].trim() === '') errors.push(`${name}.csv: 主键列 ${c} 为空 (行: ${JSON.stringify(r).slice(0, 60)})`);
        }
      }
    }
    // 行数（小配置表 4–7 行放行为 WARN，机械成长表 >200 为 WARN）
    if (t.rows.length < 4) errors.push(`${name}.csv: 行数 ${t.rows.length} < 4`);
    if (t.rows.length >= 4 && t.rows.length < 8) warnings.push(`${name}.csv: 行数 ${t.rows.length} 为小配置表（8 行下限放宽）`);
    if (t.rows.length > 200) warnings.push(`${name}.csv: 行数 ${t.rows.length} > 200（机械成长表需在模块总结说明）`);
  }
  info.push(`表级检查通过: ${okCount} 张表可解析`);
}

/* ================= 检查 3：枚举 ================= */

function checkEnums() {
  for (const [tname, col, allowedArr] of ENUM_RULES) {
    const allowedSet = new Set(allowedArr);
    for (const name of EXPECTED_TABLES) {
      if (tname !== '*' && name !== tname) continue;
      const t = loadTable(name);
      if (!t) continue;
      for (const r of t.rows) {
        if (!(col in r)) continue;
        const v = (r[col] ?? '').trim();
        if (v === '') continue;
        for (const x of v.split(';').map((s) => s.trim()).filter(Boolean)) {
          if (!allowedSet.has(x)) errors.push(`${name}.csv: 枚举列 ${col} 非法值 ${x}（允许: ${allowedArr.join('/')}）`);
        }
      }
    }
  }
  // 货币类列：货币 token 或 MAT/IT 物品（CurrencyExchange 的 from/toCurrency 可为材料）
  for (const name of EXPECTED_TABLES) {
    const t = loadTable(name);
    if (!t) continue;
    for (const r of t.rows) {
      for (const col of CURRENCY_COLS) {
        if (!(col in r)) continue;
        const v = (r[col] ?? '').trim();
        if (v === '') continue;
        for (const x of v.split(';').map((s) => s.trim()).filter(Boolean)) {
          if (CURRENCY_TOKENS.has(x)) continue;
          if (/^MAT\d+$/.test(x) && pkSet('Material', ['materialId']).has(x)) continue;
          if (/^IT\d+$/.test(x) && pkSet('Item', ['itemId']).has(x)) continue;
          errors.push(`${name}.csv: 货币列 ${col} 非法值 ${x}（须为货币 token 或已注册 MAT/IT）`);
        }
      }
    }
  }
}

/* ================= 检查 4：外键 ================= */

function checkFK() {
  for (const rule of FK) {
    const child = loadTable(rule.child);
    if (!child) continue;
    const parentPk = pkSet(rule.parent, [rule.pk]);
    for (const r of child.rows) {
      for (const col of rule.cols) {
        const v = (r[col] ?? '').trim();
        if (v === '') {
          if (!rule.nullable) errors.push(`${rule.child}.csv: 外键列 ${col} 为空（不可空）`);
          continue;
        }
        if (rule.parent === 'Material' && /^MAT\d+$/.test(v)) {
          if (!parentPk.has(v)) errors.push(`${rule.child}.csv ${r[rule.cols[0]] || ''}: ${col}=${v} → ${rule.parent} 不存在`);
        } else if (!parentPk.has(v)) {
          errors.push(`${rule.child}.csv ${r[rule.cols[0]] || ''}: ${col}=${v} → ${rule.parent}.${rule.pk} 悬空`);
        }
      }
    }
  }
}

/* ================= 检查 5：多态物品引用 ================= */

function polyResolve(id) {
  if (!id) return null;
  if (/^IT\d+$/.test(id)) return { table: 'Item', pk: 'itemId' };
  if (/^MAT\d+$/.test(id)) return { table: 'Material', pk: 'materialId' };
  if (/^WP\d+$/.test(id)) return { table: 'Weapon', pk: 'weaponId' };
  if (/^EQ\d+$/.test(id)) return { table: 'Equipment', pk: 'equipId' };
  if (/^H\d+$/.test(id)) return { table: 'Hero', pk: 'heroId' };
  if (CURRENCY_TOKENS.has(id)) return { token: true };
  return null;
}

function checkPoly() {
  // itemType + itemId 成对
  for (const { child: name, typeCol, idCol } of POLY) {
    const t = loadTable(name);
    if (!t) continue;
    for (const r of t.rows) {
      const type = (r[typeCol] ?? '').trim();
      const id = (r[idCol] ?? '').trim();
      if (id === '') continue;
      let ok = false;
      if (type === 'weapon') ok = pkSet('Weapon', ['weaponId']).has(id);
      else if (type === 'equipment') ok = pkSet('Equipment', ['equipId']).has(id);
      else if (type === 'material') ok = pkSet('Material', ['materialId']).has(id);
      else if (type === 'hero') ok = pkSet('Hero', ['heroId']).has(id);
      else if (type === 'currency') ok = CURRENCY_TOKENS.has(id);
      else if (type === 'stamina') ok = id === 'STAMINA';
      else ok = !!polyResolve(id);
      if (!ok) errors.push(`${name}.csv ${r[typeCol] || ''}: itemType=${type} itemId=${id} 悬空`);
    }
  }
  // 单列多态
  for (const [name, col] of POLY_COL) {
    const t = loadTable(name);
    if (!t) continue;
    for (const r of t.rows) {
      const v = (r[col] ?? '').trim();
      if (v === '') continue;
      const res = polyResolve(v);
      if (!res) { errors.push(`${name}.csv: ${col}=${v} 无法解析（须为 IT/MAT/WP/EQ/货币 token）`); continue; }
      if (res.token) continue;
      if (!pkSet(res.table, [res.pk]).has(v)) errors.push(`${name}.csv ${r[Object.keys(r)[0]] || ''}: ${col}=${v} → ${res.table} 悬空`);
    }
  }
  // 分号列表（含多态 GiftPack）
  for (const { child: name, col, parent, pk } of LIST_FK) {
    const t = loadTable(name);
    if (!t) continue;
    for (const r of t.rows) {
      const v = (r[col] ?? '').trim();
      if (v === '') continue;
      const items = v.split(';').map((x) => x.trim()).filter(Boolean);
      for (const it of items) {
        if (parent === null) {
          if (!polyResolve(it)) errors.push(`${name}.csv: ${col} 中 ${it} 无法解析`);
          continue;
        }
        if (!pkSet(parent, [pk]).has(it)) errors.push(`${name}.csv ${r[Object.keys(r)[0]] || ''}: ${col} 中 ${it} → ${parent} 悬空`);
      }
    }
  }
}

/* ================= 检查 5b：带类型列的特殊多态引用 ================= */

function checkSpecial() {
  // QuestStep.targetId: M**→Monster、DG**→Dungeon、其余→物品多态
  const qs = loadTable('QuestStep');
  if (qs) {
    for (const r of qs.rows) {
      const v = (r.targetId ?? '').trim();
      if (v === '') continue;
      if (/^M\d{3,}$/.test(v)) { if (!pkSet('Monster', ['monsterId']).has(v)) errors.push(`QuestStep.csv: targetId=${v} → Monster 悬空`); continue; }
      if (/^DG\d{3,}$/.test(v)) { if (!pkSet('Dungeon', ['dungeonId']).has(v)) errors.push(`QuestStep.csv: targetId=${v} → Dungeon 悬空`); continue; }
      const res = polyResolve(v);
      if (!res) { errors.push(`QuestStep.csv: targetId=${v} 无法解析（须为 M**/DG**/IT**/MAT**）`); continue; }
      if (res.table && !pkSet(res.table, [res.pk]).has(v)) errors.push(`QuestStep.csv: targetId=${v} → ${res.table} 悬空`);
    }
  }
  // Codex.targetId: 按 targetType 定向
  const cx = loadTable('Codex');
  if (cx) {
    const map = {
      hero: ['Hero', 'heroId'], monster: ['Monster', 'monsterId'], region: ['Region', 'regionId'],
      event: ['EventSchedule', 'eventId'], story: ['Quest', 'questId'],
    };
    for (const r of cx.rows) {
      const tt = (r.targetType ?? '').trim();
      const v = (r.targetId ?? '').trim();
      if (v === '') continue;
      const spec = map[tt];
      if (spec) { if (!pkSet(spec[0], [spec[1]]).has(v)) errors.push(`Codex.csv: targetType=${tt} targetId=${v} → ${spec[0]} 悬空`); continue; }
      if (tt === 'item' || tt === 'material') {
        const res = polyResolve(v);
        if (!res || res.token) { errors.push(`Codex.csv: targetType=${tt} targetId=${v} 无法解析`); continue; }
        if (!pkSet(res.table, [res.pk]).has(v)) errors.push(`Codex.csv: targetType=${tt} targetId=${v} → ${res.table} 悬空`);
        continue;
      }
      errors.push(`Codex.csv: 未知 targetType=${tt}`);
    }
  }
  // MaterialSource.sourceId: 按 sourceType 定向
  const ms = loadTable('MaterialSource');
  if (ms) {
    const map = {
      dungeon: ['Dungeon', 'dungeonId'], shop: ['ShopItem', 'shopId'], event: ['EventSchedule', 'eventId'],
      recipe: ['Recipe', 'recipeId'], exchange: ['CurrencyExchange', 'exchangeId'],
    };
    for (const r of ms.rows) {
      const st = (r.sourceType ?? '').trim();
      const v = (r.sourceId ?? '').trim();
      if (v === '') continue;
      const spec = map[st];
      if (!spec) { errors.push(`MaterialSource.csv: 未知 sourceType=${st}`); continue; }
      if (!pkSet(spec[0], [spec[1]]).has(v)) errors.push(`MaterialSource.csv: sourceType=${st} sourceId=${v} → ${spec[0]} 悬空`);
    }
  }
}

/* ================= 检查 6：ID 存在性（全表 + 文档） ================= */

function scanTextForIds(text, source, isDoc) {
  const seen = new Set();
  const tokens = text.match(/[A-Z]{1,4}\d{3,4}/g) || [];
  for (const raw of tokens) {
    if (RANGE_RE.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const fam = familyLookup(raw);
    if (!fam) continue;
    const pk = pkSet(fam.table, [fam.col]);
    if (!pk.has(raw)) {
      const msg = `${source}: ID ${raw} → ${fam.table}.${fam.col} 不存在`;
      if (isDoc) errors.push(`文档ID: ${msg}`);
      else errors.push(`表内ID: ${msg}`);
    }
  }
}

function checkIds() {
  for (const name of EXPECTED_TABLES) {
    const t = loadTable(name);
    if (!t) continue;
    for (let i = 0; i < t.rows.length; i++) {
      for (const h of t.headers) {
        const v = t.rows[i][h] ?? '';
        if (v && /[A-Z]{1,4}\d{3,4}/.test(v)) scanTextForIds(v, `${name}.csv:${i + 2}行`, false);
      }
    }
  }
  if (fs.existsSync(GAMEDOCS)) {
    const docs = fs.readdirSync(GAMEDOCS).filter((f) => f.endsWith('.md'));
    for (const d of docs) {
      const text = fs.readFileSync(path.join(GAMEDOCS, d), 'utf8');
      scanTextForIds(text, `docs/${d}`, true);
      if (!text.includes('配表引用')) errors.push(`docs/${d}: 缺少「配表引用」节`);
      if (d !== '00_项目总览与术语表.md' && !/参见《\d{2}_/.test(text)) warnings.push(`docs/${d}: 缺少「参见《NN_…》」显式引用`);
    }
    info.push(`文档数: ${docs.length}`);
  }
}

/* ================= 检查 7：公式一致性抽查 ================= */

function checkFormulas() {
  const skill = loadTable('Skill');
  const skillLevel = loadTable('SkillLevel');
  if (skill && skillLevel) {
    const base = new Map(skill.rows.map((r) => [r.skillId, parseFloat(r.skillRate)]));
    for (const r of skillLevel.rows) {
      if (String(r.level) !== '10') continue;
      const b = base.get(r.skillId);
      const l10 = parseFloat(r.skillRate);
      if (b == null || Number.isNaN(l10)) continue;
      if (Math.abs(l10 - b * 1.8) > 0.05) {
        errors.push(`SkillLevel.csv ${r.skillId}: L10=${l10} 与 Skill.skillRate=${b}×1.8=${(b * 1.8).toFixed(2)} 偏差 >0.05`);
      }
    }
  }
  const drop = loadTable('DropTable');
  if (drop) {
    const sums = new Map();
    for (const r of drop.rows) {
      sums.set(r.dropId, (sums.get(r.dropId) || 0) + parseFloat(r.weight || 0));
    }
    for (const [dropId, s] of sums) {
      if (Math.abs(s - 1000) > 0.01) errors.push(`DropTable.csv ${dropId}: weight 合计=${s} ≠ 1000`);
    }
  }
  const fp = loadTable('FormulaParam');
  if (fp) {
    const expect = { FP001: '1000', FP002: '1.5', FP003: '0.8', FP004: '1', FP005: '1.25', FP006: '1.5', FP007: '0.5', FP008: '0.25', FP009: '100', FP010: '10' };
    for (const r of fp.rows) {
      const e = expect[r.paramId];
      if (e && String(parseFloat(r.value)) !== String(parseFloat(e))) errors.push(`FormulaParam.csv ${r.paramId}: value=${r.value} ≠ ${e}`);
    }
  }
  const pw = loadTable('PowerFormulaWeight');
  if (pw) {
    const expect = { atkFlat: '3', defFlat: '2', atkPct: '250', defPct: '300', hpPct: '120', critRate: '300', critDmg: '200', energyRecharge: '100' };
    for (const r of pw.rows) {
      const e = expect[r.statType];
      if (e && String(parseFloat(r.weight)) !== String(parseFloat(e))) errors.push(`PowerFormulaWeight.csv ${r.statType}: weight=${r.weight} ≠ ${e}`);
    }
  }
  // Hero 基础值 = HeroLevel L1
  const hero = loadTable('Hero');
  const hl = loadTable('HeroLevel');
  if (hero && hl) {
    const l1 = new Map();
    for (const r of hl.rows) if (String(r.level) === '1') l1.set(r.heroId, r);
    for (const r of hero.rows) {
      const row = l1.get(r.heroId);
      if (!row) continue;
      if (String(parseFloat(r.baseAtk)) !== String(parseFloat(row.atk))) errors.push(`HeroLevel L1 与 Hero.baseAtk 不一致: ${r.heroId} base=${r.baseAtk} L1=${row.atk}`);
      if (String(parseFloat(r.baseDef)) !== String(parseFloat(row.def))) errors.push(`HeroLevel L1 与 Hero.baseDef 不一致: ${r.heroId}`);
      if (String(parseFloat(r.baseHp)) !== String(parseFloat(row.hp))) errors.push(`HeroLevel L1 与 Hero.baseHp 不一致: ${r.heroId}`);
    }
  }
}

/* ================= 检查 8：v0.1 既有行保护 ================= */

const V01_SPOT = {
  Hero: { H001: { baseAtk: '110', baseDef: '85', baseHp: '1750' }, H008: { baseAtk: '105', baseDef: '90', baseHp: '1800' } },
  Skill: { SK001: { heroId: 'H001', skillType: 'normal' }, SK007: { heroId: 'H002', skillType: 'ult', skillRate: '4.8' } },
  Buff: { BF001: { kind: 'dot' }, BF011: { kind: 'stance' } },
  Weapon: { WP001: { baseAtk: '150' }, WP008: { baseAtk: '150' } },
  Equipment: { EQ001: { mainStatType: 'critRate', mainStatValue: '0.05' }, EQ010: { mainStatType: 'defFlat', mainStatValue: '90' } },
  Dungeon: { DG001: { type: 'main', staminaCost: '10', recommendPower: '1200' }, DG006: { type: 'coop', staminaCost: '20', recommendPower: '24000' } },
  ShopItem: { SH001: { costCurrency: 'GEM', costAmount: '50' }, SH012: { costCurrency: 'GEM', costAmount: '100' } },
};

function checkV01() {
  for (const [table, spots] of Object.entries(V01_SPOT)) {
    const t = loadTable(table);
    if (!t) continue;
    const pkCol = PK[table][0];
    const byPk = new Map(t.rows.map((r) => [r[pkCol], r]));
    for (const [id, expectMap] of Object.entries(spots)) {
      const row = byPk.get(id);
      if (!row) { errors.push(`v0.1 保护: ${table} 缺失 ${id}`); continue; }
      for (const [col, ev] of Object.entries(expectMap)) {
        if (String(row[col]) !== String(ev)) errors.push(`v0.1 保护: ${table} ${id} ${col} 被改为 ${row[col]}（原 ${ev}）`);
      }
    }
  }
  const ec = loadTable('ElementChart');
  if (ec) {
    const find = ec.rows.find((r) => r.attackElement === 'fire' && r.targetElement === 'ice');
    if (!find || String(find.multiplier) !== '1.25') errors.push('v0.1 保护: ElementChart fire→ice 倍率被改');
  }
  const bt = loadTable('Breakthrough');
  if (bt) {
    const find = bt.rows.find((r) => r.heroId === 'H001' && String(r.stage) === '1');
    if (!find || String(find.costGold) !== '20000') errors.push('v0.1 保护: Breakthrough H001 stage1 costGold 被改');
  }
}

/* ================= 主流程 ================= */

checkFiles();
checkTableLevel();
checkEnums();
checkFK();
checkPoly();
checkSpecial();
checkIds();
checkFormulas();
checkV01();

console.log('========== StarTrail v0.2 校验报告 ==========');
for (const i of info) console.log(`INFO  ${i}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log('---------------------------------------------');
console.log(`ERROR: ${errors.length}   WARN: ${warnings.length}`);
if (errors.length === 0) console.log('RESULT: PASS');
else { console.log('RESULT: FAIL'); process.exit(1); }
