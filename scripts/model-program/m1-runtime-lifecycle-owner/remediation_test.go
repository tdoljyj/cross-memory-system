package main

import (
	"archive/zip"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These bytes are intentionally NOT a model, DLL, or executable. All process
// and HTTP interactions below remain in fakePlatform; production functions
// materialize, verify, publish, recover and clean up real test-owned files.
func tinyLifecycle(t *testing.T) (*controller, *executionContext, *fakePlatform) {
	t.Helper()
	l := testLayout(t)
	f := &fakePlatform{wd: t.TempDir()}
	c := newController(f, admission{}, l)
	t.Cleanup(func() { _ = c.closeFilesystem() })
	for _, p := range []string{l.sourceRoot, l.sourceRuntime, l.guardParent} {
		if e := os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	model := []byte("NOT A GGUF: lifecycle fixture only\n")
	server := []byte("NOT AN EXECUTABLE: simulated process only\n")
	dll := []byte("NOT A DLL: fixture data\n")
	for p, raw := range map[string][]byte{l.sourceModel: model, filepath.Join(l.sourceRuntime, "llama-server.exe"): server, filepath.Join(l.sourceRuntime, "fixture.dll"): dll} {
		if e := os.WriteFile(p, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	var archive bytes.Buffer
	z := zip.NewWriter(&archive)
	for _, row := range []struct {
		name string
		data []byte
	}{{"llama-server.exe", server}, {"fixture.dll", dll}} {
		w, e := z.Create(row.name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Write(row.data); e != nil {
			t.Fatal(e)
		}
	}
	if e := z.Close(); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(l.sourceAsset, archive.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	c.payload = payloadPolicy{int64(len(model)), int64(archive.Len()), int64(len(server)), sha(model), sha(archive.Bytes()), sha(server)}
	ctx := registeredContext(t, c)
	if e := c.createNewSynced(l.guard, []byte("fixture guard; no real authority"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := c.createOwnedDirs(ctx); e != nil {
		t.Fatal(e)
	}
	return c, ctx, f
}
func materialize(t *testing.T, c *controller, ctx *executionContext, revision string) {
	t.Helper()
	if _, e := c.materializeSlot(ctx, revision); e != nil {
		t.Fatal(e)
	}
}
func publish(t *testing.T, c *controller, ctx *executionContext, spec transitionSpec) {
	t.Helper()
	if _, e := c.publishCurrent(ctx, spec); e != nil {
		t.Fatal(e)
	}
}
func exists(t *testing.T, path string, want bool) {
	t.Helper()
	_, e := os.Lstat(path)
	if (e == nil) != want {
		t.Fatalf("exists(%s)=%v, want %v", path, e, want)
	}
}

func TestRemediationCanonicalIndependentJSONGolden(t *testing.T) {
	vectors := []any{
		object{"path": `C:\Users\Public\Clued\state\current.json`},
		object{"path": `payload\model\Qwen3.5-0.8B-Q8_0.gguf`},
		object{"control": "\x00\b\f\n\r\t\"\\", "unicode": "印记・続ける 😀"},
		object{"z": []any{object{"b": true, "a": nil}, json.Number("2")}, "a": "<>&"},
	}
	for i, v := range vectors {
		got := canonical(v)
		var standard bytes.Buffer
		enc := json.NewEncoder(&standard)
		enc.SetEscapeHTML(false)
		if e := enc.Encode(v); e != nil {
			t.Fatal(e)
		}
		want := bytes.TrimSuffix(standard.Bytes(), []byte("\n"))
		if !bytes.Equal(got, want) {
			t.Fatalf("vector %d: got %q; independent standard encoder %q", i, got, want)
		}
		if !json.Valid(got) {
			t.Fatalf("invalid JSON: %q", got)
		}
		var round any
		dec := json.NewDecoder(bytes.NewReader(got))
		dec.UseNumber()
		if e := dec.Decode(&round); e != nil {
			t.Fatal(e)
		}
	}
}
func TestRemediationMaterializeManifestRoundTrip(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	att, e := c.verifySlot(slotRootFor(c.paths, revisionA), ctx.deadline)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := c.readOwned(filepath.Join(slotRootFor(c.paths, revisionA), "manifest.json"))
	if e != nil {
		t.Fatal(e)
	}
	var m map[string]any
	if e = json.Unmarshal(raw, &m); e != nil {
		t.Fatal(e)
	}
	if att.manifestSHA != sha(raw) || m["model_relative_path"] != `payload\model\Qwen3.5-0.8B-Q8_0.gguf` {
		t.Fatal("manifest identity/roundtrip mismatch")
	}
}
func TestRemediationBothCaptureHandlesRejectBeforeLaunch(t *testing.T) {
	for _, stream := range []string{"stdout", "stderr"} {
		t.Run(stream, func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			materialize(t, c, ctx, revisionA)
			publish(t, c, ctx, successTransition(1))
			p := filepath.Join(c.paths.evidence, "install-a."+stream+".txt")
			f.blockedWrites = map[string]bool{p: true}
			w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "M1-08-PC-INSTALL-001", "install-a")
			if e == nil || w != nil || f.proc != nil || ctx.starts != 0 {
				t.Fatalf("write gate not before start: %v", e)
			}
			raw, readErr := os.ReadFile(p)
			if readErr != nil || len(raw) != 0 {
				t.Fatalf("failed capture received bytes: %q %v", raw, readErr)
			}
		})
	}
}
func TestRemediationFullLifecycleProductionFunctionsOnTinyFixture(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	if e := c.run(ctx); e != nil {
		t.Fatal(e)
	}
	if ctx.starts != 3 || f.proc == nil || f.proc.live {
		t.Fatalf("starts/cleanup: %d %#v", ctx.starts, f.proc)
	}
	exists(t, c.paths.testRoot, false)
	exists(t, c.paths.guard, true)
	exists(t, c.paths.evidence, true)
	raw, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleCloseout.json"))
	if e != nil {
		t.Fatal(e)
	}
	var m map[string]any
	if e = json.Unmarshal(raw, &m); e != nil || m["pass"] != true {
		t.Fatalf("closeout %s %v", raw, e)
	}
}
func TestRemediationPublicationAfterCommitFaultRoutesAllRecoveries(t *testing.T) {
	for index := 1; index <= 3; index++ {
		t.Run(strconvFormatInt(int64(index)), func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			materialize(t, c, ctx, revisionA)
			if index > 1 {
				publish(t, c, ctx, successTransition(1))
				materialize(t, c, ctx, revisionB)
			}
			if index > 2 {
				publish(t, c, ctx, successTransition(2))
			}
			f.publishFault = "after"
			_, e := c.publishCurrent(ctx, successTransition(index))
			var pe *publicationFailure
			if !errors.As(e, &pe) || pe.state != publicationCommitted {
				t.Fatalf("missing commit classification: %v", e)
			}
			if e = c.handlePublicationFailure(ctx, successTransition(index), e); e == nil {
				t.Fatal("recovery must terminal-fail")
			}
			switch index {
			case 1:
				exists(t, currentPath(c.paths), false)
			case 2:
				if e = c.requireCurrentTransition(ctx, upgradeRecovery()); e != nil {
					t.Fatal(e)
				}
			case 3:
				if e = c.requireCurrentTransition(ctx, rollbackRecovery()); e != nil {
					t.Fatal(e)
				}
			}
			exists(t, c.paths.testRoot, true)
			exists(t, c.paths.guard, true)
			if f.proc != nil {
				t.Fatal("recovery started a child")
			}
		})
	}
}
func TestRemediationPublicationEvidenceErrorIsCommittedFailure(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	materialize(t, c, ctx, revisionB)
	f.blockedWrites = map[string]bool{filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"): true}
	_, e := c.publishCurrent(ctx, successTransition(2))
	var pe *publicationFailure
	if !errors.As(e, &pe) || pe.state != publicationCommitted {
		t.Fatalf("expected post-commit event error: %v", e)
	}
	f.blockedWrites = nil
	if e = c.handlePublicationFailure(ctx, successTransition(2), e); e == nil {
		t.Fatal("expected terminal failure")
	}
	if e = c.requireCurrentTransition(ctx, upgradeRecovery()); e != nil {
		t.Fatal(e)
	}
}
func TestRemediationPreCommitFaultPreservesExactOldCurrent(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	materialize(t, c, ctx, revisionB)
	before := append([]byte(nil), c.currentBytes...)
	f.publishFault = "before"
	_, e := c.publishCurrent(ctx, successTransition(2))
	var pe *publicationFailure
	if !errors.As(e, &pe) || pe.state != publicationNotCommitted {
		t.Fatalf("expected not committed: %v", e)
	}
	if e = c.handlePublicationFailure(ctx, successTransition(2), e); e == nil {
		t.Fatal("expected terminal failure")
	}
	_, after, e := c.readCurrent()
	if e != nil || !bytes.Equal(before, after) {
		t.Fatalf("old changed: %v", e)
	}
	if e = c.requireCurrentTransition(ctx, successTransition(1)); e != nil {
		t.Fatal(e)
	}
}
func TestRemediationUnknownPublicationDoesNotInventRecoveryAuthority(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	e := c.handlePublicationFailure(ctx, successTransition(1), &publicationFailure{state: publicationUnknown, cause: fail("FIXTURE_UNCERTAIN"), expected: []byte(`{"other":true}`)})
	if e == nil {
		t.Fatal("uncertain state passed")
	}
	exists(t, currentPath(c.paths), false)
	exists(t, c.paths.testRoot, true)
}
func TestRemediationSuccessCleanupRequiresExactFinalTransition(t *testing.T) {
	mutations := []struct {
		name string
		v    any
	}{{"profile_id", "other"}, {"transition_index", json.Number("1")}, {"transition_kind", "RECOVERY"}, {"previous_active_revision_id", nil}, {"recovery_of_transition_index", json.Number("2")}, {"activated_at_utc", "not-time"}}
	for _, m := range mutations {
		t.Run(m.name, func(t *testing.T) {
			c, ctx, _ := tinyLifecycle(t)
			materialize(t, c, ctx, revisionA)
			publish(t, c, ctx, successTransition(1))
			materialize(t, c, ctx, revisionB)
			publish(t, c, ctx, successTransition(2))
			publish(t, c, ctx, successTransition(3))
			current, _, e := c.readCurrent()
			if e != nil {
				t.Fatal(e)
			}
			current[m.name] = m.v
			// Controlled fixture corruption, no race/foreign target. Same object written
			// by test harness; cleanup must reject before deleting any slot.
			if e = os.WriteFile(currentPath(c.paths), canonical(current), 0600); e != nil {
				t.Fatal(e)
			}
			if e = c.removeRuntimeRootSuccess(ctx); e == nil {
				t.Fatal("accepted bad final Current")
			}
			exists(t, slotRootFor(c.paths, revisionA), true)
			exists(t, slotRootFor(c.paths, revisionB), true)
		})
	}
}
func TestRemediationPartialCleanupRequiresCreationOwnershipAndNoAliases(t *testing.T) {
	for _, kind := range []string{"unknown", "ads", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			root := slotRootFor(c.paths, revisionA)
			if e := c.createDirExact(root); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(root, "manifest.json")
			if kind == "unknown" {
				if e := os.WriteFile(path, []byte("partial"), 0600); e != nil {
					t.Fatal(e)
				}
			} else {
				if e := c.createNewSynced(path, []byte("partial"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			if kind == "ads" {
				f.streams = map[string][]string{path: {"::$DATA", ":Zone.Identifier:$DATA"}}
			}
			if kind == "hardlink" {
				f.links = map[string]uint32{path: 2}
			}
			pre, e := c.attestSource(ctx.deadline)
			if e != nil {
				t.Fatal(e)
			}
			if e = c.removePartialSlotIfSafe(root, pre.specs); e == nil {
				t.Fatalf("unsafe %s removed", kind)
			}
			exists(t, path, true)
			exists(t, root, true)
			exists(t, c.paths.guard, true)
		})
	}
}
func TestRemediationSafeOwnedPartialCleanupUsesLedger(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	root := slotRootFor(c.paths, revisionA)
	if e := c.createDirExact(root); e != nil {
		t.Fatal(e)
	}
	if e := c.createNewSynced(filepath.Join(root, "manifest.json"), []byte("incomplete"), 0600); e != nil {
		t.Fatal(e)
	}
	pre, e := c.attestSource(ctx.deadline)
	if e != nil {
		t.Fatal(e)
	}
	if e = c.removePartialSlotIfSafe(root, pre.specs); e != nil {
		t.Fatal(e)
	}
	exists(t, root, false)
	exists(t, c.paths.guard, true)
	if e = c.removeOwned(c.paths.guard); e == nil {
		t.Fatal("guard deletion allowed")
	}
}
func TestRemediationEvidenceReserveSurvivesCaptureExhaustion(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	b := ctx.budget
	b.limit = b.used + 65536
	b.reserve = 32768
	if e := b.consume(32769, true); e == nil {
		t.Fatal("capture overflow not latched")
	}
	if e := c.limits(ctx); e == nil {
		t.Fatal("business continued after overflow")
	}
	if e := c.finalizeAttempt(ctx, fail("CAPTURE_OVERFLOW")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("forensic reserve unavailable: %v", e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), true)
}
func TestRemediationFinalizationAggregatesListenerAndEvidenceFailure(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	f.portBlocked = true
	f.blockedWrites = map[string]bool{filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"): true}
	e := c.finalizeAttempt(ctx, fail("ORIGINAL_FIXTURE_ERROR"))
	s := e.Error()
	for _, want := range []string{"ORIGINAL_FIXTURE_ERROR", "LISTENER_REMAINS", "TERMINAL_EVIDENCE_UNAVAILABLE"} {
		if !strings.Contains(s, want) {
			t.Fatalf("lost %s: %v", want, e)
		}
	}
	if f.proc != nil {
		t.Fatal("foreign listener created termination authority")
	}
	exists(t, c.paths.guard, true)
	exists(t, c.paths.testRoot, true)
}
func TestRemediationExpiryDeadlineAndContextBinding(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	now := time.Now().UTC()
	expiry := now.Add(time.Second)
	ctx.expires = expiry
	ctx.deadline = earlierDeadline(now.Add(maxWall), expiry)
	c.contexts[ctx].expires = expiry
	c.contexts[ctx].deadline = ctx.deadline
	c.now = func() time.Time { return expiry }
	if e := c.limits(ctx); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("expiry not bound: %v", e)
	}
	if _, e := c.materializeSlot(ctx, revisionA); e == nil {
		t.Fatal("write after expiry")
	}
	exists(t, slotRootFor(c.paths, revisionA), false)
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"expired": true}, false); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("normal evidence remained authorized after expiry: %v", e)
	}
	if e := c.writeTerminalEvidence(ctx, object{}); codeOf(e) != "TERMINAL_EVIDENCE_REQUIRES_FINALIZATION" {
		t.Fatalf("terminal helper minted authority: %v", e)
	}
	if e := c.finalizeAttempt(ctx, fail("EXPIRED_FIXTURE")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("safe expired finalization failed: %v", e)
	}
	ctx.expires = expiry.Add(time.Hour)
	if e := c.requireContext(ctx); e == nil {
		t.Fatal("expiry mutation accepted")
	}
}

type delayedFixtureReader struct {
	now    *time.Time
	expiry time.Time
	done   bool
}

func (r *delayedFixtureReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.done = true
	*r.now = r.expiry
	return copy(p, "late"), io.EOF
}
func TestRemediationEvidenceAllowlistAndExpiredNormalScenarioFailClosed(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.writeEvidence(ctx, "not-authorized.json", object{"x": true}, false); codeOf(e) != "EVIDENCE_OUTPUT_NOT_AUTHORIZED" {
		t.Fatalf("unauthorized evidence output accepted: %v", e)
	}
	expiry := time.Now().UTC()
	ctx.expires = expiry
	ctx.deadline = expiry
	c.contexts[ctx].expires = expiry
	c.contexts[ctx].deadline = expiry
	c.now = func() time.Time { return expiry }
	if e := c.recordScenario(ctx, "M1RuntimeLifecycleInstall.json", object{"revision_id": revisionA}); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("expired normal scenario write accepted: %v", e)
	}
	if e := c.event(ctx, "fixture", "normal_event", object{}); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("expired normal event accepted: %v", e)
	}
	if e := c.finalizeAttempt(ctx, fail("EXPIRED_FIXTURE")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("terminal safety evidence unavailable after expiry: %v", e)
	}
}

func TestRemediationFailureEvidenceCarriesRemainingOwnershipLedger(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.finalizeAttempt(ctx, fail("FIXTURE_FAILURE")); e == nil {
		t.Fatal("failure unexpectedly passed")
	}
	raw, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	var row map[string]any
	if e = json.Unmarshal(lines[len(lines)-1], &row); e != nil {
		t.Fatal(e)
	}
	remaining, ok := row["remaining_test_owned_state"].(map[string]any)
	if !ok || remaining["complete"] != true || len(remaining["objects"].([]any)) == 0 {
		t.Fatalf("missing exact remaining ownership ledger: %s", raw)
	}
}

func TestRemediationExpiryDuringReadPreventsSubsequentWrite(t *testing.T) {
	now := time.Now()
	expiry := now.Add(time.Second)
	var dst bytes.Buffer
	n, e := copyChecked(&dst, &delayedFixtureReader{now: &now, expiry: expiry}, func() error { return checkDeadline(now, expiry, expiry) })
	if e == nil || n != 0 || dst.Len() != 0 {
		t.Fatalf("late read wrote bytes: %d %q %v", n, dst.String(), e)
	}
}
func TestRemediationTinyPayloadCannotEnterProductionAdmission(t *testing.T) {
	c, _, _ := tinyLifecycle(t)
	if _, e := c.authorize(object{}); codeOf(e) != "NATIVE_REVIEWED_LAYOUT_OR_PAYLOAD_DRIFT" {
		t.Fatalf("test payload admitted: %v", e)
	}
}

func TestRemediationRunProbeFailureReachesTerminalRecovery(t *testing.T) {
	for index := 1; index <= 3; index++ {
		t.Run(strconvFormatInt(int64(index)), func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			f.completionFailsAt = index
			if e := c.run(ctx); e == nil {
				t.Fatal("failed probe passed")
			}
			if f.proc == nil || f.proc.live {
				t.Fatal("owned simulated process not terminated")
			}
			switch index {
			case 1:
				exists(t, currentPath(c.paths), false)
			case 2:
				m, raw, e := c.readCurrent()
				if e != nil || !transitionMatches(m, upgradeRecovery()) || !bytes.Equal(raw, c.currentBytes) {
					t.Fatalf("unexpected retained recovery state: %v", e)
				}
			case 3:
				m, raw, e := c.readCurrent()
				if e != nil || !transitionMatches(m, rollbackRecovery()) || !bytes.Equal(raw, c.currentBytes) {
					t.Fatalf("unexpected retained recovery state: %v", e)
				}
			}
			exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), true)
			exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleCloseout.json"), false)
			exists(t, c.paths.guard, true)
			exists(t, c.paths.testRoot, true)
		})
	}
}
func TestRemediationFinalizationPreservesWaitAndOriginalErrors(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	p := &fakeProcess{id: 7, live: false, waitErr: fail("FIXTURE_DRAIN_ERROR")}
	w := &ownedProcess{id: 7}
	c.processes[w] = &processRecord{ctx: ctx, proc: p}
	e := c.finalizeAttempt(ctx, fail("FIXTURE_ORIGINAL"))
	if e == nil || !strings.Contains(e.Error(), "FIXTURE_DRAIN_ERROR") || !strings.Contains(e.Error(), "FIXTURE_ORIGINAL") {
		t.Fatalf("lost error: %v", e)
	}
	if p.closes != 1 || !c.processes[w].closed {
		t.Fatal("exited process not closed after drain error")
	}
	second := c.finalizeAttempt(ctx, nil)
	if second == nil || second.Error() != e.Error() {
		t.Fatalf("idempotent finalization lost error: %v", second)
	}
}
func guardGateFixture(t *testing.T) (*controller, *fakePlatform, object) {
	t.Helper()
	l := testLayout(t)
	f := &fakePlatform{}
	c := newController(f, admission{}, l)
	t.Cleanup(func() { _ = c.closeFilesystem() })
	if e := os.Mkdir(l.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	id, e := f.directoryIdentity(l.guardParent)
	if e != nil {
		t.Fatal(e)
	}
	p := object{"trusted_execution_bindings": object{"guard_parent_provisioning_identity": object{
		"canonical_path": id.canonicalPath, "filesystem_type": id.filesystemType, "volume_serial": id.volumeSerial, "file_id": id.fileID,
		"owner_sid": id.ownerSID, "security_descriptor_sha256": id.securityDescriptorSHA256, "empty_parent": true, "non_reparse": true,
	}}}
	return c, f, p
}
func TestRemediationGuardFirstEffectRechecksExpiry(t *testing.T) {
	c, _, p := guardGateFixture(t)
	start := time.Now().UTC()
	end := start.Add(time.Second)
	c.now = func() time.Time { return end }
	ctx, e := c.claimGuard(p, start, end, end, machineSHA, []byte("test-only"))
	if ctx != nil || codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("expired claim: %v", e)
	}
	exists(t, c.paths.guard, false)
	exists(t, c.paths.testRoot, false)
	exists(t, c.paths.evidence, false)
}
func TestRemediationCreatedGuardValidationFailureConsumesAndReports(t *testing.T) {
	c, f, p := guardGateFixture(t)
	now := time.Now().UTC()
	end := now.Add(time.Minute)
	f.blockedWrites = map[string]bool{c.paths.guard: true}
	ctx, e := c.claimGuard(p, now, end, end, machineSHA, []byte("test-only"))
	var created *createdObjectFailure
	if ctx == nil || !errors.As(e, &created) || !ctx.consumed {
		t.Fatalf("lost successful CREATE_NEW: %v", e)
	}
	e = c.finalizeAttempt(ctx, e)
	if e == nil || !strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("missing explicit evidence failure: %v", e)
	}
	raw, readErr := os.ReadFile(c.paths.guard)
	if readErr != nil || len(raw) != 0 {
		t.Fatalf("guard was removed/written: %q %v", raw, readErr)
	}
	f.blockedWrites = nil
	if _, e = c.openOwnedWrite(c.paths.guard, true); e == nil {
		t.Fatal("consumed guard reused")
	}
	exists(t, c.paths.testRoot, false)
	exists(t, c.paths.evidence, false)
}

func TestRemediationCanonicalPythonGoldenVectors(t *testing.T) {
	raw, e := os.ReadFile("canonical-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	m, e := decodeObject(raw)
	if e != nil {
		t.Fatal(e)
	}
	rows, ok := m["vectors"].([]any)
	if !ok || len(rows) != 6 {
		t.Fatal("missing golden vectors")
	}
	for i, row := range rows {
		v := row.(object)
		got := hex.EncodeToString(canonical(v["input"]))
		if got != text(v, "canonical_utf8_hex") {
			t.Fatalf("Python/Go canonical bytes drift, vector %d", i)
		}
	}
}

// R3 regressions exercise only the existing non-model fixture platform. They
// neither execute the Owner nor act against real lifecycle/Guard namespaces.
func r3FailureEvent(t *testing.T, c *controller) object {
	t.Helper()
	raw, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	m, e := decodeObject(lines[len(lines)-1])
	if e != nil {
		t.Fatal(e)
	}
	if text(m, "scenario") != "FINALIZATION" || text(m, "kind") != "terminal_failure" || m["pass"] != false {
		t.Fatalf("not a failure event: %s", raw)
	}
	return m
}
func r3Expire(c *controller, ctx *executionContext) {
	now := time.Now().UTC()
	ctx.expires, ctx.deadline = now, now
	c.contexts[ctx].expires, c.contexts[ctx].deadline = now, now
	c.now = func() time.Time { return now }
}
func TestR3ExpiredLowerEvidenceGateIsFailClosed(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	r3Expire(c, ctx)
	if e := c.writeEvidenceBounded(ctx, "M1RuntimeLifecycleInstall.json", object{"pass": true}, false, false); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("lower gate: %v", e)
	}
	if e := c.writeTerminalEvidence(ctx, object{}); codeOf(e) != "TERMINAL_EVIDENCE_REQUIRES_FINALIZATION" {
		t.Fatalf("unscoped terminal gate: %v", e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleInstall.json"), false)
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), false)
}
func TestR3FailureFinalizationRevokesNormalAndTerminalReuse(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.finalizeAttempt(ctx, fail("FIRST_FAILURE")); e == nil {
		t.Fatal("failure lost")
	}
	path := filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl")
	before, _ := os.ReadFile(path)
	if e := c.event(ctx, "business", "after_finalization", object{}); codeOf(e) != "LIFECYCLE_AUTHORITY_TERMINATED" {
		t.Fatalf("normal resumed: %v", e)
	}
	if e := c.writeTerminalEvidence(ctx, object{}); codeOf(e) != "TERMINAL_EVIDENCE_AUTHORITY_CLOSED" {
		t.Fatalf("terminal reused: %v", e)
	}
	if e := c.finalizeAttempt(ctx, nil); e == nil || !strings.Contains(e.Error(), "FIRST_FAILURE") {
		t.Fatalf("failure not latched: %v", e)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("idempotent finalization wrote a second event")
	}
	if _, e := c.materializeSlot(ctx, revisionA); codeOf(e) != "LIFECYCLE_AUTHORITY_TERMINATED" {
		t.Fatalf("lifecycle resumed: %v", e)
	}
}
func TestR3SuccessFinalizationCannotStartSecondLifecycle(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.run(ctx); e != nil {
		t.Fatal(e)
	}
	if e := c.run(ctx); codeOf(e) != "LIFECYCLE_AUTHORITY_TERMINATED" {
		t.Fatalf("success context reused: %v", e)
	}
	exists(t, c.paths.testRoot, false)
	exists(t, c.paths.guard, true)
}
func TestR3ForensicsRecordsLiveIdentityDigestsAndCurrent(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	want := append([]byte(nil), c.currentBytes...)
	if e := c.finalizeAttempt(ctx, fail("FOR_FORENSICS")); e == nil || strings.Contains(e.Error(), "EXACT_REMAINING_STATE_UNAVAILABLE") {
		t.Fatalf("snapshot failure: %v", e)
	}
	m := r3FailureEvent(t, c)
	inv := get(m, "remaining_test_owned_state").(object)
	if inv["complete"] != true || text(inv, "observed_current/sha256") != sha(want) || get(inv, "observed_current/matches_last_committed_bytes") != true {
		t.Fatalf("inexact Current: %s", canonical(inv))
	}
	rows := get(inv, "objects").([]any)
	model := filepath.Join(slotRootFor(c.paths, revisionA), "payload", "model", "Qwen3.5-0.8B-Q8_0.gguf")
	found := false
	for _, raw := range rows {
		row := raw.(object)
		if samePath(text(row, "path"), model) {
			found = true
			if row["ownership_matches"] != true || text(row, "live_identity") != text(row, "creation_identity") || text(row, "sha256") != c.payload.modelSHA {
				t.Fatalf("model not exact: %s", canonical(row))
			}
		}
	}
	if !found {
		t.Fatal("remaining model omitted")
	}
	if text(inv, "objects_sha256") != digest(rows) {
		t.Fatal("object list digest mismatch")
	}
	exists(t, c.paths.guard, true)
	exists(t, c.paths.testRoot, true)
}
func TestR3ForensicsRejectsUnknownAndUnsafeStateWithoutDeleting(t *testing.T) {
	for _, kind := range []string{"unknown", "identity", "reparse", "ads", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			path := filepath.Join(c.paths.testRoot, "fixture.txt")
			data := []byte("non-model test fixture")
			if kind == "unknown" {
				if e := os.WriteFile(path, data, 0600); e != nil {
					t.Fatal(e)
				}
			} else {
				if e := c.createNewSynced(path, data, 0600); e != nil {
					t.Fatal(e)
				}
			}
			switch kind {
			case "identity":
				c.created[pathKey(path)] = "different-fixture-identity"
			case "reparse":
				f.reparse = map[string]bool{path: true}
			case "ads":
				f.streams = map[string][]string{path: {"::$DATA", ":unexpected:$DATA"}}
			case "hardlink":
				f.links = map[string]uint32{path: 2}
			}
			e := c.finalizeAttempt(ctx, fail("ORIGINAL"))
			if e == nil || !strings.Contains(e.Error(), "EXACT_REMAINING_STATE_UNAVAILABLE") || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
				t.Fatalf("unsafe state misreported: %v", e)
			}
			m := r3FailureEvent(t, c)
			if get(m, "remaining_test_owned_state/complete") != false {
				t.Fatal("incomplete state called exact")
			}
			after, e := os.ReadFile(path)
			if e != nil || !bytes.Equal(data, after) {
				t.Fatal("forensics changed foreign/unsafe state")
			}
			exists(t, c.paths.guard, true)
		})
	}
}
func TestR3EvidenceModeAndSignedCeiling(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{}, true); codeOf(e) != "EVIDENCE_OUTPUT_MODE_NOT_AUTHORIZED" {
		t.Fatalf("JSON append allowed: %v", e)
	}
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleEvents.jsonl", object{}, false); codeOf(e) != "EVIDENCE_OUTPUT_MODE_NOT_AUTHORIZED" {
		t.Fatalf("stream replace allowed: %v", e)
	}
	// A separately registered fixture context models a signed narrower list.
	ctx.profile["allowed_outputs"] = []any{"M1RuntimeLifecycleInstall.json"}
	ctx.profileDigest = digest(ctx.profile)
	c.contexts[ctx].profileDigest = ctx.profileDigest
	if e := c.event(ctx, "fixture", "not_in_signed_list", object{}); codeOf(e) != "EVIDENCE_OUTPUT_NOT_AUTHORIZED_BY_SIGNED_PROFILE" {
		t.Fatalf("signed scope widened: %v", e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), false)
}
func TestR3NormalEvidenceCannotSpendForensicReserve(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	ctx.budget.limit = ctx.budget.used + 65536
	ctx.budget.reserve = 32768
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"large": strings.Repeat("x", 33000)}, false); codeOf(e) != "OUTPUT_STORAGE_BUDGET_EXCEEDED" {
		t.Fatalf("reserve spent: %v", e)
	}
	if e := c.finalizeAttempt(ctx, fail("RESERVE_FIXTURE")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("reserve not available: %v", e)
	}
	if get(r3FailureEvent(t, c), "remaining_test_owned_state/complete") != true {
		t.Fatal("no exact final inventory")
	}
}

type r3LateEvidencePlatform struct {
	*fakePlatform
	latePath string
	advance  func()
}

func (f *r3LateEvidencePlatform) verifyWriteHandle(file *os.File, path string) error {
	if path == f.latePath {
		f.advance()
	}
	return f.fakePlatform.verifyWriteHandle(file, path)
}
func TestR3ExpiryDuringEvidenceHandleValidationWritesNoBytes(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	now := time.Now().UTC()
	expiry := now.Add(time.Second)
	ctx.expires, ctx.deadline = expiry, expiry
	c.contexts[ctx].expires, c.contexts[ctx].deadline = expiry, expiry
	c.now = func() time.Time { return now }
	path := filepath.Join(c.paths.evidence, "M1RuntimeLifecycleInstall.json")
	c.sys = &r3LateEvidencePlatform{fakePlatform: f, latePath: path, advance: func() { now = expiry }}
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"pass": true}, false); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("late handle accepted: %v", e)
	}
	raw, e := os.ReadFile(path)
	if e != nil || len(raw) != 0 {
		t.Fatalf("late business bytes written: %q %v", raw, e)
	}
}
func TestR3ExpiryCleanupKillsOnlyOwnedFixtureProcess(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	owned := &fakeProcess{id: 1, live: true}
	foreign := &fakeProcess{id: 2, live: true}
	c.processes[&ownedProcess{id: 1}] = &processRecord{ctx: ctx, proc: owned}
	c.processes[&ownedProcess{id: 2}] = &processRecord{ctx: &executionContext{}, proc: foreign}
	r3Expire(c, ctx)
	e := c.finalizeAttempt(ctx, fail("EXPIRY"))
	if e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatalf("cleanup/forensics: %v", e)
	}
	if owned.kills != 1 || owned.live || foreign.kills != 0 || !foreign.live {
		t.Fatal("process ownership changed")
	}
}

func TestR3TerminalStateLimitsEnvelopeReuseAndTime(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	now := time.Now().UTC()
	c.now = func() time.Time { return now }
	c.terminal[ctx] = &terminalEvidenceState{deadline: now.Add(time.Second)} // controlled fixture phase
	row := object{"profile_id": issuedID, "scenario": "FINALIZATION", "kind": "terminal_failure", "pass": false}
	if e := c.writeEvidenceBounded(ctx, "M1RuntimeLifecycleInstall.json", row, false, true); codeOf(e) != "TERMINAL_EVIDENCE_ENVELOPE_NOT_AUTHORIZED" {
		t.Fatalf("terminal output widened: %v", e)
	}
	if e := c.writeEvidenceBounded(ctx, "M1RuntimeLifecycleInstall.json", object{}, false, false); codeOf(e) != "LIFECYCLE_AUTHORITY_TERMINATED" {
		t.Fatalf("normal authority within terminal phase: %v", e)
	}
	if e := c.writeTerminalEvidence(ctx, row); e != nil {
		t.Fatal(e)
	}
	if e := c.writeTerminalEvidence(ctx, row); codeOf(e) != "TERMINAL_EVIDENCE_ALREADY_ATTEMPTED" {
		t.Fatalf("terminal reused: %v", e)
	}
	now = now.Add(time.Second)
	if _, e := c.requireTerminalEvidence(ctx); codeOf(e) != "TERMINAL_SAFETY_WINDOW_EXCEEDED" {
		t.Fatalf("unbounded safety window: %v", e)
	}
}
func TestR3ForensicsDistinguishesObservedAndCachedCurrent(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	actual := append([]byte(nil), c.currentBytes...)
	c.currentBytes = []byte("stale controller snapshot fixture")
	if e := c.finalizeAttempt(ctx, fail("STALE_CACHE")); e == nil {
		t.Fatal("failure lost")
	}
	inv := get(r3FailureEvent(t, c), "remaining_test_owned_state").(object)
	if text(inv, "observed_current/sha256") != sha(actual) || get(inv, "observed_current/matches_last_committed_bytes") != false {
		t.Fatalf("cached state presented as live: %s", canonical(inv))
	}
}

func TestR4CaptureRequiresSignedClassBeforeFileOrLaunchEffect(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	ctx.profile["allowed_outputs"] = []any{
		"M1RuntimeLifecyclePreflight.json", "M1RuntimeLifecycleEvents.jsonl", "M1RuntimeLifecycleInstall.json",
		"M1RuntimeLifecycleUpgrade.json", "M1RuntimeLifecycleRollback.json", "M1RuntimeLifecycleDigests.json",
		"M1RuntimeLifecycleCleanup.json", "M1RuntimeLifecycleCloseout.json", "M1RuntimeLifecycleAttemptGuard.snapshot.json",
	}
	ctx.profileDigest = digest(ctx.profile)
	c.contexts[ctx].profileDigest = ctx.profileDigest
	w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "M1-08-PC-INSTALL-001", "install-a")
	if codeOf(e) != "CAPTURE_OUTPUT_NOT_AUTHORIZED_BY_SIGNED_PROFILE" || w != nil || f.proc != nil || ctx.starts != 0 {
		t.Fatalf("signed capture ceiling not enforced before effect: w=%v proc=%v starts=%d err=%v", w, f.proc, ctx.starts, e)
	}
	exists(t, filepath.Join(c.paths.evidence, "install-a.stdout.txt"), false)
	exists(t, filepath.Join(c.paths.evidence, "install-a.stderr.txt"), false)
}

func TestR4CaptureRequiresExactCodePairBeforeFileOrLaunchEffect(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "M1-08-PC-INSTALL-001", "unreviewed-label")
	if codeOf(e) != "CAPTURE_OUTPUT_NOT_AUTHORIZED" || w != nil || f.proc != nil || ctx.starts != 0 {
		t.Fatalf("code capture ceiling not enforced before effect: w=%v proc=%v starts=%d err=%v", w, f.proc, ctx.starts, e)
	}
	exists(t, filepath.Join(c.paths.evidence, "unreviewed-label.stdout.txt"), false)
	exists(t, filepath.Join(c.paths.evidence, "unreviewed-label.stderr.txt"), false)
}

func TestR4ExpiredCaptureIsDrainedButNotPersisted(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	now := time.Now().UTC()
	expiry := now.Add(time.Second)
	ctx.expires, ctx.deadline = expiry, expiry
	c.contexts[ctx].expires, c.contexts[ctx].deadline = expiry, expiry
	c.now = func() time.Time { return now }
	w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "M1-08-PC-INSTALL-001", "install-a")
	if e != nil || w == nil || f.stdoutWriter == nil || f.proc == nil {
		t.Fatalf("fixture start: %v", e)
	}
	defer func() {
		f.proc.live = false
		_ = c.closeProcess(c.processes[w])
	}()
	if _, e = f.stdoutWriter.Write([]byte("BEFORE_EXPIRY\n")); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(c.paths.evidence, "install-a.stdout.txt")
	before, e := os.ReadFile(path)
	if e != nil || !bytes.Contains(before, []byte("BEFORE_EXPIRY")) {
		t.Fatalf("pre-expiry capture missing: %q %v", before, e)
	}
	now = expiry
	if e = c.limits(ctx); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatalf("fixture did not expire: %v", e)
	}
	if n, e := f.stdoutWriter.Write([]byte("AFTER_EXPIRY\n")); e != nil || n != len("AFTER_EXPIRY\n") {
		t.Fatalf("expired pipe not safely drained: n=%d err=%v", n, e)
	}
	after, e := os.ReadFile(path)
	if e != nil || !bytes.Equal(before, after) || bytes.Contains(after, []byte("AFTER_EXPIRY")) {
		t.Fatalf("post-expiry bytes persisted: before=%q after=%q err=%v", before, after, e)
	}
}

func TestR4FinalizationRevokesCaptureEvenWhenOwnedProcessCleanupFails(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "M1-08-PC-INSTALL-001", "install-a")
	if e != nil || w == nil || f.stdoutWriter == nil || f.proc == nil {
		t.Fatalf("fixture start: %v", e)
	}
	defer func() {
		f.proc.live = false
		_ = c.closeProcess(c.processes[w])
	}()
	if _, e = f.stdoutWriter.Write([]byte("BEFORE_FINALIZE\n")); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(c.paths.evidence, "install-a.stdout.txt")
	before, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	f.proc.killErr = fail("FIXTURE_KILL_FAILED")
	finalErr := c.finalizeAttempt(ctx, fail("FIXTURE_FAILURE"))
	if finalErr == nil || !strings.Contains(finalErr.Error(), "FIXTURE_KILL_FAILED") {
		t.Fatalf("cleanup failure not preserved: %v", finalErr)
	}
	if !f.proc.live || c.processes[w].closed {
		t.Fatal("fixture must retain live owned process/file to exercise revoked capture")
	}
	if n, e := f.stdoutWriter.Write([]byte("AFTER_FINALIZE\n")); e != nil || n != len("AFTER_FINALIZE\n") {
		t.Fatalf("revoked pipe not safely drained: n=%d err=%v", n, e)
	}
	after, e := os.ReadFile(path)
	if e != nil || !bytes.Equal(before, after) || bytes.Contains(after, []byte("AFTER_FINALIZE")) {
		t.Fatalf("post-finalization bytes persisted: before=%q after=%q err=%v", before, after, e)
	}
}
