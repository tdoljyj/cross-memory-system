package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Test-only inspection does not revive an expired/finalized execution context.
func verifyClosedFixtureCurrent(c *controller, spec transitionSpec) error {
	m, raw, e := c.readCurrent()
	if e != nil {
		return e
	}
	if !bytes.Equal(raw, c.currentBytes) {
		return fail("CURRENT_COMMITTED_SNAPSHOT_DRIFT")
	}
	return c.verifyCurrentObject(m, spec, time.Now().Add(time.Minute))
}
func terminalRow(t *testing.T, c *controller) object {
	t.Helper()
	raw, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	row, e := decodeObject(lines[len(lines)-1])
	if e != nil {
		t.Fatal(e)
	}
	if row["kind"] != "terminal_failure" || row["scenario"] != "FINALIZATION" || row["pass"] != false {
		t.Fatalf("not a terminal failure: %s", raw)
	}
	return row
}
func expireFixture(c *controller, ctx *executionContext) {
	end := time.Now().UTC()
	ctx.expires = end
	ctx.deadline = end
	c.contexts[ctx].expires = end
	c.contexts[ctx].deadline = end
	c.now = func() time.Time { return end }
}
func TestTerminalEvidenceAllowlistAndAppendMode(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	for _, v := range []struct {
		name   string
		append bool
	}{{"not-authorized.json", false}, {"M1RuntimeLifecycleTerminalFailure.json", false}, {"M1RuntimeLifecycleInstall.json", true}, {"M1RuntimeLifecycleEvents.jsonl", false}, {"../outside.json", false}} {
		if e := c.writeEvidence(ctx, v.name, object{}, v.append); codeOf(e) != "EVIDENCE_OUTPUT_NOT_AUTHORIZED" {
			t.Fatalf("unapproved output/mode %v: %v", v, e)
		}
	}
	raw, e := os.ReadFile(filepath.Join("..", "..", "..", "development", "contracts", "model-program", "m1", "governance", "ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-001.candidate.json"))
	if e != nil {
		t.Fatal(e)
	}
	p, e := decodeObject(raw)
	if e != nil {
		t.Fatal(e)
	}
	outputs := p["allowed_outputs"].([]any)
	for _, v := range outputs {
		n := v.(string)
		if strings.HasPrefix(n, "sanitized ") {
			continue
		}
		if !evidenceOutputAllowed(n, n == "M1RuntimeLifecycleEvents.jsonl") {
			t.Fatalf("frozen output omitted: %s", n)
		}
	}
}
func TestTerminalEvidenceExpiredNormalScenarioAndEventRejected(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	expireFixture(c, ctx)
	if e := c.recordScenario(ctx, "M1RuntimeLifecycleInstall.json", object{}); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatal(e)
	}
	if e := c.event(ctx, "fixture", "normal_event", object{}); codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatal(e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleInstall.json"), false)
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), false)
	if e := c.finalizeAttempt(ctx, fail("EXPIRED")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatal(e)
	}
	state := terminalRow(t, c)["remaining_test_owned_state"].(object)
	if state["complete"] != true {
		t.Fatalf("incomplete: %#v", state)
	}
}
func TestTerminalEvidenceRejectsDirectHelperAndFinalizedReuse(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	if e := c.writeTerminalFailure(ctx, fail("X"), nil, true); codeOf(e) != "TERMINAL_FINALIZER_AUTHORITY_REQUIRED" {
		t.Fatal(e)
	}
	if _, e := c.remainingOwnedState(ctx); codeOf(e) != "TERMINAL_FINALIZER_AUTHORITY_REQUIRED" {
		t.Fatal(e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"), false)
	if e := c.finalizeAttempt(ctx, fail("X")); e == nil {
		t.Fatal("must fail")
	}
	before, e := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	if e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{}, false); codeOf(e) != "ATTEMPT_ALREADY_FINALIZED" {
		t.Fatal(e)
	}
	_ = c.finalizeAttempt(ctx, nil)
	after, _ := os.ReadFile(filepath.Join(c.paths.evidence, "M1RuntimeLifecycleEvents.jsonl"))
	if !bytes.Equal(before, after) {
		t.Fatal("duplicate terminal append")
	}
}

// A harmless test-only time advance on a fixture write-handle check models slow
// native I/O. No production callback or CLI injection surface is added.
type slowEvidencePlatform struct {
	*fakePlatform
	tick  func()
	match string
}

func (f *slowEvidencePlatform) verifyWriteHandle(h *os.File, path string) error {
	e := f.fakePlatform.verifyWriteHandle(h, path)
	if path == f.match {
		f.tick()
	}
	return e
}
func TestTerminalEvidenceExpiryDuringOpenWritesNoLateBytes(t *testing.T) {
	c, ctx, f := tinyLifecycle(t)
	path := filepath.Join(c.paths.evidence, "M1RuntimeLifecycleInstall.json")
	c.sys = &slowEvidencePlatform{f, func() { expireFixture(c, ctx) }, path}
	e := c.recordScenario(ctx, "M1RuntimeLifecycleInstall.json", object{})
	if codeOf(e) != "PROFILE_EXPIRED_OR_REVOKED" {
		t.Fatal(e)
	}
	raw, re := os.ReadFile(path)
	if re != nil || len(raw) != 0 {
		t.Fatalf("late bytes: %q %v", raw, re)
	}
}
func TestTerminalEvidenceNormalBudgetCannotSpendReserve(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	b := ctx.budget
	b.limit = b.used + 65536
	b.reserve = 32768
	e := c.writeEvidence(ctx, "M1RuntimeLifecycleInstall.json", object{"payload": strings.Repeat("x", 32769)}, false)
	if codeOf(e) != "OUTPUT_STORAGE_BUDGET_EXCEEDED" {
		t.Fatal(e)
	}
	exists(t, filepath.Join(c.paths.evidence, "M1RuntimeLifecycleInstall.json"), false)
	if e = c.finalizeAttempt(ctx, fail("BUDGET")); e == nil || strings.Contains(e.Error(), "TERMINAL_EVIDENCE_UNAVAILABLE") {
		t.Fatal(e)
	}
	if terminalRow(t, c)["remaining_test_owned_state"].(object)["complete"] != true {
		t.Fatal("reserve did not yield complete safe fixture inventory")
	}
}
func TestTerminalEvidenceLiveInventoryAndCurrent(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	materialize(t, c, ctx, revisionB)
	publish(t, c, ctx, successTransition(2))
	publish(t, c, ctx, upgradeRecovery())
	raw, e := os.ReadFile(currentPath(c.paths))
	if e != nil {
		t.Fatal(e)
	}
	if e = c.finalizeAttempt(ctx, fail("AFTER_RECOVERY")); e == nil {
		t.Fatal("must fail")
	}
	state := terminalRow(t, c)["remaining_test_owned_state"].(object)
	if state["complete"] != true {
		t.Fatalf("%#v", state)
	}
	current := state["current"].(object)
	if current["sha256"] != sha(raw) || current["status"] != "OBSERVED" {
		t.Fatalf("cached/not-live Current: %#v", current)
	}
	if !transitionMatches(current["content"].(object), upgradeRecovery()) {
		t.Fatal("wrong recovery transition")
	}
	found := false
	for _, v := range state["entries"].([]any) {
		r := v.(object)
		if r["kind"] == "file" && r["exists"] == true {
			if r["live_handle_identity"] == "" || r["identity_matches_creation"] != true || r["sha256"] == nil {
				t.Fatalf("missing live identity/digest: %#v", r)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("no files inventoried")
	}
}
func TestTerminalEvidenceUnknownAndReparseStateExplicitlyIncomplete(t *testing.T) {
	for _, kind := range []string{"unknown", "reparse", "missing", "identity"} {
		t.Run(kind, func(t *testing.T) {
			c, ctx, f := tinyLifecycle(t)
			path := filepath.Join(c.paths.testRoot, "untrusted")
			switch kind {
			case "unknown":
				if e := os.Mkdir(path, 0700); e != nil {
					t.Fatal(e)
				}
				if e := os.WriteFile(filepath.Join(path, "do-not-read"), []byte("foreign"), 0600); e != nil {
					t.Fatal(e)
				}
			case "reparse":
				if e := c.createDirExact(path); e != nil {
					t.Fatal(e)
				}
				f.reparse = map[string]bool{path: true}
			case "missing":
				if e := c.createNewSynced(path, []byte("owned"), 0600); e != nil {
					t.Fatal(e)
				}
				if e := os.Remove(path); e != nil {
					t.Fatal(e)
				}
			case "identity":
				if e := c.createNewSynced(path, []byte("owned"), 0600); e != nil {
					t.Fatal(e)
				}
				c.created[pathKey(path)] = "other-object"
			}
			if e := c.finalizeAttempt(ctx, fail("FIXTURE")); e == nil || !strings.Contains(e.Error(), "EXACT_REMAINING_STATE_UNAVAILABLE") {
				t.Fatal(e)
			}
			state := terminalRow(t, c)["remaining_test_owned_state"].(object)
			if state["complete"] != false {
				t.Fatal("unsafe state claimed exact")
			}
			for _, v := range state["entries"].([]any) {
				r := v.(object)
				if strings.Contains(r["path"].(string), "do-not-read") {
					t.Fatal("traversed foreign directory")
				}
			}
			exists(t, c.paths.guard, true)
		})
	}
}
func TestTerminalEvidenceUsesLiveCurrentNotCachedBytes(t *testing.T) {
	c, ctx, _ := tinyLifecycle(t)
	materialize(t, c, ctx, revisionA)
	publish(t, c, ctx, successTransition(1))
	c.currentBytes = []byte("stale-cache")
	if e := c.finalizeAttempt(ctx, fail("FIXTURE")); e == nil {
		t.Fatal("must fail")
	}
	current := terminalRow(t, c)["remaining_test_owned_state"].(object)["current"].(object)
	if current["matches_last_observed_bytes"] != false || current["status"] != "OBSERVED" {
		t.Fatal(current)
	}
	if current["content"].(object)["transition_index"] != json.Number("1") {
		t.Fatal("lost live transition")
	}
}
