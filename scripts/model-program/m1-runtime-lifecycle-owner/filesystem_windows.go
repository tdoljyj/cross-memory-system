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
	ntdll                      = syscall.NewLazyDLL("ntdll.dll")
	ntCreateFile               = ntdll.NewProc("NtCreateFile")
	ntSetInformationFile       = ntdll.NewProc("NtSetInformationFile")
	rtlNtStatusToDosError      = ntdll.NewProc("RtlNtStatusToDosError")
	setFileInformationByHandle = kernel32.NewProc("SetFileInformationByHandle")
	getKernelObjectSecurity    = advapi32.NewProc("GetKernelObjectSecurity")
)

type nativeUnicodeString struct {
	length, maximum uint16
	buffer          *uint16
}
type nativeObjectAttributes struct {
	length                   uint32
	root                     syscall.Handle
	name                     *nativeUnicodeString
	attributes               uint32
	securityDescriptor       uintptr
	securityQualityOfService uintptr
}
type nativeIOStatus struct{ status, information uintptr }

func ntStatusError(status uintptr) error {
	if int32(uint32(status)) >= 0 {
		return nil
	}
	dos, _, _ := rtlNtStatusToDosError.Call(status)
	return syscall.Errno(dos)
}
func nativeRelativeOpen(parent *os.File, expected string, create, directory bool, access string) (*os.File, error) {
	if parent == nil || !filepath.IsAbs(expected) || hasForbiddenWindowsPathSyntax(expected) {
		return nil, fail("HANDLE_PARENT_REQUIRED")
	}
	parentPath, e := finalPathFromHandle(syscall.Handle(parent.Fd()))
	if e != nil || !samePath(parentPath, filepath.Dir(expected)) {
		return nil, fail("HANDLE_PARENT_IDENTITY_DRIFT")
	}
	var parentInfo syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(syscall.Handle(parent.Fd()), &parentInfo); e != nil {
		return nil, e
	}
	if parentInfo.FileAttributes&fileAttributeReparsePoint != 0 || parentInfo.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	name := filepath.Base(expected)
	if name == "." || name == ".." || strings.ContainsAny(name, `/\:`) {
		return nil, fail("RELATIVE_LEAF_INVALID")
	}
	chars, e := syscall.UTF16FromString(name)
	if e != nil {
		return nil, e
	}
	us := nativeUnicodeString{length: uint16(2 * (len(chars) - 1)), maximum: uint16(2 * len(chars)), buffer: &chars[0]}
	oa := nativeObjectAttributes{root: syscall.Handle(parent.Fd()), name: &us, attributes: 0x40 | 0x1000} // CASE_INSENSITIVE | DONT_REPARSE
	oa.length = uint32(unsafe.Sizeof(oa))
	desired := uint32(syscall.GENERIC_READ | syscall.SYNCHRONIZE)
	share := uint32(syscall.FILE_SHARE_READ | syscall.FILE_SHARE_DELETE)
	if directory {
		desired = syscall.FILE_LIST_DIRECTORY | uint32(0x80) | uint32(0x20) | uint32(0x20000) | syscall.SYNCHRONIZE
		share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE // deny DELETE; names cannot move
	} else if access == "write" {
		desired |= syscall.GENERIC_WRITE
		share = syscall.FILE_SHARE_READ
	}
	if access == "immutable" {
		share = syscall.FILE_SHARE_READ
	}
	if access == "delete" {
		desired |= uint32(0x10000)
		share = syscall.FILE_SHARE_READ // freeze the source object until this handle closes
	}
	disposition := uintptr(1) // FILE_OPEN
	if create {
		disposition = 2
	} // FILE_CREATE, never OPEN_IF/SUPERSEDE/overwrite
	options := uintptr(0x20 | 0x200000) // SYNCHRONOUS_IO_NONALERT | OPEN_REPARSE_POINT
	if directory {
		options |= 1
	} else if access != "delete" {
		options |= 0x40
	}
	var handle syscall.Handle
	var ios nativeIOStatus
	status, _, _ := ntCreateFile.Call(uintptr(unsafe.Pointer(&handle)), uintptr(desired), uintptr(unsafe.Pointer(&oa)), uintptr(unsafe.Pointer(&ios)), 0, syscall.FILE_ATTRIBUTE_NORMAL, uintptr(share), disposition, options, 0, 0)
	runtime.KeepAlive(parent)
	runtime.KeepAlive(chars)
	runtime.KeepAlive(us)
	runtime.KeepAlive(oa)
	if e = ntStatusError(status); e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(handle), expected)
	if f == nil {
		syscall.CloseHandle(handle)
		e := fail("INVALID_NATIVE_FILE_HANDLE")
		if create {
			return nil, &createdObjectFailure{cause: e}
		}
		return nil, e
	}
	if e = validateNativeHandle(f, expected, directory); e != nil {
		f.Close()
		if create {
			return nil, &createdObjectFailure{cause: e}
		}
		return nil, e
	}
	return f, nil
}
func validateNativeHandle(f *os.File, expected string, directory bool) error {
	if f == nil {
		return fail("WRITE_HANDLE_REQUIRED")
	}
	path, e := finalPathFromHandle(syscall.Handle(f.Fd()))
	if e != nil {
		return e
	}
	if !samePath(path, expected) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	var info syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); e != nil {
		return e
	}
	if info.FileAttributes&fileAttributeReparsePoint != 0 {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	isDir := info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0
	if directory && !isDir {
		return fail("DIRECTORY_HANDLE_REQUIRED")
	}
	if !isDir && info.NumberOfLinks != 1 {
		return fail("WRITE_HANDLE_HARDLINK_FORBIDDEN")
	}
	return nil
}
func (realPlatform) openDirectoryAt(parent *os.File, path string, create bool) (*os.File, error) {
	if parent != nil {
		return nativeRelativeOpen(parent, path, create, true, "read")
	}
	if create || !samePath(path, filepath.Dir(path)) || !filepath.IsAbs(path) || hasForbiddenWindowsPathSyntax(path) {
		return nil, fail("VOLUME_ROOT_HANDLE_REQUIRED")
	}
	ptr, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	h, e := syscall.CreateFile(ptr, syscall.FILE_LIST_DIRECTORY|uint32(0x80)|uint32(0x20000), syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(h), path)
	if e = validateNativeHandle(f, path, true); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func (realPlatform) openFileAt(parent *os.File, path string, create bool, access string) (*os.File, error) {
	if access != "read" && access != "write" && access != "delete" && access != "immutable" {
		return nil, fail("NATIVE_FILE_ACCESS_INVALID")
	}
	return nativeRelativeOpen(parent, path, create, false, access)
}
func (realPlatform) handleIdentity(f *os.File) (string, error) {
	if f == nil {
		return "", fail("WRITE_HANDLE_REQUIRED")
	}
	var info syscall.ByHandleFileInformation
	if e := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); e != nil {
		return "", e
	}
	if info.FileAttributes&fileAttributeReparsePoint != 0 {
		return "", fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	return fmt.Sprintf("%08x:%08x%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
func (sys realPlatform) directoryIdentityHandle(f *os.File) (directoryIdentity, error) {
	path, e := finalPathFromHandle(syscall.Handle(f.Fd()))
	if e != nil {
		return directoryIdentity{}, e
	}
	if e = validateNativeHandle(f, path, true); e != nil {
		return directoryIdentity{}, e
	}
	var info syscall.ByHandleFileInformation
	if e = syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); e != nil {
		return directoryIdentity{}, e
	}
	fs, serial, e := volumeIdentity(path)
	if e != nil {
		return directoryIdentity{}, e
	}
	if !strings.EqualFold(fs, "NTFS") || serial != fmt.Sprintf("%08x", info.VolumeSerialNumber) {
		return directoryIdentity{}, fail("GUARD_PARENT_FILESYSTEM_IDENTITY_FAILED")
	}
	owner, sd, e := fileSecurityIdentityHandle(f)
	if e != nil {
		return directoryIdentity{}, e
	}
	return directoryIdentity{canonicalPath: path, filesystemType: fs, volumeSerial: serial, fileID: fmt.Sprintf("%08x%08x", info.FileIndexHigh, info.FileIndexLow), ownerSID: owner, securityDescriptorSHA256: sd}, nil
}
func fileSecurityIdentityHandle(f *os.File) (string, string, error) {
	var needed uint32
	info := uintptr(ownerSecurityInformation | daclSecurityInformation)
	getKernelObjectSecurity.Call(f.Fd(), info, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if needed == 0 || needed > 1<<20 {
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	raw := make([]byte, needed)
	ok, _, er := getKernelObjectSecurity.Call(f.Fd(), info, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), uintptr(unsafe.Pointer(&needed)))
	if ok == 0 {
		return "", "", nonzeroCallError(er)
	}
	var sid uintptr
	var defaulted uint32
	ok, _, er = procGetSecurityDescriptorOwner.Call(uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&sid)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || sid == 0 {
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	var str *uint16
	ok, _, er = procConvertSidToStringSidW.Call(sid, uintptr(unsafe.Pointer(&str)))
	if ok == 0 || str == nil {
		return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(str)))
	chars := []uint16{}
	for i := 0; i < 256; i++ {
		u := *(*uint16)(unsafe.Add(unsafe.Pointer(str), i*2))
		if u == 0 {
			return syscall.UTF16ToString(chars), sha(raw[:needed]), nil
		}
		chars = append(chars, u)
	}
	return "", "", fail("GUARD_PARENT_SECURITY_IDENTITY_FAILED")
}
func (realPlatform) deleteHandle(f *os.File, expected string) error {
	if e := validateNativeHandle(f, expected, false); e != nil {
		return e
	}
	var disposition uint32 = 1
	ok, _, er := setFileInformationByHandle.Call(f.Fd(), 4, uintptr(unsafe.Pointer(&disposition)), unsafe.Sizeof(disposition))
	if ok == 0 {
		if e := nonzeroCallError(er); e != nil {
			return e
		}
		return fail("NATIVE_HANDLE_DELETE_FAILED")
	}
	return nil
}
func (realPlatform) renameHandle(f, parent *os.File, dst string, replace bool) error {
	src, e := finalPathFromHandle(syscall.Handle(f.Fd()))
	if e != nil {
		return e
	}
	if !samePath(filepath.Dir(src), filepath.Dir(dst)) {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	pp, e := finalPathFromHandle(syscall.Handle(parent.Fd()))
	if e != nil || !samePath(pp, filepath.Dir(dst)) {
		return fail("HANDLE_PARENT_IDENTITY_DRIFT")
	}
	fs, _, e := volumeIdentity(pp)
	if e != nil || !strings.EqualFold(fs, "NTFS") {
		return fail("NATIVE_ATOMIC_RENAME_REQUIRES_NTFS")
	}
	if e = validateNativeHandle(f, src, false); e != nil {
		return e
	}
	name, e := syscall.UTF16FromString(filepath.Base(dst))
	if e != nil {
		return e
	}
	name = name[:len(name)-1]
	// FILE_RENAME_INFORMATION_EX: use the actual ABI offsets, not a packed
	// guessed structure. Native class 65, POSIX replacement, no API fallback.
	type renameHeader struct {
		flags      uint32
		root       syscall.Handle
		nameLength uint32
		first      uint16
	}
	var header renameHeader
	offset := unsafe.Offsetof(header.first)
	raw := make([]byte, int(unsafe.Sizeof(header))+len(name)*2)
	h := (*renameHeader)(unsafe.Pointer(&raw[0]))
	if replace {
		h.flags = 0x1 | 0x2
	} // REPLACE_IF_EXISTS | POSIX_SEMANTICS
	// Same-directory rename: a simple name with NULL RootDirectory is the
	// documented form. The source creation handle is anchored in the pinned
	// directory. No pathname traversal or cross-directory move is requested.
	h.root = 0
	h.nameLength = uint32(len(name) * 2)
	for i, ch := range name {
		*(*uint16)(unsafe.Pointer(&raw[int(offset)+2*i])) = ch
	}
	var ios nativeIOStatus
	status, _, _ := ntSetInformationFile.Call(f.Fd(), uintptr(unsafe.Pointer(&ios)), uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), 65)
	runtime.KeepAlive(raw)
	runtime.KeepAlive(parent)
	runtime.KeepAlive(f)
	if e = ntStatusError(status); e != nil {
		return e
	}
	return validateNativeHandle(f, dst, false)
}
