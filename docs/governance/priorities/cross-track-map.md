# Cross-Track Dependency / Impact Map

**Projection only — not Authority.**

| From | Relation | To |
|---|---|---|
| `E-001` | `UNLOCKS` | `E-002` |
| `E-002` | `UNLOCKS` | `E-003` |
| `E-003` | `UNLOCKS` | `E-004` |
| `E-004` | `UNLOCKS` | `E-005` |
| `R-005` | `CONSTRAINS` | `E-005` |
| `R-006` | `CONSTRAINS` | `E-005` |
| `R-004` | `CONSTRAINS` | `E-006` |
| `E-005` | `UNLOCKS` | `E-006` |
| `E-006` | `UNLOCKS` | `E-007` |
| `E-007` | `UNLOCKS` | `P-007` |
| `E-014` | `CONSTRAINS` | `P-007` |
| `P-007` | `UNLOCKS` | `P-008` |
| `P-008` | `UNLOCKS` | `P-009` |
| `R-007` | `CONSTRAINS` | `P-009` |
| `P-009` | `UNLOCKS` | `P-010` |
| `P-007` | `UNLOCKS` | `P-011` |
| `P-009` | `UNLOCKS` | `P-011` |
| `E-011` | `UNLOCKS` | `P-012` |
| `E-012` | `UNLOCKS` | `P-012` |
| `P-007` | `UNLOCKS` | `P-012` |
| `P-007` | `UNLOCKS` | `B-004` |
| `P-011` | `UNLOCKS` | `B-004` |
| `P-012` | `UNLOCKS` | `B-004` |
| `B-004` | `PRECEDES` | `B-005` |
| `B-005` | `PRECEDES` | `B-006` |
| `E-008` | `DOGFOODS` | `P-013` |
