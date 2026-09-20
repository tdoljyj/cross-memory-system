//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var (
	nt                    = syscall.NewLazyDLL("ntdll.dll")
	ntCreateFile          = nt.NewProc("NtCreateFile")
	ntSetInformationFile  = nt.NewProc("NtSetInformationFile")
	rtlNtStatusToDosError = nt.NewProc("RtlNtStatusToDosError")
	setFileInformation    = kernel32.NewProc("SetFileInformationByHandle")
)

type ntUnicode struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}
type ntObjectAttributes struct {
	Length                          uint32
	Root                            uintptr
	Name                            *ntUnicode
	Attributes                      uint32
	SecurityDescriptor, SecurityQoS uintptr
}
type ntIOStatus struct{ Status, Information uintptr }

func ntError(status uintptr) error {
	if int32(uint32(status)) >= 0 {
		return nil
	}
	n, _, _ := rtlNtStatusToDosError.Call(status)
	return syscall.Errno(n)
}
func checkedFile(h syscall.Handle, expected string) (*os.File, error) {
	f := os.NewFile(uintptr(h), expected)
	if f == nil {
		syscall.CloseHandle(h)
		return nil, fail("NATIVE_FILE_HANDLE_REQUIRED")
	}
	final, e := finalPathFromHandle(h)
	if e != nil || !samePath(final, expected) {
		f.Close()
		if e != nil {
			return nil, e
		}
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if _, e = (realPlatform{}).handleIdentity(f); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func (realPlatform) openRoot(path string) (*os.File, error) {
	if !samePath(filepath.Dir(path), path) || hasForbiddenWindowsPathSyntax(path) {
		return nil, fail("VOLUME_ROOT_REQUIRED")
	}
	ptr, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	h, e := syscall.CreateFile(ptr, 0x80|syscall.SYNCHRONIZE|0x20000,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return nil, e
	}
	return checkedFile(h, path)
}
func (realPlatform) openRelative(parent *os.File, name, expected string, mode int) (*os.File, error) {
	if parent == nil || name == "" || name == "." || name == ".." || strings.ContainsAny(name, `\/:`) || filepath.Base(name) != name {
		return nil, fail("EXACT_COMPONENT_REQUIRED")
	}
	if _, e := (realPlatform{}).handleIdentity(parent); e != nil {
		return nil, e
	}
	encoded, e := syscall.UTF16FromString(name)
	if e != nil {
		return nil, e
	}
	u := ntUnicode{Length: uint16((len(encoded) - 1) * 2), MaximumLength: uint16(len(encoded) * 2), Buffer: &encoded[0]}
	attr := ntObjectAttributes{Root: parent.Fd(), Name: &u, Attributes: 0x40}
	attr.Length = uint32(unsafe.Sizeof(attr))
	access := uint32(syscall.GENERIC_READ | syscall.SYNCHRONIZE)
	share := uint32(syscall.FILE_SHARE_READ)
	disposition := uint32(1)                    // FILE_OPEN, never OPEN_IF or overwrite
	options := uint32(0x00200000 | 0x20 | 0x40) // OPEN_REPARSE_POINT, SYNC_NONALERT, NON_DIRECTORY
	switch mode {
	case fsRead:
	case fsNew:
		access |= syscall.GENERIC_WRITE
		disposition = 2
	case fsAppend:
		access |= syscall.GENERIC_WRITE
	case fsDirectory, fsNewDirectory, fsDeleteDirectory:
		access = 0x80 | syscall.SYNCHRONIZE | 0x20000 | 0x20
		options = 0x00200000 | 0x20 | 1
		share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE
		if mode == fsNewDirectory {
			disposition = 2
		}
		if mode == fsDeleteDirectory {
			access |= 0x10000
		}
	case fsDelete:
		access |= 0x10000
	default:
		return nil, fail("INVALID_NATIVE_FILE_MODE")
	}
	var h syscall.Handle
	var ios ntIOStatus
	status, _, _ := ntCreateFile.Call(uintptr(unsafe.Pointer(&h)), uintptr(access), uintptr(unsafe.Pointer(&attr)), uintptr(unsafe.Pointer(&ios)), 0, syscall.FILE_ATTRIBUTE_NORMAL, uintptr(share), uintptr(disposition), uintptr(options), 0, 0)
	runtime.KeepAlive(parent)
	runtime.KeepAlive(encoded)
	if e = ntError(status); e != nil {
		return nil, &os.PathError{Op: "NtCreateFile", Path: expected, Err: e}
	}
	return checkedFile(h, expected)
}
func (realPlatform) handleIdentity(f *os.File) (fileIdentity, error) {
	if f == nil {
		return fileIdentity{}, fail("NATIVE_FILE_HANDLE_REQUIRED")
	}
	var i syscall.ByHandleFileInformation
	if e := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &i); e != nil {
		return fileIdentity{}, e
	}
	if i.FileAttributes&fileAttributeReparsePoint != 0 {
		return fileIdentity{}, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	return fileIdentity{volume: fmt.Sprintf("%08x", i.VolumeSerialNumber), id: fmt.Sprintf("%08x%08x", i.FileIndexHigh, i.FileIndexLow), directory: i.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0}, nil
}
func (realPlatform) deleteByHandle(f *os.File) error {
	yes := uint32(1)
	ok, _, e := setFileInformation.Call(f.Fd(), 4, uintptr(unsafe.Pointer(&yes)), 4)
	runtime.KeepAlive(f)
	if ok == 0 {
		if e = nonzeroCallError(e); e != nil {
			return e
		}
		return fail("HANDLE_DELETE_FAILED")
	}
	return nil
}
func (realPlatform) renameByHandle(f, parent *os.File, name string, replace bool) error {
	if f == nil || parent == nil || name == "" || strings.ContainsAny(name, `\/:`) || name == "." || name == ".." {
		return fail("EXACT_COMPONENT_REQUIRED")
	}
	// One same-volume NTFS rename request. No copy fallback, backup exchange,
	// delete-current step, unsupported ReplaceFile WRITE_THROUGH flag, or CWD.
	// RootDirectory is the already-held state directory object.
	fs, _, e := volumeIdentity(parent.Name())
	if e != nil {
		return e
	}
	if !strings.EqualFold(fs, "NTFS") {
		return fail("NTFS_ATOMIC_RENAME_REQUIRED")
	}
	chars, e := syscall.UTF16FromString(name)
	if e != nil {
		return e
	}
	type renameInfo struct {
		Replace uint32
		Root    uintptr
		Length  uint32
		Name    [1]uint16
	}
	var header renameInfo
	off := unsafe.Offsetof(header.Name)
	raw := make([]byte, int(off)+len(chars)*2+8)
	info := (*renameInfo)(unsafe.Pointer(&raw[0]))
	if replace {
		info.Replace = 1
	}
	info.Root = parent.Fd()
	info.Length = uint32((len(chars) - 1) * 2)
	dest := unsafe.Slice((*uint16)(unsafe.Pointer(&raw[off])), len(chars))
	copy(dest, chars)
	var ios ntIOStatus
	status, _, _ := ntSetInformationFile.Call(f.Fd(), uintptr(unsafe.Pointer(&ios)), uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), 10) // FileRenameInformation
	runtime.KeepAlive(f)
	runtime.KeepAlive(parent)
	runtime.KeepAlive(raw)
	return ntError(status)
}

func (realPlatform) guardIdentity(f *os.File) (directoryIdentity, error) {
	id, e := (realPlatform{}).handleIdentity(f)
	if e != nil {
		return directoryIdentity{}, e
	}
	if !id.directory {
		return directoryIdentity{}, fail("ATTEMPT_GUARD_PARENT_MISSING_OR_UNSAFE")
	}
	resolved, e := finalPathFromHandle(syscall.Handle(f.Fd()))
	if e != nil {
		return directoryIdentity{}, e
	}
	fs, serial, e := volumeIdentity(resolved)
	if e != nil {
		return directoryIdentity{}, e
	}
	if serial != id.volume {
		return directoryIdentity{}, fail("GUARD_PARENT_VOLUME_DRIFT")
	}
	proc := advapi32.NewProc("GetKernelObjectSecurity")
	var needed uint32
	info := uintptr(ownerSecurityInformation | daclSecurityInformation)
	proc.Call(f.Fd(), info, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if needed == 0 || needed > 1<<20 {
		return directoryIdentity{}, fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	raw := make([]byte, needed)
	ok, _, er := proc.Call(f.Fd(), info, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), uintptr(unsafe.Pointer(&needed)))
	runtime.KeepAlive(f)
	if ok == 0 {
		if e = nonzeroCallError(er); e != nil {
			return directoryIdentity{}, e
		}
		return directoryIdentity{}, fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	var owner uintptr
	var defaulted uint32
	ok, _, er = procGetSecurityDescriptorOwner.Call(uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 {
		return directoryIdentity{}, fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	var sidText *uint16
	ok, _, er = procConvertSidToStringSidW.Call(owner, uintptr(unsafe.Pointer(&sidText)))
	if ok == 0 {
		return directoryIdentity{}, fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(sidText)))
	length, _, _ := kernel32.NewProc("lstrlenW").Call(uintptr(unsafe.Pointer(sidText)))
	if length == 0 || length > 183 {
		return directoryIdentity{}, fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	sid := syscall.UTF16ToString(unsafe.Slice(sidText, int(length)))
	runtime.KeepAlive(raw)
	return directoryIdentity{canonicalPath: resolved, filesystemType: fs, volumeSerial: id.volume, fileID: id.id, ownerSID: sid, securityDescriptorSHA256: sha(raw[:needed])}, nil
}
