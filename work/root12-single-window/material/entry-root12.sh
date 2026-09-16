set -eu
PATH=/usr/bin:/bin
export PATH
REPO=/home/user/cross-memory-system
MAN="$REPO/scripts/phase2-qualification/control-context-verifier-root10-single-window/ControllerSourceManifest.candidate.json"
test "$(/usr/bin/sha256sum "$MAN" | /usr/bin/cut -d" " -f1)" = "${EXPECTED_CONTROLLER_SHA256}" || { echo ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT >&2; exit 1; }
test "$(/usr/bin/sha256sum /usr/bin/python3.11 | /usr/bin/cut -d" " -f1)" = "f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e" || { echo FIXED_PYTHON_BYTES_DRIFT >&2; exit 1; }
/usr/bin/python3.11 -I -S -B -c 'import json,hashlib,os,sys
man=sys.argv[1]; repo=sys.argv[2]
d=json.load(open(man))
files=d.get("files",[])
if d.get("object_type")!="ControllerSourceManifest" or d.get("qualification_issued") is not False or not isinstance(files,list) or not (1<=len(files)<=160):
    sys.exit("EXACT_SOURCE_MANIFEST_REQUIRED")
if any(not isinstance(e,dict) or set(e)!={"bytes","path","sha256"} or not isinstance(e["path"],str) or not isinstance(e["bytes"],int) or e["bytes"]<0 or not isinstance(e["sha256"],str) or len(e["sha256"])!=64 for e in files) or len({e["path"] for e in files})!=len(files):
    sys.exit("EXACT_SOURCE_MANIFEST_REQUIRED")
qual=os.path.dirname(os.path.dirname(man))
for root,dirs,_ in os.walk(qual):
    if "node_modules" in dirs: dirs.remove("node_modules")
    if "__pycache__" in dirs: sys.exit("CONTROLLER_BYTECODE_CACHE_PRESENT")
for e in d["files"]:
    q=e["path"] if os.path.isabs(e["path"]) else os.path.join(repo,e["path"])
    b=open(q,"rb").read()
    if len(b)!=e["bytes"] or hashlib.sha256(b).hexdigest()!=e["sha256"]:
        sys.exit("EXACT_CONTROLLER_SOURCE_BYTES_DRIFT")
host={"/usr/bin/sha256sum":("e484c36c0613879fbd11058f7a2e194783bced59d4805d64c3d4b0d7f664094d",39336),"/usr/bin/cut":("e48d15703786f49ae0e01003d72d335b6307769735bd36d93df2983d6b340122",39432),"/usr/bin/test":("da73061ae72b78c517da9c1ed85ae6cbaf1cc00102c6afdb342e6347effc48af",47552)}
for q,(h,n) in host.items():
    b=open(q,"rb").read()
    if len(b)!=n or hashlib.sha256(b).hexdigest()!=h: sys.exit("FIXED_SHELL_TOOL_BYTES_DRIFT")
rdp=os.path.join(os.path.dirname(man),"RuntimeDependencyManifest.json")
r=json.load(open(rdp))
if set(r)!={"object_type","schema_version","algorithm","resolver_base","entry_request","resolved_entry","packages","authority_effect"} or r["object_type"]!="RuntimeDependencyManifest" or r["schema_version"]!=1 or r["algorithm"]!="SORTED_PACKAGE_TREE_JSON_LF_SHA256_V1" or r["resolver_base"]!="apps/clued-cloud/package.json" or r["entry_request"]!="ajv" or r["authority_effect"]!="NONE": sys.exit("EXACT_RUNTIME_DEPENDENCY_MANIFEST")
requests=["ajv","fast-deep-equal","fast-json-stable-stringify","json-schema-traverse","uri-js"]
if not isinstance(r["packages"],list) or [x.get("request") for x in r["packages"]]!=requests: sys.exit("EXACT_RUNTIME_DEPENDENCY_PACKAGE_SET")
for x in r["packages"]:
    if set(x)!={"request","path","resolved_entry","files","bytes","tree_sha256"} or x["path"]!="apps/clued-cloud/node_modules/"+x["request"] or not x["resolved_entry"].startswith(x["path"]+"/"): sys.exit("EXACT_RUNTIME_DEPENDENCY_PACKAGE_DESCRIPTOR")
    root=os.path.join(repo,x["path"]); entries=[]
    for here,dirs,names in os.walk(root):
        dirs.sort(); names.sort()
        if any(os.path.islink(os.path.join(here,n)) for n in dirs+names): sys.exit("RUNTIME_DEPENDENCY_SYMLINK")
        for name in names:
            q=os.path.join(here,name); b=open(q,"rb").read(); rel=os.path.relpath(q,root).replace(os.sep,"/")
            entries.append({"path":rel,"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()})
    entries.sort(key=lambda e:e["path"])
    encoded=(json.dumps(entries,separators=(",",":"))+"\n").encode()
    if len(entries)!=x["files"] or sum(e["bytes"] for e in entries)!=x["bytes"] or hashlib.sha256(encoded).hexdigest()!=x["tree_sha256"]: sys.exit("RUNTIME_DEPENDENCY_PACKAGE_TREE_DRIFT:"+x["request"])
' "$MAN" "$REPO"
test "$(/usr/bin/sha256sum /opt/node22/bin/node | /usr/bin/cut -d" " -f1)" = "81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90" || { echo FIXED_NODE_BYTES_DRIFT >&2; exit 1; }
cd "$REPO"
NODE_OPTIONS= NODE_PATH= exec /opt/node22/bin/node scripts/phase2-qualification/control-context-verifier-root10-single-window/cli.mjs
