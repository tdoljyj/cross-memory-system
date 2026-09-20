package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// All payloads are tiny inert byte strings; fakePlatform.start never invokes
// CreateProcess/exec. Windows file operations nevertheless use native handles.
func tinyFixture(t *testing.T) (*controller, *executionContext, *fakePlatform) {
	t.Helper()
	paths := testLayout(t)
	f := &fakePlatform{wd: filepath.Dir(paths.sourceRoot)}
	c := testController(t, f, admission{}, paths)
	if e := os.MkdirAll(paths.sourceRuntime, 0700); e != nil {
		t.Fatal(e)
	}
	model := []byte("INERT MODEL TEST DATA; NOT A MODEL")
	server := []byte("INERT EXECUTABLE TEST DATA; NOT EXECUTABLE")
	if e := os.WriteFile(paths.sourceModel, model, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(paths.sourceRuntime, "llama-server.exe"), server, 0600); e != nil {
		t.Fatal(e)
	}
	var z bytes.Buffer
	zw := zip.NewWriter(&z)
	w, e := zw.Create("llama-server.exe")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = w.Write(server); e != nil {
		t.Fatal(e)
	}
	if e = zw.Close(); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(paths.sourceAsset, z.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	c.payload = payloadIdentity{fileSpec{int64(len(model)), sha(model)}, fileSpec{int64(z.Len()), sha(z.Bytes())}, fileSpec{int64(len(server)), sha(server)}}
	if e = os.Mkdir(paths.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	if e = c.createNewSynced(paths.guard, []byte("TEST OWNED GUARD"), 0600); e != nil {
		t.Fatal(e)
	}
	ctx := registeredContext(t, c)
	if e = c.createOwnedDirs(ctx); e != nil {
		t.Fatal(e)
	}
	return c, ctx, f
}
func readySlots(t *testing.T) (*controller, *executionContext, *fakePlatform) {
	t.Helper()
	c, ctx, f := tinyFixture(t)
	for _, rev := range []string{revisionA, revisionB} {
		if _, e := c.materializeSlot(ctx, rev); e != nil {
			t.Fatal(e)
		}
	}
	return c, ctx, f
}
func TestM01CanonicalGoldenRoundTripAndTemporarySignature(t *testing.T) {
	raw, e := os.ReadFile("canonical-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	g, e := decodeObject(raw)
	if e != nil {
		t.Fatal(e)
	}
	got := canonical(g["value"])
	want := text(g, "expected_canonical_utf8")
	if string(got) != want {
		t.Fatalf("Python/Go canonical bytes differ:\ngot %s\nwant %s", got, want)
	}
	var decoded any
	d := json.NewDecoder(bytes.NewReader(got))
	d.UseNumber()
	if e = d.Decode(&decoded); e != nil {
		t.Fatal(e)
	}
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	sig := ed25519.Sign(key, []byte(want))
	if !ed25519.Verify(pub, got, sig) {
		t.Fatal("canonical temporary signature mismatch")
	}
}
func TestM01MaterializeThenVerifyOwnManifest(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	a, e := c.materializeSlot(ctx, revisionA)
	if e != nil {
		t.Fatal(e)
	}
	b, e := c.verifySlot(slotRootFor(c.paths, revisionA), ctx.deadline)
	if e != nil || a != b {
		t.Fatalf("roundtrip: %#v %#v %v", a, b, e)
	}
}
func TestM02BothOutputHandlesRejectBeforeChildStart(t *testing.T) {
	for _, suffix := range []string{".stdout.txt", ".stderr.txt"} {
		t.Run(suffix, func(t *testing.T) {
			c, ctx, f := tinyFixture(t)
			if _, e := c.materializeSlot(ctx, revisionA); e != nil {
				t.Fatal(e)
			}
			f.rejectWrite = suffix
			if _, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "TEST", "test"); codeOf(e) != "TEST_WRITE_HANDLE_REJECTED" {
				t.Fatalf("handle rejection: %v", e)
			}
			if f.startsCount != 0 {
				t.Fatal("process factory reached on invalid write handle")
			}
			st, e := os.Stat(filepath.Join(c.paths.evidence, "test"+suffix))
			if e != nil || st.Size() != 0 {
				t.Fatalf("must retain empty unverified creation: %v", e)
			}
		})
	}
}
func TestM03GuardFirstCreateNeverReusedOrRemoved(t *testing.T) {
	c, _, _ := tinyFixture(t)
	before, e := os.ReadFile(c.paths.guard)
	if e != nil {
		t.Fatal(e)
	}
	if e = c.createNewSynced(c.paths.guard, []byte("retry"), 0600); !os.IsExist(e) {
		t.Fatalf("guard reuse: %v", e)
	}
	if e = c.removeCreated(c.paths.guard); e == nil {
		t.Fatal("persistent guard deletion accepted")
	}
	after, _ := os.ReadFile(c.paths.guard)
	if !bytes.Equal(before, after) {
		t.Fatal("guard changed")
	}
}
func TestM03PartialCleanupRequiresCreationProvenance(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	root := slotRootFor(c.paths, revisionA)
	if e := c.createOwnedDirectory(root); e != nil {
		t.Fatal(e)
	}
	unknown := filepath.Join(root, "manifest.json")
	if e := os.WriteFile(unknown, []byte("not owner-created"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := c.removePartialSlotIfSafe(ctx, root, map[string]fileSpec{}); codeOf(e) != "EXACT_CREATED_OBJECT_REQUIRED" {
		t.Fatalf("unknown partial entry: %v", e)
	}
	if _, e := os.Stat(unknown); e != nil {
		t.Fatal("forensic object removed")
	}
	if ctx.starts != 0 {
		t.Fatal("unexpected start")
	}
}
func TestM03PartialCleanupRejectsNamedStreamAndHardlink(t *testing.T) {
	for _, what := range []string{"ads", "hardlink"} {
		t.Run(what, func(t *testing.T) {
			c, ctx, f := tinyFixture(t)
			root := slotRootFor(c.paths, revisionA)
			if e := c.createOwnedDirectory(root); e != nil {
				t.Fatal(e)
			}
			target := filepath.Join(root, "manifest.json")
			if e := c.createNewSynced(target, []byte("partial"), 0600); e != nil {
				t.Fatal(e)
			}
			if what == "ads" {
				f.streams = map[string][]string{target: {"::$DATA", ":Zone.Identifier:$DATA"}}
			} else {
				f.links = map[string]uint32{target: 2}
			}
			if e := c.removePartialSlotIfSafe(ctx, root, map[string]fileSpec{}); e == nil {
				t.Fatal("unsafe partial accepted")
			}
			if _, e := os.Stat(target); e != nil {
				t.Fatal("unsafe forensic entry deleted")
			}
		})
	}
}
func TestM04PreCommitFailureRetainsOldCurrent(t *testing.T) {
	c, ctx, f := readySlots(t)
	if _, e := c.publishCurrent(ctx, successTransition(1)); e != nil {
		t.Fatal(e)
	}
	old := append([]byte(nil), c.currentRaw...)
	f.beforeOpen = func(mode int, path string) error {
		if mode == fsDelete && strings.HasSuffix(path, "current.transition-2.tmp") {
			return fail("TEST_BEFORE_COMMIT")
		}
		return nil
	}
	_, e := c.publishCurrent(ctx, successTransition(2))
	var pe *publicationError
	if !errors.As(e, &pe) || pe.state != notCommitted {
		t.Fatalf("outcome: %v", e)
	}
	got, re := c.readBoundFile(currentPath(c.paths))
	if re != nil || !bytes.Equal(got, old) {
		t.Fatalf("old current lost: %v", re)
	}
}
func TestM05NativeCommitThenErrorRoutesAllRecoveries(t *testing.T) {
	for _, index := range []int{1, 2, 3} {
		t.Run(strconvFormatInt(int64(index)), func(t *testing.T) {
			c, ctx, f := tinyFixture(t)
			f.afterRename = func(src, dst string) error {
				if strings.HasSuffix(src, "current.transition-"+strconvFormatInt(int64(index))+".tmp") {
					f.afterRename = nil
					return fail("TEST_ERROR_AFTER_NATIVE_COMMIT")
				}
				return nil
			}
			e := c.run(ctx)
			if e == nil || !strings.Contains(e.Error(), "TEST_ERROR_AFTER_NATIVE_COMMIT") {
				t.Fatalf("terminal failure lost: %v", e)
			}
			if ctx.starts != index-1 {
				t.Fatalf("continued after failed activation: starts=%d", ctx.starts)
			}
			if index == 1 {
				if _, e = os.Stat(currentPath(c.paths)); !os.IsNotExist(e) {
					t.Fatalf("unverified initial current retained: %v", e)
				}
			} else {
				spec := upgradeRecovery()
				if index == 3 {
					spec = rollbackRecovery()
				}
				if e = c.requireCurrentExact(ctx, spec); e != nil {
					t.Fatalf("wrong recovery: %v", e)
				}
			}
			if _, e = os.Stat(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleFailure.json")); e != nil {
				t.Fatal(e)
			}
			if _, e = os.Stat(c.paths.guard); e != nil {
				t.Fatal("guard lost")
			}
		})
	}
}
func TestM05PostPublicationEvidenceAndVerifyErrorsRecover(t *testing.T) {
	for _, stage := range []string{"event", "verify"} {
		t.Run(stage, func(t *testing.T) {
			c, ctx, f := tinyFixture(t)
			hit := false
			f.beforeOpen = func(mode int, path string) error {
				if hit || c.currentSpec.index != 2 || c.currentSpec.kind != "NORMAL" {
					return nil
				}
				match := (stage == "event" && mode == fsAppend && strings.HasSuffix(path, "M1RuntimeLifecycleEvents.jsonl")) || (stage == "verify" && mode == fsRead && samePath(path, filepath.Join(slotRootFor(c.paths, revisionB), "manifest.json")))
				if match {
					hit = true
					return fail("TEST_POST_COMMIT_" + stage)
				}
				return nil
			}
			e := c.run(ctx)
			if !hit || e == nil {
				t.Fatalf("fault not reached: %v", e)
			}
			if e = c.requireCurrentExact(ctx, upgradeRecovery()); e != nil {
				t.Fatalf("no recovery after post-commit fault: %v", e)
			}
			if ctx.starts != 1 {
				t.Fatalf("unexpected lifecycle continuation: %d", ctx.starts)
			}
		})
	}
}
func TestM05ProbeFailuresRecoverAndStop(t *testing.T) {
	for _, index := range []int{1, 2, 3} {
		t.Run(strconvFormatInt(int64(index)), func(t *testing.T) {
			c, ctx, f := tinyFixture(t)
			f.probeFailureAt = index
			e := c.run(ctx)
			if e == nil {
				t.Fatal("bad probe accepted")
			}
			if ctx.starts != index {
				t.Fatalf("continued after failed probe: %d", ctx.starts)
			}
			if index == 1 {
				if _, e = os.Stat(currentPath(c.paths)); !os.IsNotExist(e) {
					t.Fatal("unverified initial current remains")
				}
			} else {
				spec := upgradeRecovery()
				if index == 3 {
					spec = rollbackRecovery()
				}
				if e = c.requireCurrentExact(ctx, spec); e != nil {
					t.Fatal(e)
				}
			}
			for _, r := range c.processes {
				if !r.closed {
					t.Fatal("process record not finalized")
				}
			}
		})
	}
}
func TestM06CleanupRejectsFinalTransitionFieldDrift(t *testing.T) {
	for _, field := range []string{"profile_id", "transition_index", "transition_kind", "previous_active_revision_id", "recovery_of_transition_index", "activated_at_utc"} {
		t.Run(field, func(t *testing.T) {
			c, ctx, _ := readySlots(t)
			for i := 1; i <= 3; i++ {
				if _, e := c.publishCurrent(ctx, successTransition(i)); e != nil {
					t.Fatal(e)
				}
			}
			m, _, e := c.readCurrent()
			if e != nil {
				t.Fatal(e)
			}
			m[field] = "DRIFT"
			if e = os.WriteFile(currentPath(c.paths), canonical(m), 0600); e != nil {
				t.Fatal(e)
			}
			if e = c.removeRuntimeRootSuccess(ctx); e == nil {
				t.Fatal("destructive success cleanup accepted drift")
			}
			if _, e = os.Stat(slotRootFor(c.paths, revisionB)); e != nil {
				t.Fatal("payload removed despite final-current drift")
			}
		})
	}
}
func TestM07ForensicReserveSurvivesCaptureBudgetFailure(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	ctx.budget.limit = 16384
	ctx.budget.reserve = 8192
	if e := ctx.budget.consume(8193, true); e == nil {
		t.Fatal("capture ceiling accepted")
	}
	if e := c.limits(ctx); e == nil {
		t.Fatal("business execution continued after budget failure")
	}
	e := c.finalizeFailure(ctx, fail("CAPTURE_STOPPED"))
	if e == nil {
		t.Fatal("failure lost")
	}
	if _, e = os.Stat(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleFailure.json")); e != nil {
		t.Fatal("reserved forensic output unavailable:", e)
	}
}
func TestM07FinalizerReportsPortAndEvidenceFailures(t *testing.T) {
	c, ctx, f := tinyFixture(t)
	f.portBusy = true
	f.rejectWrite = "M1RuntimeLifecycleFailure.json"
	e := c.finalizeFailure(ctx, fail("ORIGINAL_FAILURE"))
	for _, s := range []string{"ORIGINAL_FAILURE", "PORT_NOT_RELEASED", "failure evidence not persisted", "TEST_WRITE_HANDLE_REJECTED"} {
		if e == nil || !strings.Contains(e.Error(), s) {
			t.Fatalf("lost %q: %v", s, e)
		}
	}
}
func TestM08ExpiryClampsDeadlineAndStopsWrites(t *testing.T) {
	now := time.Now()
	expiry := now.Add(time.Second)
	if !executionDeadline(now, expiry).Equal(expiry) {
		t.Fatal("expiry not clamped")
	}
	if !executionDeadline(now, now.Add(2*maxWall)).Equal(now.Add(maxWall)) {
		t.Fatal("wall budget expanded")
	}
	c, ctx, f := tinyFixture(t)
	ctx.expires = expiry
	c.contexts[ctx].expires = expiry
	ctx.deadline = expiry
	c.contexts[ctx].deadline = expiry
	c.now = func() time.Time { return expiry }
	if _, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "expired", "expired"); e == nil {
		t.Fatal("expired start accepted")
	}
	if _, e := c.materializeSlot(ctx, revisionA); e == nil {
		t.Fatal("expired materialization accepted")
	}
	if f.startsCount != 0 {
		t.Fatal("expired child created")
	}
	r := &boundedDeadlineReader{reader: strings.NewReader("must not read"), now: c.now, deadline: expiry}
	b := make([]byte, 10)
	if n, e := r.Read(b); n != 0 || e == nil {
		t.Fatalf("expired copy read: %d %v", n, e)
	}
}
func TestM08GuardRechecksExpiryImmediatelyBeforeCreate(t *testing.T) {
	paths := testLayout(t)
	if e := os.Mkdir(paths.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	f := &fakePlatform{}
	c := testController(t, f, admission{}, paths)
	id, e := f.directoryIdentity(paths.guardParent)
	if e != nil {
		t.Fatal(e)
	}
	p := object{"trusted_execution_bindings": object{"guard_parent_provisioning_identity": guardIdentityObject(id)}}
	end := time.Now()
	c.now = func() time.Time { return end }
	if e = c.claimGuard(p, []byte("must not create"), end); e == nil {
		t.Fatal("expired guard created")
	}
	if _, e = os.Stat(paths.guard); !os.IsNotExist(e) {
		t.Fatalf("guard appeared: %v", e)
	}
}
func TestRemediatedFullLifecycleWithInertFixtures(t *testing.T) {
	c, ctx, f := tinyFixture(t)
	before, e := os.ReadFile(c.paths.sourceModel)
	if e != nil {
		t.Fatal(e)
	}
	if e = c.run(ctx); e != nil {
		t.Fatal(e)
	}
	if f.startsCount != 3 {
		t.Fatalf("start count: %d", f.startsCount)
	}
	if _, e = os.Stat(c.paths.testRoot); !os.IsNotExist(e) {
		t.Fatalf("test-root not removed: %v", e)
	}
	after, _ := os.ReadFile(c.paths.sourceModel)
	if !bytes.Equal(before, after) {
		t.Fatal("source modified")
	}
	raw, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleCloseout.json"))
	if e != nil {
		t.Fatal(e)
	}
	d, e := decodeObject(raw)
	if e != nil || d["pass"] != true {
		t.Fatalf("closeout: %v %s", e, raw)
	}
}

var _ io.Reader = (*boundedDeadlineReader)(nil)

// A liveness API error must neither abandon the owned handle nor disappear.
type transientQueryFailureProcess struct {
	fakeProcess
	queries int
}

func (p *transientQueryFailureProcess) alive() (bool, error) {
	p.queries++
	if p.queries == 1 {
		return false, fail("TEST_LIVENESS_QUERY_FAILURE")
	}
	return p.live, nil
}
func TestM07OwnedCleanupContinuesAfterLivenessQueryError(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	p := &transientQueryFailureProcess{fakeProcess: fakeProcess{id: 401, live: true}}
	w := &ownedProcess{id: 401, scenario: "TEST", label: "query-failure", startIndex: 1}
	c.processes[w] = &processRecord{ctx: ctx, proc: p}
	e := c.forceKill(ctx, w)
	if e == nil || !strings.Contains(e.Error(), "TEST_LIVENESS_QUERY_FAILURE") {
		t.Fatalf("lost original error: %v", e)
	}
	if p.kills != 1 || p.waits != 1 || p.closes != 1 || p.live {
		t.Fatalf("cleanup abandoned: %#v", p)
	}
}
func TestM08ExpiredPartialCleanupPreservesForensicState(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	root := slotRootFor(c.paths, revisionA)
	if e := c.createOwnedDirectory(root); e != nil {
		t.Fatal(e)
	}
	target := filepath.Join(root, "manifest.json")
	if e := c.createNewSynced(target, []byte("partial"), 0600); e != nil {
		t.Fatal(e)
	}
	c.now = func() time.Time { return ctx.deadline.Add(time.Second) }
	if e := c.removePartialSlotIfSafe(ctx, root, map[string]fileSpec{}); e == nil {
		t.Fatal("expired cleanup accepted")
	}
	if _, e := os.Stat(target); e != nil {
		t.Fatal("expired cleanup deleted forensic state")
	}
}
func TestM08ArchiveStreamRechecksDeadline(t *testing.T) {
	c, ctx, _ := tinyFixture(t)
	calls := 0
	c.now = func() time.Time {
		calls++
		if calls == 1 {
			return ctx.started
		}
		return ctx.deadline.Add(time.Second)
	}
	if _, _, e := c.zipSpecs(c.paths.sourceAsset, ctx.deadline); codeOf(e) != "MAX_WALL_TIME_EXCEEDED" {
		t.Fatalf("unbounded archive read: %v", e)
	}
}
func TestM06NextPublicationRejectsChangedRecordedCurrentBytes(t *testing.T) {
	c, ctx, _ := readySlots(t)
	if _, e := c.publishCurrent(ctx, successTransition(1)); e != nil {
		t.Fatal(e)
	}
	m, _, e := c.readCurrent()
	if e != nil {
		t.Fatal(e)
	}
	m["activated_at_utc"] = ctx.started.Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if e = os.WriteFile(currentPath(c.paths), canonical(m), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = c.publishCurrent(ctx, successTransition(2)); e == nil || !strings.Contains(e.Error(), "CURRENT_RECORDED_PUBLICATION_DRIFT") {
		t.Fatalf("drift accepted: %v", e)
	}
}
