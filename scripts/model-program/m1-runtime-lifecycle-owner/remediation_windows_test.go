//go:build windows

package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func nativeFixture(t *testing.T) (*controller, realPlatform) {
	t.Helper()
	l := testLayout(t)
	sys := realPlatform{}
	c := newController(sys, admission{}, l)
	t.Cleanup(func() {
		if e := c.closeFilesystem(); e != nil {
			t.Errorf("native handle close: %v", e)
		}
	})
	if e := os.Mkdir(l.guardParent, 0700); e != nil {
		t.Fatal(e)
	}
	if e := c.createDirExact(l.testRoot); e != nil {
		t.Fatal(e)
	}
	return c, sys
}
func TestWindowsRemediationRetainedGuardParentAndRelativeCreate(t *testing.T) {
	c, sys := nativeFixture(t)
	parent, e := c.pinDirectory(c.paths.guardParent)
	if e != nil {
		t.Fatal(e)
	}
	id, e := sys.directoryIdentityHandle(parent)
	if e != nil {
		t.Fatal(e)
	}
	p := object{"trusted_execution_bindings": object{"guard_parent_provisioning_identity": object{
		"canonical_path": id.canonicalPath, "filesystem_type": id.filesystemType, "volume_serial": id.volumeSerial,
		"file_id": id.fileID, "owner_sid": id.ownerSID, "security_descriptor_sha256": id.securityDescriptorSHA256,
		"empty_parent": true, "non_reparse": true,
	}}}
	if _, e = c.verifyGuardParent(p); e != nil {
		t.Fatal(e)
	}
	if c.dirPins[pathKey(c.paths.guardParent)] != parent {
		t.Fatal("guard parent not retained")
	}
	if e = os.Rename(c.paths.guardParent, c.paths.guardParent+"-moved"); e == nil {
		t.Fatal("retained guard parent was movable")
	}
	if e = c.createNewSynced(c.paths.guard, []byte("qualification only"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = c.createNewSynced(c.paths.guard, []byte("reuse"), 0600); e == nil {
		t.Fatal("CREATE_NEW permitted reuse")
	}
	raw, e := os.ReadFile(c.paths.guard)
	if e != nil || string(raw) != "qualification only" {
		t.Fatalf("guard %q %v", raw, e)
	}
	if e = c.removeOwned(c.paths.guard); e == nil {
		t.Fatal("persistent Guard deletion permitted")
	}
}
func TestWindowsRemediationImmutablePayloadHandleRejectsWriter(t *testing.T) {
	c, _ := nativeFixture(t)
	path := filepath.Join(c.paths.testRoot, "fixture.bin")
	if e := c.createNewSynced(path, []byte("fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := c.pinImmutable(path, true); e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(path, os.O_WRONLY, 0600)
	if e == nil {
		_ = f.Close()
		t.Fatal("write opened despite retained read-only payload handle")
	}
	if e = c.removeOwned(path); e != nil {
		t.Fatal(e)
	}
	exists(t, path, false)
}
func TestWindowsRemediationNativeFailureLeavesOldAndTemp(t *testing.T) {
	sys := realPlatform{}
	dir := t.TempDir()
	dst := filepath.Join(dir, "current.json")
	temp := filepath.Join(dir, "current.transition-2.tmp")
	old := []byte(`{"revision":"A"}`)
	next := []byte(`{"revision":"B"}`)
	if e := os.WriteFile(dst, old, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(temp, next, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Chmod(dst, 0400); e != nil {
		t.Fatal(e)
	}
	defer os.Chmod(dst, 0600)
	if e := sys.atomicPublish(temp, dst, true); e == nil {
		t.Fatal("readonly replacement unexpectedly succeeded")
	}
	raw, e := os.ReadFile(dst)
	if e != nil || !bytes.Equal(raw, old) {
		t.Fatalf("old not retained: %q %v", raw, e)
	}
	raw, e = os.ReadFile(temp)
	if e != nil || !bytes.Equal(raw, next) {
		t.Fatalf("temp not retained: %q %v", raw, e)
	}
}
func TestWindowsRemediationNativeReplacementPreservesOldReader(t *testing.T) {
	c, sys := nativeFixture(t)
	dir := c.paths.testRoot
	dst := filepath.Join(dir, "current.json")
	temp := filepath.Join(dir, "current.transition-2.tmp")
	if e := c.createNewSynced(dst, []byte("OLD"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := c.createNewSynced(temp, []byte("NEW"), 0600); e != nil {
		t.Fatal(e)
	}
	parent, e := c.pinDirectory(dir)
	if e != nil {
		t.Fatal(e)
	}
	old, e := sys.openFileAt(parent, dst, false, "read")
	if e != nil {
		t.Fatal(e)
	}
	defer old.Close()
	if e = sys.atomicPublish(temp, dst, true); e != nil {
		t.Fatal(e)
	}
	raw, e := io.ReadAll(old)
	if e != nil || string(raw) != "OLD" {
		t.Fatalf("old handle %q %v", raw, e)
	}
	raw, e = os.ReadFile(dst)
	if e != nil || string(raw) != "NEW" {
		t.Fatalf("new name %q %v", raw, e)
	}
	exists(t, temp, false)
}
func TestWindowsRemediationNativeCrossDirectoryRenameRejected(t *testing.T) {
	c, sys := nativeFixture(t)
	src := filepath.Join(c.paths.testRoot, "candidate.tmp")
	if e := c.createNewSynced(src, []byte("fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	parent, e := c.pinDirectory(c.paths.testRoot)
	if e != nil {
		t.Fatal(e)
	}
	file, e := sys.openFileAt(parent, src, false, "delete")
	if e != nil {
		t.Fatal(e)
	}
	defer file.Close()
	dst := filepath.Join(c.paths.guardParent, "current.json")
	if e = sys.renameHandle(file, parent, dst, false); e == nil {
		t.Fatal("cross-directory rename accepted")
	}
	exists(t, src, true)
	exists(t, dst, false)
}
