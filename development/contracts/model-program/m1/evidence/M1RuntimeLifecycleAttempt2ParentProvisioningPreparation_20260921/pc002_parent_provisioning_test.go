//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

const pc001GuardPathForProvisioning = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001\M1RuntimeLifecycleAttemptGuard.json`
const pc001GuardSHA256ForProvisioning = "9e0b95cf7e8cbb16608c73318b6c39b54dd5c1b2ae26daa63e822420cbce14bb"

func observeProvisionedParent(t *testing.T, path string, requireEmpty bool) map[string]any {
	t.Helper()
	c := newController(realPlatform{}, admission{}, productionLayout)
	defer func() {
		if err := c.closeFilesystem(); err != nil {
			t.Fatalf("closeFilesystem(%s): %v", path, err)
		}
	}()
	if err := c.verifySafeExistingPath(path); err != nil {
		t.Fatalf("verifySafeExistingPath(%s): %v", path, err)
	}
	h, err := c.pinDirectory(path)
	if err != nil {
		t.Fatalf("pinDirectory(%s): %v", path, err)
	}
	fs, err := c.filesystem()
	if err != nil {
		t.Fatalf("filesystem(%s): %v", path, err)
	}
	id, err := fs.directoryIdentityHandle(h)
	if err != nil {
		t.Fatalf("directoryIdentityHandle(%s): %v", path, err)
	}
	rows, err := c.readPinnedDirectory(path)
	if err != nil {
		t.Fatalf("readPinnedDirectory(%s): %v", path, err)
	}
	if requireEmpty && len(rows) != 0 {
		t.Fatalf("provisioned parent not empty: %s entries=%d", path, len(rows))
	}
	return map[string]any{
		"canonical_path": id.canonicalPath,
		"filesystem_type": id.filesystemType,
		"volume_serial": id.volumeSerial,
		"file_id": id.fileID,
		"owner_sid": id.ownerSID,
		"security_descriptor_sha256": id.securityDescriptorSHA256,
		"empty_at_observation": len(rows) == 0,
		"non_reparse": true,
	}
}

func TestPC002ParentProvisioningIdentity(t *testing.T) {
	pc001Guard, err := os.ReadFile(pc001GuardPathForProvisioning)
	if err != nil {
		t.Fatalf("PC-001 guard missing/unreadable: %v", err)
	}
	if got := sha(pc001Guard); got != pc001GuardSHA256ForProvisioning {
		t.Fatalf("PC-001 guard hash drift: %s", got)
	}
	if _, err := os.Lstat(productionLayout.guard); !os.IsNotExist(err) {
		t.Fatalf("PC-002 Attempt Guard must remain absent: %v", err)
	}

	out := map[string]any{
		"pc001_guard_preserved": true,
		"pc001_guard_sha256": pc001GuardSHA256ForProvisioning,
		"pc002_attempt_guard_absent": true,
		"guard_parent": observeProvisionedParent(t, productionLayout.guardParent, true),
		"evidence_parent": observeProvisionedParent(t, filepath.Dir(productionLayout.evidence), true),
		"runtime_lifecycle_parent": observeProvisionedParent(t, filepath.Dir(productionLayout.testRoot), true),
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("PC002_PARENT_PROVISIONING_IDENTITY_JSON=%s\n", b)
}
