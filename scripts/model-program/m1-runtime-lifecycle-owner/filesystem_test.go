package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func testController(t *testing.T, sys platform, trust admission, paths layout) *controller {
	t.Helper()
	c := newController(sys, trust, paths)
	t.Cleanup(func() {
		if e := c.closeFilesystem(); e != nil {
			t.Errorf("close filesystem: %v", e)
		}
	})
	return c
}

// On Windows these fake-process integration tests use the actual native file
// primitives. On other hosts this small portable adapter tests control flow;
// it is NOT a substitute for the Windows native qualification.
func (f *fakePlatform) nativeFS() filesystemPlatform {
	p, _ := any(realPlatform{}).(filesystemPlatform)
	return p
}
func (f *fakePlatform) openRoot(path string) (*os.File, error) {
	if p := f.nativeFS(); p != nil {
		return p.openRoot(path)
	}
	return os.Open(path)
}
func (f *fakePlatform) guardIdentity(file *os.File) (directoryIdentity, error) {
	return f.directoryIdentity(file.Name())
}
func (f *fakePlatform) openRelative(parent *os.File, name, expected string, mode int) (*os.File, error) {
	if f.beforeOpen != nil {
		if e := f.beforeOpen(mode, expected); e != nil {
			return nil, e
		}
	}
	if rp, _ := f.pathIsReparse(expected); rp {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if p := f.nativeFS(); p != nil {
		return p.openRelative(parent, name, expected, mode)
	}
	if parent == nil || filepath.Base(name) != name || name == ".." {
		return nil, fail("EXACT_COMPONENT_REQUIRED")
	}
	switch mode {
	case fsNewDirectory:
		if e := os.Mkdir(expected, 0700); e != nil {
			return nil, e
		}
		return os.Open(expected)
	case fsNew:
		return os.OpenFile(expected, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	case fsAppend:
		return os.OpenFile(expected, os.O_RDWR, 0600)
	default:
		return os.Open(expected)
	}
}
func (f *fakePlatform) handleIdentity(file *os.File) (fileIdentity, error) {
	if p := f.nativeFS(); p != nil {
		return p.handleIdentity(file)
	}
	st, e := file.Stat()
	if e != nil {
		return fileIdentity{}, e
	}
	for i, old := range f.fakeIDs {
		if os.SameFile(st, old) {
			return fileIdentity{"test-volume", fmt.Sprint(i), st.IsDir()}, nil
		}
	}
	f.fakeIDs = append(f.fakeIDs, st)
	return fileIdentity{"test-volume", fmt.Sprint(len(f.fakeIDs) - 1), st.IsDir()}, nil
}
func (f *fakePlatform) deleteByHandle(file *os.File) error {
	if p := f.nativeFS(); p != nil {
		return p.deleteByHandle(file)
	}
	return os.Remove(file.Name())
}
func (f *fakePlatform) renameByHandle(file, parent *os.File, name string, replace bool) error {
	dst := filepath.Join(parent.Name(), name)
	if p := f.nativeFS(); p != nil {
		if e := p.renameByHandle(file, parent, name, replace); e != nil {
			return e
		}
	} else {
		if _, e := os.Lstat(dst); e == nil && !replace {
			return os.ErrExist
		}
		if e := os.Rename(file.Name(), dst); e != nil {
			return e
		}
	}
	if f.afterRename != nil {
		return f.afterRename(file.Name(), dst)
	}
	return nil
}
