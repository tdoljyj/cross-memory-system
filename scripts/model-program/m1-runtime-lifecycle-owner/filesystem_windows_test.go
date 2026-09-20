//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsPinnedGuardParentUsesSameHandleIdentity(t *testing.T) {
	sys := realPlatform{}
	paths := testLayout(t)
	if e := os.Mkdir(paths.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	c := testController(t, sys, admission{}, paths)
	d, e := c.pinDirectory(paths.guardParent)
	if e != nil {
		t.Fatal(e)
	}
	live, e := sys.guardIdentity(d)
	if e != nil {
		t.Fatal(e)
	}
	p := object{"trusted_execution_bindings": object{"guard_parent_provisioning_identity": guardIdentityObject(live)}}
	got, e := c.verifyGuardParent(p)
	if e != nil || got != live {
		t.Fatalf("live signed identity: %#v %v", got, e)
	}
	// Normal rename of a directory with a no-delete-share lease must be denied.
	if e = os.Rename(paths.guardParent, paths.guardParent+"-renamed"); e == nil {
		t.Fatal("pinned parent unexpectedly renamed")
	}
	if e = c.createNewSynced(paths.guard, []byte("test guard"), 0600); e != nil {
		t.Fatal(e)
	}
	gotID, e := sys.handleIdentity(d)
	if e != nil || gotID.id != live.fileID {
		t.Fatalf("guard parent identity changed: %v", e)
	}
}
func TestWindowsAtomicRenameFailureDoesNotDeleteOldCurrent(t *testing.T) {
	sys := realPlatform{}
	paths := testLayout(t)
	c := testController(t, sys, admission{}, paths)
	ctx := registeredContext(t, c)
	if e := os.Mkdir(paths.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	if e := c.createNewSynced(paths.guard, []byte("inert"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := c.createOwnedDirs(ctx); e != nil {
		t.Fatal(e)
	}
	cur := currentPath(paths)
	tmp := currentTempPath(paths, 1)
	if e := c.createNewSynced(tmp, []byte(`{"value":"old"}`), 0600); e != nil {
		t.Fatal(e)
	}
	if state, e := c.publishOwnedFile(tmp, cur, false); e != nil || state != committed {
		t.Fatalf("initial: %s %v", state, e)
	}
	// A normal reader denies replacement. The failed rename must leave old bytes
	// intact and preserve the complete staged file for investigation.
	held, e := c.openBoundRead(cur)
	if e != nil {
		t.Fatal(e)
	}
	next := currentTempPath(paths, 2)
	if e = c.createNewSynced(next, []byte(`{"value":"new"}`), 0600); e != nil {
		held.Close()
		t.Fatal(e)
	}
	state, e := c.publishOwnedFile(next, cur, true)
	held.Close()
	if e == nil || state != notCommitted {
		t.Fatalf("expected old retained on sharing failure: %s %v", state, e)
	}
	raw, e := os.ReadFile(cur)
	if e != nil || !bytes.Equal(raw, []byte(`{"value":"old"}`)) {
		t.Fatalf("old bytes: %s %v", raw, e)
	}
	if _, e = os.Stat(next); e != nil {
		t.Fatalf("staging bytes missing: %v", e)
	}
}
func TestWindowsDeleteUsesRecordedCreatedFileIdentity(t *testing.T) {
	sys := realPlatform{}
	paths := testLayout(t)
	c := testController(t, sys, admission{}, paths)
	if e := c.createOwnedDirectory(paths.testRoot); e != nil {
		t.Fatal(e)
	}
	target := filepath.Join(paths.testRoot, "owned.txt")
	if e := c.createNewSynced(target, []byte("owned"), 0600); e != nil {
		t.Fatal(e)
	}
	// A wrong recorded identity must not authorize deletion of an existing file.
	id := c.created[fileKey(target)]
	wrong := id
	wrong.id = "not-the-created-object"
	c.created[fileKey(target)] = wrong
	if e := c.removeCreated(target); codeOf(e) != "CREATED_OBJECT_IDENTITY_DRIFT" {
		t.Fatalf("identity gate: %v", e)
	}
	if _, e := os.Stat(target); e != nil {
		t.Fatal("wrong-object deletion occurred")
	}
	c.created[fileKey(target)] = id
	if e := c.removeCreated(target); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(target); !os.IsNotExist(e) {
		t.Fatalf("owned deletion failed: %v", e)
	}
}
