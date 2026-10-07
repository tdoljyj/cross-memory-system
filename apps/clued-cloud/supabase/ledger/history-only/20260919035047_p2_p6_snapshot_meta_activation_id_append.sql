-- P2 · P-6 选项①（Owner 批准于 canonical_event:767，取值登记于 766）
-- 追加 migration（A-R §2 / E16 许可的扩展形态）：为 snapshot_meta 增 activation_id 列。
-- 仅追加，不改既有列、不删任何对象。mtpe_m0_test 同步加列以保持测试域结构对等（夹具保真）。
alter table mtpe_m0.snapshot_meta
  add column activation_id uuid references mtpe_m0.inventory_activation(id);
alter table mtpe_m0_test.snapshot_meta
  add column activation_id uuid references mtpe_m0_test.inventory_activation(id);
comment on column mtpe_m0.snapshot_meta.activation_id is
  'P-6① 追加（批准包 B v0.8，canonical_event:767）：生效机制在 snapshot_meta 上的落点；仅现行枚举行指向 inventory_activation，被取代行保持 NULL';