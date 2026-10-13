// Explicit setup for regression tests exercising Owner confirmation, missing
// grants or exhausted start-rate buckets. Production and successor/default-On
// tests never install this fixture. It records an unmistakably test-only Off
// setting for existing users and users inserted later in this test database.

export async function enableManualOwnerApprovalFixture(client) {
  // Staged migration tests call this again after the successor is installed.
  if (!(await client.query(`select to_regclass('clued_private.owner_auto_approve_settings_v1') is not null as ready`))
    .rows[0].ready) return;
  await client.query(`
    create or replace function clued_private.test_manual_owner_approval_setup_v1(p_user_id uuid)
    returns void language plpgsql security definer set search_path='' as $$
    declare p clued_private.owner_auto_approve_settings_v1%rowtype;
      v_version integer; v_receipt uuid;
    begin
      perform clued_private.owner_grant_lock_v1(p_user_id);
      select * into p from clued_private.owner_auto_approve_settings_v1 where user_id=p_user_id for update;
      if p.user_id is not null and not p.enabled then return; end if;
      v_version:=coalesce(p.version,0)+1;
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(p_user_id,null,'global','test_manual_owner_approval_setup','owner_auto_approve',p_user_id::text,v_version,
        jsonb_build_object('receipt_kind','TEST_MANUAL_OWNER_APPROVAL_SETUP','principal','database_test_fixture',
          'enabled',false,'reason','explicit manual Owner approval regression fixture'))
      returning id into v_receipt;
      insert into clued_private.owner_auto_approve_settings_v1(user_id,enabled,version,auto_approve_id,receipt_id)
      values(p_user_id,false,v_version,null,v_receipt)
      on conflict(user_id) do update set enabled=false,version=excluded.version,
        auto_approve_id=null,receipt_id=excluded.receipt_id,updated_at=clock_timestamp();
    end $$;
    create or replace function clued_private.test_manual_owner_approval_insert_v1()
    returns trigger language plpgsql security definer set search_path='' as $$
    begin
      perform clued_private.test_manual_owner_approval_setup_v1(new.id);
      return null;
    end $$;
    drop trigger if exists test_manual_owner_approval_insert_v1 on auth.users;
    create trigger test_manual_owner_approval_insert_v1 after insert on auth.users
      for each row execute function clued_private.test_manual_owner_approval_insert_v1();
    revoke all on function clued_private.test_manual_owner_approval_setup_v1(uuid),
      clued_private.test_manual_owner_approval_insert_v1() from public,anon,authenticated,service_role;
    select clued_private.test_manual_owner_approval_setup_v1(id) from auth.users;
  `);
}
