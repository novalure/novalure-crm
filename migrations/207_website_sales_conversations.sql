-- Internal source-bound Sales dialogue only. No mail delivery, model or provider grant.
set local lock_timeout='5s';
set local statement_timeout='14min';

create unique index website_sales_conversation_workflow_contact_scope
 on crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id,contact_id);

create table crm_website_sales_conversations (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,contact_id uuid not null,
 version integer not null check(version>0),status text not null check(status in('OPEN','WAITING_FOR_FACTS','DRAFT_READY','WAITING_FOR_CUSTOMER','STOPPED','HUMAN_REVIEW_REQUIRED')),
 stop_reason text,last_command_id uuid not null,created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,workflow_id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,contact_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id,contact_id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,last_command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((status='STOPPED')=(stop_reason is not null))
);

create table crm_website_sales_topic_permissions (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 source_user_id uuid not null,message_id uuid not null,source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 purpose text not null default 'SALES_TOPIC_EXTRACTION' check(purpose='SALES_TOPIC_EXTRACTION'),version integer not null check(version>0),
 authorized_by uuid not null,created_at timestamptz not null default now(),expires_at timestamptz not null,
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),unique(workspace_id,workflow_id,message_id,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,source_user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),
 foreign key(workspace_id,authorized_by) references workspace_users(workspace_id,id),
 check(source_user_id=authorized_by),check(expires_at>created_at and expires_at<=created_at+interval '24 hours')
);
create index website_sales_topic_permission_current on crm_website_sales_topic_permissions(workspace_id,workflow_id,message_id,version desc);
create table crm_website_sales_topic_revocations (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 permission_id uuid not null,revoked_by uuid not null,created_at timestamptz not null default now(),unique(workspace_id,permission_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,permission_id) references crm_website_sales_topic_permissions(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,revoked_by) references workspace_users(workspace_id,id)
);

create table crm_website_sales_answer_facts (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 version integer not null check(version>0),topic_code text not null check(topic_code in('SERVICES','SCOPE','PRICE','DISCOUNT','TIMING','PROCESS','PROOF','PRIVACY','OBJECTION_PRICE','OBJECTION_TIMING','OBJECTION_NEED','MEETING','ACCEPTANCE','LEGAL_OR_CONTRACT','GENERAL','UNKNOWN','OPT_OUT','OUT_OF_OFFICE')),
 fact jsonb not null check(jsonb_typeof(fact)='object' and octet_length(fact::text)<=16000),
 source_digest text not null check(source_digest ~ '^[a-f0-9]{64}$'),evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 approved_by uuid not null,created_at timestamptz not null default now(),valid_until timestamptz not null,
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),unique(workspace_id,workflow_id,topic_code,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,approved_by) references workspace_users(workspace_id,id),
 check(fact ?& array['id','identity','version','topicCode','kind','text','sourceReference','sourceDigest','observedAt','validUntil','approvedBy','approvedAt','classification']),
 check(jsonb_typeof(fact->'identity')='object' and (fact->'identity') ?& array['workspaceId','projectId','companyId','locationId']),
 check(valid_until>created_at),check(fact->>'id'=id::text and (fact->>'version')::integer=version and fact->>'topicCode'=topic_code and fact->>'sourceDigest'=source_digest),
 check(fact->'identity'->>'workspaceId'=workspace_id::text and fact->'identity'->>'projectId'=project_id::text and fact->'identity'->>'companyId'=company_id::text and fact->'identity'->>'locationId'=location_id::text and fact->>'approvedBy'=approved_by::text),
 check(fact->>'classification' in('PUBLIC_BUSINESS','APPROVED_SALES'))
);
create index website_sales_answer_facts_current on crm_website_sales_answer_facts(workspace_id,workflow_id,topic_code,version desc);

create table crm_website_sales_conversation_turns (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,conversation_id uuid not null,
 turn_index integer not null check(turn_index>0),kind text not null check(kind in('TOPIC_RECORDED','ANSWER_DRAFTED','CLARIFICATION_REQUIRED','STOP_RECORDED')),
 topic_turn_id uuid,topic_code text not null check(topic_code in('SERVICES','SCOPE','PRICE','DISCOUNT','TIMING','PROCESS','PROOF','PRIVACY','OBJECTION_PRICE','OBJECTION_TIMING','OBJECTION_NEED','MEETING','ACCEPTANCE','LEGAL_OR_CONTRACT','GENERAL','UNKNOWN','OPT_OUT','OUT_OF_OFFICE')),language text not null check(language in('de','en')),
 source_kind text not null check(source_kind in('CANONICAL_TOPIC_EXTRACTION','HUMAN_RECORDED_TOPIC')),
 source_user_id uuid,message_id uuid,source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),facts_digest text check(facts_digest ~ '^[a-f0-9]{64}$'),
 draft jsonb check(draft is null or jsonb_typeof(draft)='object' and octet_length(draft::text)<=32000),
 created_by uuid not null,command_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,conversation_id,turn_index),unique(workspace_id,conversation_id,command_id,kind),
 unique(workspace_id,project_id,company_id,location_id,workflow_id,conversation_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,conversation_id) references crm_website_sales_conversations(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,conversation_id,topic_turn_id) references crm_website_sales_conversation_turns(workspace_id,project_id,company_id,location_id,workflow_id,conversation_id,id),
 foreign key(workspace_id,source_user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((source_user_id is null)=(message_id is null)),check(source_kind<>'CANONICAL_TOPIC_EXTRACTION' or message_id is not null),
 check(kind not in('ANSWER_DRAFTED','CLARIFICATION_REQUIRED') or topic_turn_id is not null and draft is not null and facts_digest is not null)
);
create unique index website_sales_conversation_source_dedupe on crm_website_sales_conversation_turns(workspace_id,workflow_id,message_id,source_hash,kind)
 where message_id is not null and kind='TOPIC_RECORDED';
create unique index website_sales_conversation_answer_dedupe on crm_website_sales_conversation_turns(workspace_id,workflow_id,message_id,source_hash,kind,facts_digest,evidence_digest,((draft->>'workflowVersion')))
 where message_id is not null and kind in('ANSWER_DRAFTED','CLARIFICATION_REQUIRED');

create function crm_website_sales_conversation_update_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.id<>old.id or new.workspace_id<>old.workspace_id or new.project_id<>old.project_id or new.company_id<>old.company_id
 or new.location_id<>old.location_id or new.workflow_id<>old.workflow_id or new.contact_id<>old.contact_id or new.created_by<>old.created_by
 or new.created_at<>old.created_at or new.version<>old.version+1 or old.status='STOPPED' and(new.status<>'STOPPED' or old.stop_reason='OPT_OUT' and new.stop_reason<>'OPT_OUT')
 then raise exception using errcode='23514',message='Conversation identity and hard stop are immutable; version must advance';end if;
 return new;
end $$;
revoke all on function crm_website_sales_conversation_update_guard() from public;
create trigger website_sales_conversation_identity before update on crm_website_sales_conversations for each row execute function crm_website_sales_conversation_update_guard();
create trigger website_sales_conversation_no_delete before delete or truncate on crm_website_sales_conversations for each statement execute function crm_reject_immutable_mutation();

do $$ declare relation text;begin
 foreach relation in array array['crm_website_sales_conversations','crm_website_sales_topic_permissions','crm_website_sales_topic_revocations','crm_website_sales_answer_facts','crm_website_sales_conversation_turns'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy website_sales_conversation_scope on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);execute format('grant select,insert on %I to novalure_tenant_app',relation);
  if relation<>'crm_website_sales_conversations' then execute format('create trigger website_sales_conversation_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);end if;
 end loop;
end $$;
grant update on crm_website_sales_conversations to novalure_tenant_app;
create policy website_sales_topic_permission_owner on crm_website_sales_topic_permissions as restrictive for insert to novalure_tenant_app
 with check(source_user_id=nullif(current_setting('app.actor_id',true),'')::uuid and authorized_by=source_user_id);
create policy website_sales_topic_revoke_owner on crm_website_sales_topic_revocations as restrictive for insert to novalure_tenant_app
 with check(revoked_by=nullif(current_setting('app.actor_id',true),'')::uuid and exists(select 1 from crm_website_sales_topic_permissions p
  where p.workspace_id=crm_website_sales_topic_revocations.workspace_id and p.id=crm_website_sales_topic_revocations.permission_id and p.source_user_id=nullif(current_setting('app.actor_id',true),'')::uuid));
create policy website_sales_answer_fact_owner on crm_website_sales_answer_facts as restrictive for insert to novalure_tenant_app
 with check(approved_by=nullif(current_setting('app.actor_id',true),'')::uuid and exists(select 1 from workspace_users u where u.workspace_id=crm_website_sales_answer_facts.workspace_id and u.id=approved_by and u.status='active' and u.role in('owner','admin')));
create policy website_sales_conversation_created_actor on crm_website_sales_conversations as restrictive for insert to novalure_tenant_app
 with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy website_sales_conversation_turn_actor on crm_website_sales_conversation_turns as restrictive for insert to novalure_tenant_app
 with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid);

-- The function owner gets only the same tenant/project projection as 205, never a runtime body grant.
do $$ declare relation text;begin
 foreach relation in array array['crm_website_sales_topic_permissions','crm_website_sales_topic_revocations'] loop
  execute format('create policy sales_topic_projection_owner on %I for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_project_access(workspace_id,project_id,false))',relation,current_user);
 end loop;
 execute format('create policy sales_topic_consent_owner on consent_records for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_project_access(workspace_id,project_id,false))',current_user);
 execute format('create policy sales_topic_project_owner on projects for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_project_access(workspace_id,id,false))',current_user);
end $$;

-- Closed extractor. Its rules mirror website-sales-conversation.ts and have a shared PG corpus.
-- This pure helper reads no table and is not an application entrypoint.
create function crm_website_sales_extract_topic(p_text text,p_language text)
 returns table(topic_code text,language text,basis text,blocked_reason text)
 language plpgsql immutable set search_path=pg_catalog,public as $$
declare original_line text;trimmed text;candidate text:='';
 whitespace text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' '||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
begin
 if p_language not in('de','en') or p_language is null then raise exception using errcode='22023',message='Supported Sales language required';end if;
 language:=p_language;topic_code:='UNKNOWN';basis:='UNCLASSIFIED';blocked_reason:='CONTENT_LIMIT';
 if p_text is null or length(p_text)>16000 or length(p_text)+(select count(*) from regexp_split_to_table(p_text,'') ch where ascii(ch)>65535)>16000 then return next;return;end if;
 for original_line in select regexp_split_to_table(replace(replace(normalize(p_text,NFKC),E'\r\n',E'\n'),E'\r',E'\n'),E'\n') loop
  trimmed:=btrim(original_line,whitespace);
  if lower(translate(trimmed,'ÄÖÜẞÉ','äöüßé')) ~ '^(on .+wrote:|am .+schrieb.*:|le .+[ée]crit.*:|from:|von:|-{2,}[ ]*(original|forwarded|weitergeleitete))' then exit;end if;
  if left(trimmed,1)<>'>' then candidate:=candidate||' '||trimmed;end if;
 end loop;
 candidate:=lower(translate(regexp_replace(replace(candidate,'’',''''),'['||whitespace||']+',' ','g'),'ÄÖÜẞÉ','äöüßé'));
 blocked_reason:=null;basis:='BOUNDED_RULES';
 if candidate ~ '(unsubscribe|opt[ -]?out|remove me|do not contact|stop emailing|abmelden|keine (weiteren )?(mails|emails|nachrichten)|nicht mehr kontaktieren|widerspreche)' then topic_code:='OPT_OUT';
 elsif candidate ~ '(ignore|override|bypass).{0,80}(previous|system|developer|instruction|rule|approval|policy)|system[ ]*prompt|developer[ ]*message|-----begin.{0,30}private key|postgres(ql)?://|sk-[a-z0-9_-]{16,}|bearer[ ]+[a-z0-9._-]{16,}' then basis:='UNCLASSIFIED';blocked_reason:='UNTRUSTED_INSTRUCTION';
 elsif candidate ~ '(out of office|automatic reply|on leave|abwesenheitsnotiz|nicht im b[üu]ro)' then topic_code:='OUT_OF_OFFICE';
 elsif candidate ~ '(contract|vertrag|signature|legal advice|lawyer|rechtsberatung|haftung)' then topic_code:='LEGAL_OR_CONTRACT';
 elsif candidate ~ '(too (expensive|costly)|price (is )?too high|zu teuer|preis.{0,30}zu hoch)' then topic_code:='OBJECTION_PRICE';
 elsif candidate ~ '(no time|not now|kein[e]? zeit|derzeit nicht|sp[äa]ter)' then topic_code:='OBJECTION_TIMING';
 elsif candidate ~ '(already have|no need|don.t need|kein(en)? bedarf|haben (bereits|schon)|nicht einverstanden|(ich nehme|wir nehmen).{0,60}nicht an|(i|we) (do not|don.t) (accept|agree)|not agreed)' then topic_code:='OBJECTION_NEED';
 elsif candidate ~ '(i accept|we accept|agreed|ich nehme (ihr|das|dieses) (angebot|konzept).{0,40} an|wir nehmen (ihr|das|dieses) (angebot|konzept).{0,40} an|einverstanden)' then topic_code:='ACCEPTANCE';
 elsif candidate ~ '(discount|rabatt|cheaper|g[üu]nstiger|budget)' then topic_code:='DISCOUNT';
 elsif candidate ~ '(price|pricing|cost|quote|preis|kosten|angebot)' then topic_code:='PRICE';
 elsif candidate ~ '(privacy|personal data|data protection|datenschutz|personenbezogen)' then topic_code:='PRIVACY';
 elsif candidate ~ '(reference|example|portfolio|case study|referenz|beispiel)' then topic_code:='PROOF';
 elsif candidate ~ '(when|timeline|deadline|how long|wann|dauer|lieferzeit|terminplan)' then topic_code:='TIMING';
 elsif candidate ~ '(meeting|appointment|call|gespr[äa]ch|besprechung|termin)' then topic_code:='MEETING';
 elsif candidate ~ '(included|include|scope|feature|umfang|enthalten|leistung)' then topic_code:='SCOPE';
 elsif candidate ~ '(process|next step|how does|ablauf|n[äa]chste[rs]? schritt|wie funktioniert)' then topic_code:='PROCESS';
 elsif candidate ~ '(service|website|webseite|webdesign|what do you|was bieten)' then topic_code:='SERVICES';
 else basis:='UNCLASSIFIED';blocked_reason:='NO_SUPPORTED_TOPIC';end if;
 return next;
end $$;
revoke all on function crm_website_sales_extract_topic(text,text) from public;

create function crm_website_sales_topic_source(p_workspace uuid,p_project uuid,p_workflow uuid,p_message uuid default null,p_language text default 'en')
 returns table(message_id uuid,source_user_id uuid,received_at timestamptz,source_hash text,topic_code text,language text,basis text,blocked_reason text,authorized boolean,can_authorize boolean)
 language plpgsql security definer set search_path=pg_catalog,public as $$
declare target public.crm_website_sales_workflows%rowtype;source_row record;permission_row record;body text;extracted record;hard_stopped boolean;
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
 or crm_lock_project_access(p_workspace,p_project,false) is not true or crm_classification_allowed(p_workspace,'NOVALURE_INTERNAL','crm_sales') is not true
 or not exists(select 1 from public.projects p where p.workspace_id=p_workspace and p.id=p_project and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales')
 then raise exception using errcode='42501',message='Sales topic scope denied';end if;
 if p_language not in('de','en') or p_language is null then raise exception using errcode='22023',message='Supported Sales language required';end if;
 select * into target from public.crm_website_sales_workflows w where w.workspace_id=p_workspace and w.project_id=p_project and w.id=p_workflow;
 if not found or target.contact_id is null then return;end if;
 select exists(select 1 from public.contacts c where c.workspace_id=p_workspace and c.id=target.contact_id and c.consent_label='Abgemeldet')
  or exists(select 1 from public.consent_records c where c.workspace_id=p_workspace and c.project_id=p_project and c.contact_id=target.contact_id and c.status='Abgemeldet')
  or exists(select 1 from public.crm_website_sales_workflows w where w.workspace_id=p_workspace and w.project_id=p_project and w.contact_id=target.contact_id and w.status='STOPPED' and w.stop_reason in('OPT_OUT','UNKNOWN_DELIVERY')) into hard_stopped;
 for source_row in
  select distinct m.id,m.user_id,m.received_at,m.revision,m.content_hash,m.body_truncated,
   encode(sha256(convert_to(m.id::text||':'||m.revision::text||':'||m.content_hash,'UTF8')),'hex') as hash
  from public.crm_mailbox_messages m join public.crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id
  join public.contacts c on c.workspace_id=l.workspace_id and c.id=l.contact_id and c.project_id=l.project_id
  where m.workspace_id=p_workspace and l.project_id=p_project and l.contact_id=target.contact_id and l.lead_id=target.lead_id
   and l.confirmed_reply and m.deleted_at is null and m.received_at>=target.created_at and c.archived_at is null and c.organization_id=target.company_id
   and lower(trim(m.from_address))=lower(trim(c.email)) and(p_message is null or m.id=p_message)
  order by m.received_at desc,m.id desc limit 25
 loop
  -- Also acquired by insert/revoke guards: a committed revocation cannot race a body read.
  perform pg_advisory_xact_lock(hashtextextended('sales-topic:'||p_workspace::text||':'||p_workflow::text||':'||source_row.id::text,0));
  select p.id,p.source_hash,p.expires_at into permission_row from public.crm_website_sales_topic_permissions p
   where p.workspace_id=p_workspace and p.project_id=p_project and p.company_id=target.company_id and p.location_id=target.location_id and p.workflow_id=p_workflow
    and p.source_user_id=source_row.user_id and p.message_id=source_row.id order by p.version desc limit 1;
  message_id:=source_row.id;source_user_id:=source_row.user_id;received_at:=source_row.received_at;source_hash:=source_row.hash;
  language:=p_language;topic_code:='UNKNOWN';basis:='UNCLASSIFIED';blocked_reason:='PURPOSE_PERMISSION_REQUIRED';
  can_authorize:=source_row.user_id=nullif(current_setting('app.actor_id',true),'')::uuid;
  authorized:=permission_row.id is not null and permission_row.source_hash=source_row.hash and permission_row.expires_at>clock_timestamp()
   and not exists(select 1 from public.crm_website_sales_topic_revocations r where r.workspace_id=p_workspace and r.permission_id=permission_row.id);
  if authorized and hard_stopped then blocked_reason:='CONTACT_STOPPED';
  elsif authorized then
   -- No private body is read until exact live owner-purpose permission has been established.
   select m.body_text into body from public.crm_mailbox_messages m where m.workspace_id=p_workspace and m.id=source_row.id and m.user_id=source_row.user_id
    and m.revision=source_row.revision and m.content_hash=source_row.content_hash and m.deleted_at is null;
   if not found then authorized:=false;blocked_reason:='SOURCE_CHANGED';
   else
    select * into extracted from public.crm_website_sales_extract_topic(case when source_row.body_truncated then null else body end,p_language);
    topic_code:=extracted.topic_code;language:=extracted.language;basis:=extracted.basis;blocked_reason:=extracted.blocked_reason;
   end if;
  end if;
  return next;
 end loop;
end $$;
revoke all on function crm_website_sales_topic_source(uuid,uuid,uuid,uuid,text) from public;
grant execute on function crm_website_sales_topic_source(uuid,uuid,uuid,uuid,text) to novalure_tenant_app;

create function crm_website_sales_topic_permission_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare source record;permission public.crm_website_sales_topic_permissions%rowtype;
begin
 if tg_table_name='crm_website_sales_topic_permissions' then
  select * into source from public.crm_website_sales_topic_source(new.workspace_id,new.project_id,new.workflow_id,new.message_id,'en');
  if not found or not source.can_authorize or source.source_user_id<>new.source_user_id or source.source_hash<>new.source_hash
  then raise exception using errcode='42501',message='Current personal source and exact topic-purpose scope required';end if;
 else
  select * into permission from public.crm_website_sales_topic_permissions p where p.workspace_id=new.workspace_id and p.id=new.permission_id;
  if not found or permission.source_user_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
  then raise exception using errcode='42501',message='Personal source owner required';end if;
  perform pg_advisory_xact_lock(hashtextextended('sales-topic:'||permission.workspace_id::text||':'||permission.workflow_id::text||':'||permission.message_id::text,0));
 end if;
 return new;
end $$;
revoke all on function crm_website_sales_topic_permission_guard() from public;
create trigger website_sales_topic_permission_source before insert on crm_website_sales_topic_permissions for each row execute function crm_website_sales_topic_permission_guard();
create trigger website_sales_topic_revocation_source before insert on crm_website_sales_topic_revocations for each row execute function crm_website_sales_topic_permission_guard();
