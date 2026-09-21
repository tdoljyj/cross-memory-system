//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

const pc001GuardPathForPC003Provisioning = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001\M1RuntimeLifecycleAttemptGuard.json`
const pc001GuardSHA256ForPC003Provisioning = "9e0b95cf7e8cbb16608c73318b6c39b54dd5c1b2ae26daa63e822420cbce14bb"
const pc002GuardPathForPC003Provisioning = `C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-002\M1RuntimeLifecycleAttemptGuard.json`
const pc002GuardSHA256ForPC003Provisioning = "4d6a230560fea05a4488ccd3eab1b3054e8906e0360a947409dd04313e4d7863"

func observePC003ProvisionedParent(t *testing.T, path string, requireEmpty bool) map[string]any {
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
		"entry_count": len(rows),
		"empty_at_observation": len(rows) == 0,
		"non_reparse": true,
	}
}

func exactGuard(t *testing.T, path, want string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("guard missing/unreadable %s: %v", path, err)
	}
	if got := sha(raw); got != want {
		t.Fatalf("guard hash drift %s: %s", path, got)
	}
}

func TestPC003ParentProvisioningIdentity(t *testing.T) {
	exactGuard(t, pc001GuardPathForPC003Provisioning, pc001GuardSHA256ForPC003Provisioning)
	exactGuard(t, pc002GuardPathForPC003Provisioning, pc002GuardSHA256ForPC003Provisioning)
	if _, err := os.Lstat(productionLayout.guard); !os.IsNotExist(err) {
		t.Fatalf("PC-003 Attempt Guard must remain absent: %v", err)
	}
	if _, err := os.Lstat(productionLayout.testRoot); !os.IsNotExist(err) {
		t.Fatalf("PC-003 test root must remain absent: %v", err)
	}
	if _, err := os.Lstat(productionLayout.evidence); !os.IsNotExist(err) {
		t.Fatalf("PC-003 evidence dir must remain absent: %v", err)
	}

	out := map[string]any{
		"pc001_guard_preserved": true,
		"pc001_guard_sha256": pc001GuardSHA256ForPC003Provisioning,
		"pc002_guard_preserved": true,
		"pc002_guard_sha256": pc002GuardSHA256ForPC003Provisioning,
		"pc003_attempt_guard_absent": true,
		"pc003_test_root_absent": true,
		"pc003_evidence_dir_absent": true,
		"guard_parent": observePC003ProvisionedParent(t, productionLayout.guardParent, true),
		"evidence_parent": observePC003ProvisionedParent(t, filepath.Dir(productionLayout.evidence), false),
		"runtime_lifecycle_parent": observePC003ProvisionedParent(t, filepath.Dir(productionLayout.testRoot), false),
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("PC003_PARENT_PROVISIONING_IDENTITY_JSON=%s\n", b)
}
