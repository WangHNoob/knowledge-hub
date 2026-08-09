# StarTrail 黄金测评集报告（严格版 v2）

- 总题数: 30 | PASS: 26 | PARTIAL: 0 | FAIL: 4
- 综合得分: 86.7 / 100（PASS=1，PARTIAL=0.5）
- 数值规则: 精确匹配为主；≈ 前缀容差 5%

## 分组表现

| 分组 | PASS | PARTIAL | FAIL |
|------|------|---------|------|
| anti_hallucination | 3 | 0 | 0 |
| basic_retrieval | 2 | 0 | 3 |
| consistency | 4 | 0 | 0 |
| cross_table | 5 | 0 | 1 |
| economy_loop | 4 | 0 | 0 |
| evidence_chain | 2 | 0 | 0 |
| formula_calc | 6 | 0 | 0 |

## 逐题明细

- **EV-001** [basic_retrieval] **PASS** — keyFacts 4/4
- **EV-002** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-003** [basic_retrieval] **FAIL** — keyFacts 1/1; numPairs不符: staminaCost=20(field missing); unlockLevel=60(field missing)
- **EV-004** [basic_retrieval] **FAIL** — keyFacts 2/2; numPairs不符: skillRate=1.7(value mismatch: got 3.06)
- **EV-005** [basic_retrieval] **FAIL** — keyFacts 2/2; numPairs不符: rarity=5(field missing); subStatValue=0.12(field missing)
- **EV-006** [cross_table] **PASS** — keyFacts 5/5
- **EV-007** [cross_table] **PASS** — keyFacts 4/4
- **EV-008** [cross_table] **PASS** — keyFacts 3/3
- **EV-009** [cross_table] **PASS** — keyFacts 4/4
- **EV-010** [cross_table] **FAIL** — keyFacts 4/4; numPairs不符: costAmount=3200(field missing); weeklyLimit=1(field missing)
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
- **EV-021** [economy_loop] **PASS** — keyFacts 3/3
- **EV-022** [consistency] **PASS** — keyFacts 5/5
- **EV-023** [consistency] **PASS** — keyFacts 4/4
- **EV-024** [consistency] **PASS** — keyFacts 4/4
- **EV-025** [consistency] **PASS** — keyFacts 8/8
- **EV-026** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-027** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-028** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-029** [evidence_chain] **PASS** — keyFacts 5/5
- **EV-030** [evidence_chain] **PASS** — keyFacts 6/6
