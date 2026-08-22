# R5.1 K4 Known Limitations

K4 passed its executable synthetic/dev contract at commit
`aa23b0db88394386887ecc2ff30ea608391de3b3`.

- The second-device scenarios use isolated logical profiles, which R5.1 permits.
- The PostgreSQL 15+ K2/K3 integration rerun remains a K7 requirement.
- Production Binding backends were not changed or contacted.
- No production data, credential, Cookie, token or private query was used.
- Semantic recall remains disabled.

None of these limitations permits data loss, scope expansion, Tombstone
resurrection, revoked access, duplicate authoritative events or secret logging.
