# StarTrail 黄金测评集报告（严格版 v2）

- 总题数: 78 | PASS: 58 | PARTIAL: 2 | FAIL: 18
- 综合得分: 75.6 / 100（PASS=1，PARTIAL=0.5）
- 数值规则: 精确匹配为主；≈ 前缀容差 5%

## 分组表现

| 分组 | PASS | PARTIAL | FAIL |
|------|------|---------|------|
| anti_hallucination | 7 | 0 | 2 |
| basic_retrieval | 11 | 0 | 2 |
| consistency | 10 | 0 | 1 |
| cross_table | 11 | 1 | 2 |
| economy_loop | 4 | 0 | 7 |
| evidence_chain | 3 | 1 | 2 |
| formula_calc | 12 | 0 | 2 |

## 逐题明细

- **EV-001** [basic_retrieval] **PASS** — keyFacts 4/4
- **EV-002** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-003** [basic_retrieval] **FAIL** — keyFacts 1/1; numPairs不符: staminaCost=20(field missing); unlockLevel=60(field missing)
- **EV-004** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-005** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-006** [cross_table] **PASS** — keyFacts 5/5
- **EV-007** [cross_table] **PASS** — keyFacts 4/4
- **EV-008** [cross_table] **PASS** — keyFacts 3/3
- **EV-009** [cross_table] **PARTIAL** — keyFacts 3/4
- **EV-010** [cross_table] **FAIL** — keyFacts 4/4; numPairs不符: costAmount=3200(field missing)
- **EV-011** [cross_table] **PASS** — keyFacts 3/3
- **EV-012** [formula_calc] **PASS** — keyFacts 2/2
- **EV-013** [formula_calc] **PASS** — keyFacts 5/5
- **EV-014** [formula_calc] **PASS** — keyFacts 1/1
- **EV-015** [formula_calc] **PASS** — keyFacts 3/3
- **EV-016** [formula_calc] **PASS** — keyFacts 4/4
- **EV-017** [formula_calc] **PASS** — keyFacts 2/2
- **EV-018** [economy_loop] **PASS** — keyFacts 5/5
- **EV-019** [economy_loop] **PASS** — keyFacts 5/5
- **EV-020** [economy_loop] **PASS** — keyFacts 3/3
- **EV-021** [economy_loop] **FAIL** — keyFacts 0/3
- **EV-022** [consistency] **PASS** — keyFacts 5/5
- **EV-023** [consistency] **PASS** — keyFacts 4/4
- **EV-024** [consistency] **PASS** — keyFacts 4/4
- **EV-025** [consistency] **PASS** — keyFacts 8/8
- **EV-026** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-027** [anti_hallucination] **FAIL** — keyFacts 0/2
- **EV-028** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-029** [evidence_chain] **PASS** — keyFacts 5/5
- **EV-030** [evidence_chain] **PASS** — keyFacts 6/6
- **EV-031** [basic_retrieval] **PASS** — keyFacts 4/4
- **EV-032** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-033** [basic_retrieval] **PASS** — keyFacts 1/1
- **EV-034** [basic_retrieval] **PASS** — keyFacts 3/3
- **EV-035** [basic_retrieval] **FAIL** — keyFacts 2/2; numPairs不符: baseHp=3600(field missing)
- **EV-036** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-037** [basic_retrieval] **PASS** — keyFacts 1/1
- **EV-038** [basic_retrieval] **PASS** — keyFacts 4/4
- **EV-039** [cross_table] **PASS** — keyFacts 5/5
- **EV-040** [cross_table] **PASS** — keyFacts 4/4
- **EV-041** [cross_table] **PASS** — keyFacts 2/2
- **EV-042** [cross_table] **PASS** — keyFacts 3/3
- **EV-043** [cross_table] **FAIL** — keyFacts 3/3; numPairs不符: durationHour=4(field missing)
- **EV-044** [cross_table] **PASS** — keyFacts 4/4
- **EV-045** [cross_table] **PASS** — keyFacts 3/3
- **EV-046** [cross_table] **PASS** — keyFacts 2/2
- **EV-047** [formula_calc] **FAIL** — keyFacts 2/2; numPairs不符: skillRate=8.46(value mismatch: got 4.7)
- **EV-048** [formula_calc] **PASS** — keyFacts 3/3
- **EV-049** [formula_calc] **PASS** — keyFacts 2/2
- **EV-050** [formula_calc] **FAIL** — keyFacts 4/4; numPairs不符: weightTotal=1000(field missing)
- **EV-051** [formula_calc] **PASS** — keyFacts 1/1
- **EV-052** [formula_calc] **PASS** — keyFacts 1/1
- **EV-053** [formula_calc] **PASS** — keyFacts 1/1
- **EV-054** [formula_calc] **PASS** — keyFacts 2/2
- **EV-055** [economy_loop] **FAIL** — keyFacts 3/3; numPairs不符: costQty=10(field missing); rewardQty=5(field missing); weeklyLimit=30(field missing)
- **EV-056** [economy_loop] **FAIL** — keyFacts 4/4; numPairs不符: rewardGuildPoint=25(field missing)
- **EV-057** [economy_loop] **PASS** — keyFacts 4/4
- **EV-058** [economy_loop] **FAIL** — keyFacts 0/4
- **EV-059** [economy_loop] **FAIL** — keyFacts 4/4; numPairs不符: day=14(value mismatch: got 1.0)
- **EV-060** [economy_loop] **FAIL** — keyFacts 0/2
- **EV-061** [economy_loop] **FAIL** — keyFacts 2/2; numPairs不符: costGold=20000(field missing); material1Qty=3(field missing); material2Qty=2(field missing)
- **EV-062** [consistency] **PASS** — keyFacts 2/2
- **EV-063** [consistency] **PASS** — keyFacts 3/3
- **EV-064** [consistency] **PASS** — keyFacts 3/3
- **EV-065** [consistency] **FAIL** — keyFacts 0/2
- **EV-066** [consistency] **PASS** — keyFacts 3/3
- **EV-067** [consistency] **PASS** — keyFacts 6/6
- **EV-068** [consistency] **PASS** — keyFacts 3/3
- **EV-069** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-070** [anti_hallucination] **PASS** — keyFacts 1/1
- **EV-071** [anti_hallucination] **FAIL** — keyFacts 0/1
- **EV-072** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-073** [anti_hallucination] **PASS** — keyFacts 1/1
- **EV-074** [anti_hallucination] **PASS** — keyFacts 1/1
- **EV-075** [evidence_chain] **PARTIAL** — keyFacts 4/5
- **EV-076** [evidence_chain] **PASS** — keyFacts 5/5
- **EV-077** [evidence_chain] **FAIL** — keyFacts 0/5
- **EV-078** [evidence_chain] **FAIL** — keyFacts 3/4; numPairs不符: rewardGuildPoint=25(value mismatch: got 15.0)
