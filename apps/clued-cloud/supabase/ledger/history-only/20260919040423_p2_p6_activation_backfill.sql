-- P2 · P-6① 数据回填（Owner 批准：canonical_event:766 取值、767 H2；执行日志 v0.1 §3 原文）
-- registry_entry 全部 61 行纳入生效面；snapshot_meta 仅现行枚举行（supersedes_id 非空）激活。
-- 计数守卫：预期 61 + 1，不符即整体回滚。
do $$
declare
  act uuid;
  n_reg int;
  n_snap int;
begin
  select id into strict act from mtpe_m0.inventory_activation;  -- 唯一行，多行/零行即报错终止

  update mtpe_m0.registry_entry set activation_id = act where activation_id is null;
  get diagnostics n_reg = row_count;

  update mtpe_m0.snapshot_meta set activation_id = act
   where supersedes_id is not null and activation_id is null;
  get diagnostics n_snap = row_count;

  if n_reg <> 61 or n_snap <> 1 then
    raise exception 'P-6 backfill unexpected counts: registry=% snapshot=%', n_reg, n_snap;
  end if;
end $$;