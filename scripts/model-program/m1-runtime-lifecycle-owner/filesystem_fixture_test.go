package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Test-only platform seam. No constructor, switch or fixture path is exposed by
// the production CLI. On Windows these calls use the same native primitives;
// on Linux they are a functional model, NOT native qualification evidence.
func (f *fakePlatform) openDirectoryAt(parent *os.File, path string, create bool) (*os.File, error) {
	if e := f.fixturePath(path); e != nil {
		return nil, e
	}
	return fixtureOpenDirectory(parent, path, create)
}
func (f *fakePlatform) openFileAt(parent *os.File, path string, create bool, access string) (*os.File, error) {
	if e := f.fixturePath(path); e != nil {
		return nil, e
	}
	return fixtureOpenFile(parent, path, create, access)
}
func (f *fakePlatform) fixturePath(path string) error {
	if f.reparse[filepath.Clean(path)] {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	got, e := f.finalPath(path)
	if e != nil {
		return e
	}
	if !samePath(got, path) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	return nil
}
func (f *fakePlatform) handleIdentity(file *os.File) (string, error) {
	st, e := file.Stat()
	if e != nil {
		return "", e
	}
	if f.fileIDs == nil {
		f.fileIDs = map[string]os.FileInfo{}
	}
	for id, old := range f.fileIDs {
		if os.SameFile(st, old) {
			return id, nil
		}
	}
	id := fmt.Sprintf("fixture:%d", len(f.fileIDs)+1)
	f.fileIDs[id] = st
	return id, nil
}
func (f *fakePlatform) directoryIdentityHandle(file *os.File) (directoryIdentity, error) {
	return f.directoryIdentity(file.Name())
}
func (f *fakePlatform) deleteHandle(file *os.File, path string) error {
	st, e := file.Stat()
	if e != nil {
		return e
	}
	live, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !os.SameFile(st, live) {
		return fail("FILESYSTEM_OBJECT_NOT_CREATED_BY_THIS_ATTEMPT")
	}
	return fixtureDelete(file, path)
}
func (f *fakePlatform) renameHandle(file, parent *os.File, dst string, replace bool) error {
	if f.publishFault == "before" {
		return fail("FIXTURE_PRE_COMMIT_FAILURE")
	}
	if e := fixtureRename(file, parent, dst, replace); e != nil {
		return e
	}
	if f.publishFault == "after" {
		f.publishFault = ""
		return fail("FIXTURE_POST_COMMIT_FAILURE")
	}
	return nil
}
