# StarTrail 黄金测评集报告（严格版 v2）

- 总题数: 30 | PASS: 25 | PARTIAL: 0 | FAIL: 5
- 综合得分: 83.3 / 100（PASS=1，PARTIAL=0.5）
- 数值规则: 精确匹配为主；≈ 前缀容差 5%

## 分组表现

| 分组 | PASS | PARTIAL | FAIL |
|------|------|---------|------|
| anti_hallucination | 3 | 0 | 0 |
| basic_retrieval | 3 | 0 | 2 |
| consistency | 3 | 0 | 1 |
| cross_table | 6 | 0 | 0 |
| economy_loop | 3 | 0 | 1 |
| evidence_chain | 1 | 0 | 1 |
| formula_calc | 6 | 0 | 0 |

## 逐题明细

- **EV-001** [basic_retrieval] **PASS** — keyFacts 4/4
- **EV-002** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-003** [basic_retrieval] **FAIL** — keyFacts 1/1; numPairs不符: staminaCost=20(field missing); recommendPower=15000(field missing); unlockLevel=60(field missing)
- **EV-004** [basic_retrieval] **FAIL** — keyFacts 2/2; numPairs不符: cdSec=6(field missing); energyCost=15(field missing); skillRate=1.7(field missing)
- **EV-005** [basic_retrieval] **PASS** — keyFacts 2/2
- **EV-006** [cross_table] **PASS** — keyFacts 5/5
- **EV-007** [cross_table] **PASS** — keyFacts 4/4
- **EV-008** [cross_table] **PASS** — keyFacts 3/3
- **EV-009** [cross_table] **PASS** — keyFacts 4/4
- **EV-010** [cross_table] **PASS** — keyFacts 4/4
- **EV-011** [cross_table] **PASS** — keyFacts 3/3
- **EV-012** [formula_calc] **PASS** — keyFacts 2/2
- **EV-013** [formula_calc] **PASS** — keyFacts 5/5
- **EV-014** [formula_calc] **PASS** — keyFacts 1/1
- **EV-015** [formula_calc] **PASS** — keyFacts 3/3
- **EV-016** [formula_calc] **PASS** — keyFacts 4/4
- **EV-017** [formula_calc] **PASS** — keyFacts 2/2
- **EV-018** [economy_loop] **FAIL** — keyFacts 0/5
- **EV-019** [economy_loop] **PASS** — keyFacts 5/5
- **EV-020** [economy_loop] **PASS** — keyFacts 3/3
- **EV-021** [economy_loop] **PASS** — keyFacts 3/3
- **EV-022** [consistency] **PASS** — keyFacts 5/5
- **EV-023** [consistency] **PASS** — keyFacts 4/4
- **EV-024** [consistency] **PASS** — keyFacts 4/4
- **EV-025** [consistency] **FAIL** — keyFacts 0/8
- **EV-026** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-027** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-028** [anti_hallucination] **PASS** — keyFacts 2/2
- **EV-029** [evidence_chain] **PASS** — keyFacts 5/5
- **EV-030** [evidence_chain] **FAIL** — missing answer
