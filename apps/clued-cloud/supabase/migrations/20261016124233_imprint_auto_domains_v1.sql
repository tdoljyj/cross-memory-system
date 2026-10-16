-- New-content organization only. Existing Record identity, authority, lifecycle,
-- Currentness, source bodies and permission entry points remain unchanged.
-- BEGIN GENERATED IMPRINT PURPOSE RULES
create function clued_private.imprint_auto_rules_v1()
returns jsonb language sql immutable parallel safe set search_path='' as $rules$
  select $imprint_rules${"version":"imprint-explicit-local.v2","purposes":["^(?:保存用途|收藏用途|记录用途|用途)\\s*[:：]\\s*(.+)$","^我(?:保存|收藏|记下|留存)(?:这(?:份|篇|条|个|段)(?:资料|材料|文章|笔记|内容|教程|记录|链接|视频)?)?(?:是)?(?:为了|用于|用来)\\s*(.+)$","^(?:save purpose|purpose)\\s*:\\s*(.+)$","^I (?:save|saved|keep|kept) (?:this|these)(?: (?:material|materials|article|notes|note|reference|video|link))? (?:for|to support)\\s+(.+)$"],"domains":[{"domain":"daily","patterns":["^(?:我的)?(?:日常生活|家庭生活|家务安排|家庭开支|个人开支|家庭预算|个人预算|就医安排|搬家安排)(?:$|[^A-Za-z])","^(?:my )?(?:daily life|household planning|household budget|personal budget|family life|medical appointments|moving home)\\y"]},{"domain":"work","patterns":["^(?:我的)?工作(?:$|中|上的|职责|项目|汇报|会议|交付|准备|用途|使用|需要)","^(?:my )?(?:work|job duties|work meetings|work delivery)\\y"]},{"domain":"learning","patterns":["^(?:我的)?(?:学习|课程学习|课程复习|考试复习|备考)","^(?:my )?(?:learning|course study|course revision|exam preparation)\\y"]},{"domain":"creation","patterns":["^(?:我的)?(?:创作|小说写作|剧本写作|故事写作|艺术创作)","^(?:my )?(?:creative writing|artistic creation|creating (?:stories|art|fiction|a novel)|writing (?:fiction|a novel|a script))\\y"]},{"domain":"interest","patterns":["^(?:我的)?(?:兴趣爱好|兴趣探索|兴趣研究|业余爱好|爱好|休闲娱乐)","^(?:my )?(?:hobbies|hobby|leisure|personal interests)\\y"]}],"activities":[{"domain":"daily","patterns":["^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:安排|核对|记录|支付|整理|制定|更新)(?:家庭预算|家庭开支|个人预算|房租|水电费|家务|搬家|就医|体检|门诊)","^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:买菜|做饭|做家务|预约体检|预约门诊)(?:$|[^A-Za-z])","^(?:I am )?(?:planning|reviewing|paying|updating) (?:my |our |the )?(?:household budget|personal budget|rent|utility bills|medical appointment)\\y"]},{"domain":"work","patterns":["^(?:客户|公司|团队)(?:的)?\\s*(?:Logo|标志|品牌视觉|海报|插画|页面|界面)\\s*(?:设计(?:方案|稿件|稿)?|方案|稿件)(?:$|[：:，,、。.!?\\s])","^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:为|给)(?:客户|公司|团队)(?:设计|创作|绘制|制作|交付|提交|准备|整理|完成|修改)","^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:整理|撰写|提交|更新|准备|完成|修改)(?:本周|这周|下周)?(?:工作周报|工作汇报|客户提案|项目交付|工作会议纪要|工作计划)","^(?:client|customer) (?:logo|brand|poster|illustration) (?:design|proposal|concepts?)\\y","^(?:I am )?(?:designing|creating|preparing|delivering|revising) .+ for (?:a |the |my )?client\\y"]},{"domain":"learning","patterns":["^(?=我|今天|明天|本周|下周|正在|在|继续|准备)(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:学习(?!用品)|复习|备考|练习)\\s*\\S+","^(?:复习|备考)(?!资料(?:$|[：:])|用品)\\s*\\S+","^I am (?:studying|learning|revising|practicing)\\s+\\S"]},{"domain":"creation","patterns":["^(?:客户|公司|团队)(?:的)?\\s*(?:Logo|标志|品牌视觉|海报|插画|页面|界面)\\s*(?:设计(?:方案|稿件|稿)?|方案|稿件)(?:$|[：:，,、。.!?\\s])","^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:(?:为|给)(?:客户|公司|团队))?(?:设计|创作|绘制)\\s*(?:一(?:个|份|幅|套))?\\s*(?:品牌标志|Logo|海报|插画|界面|页面)","^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:撰写|写|续写|修改|创作)(?:小说|剧本|故事|游戏剧情|诗歌|歌词|散文)","^(?:client|customer) (?:logo|brand|poster|illustration) (?:design|proposal|concepts?)\\y","^(?:I am )?(?:designing|creating|drawing|writing|revising) (?:a |the |my )?(?:logo|illustration|poster|novel|script|story)\\y"]},{"domain":"interest","patterns":["^(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?(?:安排|记录|整理|计划)(?:周末徒步|业余摄影|兴趣活动|业余爱好|休闲活动|游戏游玩)","^(?:I am )?(?:planning|recording|organizing) (?:a |my |our )?(?:weekend hike|hobby photography|leisure activity)\\y"]}],"activity_context_block":"(?:考虑|想要|只是|不是|并非|不用于|不再)|\\y(?:not|never|no longer)\\y","activity_material_block":"(?:教程|教材|指南|案例|简介|介绍|是什么|如何)|\\y(?:tutorial|textbook|guide|example)\\y","uncertain":["(?:如果|假如|假设|除非|否则|不然|要是|若是|只要|一旦|示例|例子|举例|引用|转述|原文|文章说|建议|愿望|希望|也许|可能|是否|能否|不一定|只是讨论|尚未决定|还没决定|没有决定|不是(?:我的)?(?:承诺|决定|选择)|并非(?:我的)?(?:承诺|决定|选择))","\\y(?:if|unless|else|otherwise|when|once|provided|hypothetical|example|quotation|quoted|suggestion|wish|hope|maybe|might|whether|not necessarily|just discussing|not (?:my )?(?:commitment|decision))\\y","[?？]"],"reported":["(?:他|她|客户|朋友|同事|对方|文章|原文|资料)(?:今天|昨天|刚才)?(?:说|表示|写道|告诉我|承诺|决定|要求|请求)","\\y(?:he|she|they|the client|a friend|my colleague|the article)\\s+(?:said|says|wrote|writes|promised|asked|states)\\y"]}$imprint_rules$::jsonb
$rules$;
-- END GENERATED IMPRINT PURPOSE RULES

create function clued_private.imprint_auto_domains_v1(p_content text)
returns text[] language plpgsql immutable parallel safe set search_path='' as $$
declare rules jsonb:=clued_private.imprint_auto_rules_v1(); line text; segment text; piece text;
  pattern text; purpose text; captures text[]; rule jsonb; domains text[]:='{}';
  external_block boolean:=false; code_fence text; fence text; excluded boolean;
begin
  -- Abstain rather than truncate long sources or add latency to their write.
  if p_content is null or char_length(p_content)>65536 then return domains; end if;
  foreach line in array string_to_array(p_content,E'\n') loop
    fence:=substring(line from '^\s*(`{3,}|~{3,})');
    if fence is not null then
      if code_fence is null then code_fence:=fence;
      elsif left(fence,1)=left(code_fence,1) and length(fence)>=length(code_fence)
        and btrim(substr(btrim(line),length(fence)+1))='' then code_fence:=null;
      end if;
      continue;
    end if;
    if code_fence is not null or line ~ '`' then continue; end if;
    if btrim(line)='' then external_block:=false; continue; end if;
    if line ~* '^\s*(以下(是|为))?(客户(请求|要求|说|原话|邮件|消息)|对方(说|要求)|文章(说|内容)|原文|引用|转述|摘录|示例|例子|quoted text|client request|article says|example)\s*[:：]'
      then external_block:=true; end if;
    excluded:=external_block or line ~ '^\s*>';
    for pattern in select jsonb_array_elements_text(rules->'reported') loop
      if line ~* pattern then
        excluded:=true;
        if line ~ '[:：]\s*$' then external_block:=true; end if;
      end if;
    end loop;
    for pattern in select jsonb_array_elements_text(rules->'uncertain') loop
      excluded:=excluded or line ~* pattern;
    end loop;
    -- Automatic adoption is deliberately stricter than the optional suggestions:
    -- a quote anywhere in a line abstains, including unfinished multiline quotes.
    if line ~ '[“”‘’「」『』"'']' then return '{}'::text[]; end if;
    if excluded then continue; end if;
    foreach segment in array regexp_split_to_array(line,'[。！？.!?；;]') loop
      segment:=btrim(regexp_replace(segment,'^\s*([-*]\s+|[0-9]+[.)]\s+)?',''));
      for rule in select value from jsonb_array_elements(rules->'activities') loop
        if line ~* (rules->>'activity_context_block') then exit; end if;
        if rule->>'domain'<>'learning' and line ~* (rules->>'activity_material_block') then continue; end if;
        for pattern in select jsonb_array_elements_text(rule->'patterns') loop
          if segment ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
        end loop;
      end loop;
      purpose:=null;
      for pattern in select jsonb_array_elements_text(rules->'purposes') loop
        captures:=regexp_match(segment,pattern,'i');
        if captures is not null then purpose:=captures[1]; exit; end if;
      end loop;
      if purpose is null or purpose ~* '(不用|不用于|不为了|not for|not to)' then continue; end if;
      foreach piece in array regexp_split_to_array(purpose,'([、，,；;]|以及|并用于|也用于|同时用于|\s+and\s+|\s+also\s+)','i') loop
        piece:=regexp_replace(btrim(piece),'^(用于|为了|for)\s*','','i');
        for rule in select value from jsonb_array_elements(rules->'domains') loop
          for pattern in select jsonb_array_elements_text(rule->'patterns') loop
            if piece ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;
  return array(select distinct domain from unnest(domains) domain order by domain);
end $$;

alter table clued_private.imprint_organization_v1
  add column auto_rules_version text, add column auto_source_version bigint;
alter table clued_private.imprint_development_organization_v1
  alter column receipt_id drop not null,
  add column source_operation_id uuid references clued_private.development_operations_v14(id),
  add column auto_rules_version text, add column auto_source_version bigint,
  add constraint imprint_development_organization_provenance_v1 check (
    (receipt_id is not null and source_operation_id is null)
    or (receipt_id is null and source_operation_id is not null
      and auto_rules_version is not null and auto_source_version=1));

-- Existing Native organization RPCs keep their CAS/idempotency behavior. A new
-- manual Receipt replaces automatic provenance, including a manual empty set.
create function clued_private.imprint_auto_manual_override_v1()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.receipt_id is distinct from old.receipt_id then
    new.auto_rules_version:=null; new.auto_source_version:=null;
    if tg_table_name='imprint_development_organization_v1' then new.source_operation_id:=null; end if;
  end if;
  return new;
end $$;
create trigger imprint_organization_manual_override_v1 before update
  on clued_private.imprint_organization_v1 for each row execute function clued_private.imprint_auto_manual_override_v1();
create trigger imprint_development_manual_override_v1 before update
  on clued_private.imprint_development_organization_v1 for each row execute function clued_private.imprint_auto_manual_override_v1();

create function clued_private.imprint_auto_canonical_create_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare domains text[];
begin
  if new.record_schema_version is distinct from 1 or new.version is distinct from 1 or new.lifecycle_status is distinct from 'active'
    or new.receipt_id is null or new.authority='imported'
    or new.record_type not in ('note','state','task','decision') then return new; end if;
  if not exists(select 1 from public.clued_audit_receipts r
    where r.id=new.receipt_id and r.user_id=new.user_id
      and r.operation_family='record_mutation' and r.status='pending') then return new; end if;
  domains:=clued_private.imprint_auto_domains_v1(new.content);
  if cardinality(domains)>0 then
    insert into clued_private.imprint_organization_v1
      (user_id,record_id,domains,version,receipt_id,auto_rules_version,auto_source_version)
      values(new.user_id,new.id,domains,1,new.receipt_id,clued_private.imprint_auto_rules_v1()->>'version',new.version)
      on conflict(user_id,record_id) do nothing;
  end if;
  return new;
end $$;
create trigger imprint_auto_canonical_create_v1 after insert on public.clued_memories
  for each row execute function clued_private.imprint_auto_canonical_create_v1();

create function clued_private.imprint_auto_context_create_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare source clued_private.development_records_v14; space clued_private.development_spaces_v14;
  content text; domains text[];
begin
  if new.op<>'record_put' or new.actor_user_id is distinct from new.owner_id
    or old.result is distinct from '{}'::jsonb or new.result->>'status' is distinct from 'committed'
    or new.result->'result'->>'version' is distinct from '1'
    or new.result->>'operation_id' is distinct from new.id::text
    or new.result->>'receipt_id' is distinct from new.receipt_id::text then return new; end if;
  select * into source from clued_private.development_records_v14
    where id::text=new.result->'result'->>'id' and context_id=new.context_id
      and version=1 and revision_cursor=created_cursor and lifecycle_status='ACTIVE'
      and record_type in ('note','state','task','decision');
  if not found then return new; end if;
  if source.actor_binding_id::text is distinct from new.binding_ref
    or source.content_hash is distinct from new.result->'result'->>'content_hash'
    or source.content_hash is distinct from clued_private.development_hash_v14(source.body)
    or source.revision_cursor::text is distinct from new.result->'result'->>'revision_cursor'
    then return new; end if;
  select s.* into space from clued_private.development_spaces_v14 s
    join public.clued_projects p on p.id=s.project_id and p.user_id=new.owner_id
    where s.id=new.context_id and s.owner_id=new.owner_id;
  if not found then return new; end if;
  -- Explicit text fields only. Source/evidence/metadata/nested JSON are not
  -- instruction or purpose anchors. Preserve every original body byte.
  content:=case when jsonb_typeof(source.body->'content')='string' then source.body->>'content'
    when jsonb_typeof(source.body->'text')='string' then source.body->>'text' else null end;
  if source.body->>'source_kind'='external_material' then return new; end if;
  domains:=clued_private.imprint_auto_domains_v1(content);
  if cardinality(domains)>0 then
    insert into clued_private.imprint_development_organization_v1
      (user_id,context_id,record_id,domains,version,source_operation_id,auto_rules_version,auto_source_version)
      values(new.owner_id,source.context_id,source.id,domains,1,new.id,clued_private.imprint_auto_rules_v1()->>'version',1)
      on conflict(user_id,record_id) do nothing;
  end if;
  return new;
end $$;
create trigger imprint_auto_context_create_v1 after update of result
  on clued_private.development_operations_v14 for each row execute function clued_private.imprint_auto_context_create_v1();

revoke all on function clued_private.imprint_auto_rules_v1(),clued_private.imprint_auto_domains_v1(text),
  clued_private.imprint_auto_manual_override_v1(),clued_private.imprint_auto_canonical_create_v1(),
  clued_private.imprint_auto_context_create_v1() from public,anon,authenticated,service_role;
