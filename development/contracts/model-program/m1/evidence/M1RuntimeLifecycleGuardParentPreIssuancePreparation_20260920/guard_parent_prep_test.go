//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestGuardParentPreparationIdentity(t *testing.T) {
	path := productionLayout.guardParent
	if err := (&controller{sys: realPlatform{}}).verifySafeExistingPath(path); err != nil {
		t.Fatalf("verifySafeExistingPath: %v", err)
	}
	c := newController(realPlatform{}, admission{}, productionLayout)
	defer func() {
		if err := c.closeFilesystem(); err != nil {
			t.Fatalf("closeFilesystem: %v", err)
		}
	}()
	h, err := c.pinDirectory(path)
	if err != nil {
		t.Fatalf("pinDirectory: %v", err)
	}
	fs, err := c.filesystem()
	if err != nil {
		t.Fatalf("filesystem: %v", err)
	}
	id, err := fs.directoryIdentityHandle(h)
	if err != nil {
		t.Fatalf("directoryIdentityHandle: %v", err)
	}
	rows, err := c.readPinnedDirectory(path)
	if err != nil {
		t.Fatalf("readPinnedDirectory: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("guard parent not empty: %d entries", len(rows))
	}
	if _, err := os.Lstat(productionLayout.guard); !os.IsNotExist(err) {
		t.Fatalf("attempt guard is not absent: %v", err)
	}
	out := map[string]any{"canonical_path": id.canonicalPath, "filesystem_type": id.filesystemType, "volume_serial": id.volumeSerial, "file_id": id.fileID, "owner_sid": id.ownerSID, "security_descriptor_sha256": id.securityDescriptorSHA256, "empty_parent": true, "non_reparse": true, "attempt_guard_absent": true}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("GUARD_PARENT_IDENTITY_JSON=%s\n", b)
}