package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPC003PredecessorGuardExactHash(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "guard.json")
	raw := []byte("guard-bytes\n")
	if e := os.WriteFile(p, raw, 0600); e != nil {
		t.Fatal(e)
	}
	f := &fakePlatform{}
	c := newController(f, admission{}, testLayout(t))
	if e := c.verifyPredecessorGuard(p, sha(raw)); e != nil {
		t.Fatalf("exact guard rejected: %v", e)
	}
	if e := c.verifyPredecessorGuard(p, sha([]byte("other"))); codeOf(e) != "PREDECESSOR_ATTEMPT_GUARD_MISSING_OR_DRIFTED" {
		t.Fatalf("drift accepted: %v", e)
	}
}

func TestPC003PredecessorGuardMissingAndReparseFailClosed(t *testing.T) {
	f := &fakePlatform{reparse: map[string]bool{}}
	c := newController(f, admission{}, testLayout(t))
	p := filepath.Join(t.TempDir(), "missing.json")
	if e := c.verifyPredecessorGuard(p, sha([]byte("x"))); codeOf(e) != "PREDECESSOR_ATTEMPT_GUARD_MISSING_OR_DRIFTED" {
		t.Fatalf("missing guard: %v", e)
	}
	if e := os.WriteFile(p, []byte("x"), 0600); e != nil {
		t.Fatal(e)
	}
	f.reparse[filepath.Clean(p)] = true
	if e := c.verifyPredecessorGuard(p, sha([]byte("x"))); codeOf(e) != "PREDECESSOR_ATTEMPT_GUARD_MISSING_OR_DRIFTED" {
		t.Fatalf("reparse guard: %v", e)
	}
}
