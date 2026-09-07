import collections, hashlib, io, json, re, subprocess, zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

BASE=Path('C:/Users/Windows/Downloads')
OUT=Path('C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/step3-gap-supabase/downloads-auth-evidence')
EXCLUDE=['node_modules','.git','.next','memory','bundle','objects','.clued-backups','.venv','__pycache__']
args=['rg','--files','-uu',str(BASE)]
for name in EXCLUDE: args += ['-g',f'!**/{name}/**']
all_paths=subprocess.run(args,check=True,capture_output=True).stdout.decode('utf-8').splitlines()
files=[Path(p) for p in all_paths if re.search(r'clued|supabase|auth|cross-memory-system',p,re.I)]
allowed={'.md','.txt','.json','.toml','.yaml','.yml','.mjs','.js','.ts','.tsx','.py','.ps1','.log','.html','.sql','.sh'}
pattern=re.compile(r'site[_ ]url|redirect[_ ]urls?|uri_allow_list|additional_redirect_urls|config/auth|auth/url-configuration|emailRedirectTo|redirectTo|站点.{0,5}URL|重定向.{0,5}(?:URL|地址)|回调.{0,5}(?:URL|地址)',re.I)
hits=[];scanned=[];skipped=[];archives=[]
seen_archive_hashes=set()
def relevant_name(name):
    lower=name.lower().replace('\\','/')
    return not any('/'+x+'/' in '/'+lower for x in EXCLUDE) and not Path(name).name.startswith('.env') and not re.search(r'(credential|password|secret|token)[_.-]?(export|backup|store|dump)?\.(json|txt|log)$',Path(name).name,re.I)
def scan_bytes(data,label,original_path,member=None):
    encoding='utf-16' if data.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8-sig'
    if b'\x00' in data and encoding!='utf-16':
        skipped.append({'path':label,'reason':'binary_nul_no_utf16_bom'});return
    try: content=data.decode(encoding)
    except UnicodeDecodeError:
        skipped.append({'path':label,'reason':'not_supported_text_encoding'});return
    scanned.append(label)
    local=[]
    for number,line in enumerate(content.splitlines(),1):
        found=pattern.findall(line)
        if not found: continue
        # Save the configuration field and URL syntax only, never neighboring credentials.
        safe_urls=[]
        for match in re.findall(r'https?://[^\s<>"\'`]+',line):
            if '@' in match: continue
            safe_urls.append(match.split('?',1)[0].split('#',1)[0])
        local.append({'line':number,'matched_fields':sorted(set(found)),'urls_without_query_or_fragment':safe_urls,'production_project_ref_present':'ccxsikzwxlolxqlosril' in line,'clued_domain_present':'clued.pixelgrav.com' in line,'source_line_sha256':hashlib.sha256(line.encode()).hexdigest()})
    if local:
        hits.append({'source_path':str(original_path),'archive_member':member,'source_content_sha256':hashlib.sha256(data).hexdigest(),'source_content_bytes':len(data),'matches':local})
def scan_archive(handle,outer,chain='',depth=0):
    with zipfile.ZipFile(handle) as z:
        members=z.infolist()
        candidates=[m for m in members if not m.is_dir() and PurePosixPath(m.filename).suffix.lower() in allowed and relevant_name(m.filename) and m.file_size<=8*1024*1024]
        nested=[m for m in members if m.filename.lower().endswith('.zip')]
        archive_record={'path':str(outer),'archive_chain':chain,'members':len(members),'text_metadata_candidates':len(candidates),'nested_archives':[]}
        archives.append(archive_record)
        for m in candidates:
            name=(chain+'!' if chain else '')+m.filename
            scan_bytes(z.read(m),str(outer)+'!'+name,outer,name)
        for m in nested:
            record={'member':m.filename,'bytes':m.file_size}
            archive_record['nested_archives'].append(record)
            if depth>=5 or m.file_size>100*1024*1024:
                record['status']='not_read_depth_or_size_limit';continue
            data=z.read(m);digest=hashlib.sha256(data).hexdigest();record['sha256']=digest
            if digest in seen_archive_hashes:
                record['status']='same_hash_already_scanned';continue
            seen_archive_hashes.add(digest);record['status']='scanned_metadata'
            scan_archive(io.BytesIO(data),outer,(chain+'!' if chain else '')+m.filename,depth+1)
for p in files:
    if not relevant_name(str(p)): skipped.append({'path':str(p),'reason':'not_naming_metadata_or_sensitive_store_name'});continue
    if p.suffix.lower() in allowed:
        if p.stat().st_size>8*1024*1024: skipped.append({'path':str(p),'reason':'text_over_8MiB'});continue
        scan_bytes(p.read_bytes(),str(p),p)
    elif p.suffix.lower()=='.zip':
        scan_archive(p,p)
def filehash(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()
source_paths={r['source_path'] for r in hits}|{a['path'] for a in archives}
source_file_hashes={p:filehash(Path(p)) for p in source_paths}
index={'recorded_at_utc':datetime.now(timezone.utc).isoformat(),'scope':'Downloads recursively, Clued/Supabase/Auth/cross-memory-system path matching; naming metadata patterns only','excluded_directories':EXCLUDE,'no_ui_or_external_api':True,'all_relevant_path_count':len(files),'text_items_scanned':len(scanned),'hit_source_count':len(hits),'files':[{'path':str(p),'bytes':p.stat().st_size,'modified_at_utc':datetime.fromtimestamp(p.stat().st_mtime,timezone.utc).isoformat()} for p in files],'source_file_sha256':source_file_hashes,'archives':archives,'skipped':skipped,'hits':hits}
(OUT/'SearchIndex.json').write_text(json.dumps(index,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'relevant_paths':len(files),'text_items_scanned':len(scanned),'archives':len(archives),'hit_sources':len(hits),'skipped_count':len(skipped),'nested_dispositions':dict(collections.Counter(n['status'] for a in archives for n in a['nested_archives'])),'non_doc_hit_sources':[{'path':r['source_path'],'member':r['archive_member'],'matches':len(r['matches'])} for r in hits if not r['archive_member'] and Path(r['source_path']).suffix!='.md']}))
