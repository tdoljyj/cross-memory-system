# R5.1 K6 Beta Known Limitations

K6 passed at implementation commit
`c94a4f0063055c677e1b3ad5077fb7c5ded79998`.

- The graphical Installer shell is deferred. The CLI and AI Conversation entry
  points both use the same verified `KernelService` and transaction engine.
- The controlled Pilot used synthetic data on one real Windows host with
  isolated logical device profiles, as allowed by R5.1.
- PostgreSQL 15+ K2/K3 integration remains a K7 environment qualification.
- Production Binding backends, production data and production deployment were
  not touched.
- Semantic recall remains disabled.

There are no known limitations involving data loss, cross-tenant access,
Secret leakage, Tombstone resurrection, revoked access or rollback failure.
