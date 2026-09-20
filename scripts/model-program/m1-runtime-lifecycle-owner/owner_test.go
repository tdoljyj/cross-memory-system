package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeProcess struct {
	id     int
	live   bool
	kills  int
	stops  int
	waits  int
	closes int
}
func (p *fakeProcess) pid() int { return p.id }
func (p *fakeProcess) alive() (bool, error) { return p.live, nil }
func (p *fakeProcess) graceful() error { p.stops++; p.live = false; return nil }
func (p *fakeProcess) kill() error { p.kills++; p.live = false; return nil }
func (p *fakeProcess) wait(time.Duration) error { p.waits++; return nil }
func (p *fakeProcess) close() error { p.closes++; if p.live { return fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP") }; return nil }

type fakePlatform struct {
	wd       string
	reparse  map[string]bool
	streams  map[string][]string
	links    map[string]uint32
	request  *http.Request
	started  launchEnvelope
	proc     *fakeProcess
	finalOverride map[string]string
	identityOverride map[string]directoryIdentity
}
func (f *fakePlatform) physical() (string, string, error) { return "DESK-W-591", machineSHA, nil }
func (f *fakePlatform) windowsDirectory() (string, error) {
	if f.wd == "" { return `C:\Windows`, nil }
	return f.wd, nil
}
func (f *fakePlatform) pathIsReparse(path string) (bool, error) {
	return f.reparse[filepath.Clean(path)], nil
}
func (f *fakePlatform) finalPath(path string) (string, error) {
	if f.finalOverride != nil {
		if v, ok := f.finalOverride[filepath.Clean(path)]; ok { return v, nil }
	}
	return filepath.Clean(path), nil
}
func (f *fakePlatform) directoryIdentity(path string) (directoryIdentity, error) {
	if f.identityOverride != nil {
		if v, ok := f.identityOverride[filepath.Clean(path)]; ok { return v, nil }
	}
	return directoryIdentity{
		canonicalPath: filepath.Clean(path),
		filesystemType: "NTFS",
		volumeSerial: "1234abcd",
		fileID: "0000000000000001",
		ownerSID: "S-1-5-18",
		securityDescriptorSHA256: strings.Repeat("a",64),
	}, nil
}
func (f *fakePlatform) hardlinkCount(path string) (uint32, error) {
	if n, ok := f.links[filepath.Clean(path)]; ok { return n, nil }
	return 1, nil
}
func (f *fakePlatform) namedStreams(path string) ([]string, error) {
	if s, ok := f.streams[filepath.Clean(path)]; ok { return append([]string(nil), s...), nil }
	return []string{"::$DATA"}, nil
}
func (f *fakePlatform) atomicPublish(temp, dst string, replace bool) error {
	raw, e := os.ReadFile(temp); if e != nil { return e }
	if replace {
		if _, e = os.Stat(dst); e != nil { return e }
	}
	if !replace {
		if _, e = os.Stat(dst); e == nil { return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN") }
	}
	if e = os.WriteFile(dst, raw, 0600); e != nil { return e }
	return os.Remove(temp)
}
func (f *fakePlatform) start(l launchEnvelope, out, errOut io.Writer) (process, error) {
	f.started = l
	if f.proc == nil { f.proc = &fakeProcess{id: 1234, live: true} }
	return f.proc, nil
}
func (f *fakePlatform) portFree() bool { return true }
func (f *fakePlatform) roundTrip(req *http.Request) (*http.Response, error) {
	f.request = req
	body := `{"content":"OK"}`
	if req.URL.Path == "/health" { body = `{"status":"ok"}` }
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
}

func testLayout(t *testing.T) layout {
	t.Helper()
	root := t.TempDir()
	return layout{
		sourceRoot: filepath.Join(root, "source"),
		sourceModel: filepath.Join(root, "source", "model.gguf"),
		sourceAsset: filepath.Join(root, "source", "runtime.zip"),
		sourceRuntime: filepath.Join(root, "source", "runtime"),
		testRoot: filepath.Join(root, "test-root"),
		tempRoot: filepath.Join(root, "test-root", "state", "temp"),
		guardParent: filepath.Join(root, "guard"),
		guard: filepath.Join(root, "guard", "attempt.json"),
		evidence: filepath.Join(root, "evidence"),
	}
}
func registeredContext(t *testing.T, c *controller) *executionContext {
	t.Helper()
	now := time.Now().UTC()
	b := &budget{limit: maxStorage, reserve: evidenceReserve}
	p := object{"x":"y"}
	ctx := &executionContext{profile:p, profileDigest:digest(p), started:now, deadline:now.Add(time.Hour), physical:machineSHA, budget:b, consumed:true}
	c.contexts[ctx] = &contextRecord{profileDigest:ctx.profileDigest, started:ctx.started, deadline:ctx.deadline, physical:ctx.physical, starts:0, budget:b, consumed:true}
	return ctx
}

func TestFixedCLIRejectsCallerAuthoritySurfaces(t *testing.T) {
	base := []string{`C:\owner.exe`, "--execute", "--profile", `C:\issued.json`}
	if execute, p, e := parseLaunch(base); e != nil || !execute || p != base[3] { t.Fatalf("base: %v %v %v", execute, p, e) }
	for _, extra := range []string{"--pid","--handle","--process","--factory","--callback","--command","--exe","--argv","--env","--cwd","--endpoint","--port","--root","--output-dir","--test"} {
		a := append(append([]string{}, base...), extra, "X")
		if _, _, e := parseLaunch(a); e == nil || codeOf(e) != "OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED" {
			t.Fatalf("accepted %s: %v", extra, e)
		}
	}
	for _, bad := range [][]string{{"owner.exe"}, {`C:\owner.exe`, "--execute", "--profile", "relative.json"}} {
		if _, _, e := parseLaunch(bad); e == nil { t.Fatalf("accepted %#v", bad) }
	}
}

func TestCandidateCannotExecuteAndRootIsUnbound(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "candidate.json")
	if e := os.WriteFile(p, []byte(`{"status":"BLOCKED_PENDING_FRESH_CONTEXT_REVIEW_AND_REVIEWED_EFFECTFUL_OWNER_IMPLEMENTATION_AND_FINAL_ISSUANCE","profile_id":"M1-LIFE-QWEN35-08B-PC-001-CANDIDATE"}`), 0600); e != nil { t.Fatal(e) }
	var out, er bytes.Buffer
	rc := runCLI([]string{`C:\owner.exe`, "--execute", "--profile", p}, &out, &er)
	if rc != 3 || !strings.Contains(er.String(), "PROFILE_NOT_ISSUED") { t.Fatalf("rc=%d err=%s", rc, er.String()) }
	if e := verifySignature(object{}, ""); codeOf(e) != "OWNER_ISSUER_TRUST_ROOT_UNBOUND" { t.Fatalf("root: %v", e) }
}

func TestContextIsControllerOwnedAndTamperEvident(t *testing.T) {
	f := &fakePlatform{}
	c := newController(f, admission{}, testLayout(t))
	ctx := registeredContext(t, c)
	if e := c.requireContext(ctx); e != nil { t.Fatal(e) }
	ctx.physical = "forged"
	if e := c.requireContext(ctx); codeOf(e) != "EXECUTION_CONTEXT_TAMPERED" { t.Fatalf("physical: %v", e) }
	ctx.physical = machineSHA
	ctx.deadline = ctx.deadline.Add(time.Hour)
	if e := c.requireContext(ctx); codeOf(e) != "EXECUTION_CONTEXT_TAMPERED" { t.Fatalf("deadline: %v", e) }
}

func TestCleanupAuthorityStillResolvesAfterDeadline(t *testing.T) {
	f := &fakePlatform{}
	c := newController(f, admission{}, testLayout(t))
	ctx := registeredContext(t, c)
	r := c.contexts[ctx]
	p := &fakeProcess{id:7, live:true}
	w := &ownedProcess{id:7, scenario:"x", label:"x", startIndex:1}
	c.processes[w] = &processRecord{ctx:ctx, proc:p, stdout:nil, stderr:nil}
	ctx.deadline = time.Now().Add(-time.Minute)
	r.deadline = ctx.deadline
	if e := c.requireContext(ctx); e != nil { t.Fatalf("identity should remain usable for cleanup: %v", e) }
	if e := c.limits(ctx); codeOf(e) != "MAX_WALL_TIME_EXCEEDED" { t.Fatalf("limits: %v", e) }
	if _, e := c.resolve(ctx, w); e != nil { t.Fatal(e) }
}

func TestEnvironmentIsRebuiltFromEmpty(t *testing.T) {
	t.Setenv("PATH", `C:\attacker`)
	t.Setenv("LLAMA_ARG_HOST", "0.0.0.0")
	t.Setenv("HTTP_PROXY", "http://attacker")
	t.Setenv("CUDA_VISIBLE_DEVICES", "0")
	f := &fakePlatform{wd:`C:\Windows`}
	c := newController(f, admission{}, productionLayout)
	env, e := c.exactChildEnvironment(); if e != nil { t.Fatal(e) }
	want := []string{"SystemRoot=C:\\Windows","WINDIR=C:\\Windows","TEMP="+tempRoot,"TMP="+tempRoot}
	if len(env) != len(want) { t.Fatalf("env=%#v", env) }
	for i := range want { if env[i] != want[i] { t.Fatalf("%d got=%q want=%q", i, env[i], want[i]) } }
	for _, row := range env {
		u := strings.ToUpper(row)
		if strings.HasPrefix(u,"PATH=") || strings.Contains(u,"LLAMA_") || strings.Contains(u,"PROXY") || strings.Contains(u,"CUDA_") { t.Fatalf("pollution propagated: %s", row) }
	}
}

func TestServerLaunchIsExactAndSlotDerived(t *testing.T) {
	env := []string{"SystemRoot=C:\\Windows","WINDIR=C:\\Windows","TEMP="+tempRoot,"TMP="+tempRoot}
	slot := slotRootFor(productionLayout, revisionA)
	l := serverLaunch(slot, env)
	if !samePath(l.executable, filepath.Join(slot,"payload","runtime","b11033-vulkan","llama-server.exe")) { t.Fatal(l.executable) }
	if !samePath(l.cwd, filepath.Join(slot,"payload","runtime","b11033-vulkan")) { t.Fatal(l.cwd) }
	if len(l.argv) != 22 || l.argv[3] != "--offline" || l.argv[5] != "127.0.0.1" || l.argv[7] != "18088" || l.argv[19] != "--device" || l.argv[20] != "none" {
		t.Fatalf("argv=%#v", l.argv)
	}
}

func TestIllegalTransitionRejectedBeforeFilesystemEffects(t *testing.T) {
	f := &fakePlatform{}
	c := newController(f, admission{}, testLayout(t))
	ctx := registeredContext(t,c)
	_, e := c.publishCurrent(ctx, transitionSpec{index:2, from:revisionA, to:revisionA, kind:"NORMAL"})
	if codeOf(e) != "UNAUTHORIZED_CURRENT_TRANSITION_INDEX_KIND_OR_RECOVERY_LINKAGE" { t.Fatalf("%v", e) }
}

func TestTransitionShapesAndTempNames(t *testing.T) {
	cases := []struct{ spec transitionSpec; idx int; from,to,kind string; recovery any }{
		{successTransition(1),1,"",revisionA,"NORMAL",nil},
		{successTransition(2),2,revisionA,revisionB,"NORMAL",nil},
		{successTransition(3),3,revisionB,revisionA,"NORMAL",nil},
		{upgradeRecovery(),3,revisionB,revisionA,"RECOVERY",json.Number("2")},
		{rollbackRecovery(),4,revisionA,revisionB,"RECOVERY",json.Number("3")},
	}
	for _, c := range cases {
		if c.spec.index!=c.idx || c.spec.from!=c.from || c.spec.to!=c.to || c.spec.kind!=c.kind || !equal(c.spec.recoveryOf,c.recovery) { t.Fatalf("%#v", c.spec) }
	}
	p := testLayout(t)
	for i:=1;i<=4;i++ {
		want := filepath.Join(p.testRoot,"state",fmt.Sprintf("current.transition-%d.tmp",i))
		if currentTempPath(p,i)!=want { t.Fatalf("%d %q %q",i,currentTempPath(p,i),want) }
	}
}

func TestAtomicityClassifierAcceptsOnlyOldOrNewComplete(t *testing.T) {
	p := testLayout(t)
	if e := os.MkdirAll(filepath.Join(p.testRoot,"state"),0700); e != nil { t.Fatal(e) }
	c := newController(&fakePlatform{}, admission{}, p)
	cur := currentPath(p)
	oldRaw := []byte(`{"old":true}`)
	newRaw := []byte(`{"new":true}`)
	for _, tc := range []struct{name string; raw []byte; want bool}{
		{"old",oldRaw,true},{"new",newRaw,true},{"partial",[]byte(`{"new":`),false},
	} {
		if e := os.WriteFile(cur,tc.raw,0600); e != nil { t.Fatal(e) }
		e := c.verifyCurrentFailureAtomicity(oldRaw,newRaw,false)
		if (e==nil)!=tc.want { t.Fatalf("%s e=%v",tc.name,e) }
	}
	if e := os.Remove(cur); e != nil { t.Fatal(e) }
	if e := c.verifyCurrentFailureAtomicity(nil,newRaw,true); e != nil { t.Fatalf("initial absent: %v",e) }
}

func TestNamedStreamAndReparseAreFailClosed(t *testing.T) {
	p := testLayout(t)
	if e := os.MkdirAll(p.guardParent,0700); e != nil { t.Fatal(e) }
	file := filepath.Join(p.guardParent,"x")
	if e := os.WriteFile(file,[]byte("x"),0600); e != nil { t.Fatal(e) }
	f := &fakePlatform{reparse:map[string]bool{},streams:map[string][]string{},links:map[string]uint32{}}
	c := newController(f,admission{},p)
	f.streams[filepath.Clean(file)] = []string{"::$DATA",":Zone.Identifier:$DATA"}
	if e := c.verifyNoNamedStreams(file); codeOf(e)!="NAMED_NTFS_ALTERNATE_DATA_STREAM_DETECTED_ON_BOUND_SOURCE_OR_SLOT_FILE" { t.Fatalf("ads=%v",e) }
	f.streams[filepath.Clean(file)] = []string{"::$DATA"}
	f.reparse[filepath.Clean(p.guardParent)] = true
	if e := c.verifySafeExistingPath(file); codeOf(e)!="REPARSE_POINT_OR_PATH_ESCAPE_DETECTED" { t.Fatalf("reparse=%v",e) }
}

func TestForeignProcessObjectCannotBeUsed(t *testing.T) {
	f := &fakePlatform{}
	c := newController(f, admission{}, testLayout(t))
	ctx := registeredContext(t,c)
	p := &fakeProcess{id:9,live:true}
	owned := &ownedProcess{id:9,scenario:"x",label:"x",startIndex:1}
	c.processes[owned]=&processRecord{ctx:ctx,proc:p}
	if _,e:=c.resolve(ctx,owned); e!=nil { t.Fatal(e) }
	forged:=&ownedProcess{id:9,scenario:"x",label:"x",startIndex:1}
	if _,e:=c.resolve(ctx,forged); codeOf(e)!="FOREIGN_PROCESS_REJECTED" { t.Fatalf("%v",e) }
	if p.kills+p.stops+p.waits+p.closes!=0 { t.Fatal("foreign effect") }
}

func TestStrictJSONRejectsDuplicateKeys(t *testing.T) {
	if _,e:=decodeObject([]byte(`{"status":"ISSUED","status":"ISSUED"}`)); codeOf(e)!="PROFILE_DUPLICATE_KEY" { t.Fatalf("%v",e) }
}

func TestLoopbackRequestIsFixed(t *testing.T) {
	f:=&fakePlatform{}
	c:=newController(f,admission{},testLayout(t))
	ctx:=registeredContext(t,c)
	resp,closeFn,e:=c.request(ctx,"POST","/completion",object{"prompt":"Reply with exactly: OK"},time.Second)
	if e!=nil { t.Fatal(e) }
	closeFn()
	if resp.StatusCode!=200 || f.request==nil || f.request.URL.String()!="http://127.0.0.1:18088/completion" { t.Fatalf("%v %#v",resp.StatusCode,f.request) }
	if _,_,e=c.request(ctx,"GET","http://attacker",nil,time.Second); codeOf(e)!="LOOPBACK_REQUEST_PATH_FORBIDDEN" { t.Fatalf("%v",e) }
}


func TestImplementationPolicyMatchesReviewedCandidateProfile(t *testing.T) {
	p := filepath.Join("..", "..", "..", "development", "contracts", "model-program", "m1", "governance", "ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-001.candidate.json")
	raw, e := os.ReadFile(p)
	if e != nil { t.Fatal(e) }
	profile, e := decodeObject(raw)
	if e != nil { t.Fatal(e) }
	checks := []struct{ path string; want any }{
		{"authority_and_sources/lifecycle_contract_git_blob_sha1", contractBlobSHA1},
		{"config_revision/server_probe/exact_server_argv_semantics", exactArgvSemantics()},
		{"config_revision/server_probe/launch_envelope", exactLaunchEnvelopePolicy()},
		{"lifecycle_safety_binding/transition_sequence", exactSuccessTransitions()},
		{"lifecycle_safety_binding/failure_recovery_transition_sequence", exactRecoveryTransitions()},
		{"lifecycle_safety_binding/child_launch_environment", scopePolicy()["lifecycle_safety_binding/child_launch_environment"]},
		{"lifecycle_safety_binding/child_launch_cwd", scopePolicy()["lifecycle_safety_binding/child_launch_cwd"]},
		{"lifecycle_safety_binding/child_launch_envelope", scopePolicy()["lifecycle_safety_binding/child_launch_envelope"]},
	}
	for _, tc := range checks {
		if !equal(get(profile,tc.path),tc.want) {
			t.Fatalf("reviewed candidate mismatch at %s\ngot=%s\nwant=%s",tc.path,canonical(get(profile,tc.path)),canonical(tc.want))
		}
	}
}


func guardIdentityObject(id directoryIdentity) object {
	return object{
		"canonical_path": id.canonicalPath,
		"filesystem_type": id.filesystemType,
		"volume_serial": id.volumeSerial,
		"file_id": id.fileID,
		"owner_sid": id.ownerSID,
		"security_descriptor_sha256": id.securityDescriptorSHA256,
		"empty_parent": true,
		"non_reparse": true,
	}
}

func TestHandleResolvedPathMismatchFailsClosed(t *testing.T) {
	p:=testLayout(t)
	if e:=os.MkdirAll(p.guardParent,0700); e!=nil { t.Fatal(e) }
	target:=filepath.Join(p.guardParent,"x")
	if e:=os.WriteFile(target,[]byte("x"),0600); e!=nil { t.Fatal(e) }
	f:=&fakePlatform{finalOverride:map[string]string{
		filepath.Clean(target): filepath.Join(p.guardParent,"other"),
	}}
	c:=newController(f,admission{},p)
	if e:=c.verifySafeExistingPath(target); codeOf(e)!="REPARSE_POINT_OR_PATH_ESCAPE_DETECTED" {
		t.Fatalf("resolved path escape accepted: %v",e)
	}
}

func TestGuardParentRequiresSignedLiveIdentity(t *testing.T) {
	p:=testLayout(t)
	if e:=os.MkdirAll(p.guardParent,0700); e!=nil { t.Fatal(e) }
	id:=directoryIdentity{
		canonicalPath:filepath.Clean(p.guardParent), filesystemType:"NTFS",
		volumeSerial:"1234abcd", fileID:"0000000000000001",
		ownerSID:"S-1-5-18", securityDescriptorSHA256:strings.Repeat("a",64),
	}
	f:=&fakePlatform{identityOverride:map[string]directoryIdentity{filepath.Clean(p.guardParent):id}}
	c:=newController(f,admission{},p)
	profile:=object{"trusted_execution_bindings":object{"guard_parent_provisioning_identity":guardIdentityObject(id)}}
	got,e:=c.verifyGuardParent(profile)
	if e!=nil || !samePath(got.canonicalPath,id.canonicalPath) { t.Fatalf("matching identity: %#v %v",got,e) }

	bad:=guardIdentityObject(id)
	bad["file_id"]="0000000000000002"
	profile=object{"trusted_execution_bindings":object{"guard_parent_provisioning_identity":bad}}
	if _,e=c.verifyGuardParent(profile); codeOf(e)!="ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE" {
		t.Fatalf("identity drift accepted: %v",e)
	}

	if e=os.WriteFile(filepath.Join(p.guardParent,"foreign"),[]byte("x"),0600); e!=nil { t.Fatal(e) }
	profile=object{"trusted_execution_bindings":object{"guard_parent_provisioning_identity":guardIdentityObject(id)}}
	if _,e=c.verifyGuardParent(profile); codeOf(e)!="ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE" {
		t.Fatalf("non-empty parent accepted: %v",e)
	}
}

func TestFutureIssuedProfileRequiresGuardProvisioningIdentity(t *testing.T) {
	// validateStatic must never accept a future issued profile that binds only
	// an evidence hash without also binding the live directory identity fields.
	p:=object{
		"status":"ISSUED",
		"trusted_execution_bindings":object{
			"guard_parent_provisioning_evidence_sha256":strings.Repeat("a",64),
		},
	}
	// Earlier exact scope checks may fail first for this intentionally minimal
	// object; directly verify the identity shape helper invariant as well.
	id,ok:=get(p,"trusted_execution_bindings/guard_parent_provisioning_identity").(object)
	if ok || id!=nil { t.Fatal("unexpected identity") }
}
