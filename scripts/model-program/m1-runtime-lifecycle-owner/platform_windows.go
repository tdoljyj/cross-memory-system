//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

type realPlatform struct{}

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetWindowsDirectoryW  = kernel32.NewProc("GetWindowsDirectoryW")
	procGetFileAttributesW    = kernel32.NewProc("GetFileAttributesW")
	procGetFinalPathNameByHandleW = kernel32.NewProc("GetFinalPathNameByHandleW")
	procGetVolumePathNameW    = kernel32.NewProc("GetVolumePathNameW")
	procGetVolumeInformationW = kernel32.NewProc("GetVolumeInformationW")
	procLocalFree             = kernel32.NewProc("LocalFree")
	advapi32                  = syscall.NewLazyDLL("advapi32.dll")
	procGetFileSecurityW      = advapi32.NewProc("GetFileSecurityW")
	procGetSecurityDescriptorOwner = advapi32.NewProc("GetSecurityDescriptorOwner")
	procConvertSidToStringSidW = advapi32.NewProc("ConvertSidToStringSidW")
	procFindFirstStreamW      = kernel32.NewProc("FindFirstStreamW")
	procFindNextStreamW       = kernel32.NewProc("FindNextStreamW")
	procFindClose             = kernel32.NewProc("FindClose")
	procMoveFileExW           = kernel32.NewProc("MoveFileExW")
	procReplaceFileW          = kernel32.NewProc("ReplaceFileW")
	procGenerateConsoleCtrl   = kernel32.NewProc("GenerateConsoleCtrlEvent")
)

const (
	fileAttributeReparsePoint = 0x00000400
	invalidFileAttributes      = 0xffffffff
	movefileWriteThrough       = 0x00000008
	replacefileWriteThrough    = 0x00000001
	errorHandleEOF             = syscall.Errno(38)
	ownerSecurityInformation   = 0x00000001
	daclSecurityInformation    = 0x00000004
)

func nonzeroCallError(e error) error {
	if e == nil {
		return nil
	}
	if errno, ok := e.(syscall.Errno); ok && errno == 0 {
		return nil
	}
	return e
}

func (realPlatform) physical() (string, string, error) {
	name, e := os.Hostname()
	if e != nil {
		return "", "", e
	}
	keyName, e := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Cryptography`)
	if e != nil {
		return "", "", e
	}
	var key syscall.Handle
	if e = syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, keyName, 0, syscall.KEY_READ|syscall.KEY_WOW64_64KEY, &key); e != nil {
		return "", "", e
	}
	defer syscall.RegCloseKey(key)
	valueName, _ := syscall.UTF16PtrFromString("MachineGuid")
	var typ, n uint32
	if e = syscall.RegQueryValueEx(key, valueName, nil, &typ, nil, &n); e != nil {
		return "", "", e
	}
	if typ != syscall.REG_SZ || n > 4096 || n < 2 {
		return "", "", fail("MACHINE_IDENTITY_INVALID")
	}
	buf := make([]uint16, (n+1)/2)
	if e = syscall.RegQueryValueEx(key, valueName, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n); e != nil {
		return "", "", e
	}
	raw := strings.ToLower(strings.TrimSpace(syscall.UTF16ToString(buf)))
	return strings.ToUpper(name), sha([]byte("windows-machineguid:" + raw)), nil
}

func (realPlatform) windowsDirectory() (string, error) {
	buf := make([]uint16, 32768)
	n, _, er := procGetWindowsDirectoryW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || n >= uintptr(len(buf)) {
		if e := nonzeroCallError(er); e != nil {
			return "", e
		}
		return "", fail("TRUSTED_WINDOWS_DIRECTORY_INVALID")
	}
	p := filepath.Clean(syscall.UTF16ToString(buf[:n]))
	if !filepath.IsAbs(p) || filepath.VolumeName(p) == "" {
		return "", fail("TRUSTED_WINDOWS_DIRECTORY_INVALID")
	}
	return p, nil
}

func (realPlatform) pathIsReparse(path string) (bool, error) {
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return false, e
	}
	attrs, _, er := procGetFileAttributesW.Call(uintptr(unsafe.Pointer(p)))
	if uint32(attrs) == invalidFileAttributes {
		if ce := nonzeroCallError(er); ce != nil {
			return false, ce
		}
		return false, fail("WINDOWS_FILE_ATTRIBUTES_FAILED")
	}
	return uint32(attrs)&fileAttributeReparsePoint != 0, nil
}

func finalPathFromHandle(h syscall.Handle) (string, error) {
	buf := make([]uint16, 32768)
	n, _, er := procGetFinalPathNameByHandleW.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)),
		0,
	)
	if n == 0 || n >= uintptr(len(buf)) {
		if ce := nonzeroCallError(er); ce != nil {
			return "", ce
		}
		return "", fail("HANDLE_RESOLVED_CANONICAL_PATH_INVALID")
	}
	p := syscall.UTF16ToString(buf[:n])
	if strings.HasPrefix(p, `\\?\UNC\`) {
		return "", fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	p = strings.TrimPrefix(p, `\\?\`)
	p = filepath.Clean(p)
	if !filepath.IsAbs(p) || filepath.VolumeName(p) == "" {
		return "", fail("HANDLE_RESOLVED_CANONICAL_PATH_INVALID")
	}
	return p, nil
}

func (realPlatform) finalPath(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	return finalPathFromHandle(syscall.Handle(f.Fd()))
}

func volumeIdentity(path string) (string, string, error) {
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return "", "", e
	}
	root := make([]uint16, 32768)
	ok, _, er := procGetVolumePathNameW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&root[0])),
		uintptr(len(root)),
	)
	if ok == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return "", "", ce
		}
		return "", "", fail("GUARD_PARENT_FILESYSTEM_IDENTITY_FAILED")
	}
	fs := make([]uint16, 64)
	var serial uint32
	ok, _, er = procGetVolumeInformationW.Call(
		uintptr(unsafe.Pointer(&root[0])),
		0, 0,
		uintptr(unsafe.Pointer(&serial)),
		0, 0,
		uintptr(unsafe.Pointer(&fs[0])),
		uintptr(len(fs)),
	)
	if ok == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return "", "", ce
		}
		return "", "", fail("GUARD_PARENT_FILESYSTEM_IDENTITY_FAILED")
	}
	return strings.ToUpper(syscall.UTF16ToString(fs)), fmt.Sprintf("%08x", serial), nil
}

func fileSecurityIdentity(path string) (string, string, error) {
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return "", "", e
	}
	var needed uint32
	securityInfo := uintptr(ownerSecurityInformation | daclSecurityInformation)
	procGetFileSecurityW.Call(
		uintptr(unsafe.Pointer(p)), securityInfo, 0, 0,
		uintptr(unsafe.Pointer(&needed)),
	)
	if needed == 0 || needed > 1<<20 {
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	buf := make([]byte, needed)
	ok, _, er := procGetFileSecurityW.Call(
		uintptr(unsafe.Pointer(p)), securityInfo,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ok == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return "", "", ce
		}
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	var owner uintptr
	var defaulted uint32
	ok, _, er = procGetSecurityDescriptorOwner.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&owner)),
		uintptr(unsafe.Pointer(&defaulted)),
	)
	if ok == 0 || owner == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return "", "", ce
		}
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	var sidText uintptr
	ok, _, er = procConvertSidToStringSidW.Call(owner, uintptr(unsafe.Pointer(&sidText)))
	if ok == 0 || sidText == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return "", "", ce
		}
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	defer procLocalFree.Call(sidText)
	sid := syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(sidText))[:])
	sum := sha256.Sum256(buf[:needed])
	return sid, hex.EncodeToString(sum[:]), nil
}

func (sys realPlatform) directoryIdentity(path string) (directoryIdentity, error) {
	f, e := os.Open(path)
	if e != nil {
		return directoryIdentity{}, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return directoryIdentity{}, e
	}
	if !st.IsDir() {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	canonical, e := finalPathFromHandle(syscall.Handle(f.Fd()))
	if e != nil {
		return directoryIdentity{}, e
	}
	var info syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); e != nil {
		return directoryIdentity{}, e
	}
	fsType, serial, e := volumeIdentity(canonical)
	if e != nil {
		return directoryIdentity{}, e
	}
	ownerSID, securitySHA, e := fileSecurityIdentity(canonical)
	if e != nil {
		return directoryIdentity{}, e
	}
	return directoryIdentity{
		canonicalPath: canonical,
		filesystemType: fsType,
		volumeSerial: serial,
		fileID: fmt.Sprintf("%08x%08x", info.FileIndexHigh, info.FileIndexLow),
		ownerSID: ownerSID,
		securityDescriptorSHA256: securitySHA,
	}, nil
}

func (realPlatform) verifyWriteHandle(f *os.File, expected string) error {
	if f == nil {
		return fail("WRITE_HANDLE_REQUIRED")
	}
	h := syscall.Handle(f.Fd())
	resolved, e := finalPathFromHandle(h)
	if e != nil {
		return e
	}
	if !samePath(resolved, expected) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	var info syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(h, &info); e != nil {
		return e
	}
	if info.NumberOfLinks != 1 {
		return fail("WRITE_HANDLE_HARDLINK_FORBIDDEN")
	}
	return nil
}

func (realPlatform) hardlinkCount(path string) (uint32, error) {
	f, e := os.Open(path)
	if e != nil {
		return 0, e
	}
	defer f.Close()
	var info syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); e != nil {
		return 0, e
	}
	return info.NumberOfLinks, nil
}

type findStreamData struct {
	StreamSize int64
	StreamName [296]uint16
}

func (realPlatform) namedStreams(path string) ([]string, error) {
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	var data findStreamData
	h, _, er := procFindFirstStreamW.Call(
		uintptr(unsafe.Pointer(p)),
		0,
		uintptr(unsafe.Pointer(&data)),
		0,
	)
	if h == ^uintptr(0) {
		if ce := nonzeroCallError(er); ce != nil {
			return nil, ce
		}
		return nil, fail("NTFS_STREAM_ENUMERATION_FAILED")
	}
	defer procFindClose.Call(h)
	streams := []string{syscall.UTF16ToString(data.StreamName[:])}
	for {
		var next findStreamData
		ok, _, callErr := procFindNextStreamW.Call(h, uintptr(unsafe.Pointer(&next)))
		if ok != 0 {
			streams = append(streams, syscall.UTF16ToString(next.StreamName[:]))
			continue
		}
		if errno, isErrno := callErr.(syscall.Errno); isErrno && errno == errorHandleEOF {
			break
		}
		if ce := nonzeroCallError(callErr); ce != nil {
			return nil, ce
		}
		break
	}
	return streams, nil
}

func (realPlatform) atomicPublish(temp, dst string, replace bool) error {
	if !filepath.IsAbs(temp) || !filepath.IsAbs(dst) || !samePath(filepath.Dir(temp), filepath.Dir(dst)) {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	tv := filepath.VolumeName(filepath.Clean(temp))
	dv := filepath.VolumeName(filepath.Clean(dst))
	if tv == "" || !strings.EqualFold(tv, dv) {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	tp, e := syscall.UTF16PtrFromString(temp)
	if e != nil {
		return e
	}
	dp, e := syscall.UTF16PtrFromString(dst)
	if e != nil {
		return e
	}
	if replace {
		if _, e = os.Lstat(dst); e != nil {
			return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
		}
		ok, _, er := procReplaceFileW.Call(
			uintptr(unsafe.Pointer(dp)),
			uintptr(unsafe.Pointer(tp)),
			0,
			replacefileWriteThrough,
			0,
			0,
		)
		if ok == 0 {
			if ce := nonzeroCallError(er); ce != nil {
				return ce
			}
			return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
		}
		return nil
	}
	if _, e = os.Lstat(dst); !os.IsNotExist(e) {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	ok, _, er := procMoveFileExW.Call(
		uintptr(unsafe.Pointer(tp)),
		uintptr(unsafe.Pointer(dp)),
		movefileWriteThrough,
	)
	if ok == 0 {
		if ce := nonzeroCallError(er); ce != nil {
			return ce
		}
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	return nil
}

func parseExactEnvironment(env []string) (map[string]string, error) {
	if len(env) != 4 {
		return nil, fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
	}
	out := map[string]string{}
	for _, row := range env {
		parts := strings.SplitN(row, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
		}
		k := strings.ToUpper(parts[0])
		if _, exists := out[k]; exists {
			return nil, fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
		}
		switch k {
		case "SYSTEMROOT", "WINDIR", "TEMP", "TMP":
		default:
			return nil, fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
		}
		out[k] = parts[1]
	}
	for _, k := range []string{"SYSTEMROOT", "WINDIR", "TEMP", "TMP"} {
		if out[k] == "" {
			return nil, fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
		}
	}
	return out, nil
}

func validateLaunchEnvelope(sys realPlatform, launch launchEnvelope) error {
	if !filepath.IsAbs(launch.executable) || !filepath.IsAbs(launch.cwd) || len(launch.argv) != 22 {
		return fail("EXECUTABLE_ARGV_ENDPOINT_OR_PROCESS_OWNERSHIP_DRIFT")
	}
	slot := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Clean(launch.cwd))))
	if !samePath(slot, slotRootFor(productionLayout, revisionA)) && !samePath(slot, slotRootFor(productionLayout, revisionB)) {
		return fail("CHILD_CWD_NOT_EXACT_VERIFIED_ACTIVE_SLOT_RUNTIME_DIRECTORY")
	}
	envMap, e := parseExactEnvironment(launch.env)
	if e != nil {
		return e
	}
	wd, e := sys.windowsDirectory()
	if e != nil {
		return e
	}
	if !samePath(envMap["SYSTEMROOT"], wd) || !samePath(envMap["WINDIR"], wd) ||
		!samePath(envMap["TEMP"], productionLayout.tempRoot) || !samePath(envMap["TMP"], productionLayout.tempRoot) {
		return fail("PATH_DLL_RUNTIME_SEARCH_OR_BACKEND_DEVICE_ENVIRONMENT_INFLUENCE_DETECTED")
	}
	expected := serverLaunch(slot, []string{
		"SystemRoot=" + wd,
		"WINDIR=" + wd,
		"TEMP=" + productionLayout.tempRoot,
		"TMP=" + productionLayout.tempRoot,
	})
	if !samePath(launch.executable, expected.executable) || !samePath(launch.cwd, expected.cwd) ||
		len(launch.argv) != len(expected.argv) || len(launch.env) != len(expected.env) {
		return fail("EXECUTABLE_ARGV_ENDPOINT_OR_PROCESS_OWNERSHIP_DRIFT")
	}
	for i := range expected.argv {
		if i == 0 || i == 2 {
			if !samePath(launch.argv[i], expected.argv[i]) {
				return fail("EXECUTABLE_ARGV_ENDPOINT_OR_PROCESS_OWNERSHIP_DRIFT")
			}
		} else if launch.argv[i] != expected.argv[i] {
			return fail("EXECUTABLE_ARGV_ENDPOINT_OR_PROCESS_OWNERSHIP_DRIFT")
		}
	}
	for i := range expected.env {
		if launch.env[i] != expected.env[i] {
			return fail("UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION")
		}
	}
	return nil
}

type winProcess struct {
	id      int
	handle  syscall.Handle
	copies  sync.WaitGroup
	readers []*os.File
	copyErr error
	mu      sync.Mutex
	closed  bool
}

func (p *winProcess) pid() int { return p.id }
func (p *winProcess) alive() (bool, error) {
	if p.closed {
		return false, nil
	}
	s, e := syscall.WaitForSingleObject(p.handle, 0)
	if e != nil {
		return false, e
	}
	return s == syscall.WAIT_TIMEOUT, nil
}
func (p *winProcess) graceful() error {
	alive, e := p.alive()
	if e != nil || !alive {
		return e
	}
	ok, _, er := procGenerateConsoleCtrl.Call(uintptr(syscall.CTRL_BREAK_EVENT), uintptr(p.id))
	if ok == 0 {
		return nonzeroCallError(er)
	}
	return nil
}
func (p *winProcess) kill() error {
	if p.closed {
		return nil
	}
	return syscall.TerminateProcess(p.handle, 1)
}
func (p *winProcess) wait(timeout time.Duration) error {
	if p.closed {
		return nil
	}
	ms := uint32(timeout / time.Millisecond)
	s, e := syscall.WaitForSingleObject(p.handle, ms)
	if e != nil {
		return e
	}
	if s == syscall.WAIT_TIMEOUT {
		return fail("PROCESS_EXIT_TIMEOUT")
	}
	done := make(chan struct{})
	go func() { p.copies.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		for _, r := range p.readers {
			_ = r.Close()
		}
		return fail("CAPTURE_DRAIN_TIMEOUT")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.copyErr
}
func (p *winProcess) close() error {
	if p.closed {
		return nil
	}
	alive, e := p.alive()
	if e != nil {
		return e
	}
	if alive {
		return fail("ORPHAN_PROFILE_OWNED_SERVER_AFTER_CLEANUP")
	}
	p.closed = true
	return syscall.CloseHandle(p.handle)
}

func (sys realPlatform) start(launch launchEnvelope, out, errOut io.Writer) (process, error) {
	// Re-derive and validate the complete envelope immediately before the native
	// process creation call. No caller-supplied process, PID, handle, callback,
	// executable, argv extension, environment, CWD or endpoint enters here.
	if e := validateLaunchEnvelope(sys, launch); e != nil {
		return nil, e
	}
	stdoutR, stdoutW, e := os.Pipe()
	if e != nil {
		return nil, e
	}
	stderrR, stderrW, e := os.Pipe()
	if e != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return nil, e
	}
	null, e := os.Open(os.DevNull)
	if e != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		return nil, e
	}
	defer null.Close()
	defer stdoutW.Close()
	defer stderrW.Close()

	id, h, e := syscall.StartProcess(
		launch.executable,
		launch.argv,
		&syscall.ProcAttr{
			Dir:   launch.cwd,
			Env:   append([]string(nil), launch.env...),
			Files: []uintptr{null.Fd(), stdoutW.Fd(), stderrW.Fd()},
			Sys: &syscall.SysProcAttr{
				HideWindow:     true,
				CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
			},
		},
	)
	if e != nil {
		_ = stdoutR.Close()
		_ = stderrR.Close()
		return nil, e
	}
	p := &winProcess{id: id, handle: syscall.Handle(h), readers: []*os.File{stdoutR, stderrR}}
	for i, w := range []io.Writer{out, errOut} {
		p.copies.Add(1)
		go func(r *os.File, dst io.Writer) {
			defer p.copies.Done()
			defer r.Close()
			_, copyErr := io.Copy(dst, r)
			if copyErr != nil {
				p.mu.Lock()
				if p.copyErr == nil {
					p.copyErr = copyErr
				}
				p.mu.Unlock()
			}
		}(p.readers[i], w)
	}
	// p.handle is the original creation-time process handle returned by
	// StartProcess and is retained for liveness, stop, kill, wait and close.
	return p, nil
}
