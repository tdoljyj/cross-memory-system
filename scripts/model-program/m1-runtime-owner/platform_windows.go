//go:build windows

package main

import (
	"archive/zip"
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
func hashReader(r io.Reader, deadline time.Time) (string, int64, error) {
	h := sha256.New()
	buf := make([]byte, 1<<20)
	var total int64
	for {
		if !time.Now().Before(deadline) {
			return "", total, fail("MAX_WALL_TIME_EXCEEDED")
		}
		n, er := r.Read(buf)
		if n > 0 {
			total += int64(n)
			h.Write(buf[:n])
		}
		if er == io.EOF {
			break
		}
		if er != nil {
			return "", total, er
		}
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}
func fileHash(path string, bytesExpected int64, expected string, deadline time.Time) error {
	lst, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !lst.Mode().IsRegular() || lst.Size() != bytesExpected {
		return fail("EXACT_FILE_SIZE_DRIFT")
	}
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	digest, total, e := hashReader(f, deadline)
	if e != nil {
		return e
	}
	if total != bytesExpected {
		return fail("EXACT_FILE_SIZE_DRIFT")
	}
	if digest != expected {
		return &fault{"EXACT_FILE_DIGEST_DRIFT", filepath.Base(path)}
	}
	return nil
}
func attestRuntimeTree(deadline time.Time) error {
	if e := fileHash(runtimeAssetPath, runtimeAssetBytes, runtimeAssetSHA, deadline); e != nil {
		return e
	}
	z, e := zip.OpenReader(runtimeAssetPath)
	if e != nil {
		return e
	}
	defer z.Close()
	type spec struct {
		bytes int64
		sha   string
	}
	expected := make(map[string]spec, len(z.File))
	for _, entry := range z.File {
		name := entry.Name
		if entry.FileInfo().IsDir() || name == "" || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
			return fail("RUNTIME_TREE_ARCHIVE_PATH_INVALID")
		}
		if _, exists := expected[name]; exists {
			return fail("RUNTIME_TREE_DUPLICATE_ENTRY")
		}
		r, er := entry.Open()
		if er != nil {
			return er
		}
		digest, total, er := hashReader(r, deadline)
		closeErr := r.Close()
		if er != nil {
			return er
		}
		if closeErr != nil {
			return closeErr
		}
		if total != int64(entry.UncompressedSize64) {
			return fail("RUNTIME_TREE_ARCHIVE_SIZE_DRIFT")
		}
		expected[name] = spec{bytes: total, sha: digest}
	}
	actual, e := os.ReadDir(runtimeDir)
	if e != nil {
		return e
	}
	if len(actual) != len(expected) {
		return fail("RUNTIME_TREE_FILE_SET_DRIFT")
	}
	for _, entry := range actual {
		if entry.IsDir() {
			return fail("RUNTIME_TREE_FILE_SET_DRIFT")
		}
		want, ok := expected[entry.Name()]
		if !ok {
			return &fault{"RUNTIME_TREE_UNEXPECTED_FILE", entry.Name()}
		}
		if e := fileHash(filepath.Join(runtimeDir, entry.Name()), want.bytes, want.sha, deadline); e != nil {
			return e
		}
	}
	return nil
}
func (realPlatform) attestFiles(deadline time.Time) error {
	if e := attestRuntimeTree(deadline); e != nil {
		return e
	}
	return fileHash(modelPath, 833592320, modelSHA, deadline)
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
func (p *winProcess) kill() error {
	if p.closed {
		return nil
	}
	return syscall.TerminateProcess(p.handle, 1)
}
func (p *winProcess) graceful() error {
	alive, e := p.alive()
	if e != nil || !alive {
		return e
	}
	// Only the creation-time process-group ID paired with our retained handle.
	// No caller PID is read, no foreign process is looked up/opened by PID.
	fn := syscall.NewLazyDLL("kernel32.dll").NewProc("GenerateConsoleCtrlEvent")
	ok, _, er := fn.Call(uintptr(syscall.CTRL_BREAK_EVENT), uintptr(p.id))
	if ok == 0 {
		return er
	}
	return nil
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
			r.Close()
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
func (p *winProcess) rss() (uint64, error) {
	alive, e := p.alive()
	if e != nil {
		return 0, e
	}
	if !alive {
		return 0, fail("PROCESS_METRICS_PROCESS_EXITED")
	}
	type counters struct {
		Size, Faults                                                                                                 uint32
		Peak, Working, QuotaPeakPaged, QuotaPaged, QuotaPeakNonPaged, QuotaNonPaged, Pagefile, PeakPagefile, Private uintptr
	}
	var mem counters
	mem.Size = uint32(unsafe.Sizeof(mem))
	// Absolute system DLL path; no working-directory DLL resolution.
	system := make([]uint16, 32768)
	k := syscall.NewLazyDLL("kernel32.dll")
	getDir := k.NewProc("GetSystemDirectoryW")
	n, _, er := getDir.Call(uintptr(unsafe.Pointer(&system[0])), uintptr(len(system)))
	if n == 0 || n >= uintptr(len(system)) {
		return 0, fmt.Errorf("system directory: %v", er)
	}
	psapi := syscall.NewLazyDLL(filepath.Join(syscall.UTF16ToString(system), "psapi.dll"))
	fn := psapi.NewProc("GetProcessMemoryInfo")
	ok, _, er := fn.Call(uintptr(p.handle), uintptr(unsafe.Pointer(&mem)), uintptr(mem.Size))
	if ok == 0 {
		return 0, fmt.Errorf("GetProcessMemoryInfo: %v", er)
	}
	return uint64(mem.Working), nil
}
func (realPlatform) start(cmd []string, out, errOut io.Writer) (process, error) {
	if len(cmd) == 0 || cmd[0] != serverPath {
		return nil, fail("EXACT_COMMAND_REQUIRED")
	}
	stdoutR, stdoutW, e := os.Pipe()
	if e != nil {
		return nil, e
	}
	stderrR, stderrW, e := os.Pipe()
	if e != nil {
		stdoutR.Close()
		stdoutW.Close()
		return nil, e
	}
	null, e := os.Open(os.DevNull)
	if e != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return nil, e
	}
	defer null.Close()
	defer stdoutW.Close()
	defer stderrW.Close()
	// syscall.StartProcess returns the ORIGINAL creation-time process handle.
	// It is retained for kill, wait, liveness and RSS, never reopened via PID.
	id, h, e := syscall.StartProcess(cmd[0], cmd, &syscall.ProcAttr{Dir: filepath.Dir(cmd[0]), Env: sanitizedServerEnv(), Files: []uintptr{null.Fd(), stdoutW.Fd(), stderrW.Fd()}, Sys: &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}})
	if e != nil {
		stdoutR.Close()
		stderrR.Close()
		return nil, e
	}
	p := &winProcess{id: id, handle: syscall.Handle(h), readers: []*os.File{stdoutR, stderrR}}
	for i, w := range []io.Writer{out, errOut} {
		p.copies.Add(1)
		go func(r *os.File, w io.Writer) {
			defer p.copies.Done()
			defer r.Close()
			_, e := io.Copy(w, r)
			if e != nil {
				p.mu.Lock()
				if p.copyErr == nil {
					p.copyErr = e
				}
				p.mu.Unlock()
			}
		}(p.readers[i], w)
	}
	return p, nil
}
