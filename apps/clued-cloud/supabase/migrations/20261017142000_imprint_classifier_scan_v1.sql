-- Preserve the current rule catalog and every classification boundary. Cache
-- immutable rule arrays once per call instead of issuing SQL in every sentence
-- loop. Quote abstention may return before the line guards: both paths return
-- the same empty result for the whole source. No source is truncated.
create or replace function clued_private.imprint_auto_domains_v1(p_content text)
returns text[] language plpgsql immutable parallel safe set search_path='' as $$
declare rules jsonb:=clued_private.imprint_auto_rules_v1(); line text; segment text; piece text;
  pattern text; purpose text; captures text[]; rule jsonb; domains text[]:='{}';
  external_block boolean:=false; code_fence text; fence text; excluded boolean;
  reported_patterns text[]; uncertain_patterns text[]; purpose_patterns text[];
  activities jsonb[]; domain_rules jsonb[]; pattern_index integer;
  context_blocked boolean; material_blocked boolean;
begin
  if p_content is null or char_length(p_content)>65536 then return domains; end if;
  reported_patterns:=array(select jsonb_array_elements_text(rules->'reported'));
  uncertain_patterns:=array(select jsonb_array_elements_text(rules->'uncertain'));
  purpose_patterns:=array(select jsonb_array_elements_text(rules->'purposes'));
  activities:=array(select value from jsonb_array_elements(rules->'activities'));
  domain_rules:=array(select value from jsonb_array_elements(rules->'domains'));
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
    if line ~ '[“”‘’「」『』"'']' then return '{}'::text[]; end if;
    if line ~* '^\s*(以下(是|为))?(客户(请求|要求|说|原话|邮件|消息)|对方(说|要求)|文章(说|内容)|原文|引用|转述|摘录|示例|例子|quoted text|client request|article says|example)\s*[:：]'
      then external_block:=true; end if;
    excluded:=external_block or line ~ '^\s*>';
    foreach pattern in array reported_patterns loop
      if line ~* pattern then
        excluded:=true;
        if line ~ '[:：]\s*$' then external_block:=true; end if;
      end if;
    end loop;
    foreach pattern in array uncertain_patterns loop
      excluded:=excluded or line ~* pattern;
    end loop;
    if excluded then continue; end if;
    context_blocked:=line ~* (rules->>'activity_context_block');
    material_blocked:=line ~* (rules->>'activity_material_block');
    foreach segment in array regexp_split_to_array(line,'[。！？.!?；;]') loop
      segment:=btrim(regexp_replace(segment,'^\s*([-*]\s+|[0-9]+[.)]\s+)?',''));
      if segment='' then continue; end if;
      if context_blocked is not true then
        foreach rule in array activities loop
          if rule->>'domain'<>'learning' and material_blocked then continue; end if;
          for pattern_index in 0..jsonb_array_length(rule->'patterns')-1 loop
            pattern:=rule->'patterns'->>pattern_index;
            if segment ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
          end loop;
        end loop;
      end if;
      purpose:=null;
      foreach pattern in array purpose_patterns loop
        captures:=regexp_match(segment,pattern,'i');
        if captures is not null then purpose:=captures[1]; exit; end if;
      end loop;
      if purpose is null or purpose ~* '(不用|不用于|不为了|not for|not to)' then continue; end if;
      foreach piece in array regexp_split_to_array(purpose,'([、，,；;]|以及|并用于|也用于|同时用于|\s+and\s+|\s+also\s+)','i') loop
        piece:=regexp_replace(btrim(piece),'^(用于|为了|for)\s*','','i');
        foreach rule in array domain_rules loop
          for pattern_index in 0..jsonb_array_length(rule->'patterns')-1 loop
            pattern:=rule->'patterns'->>pattern_index;
            if piece ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;
  return array(select distinct domain from unnest(domains) domain order by domain);
end $$;
