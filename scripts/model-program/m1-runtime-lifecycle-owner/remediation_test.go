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
			p := filepath.Join(c.paths.evidence, "gated."+stream+".txt")
			f.blockedWrites = map[string]bool{p: true}
			w, e := c.startServer(ctx, slotRootFor(c.paths, revisionA), "fixture", "gated")
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
	b.limit = b.used + 4096
	b.reserve = 2048
	if e := b.consume(2049, true); e == nil {
		t.Fatal("capture overflow not latched")
	}
	if e := c.limits(ctx); e == nil {
		t.Fatal("business continued after overflow")
	}
	if e := c.writeEvidence(ctx, "forensic.json", object{"cause": "capture_overflow"}, false); e != nil {
		t.Fatal(e)
	}
	exists(t, filepath.Join(c.paths.evidence, "forensic.json"), true)
}
func TestRemediationFinalizationAggregatesListenerAndEvidenceFailure(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	f.portBlocked = true
	f.blockedWrites = map[string]bool{filepath.Join(c.paths.evidence, "M1RuntimeLifecycleTerminalFailure.json"): true}
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
	if e := c.writeEvidence(ctx, "expired-finalization.json", object{"expired": true}, false); e != nil {
		t.Fatal(e)
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
				if e := c.requireCurrentTransition(ctx, upgradeRecovery()); e != nil {
					t.Fatal(e)
				}
			case 3:
				if e := c.requireCurrentTransition(ctx, rollbackRecovery()); e != nil {
					t.Fatal(e)
				}
			}
			exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleTerminalFailure.json"), true)
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
