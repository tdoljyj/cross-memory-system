-- UNINSTALLED minimal catalog successor, not a numbered migration.
-- Existing model.dataset_split.verify/recognize/producer grants from the
-- read-only source package must NOT be consumed as Canonical write permission.
-- Reuse only the existing Owner Grant/Native confirmation storage and engine.
insert into clued_private.owner_grant_actions(action,doors,title,risk) values
 ('model.dataset_split.bootstrap',array['model-domain-bootstrap'],
  '一次创建指定的非生产DatasetSplit生产者、权限投影与认定记录：固定Owner来源、三目标ID和真实Native确认；不授权Kernel/M2/训练',
  'high');
-- No grants, producer registration, source records, EXECUTE or DML privileges
-- are installed by this catalog candidate. Native approval remains external.
