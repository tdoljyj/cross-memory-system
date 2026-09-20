package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// All filesystem effects go through handle-relative operations. The parent
// directory chain is held open against rename/deletion for the attempt. Each
// native relative open separately rejects reparse traversal on the actual handles.
// The creation ledger is populated from the CREATE_NEW handle, not from names.
// A missing ledger entry is forensic state, never implicit deletion authority.
type filesystemPlatform interface {
	openDirectoryAt(parent *os.File, path string, create bool) (*os.File, error)
	openFileAt(parent *os.File, path string, create bool, access string) (*os.File, error)
	handleIdentity(*os.File) (string, error)
	directoryIdentityHandle(*os.File) (directoryIdentity, error)
	deleteHandle(*os.File, string) error
	renameHandle(*os.File, *os.File, string, bool) error
}

func pathKey(path string) string { return strings.ToLower(filepath.Clean(path)) }
func (c *controller) filesystem() (filesystemPlatform, error) {
	f, ok := c.sys.(filesystemPlatform)
	if !ok {
		return nil, fail("HANDLE_RELATIVE_FILESYSTEM_UNAVAILABLE")
	}
	return f, nil
}
func (c *controller) pinDirectory(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || hasForbiddenWindowsPathSyntax(path) {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	key := pathKey(path)
	if f := c.dirPins[key]; f != nil {
		if e := c.verifySafeExistingPath(path); e != nil {
			return nil, e
		}
		return f, nil
	}
	sys, e := c.filesystem()
	if e != nil {
		return nil, e
	}
	var parent *os.File
	dir := filepath.Dir(filepath.Clean(path))
	if !samePath(path, dir) {
		parent, e = c.pinDirectory(dir)
		if e != nil {
			return nil, e
		}
	}
	f, e := sys.openDirectoryAt(parent, path, false)
	if e != nil {
		return nil, e
	}
	// openDirectoryAt validates the actual returned directory handle, including
	// no-follow, final path, directory type and native identity before returning.
	c.dirPins[key] = f
	return f, nil
}
func (c *controller) closeFilesystem() error {
	var pinErr error
	for k, f := range c.immutablePins {
		pinErr = errors.Join(pinErr, f.Close())
		delete(c.immutablePins, k)
	}
	keys := make([]string, 0, len(c.dirPins))
	for k := range c.dirPins {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	result := pinErr
	for _, k := range keys {
		result = errors.Join(result, c.dirPins[k].Close())
		delete(c.dirPins, k)
	}
	return result
}
func (c *controller) ownedIdentity(f *os.File, path string, created bool) error {
	sys, e := c.filesystem()
	if e != nil {
		return e
	}
	identity, e := sys.handleIdentity(f)
	if e != nil {
		return e
	}
	if identity == "" {
		return fail("EMPTY_FILESYSTEM_OBJECT_IDENTITY")
	}
	key := pathKey(path)
	if created {
		if _, exists := c.created[key]; exists {
			return fail("CREATION_LEDGER_COLLISION")
		}
		c.created[key] = identity
		return nil
	}
	if c.created[key] == "" || c.created[key] != identity {
		return fail("FILESYSTEM_OBJECT_NOT_CREATED_BY_THIS_ATTEMPT")
	}
	return nil
}
func (c *controller) openOwnedWrite(path string, create bool) (*os.File, error) {
	if !c.allowedWritePath(path) {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	if !create && samePath(path, c.paths.guard) {
		return nil, fail("PERSISTENT_GUARD_MUTATION_FORBIDDEN")
	}
	sys, e := c.filesystem()
	if e != nil {
		return nil, e
	}
	parent, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	f, e := sys.openFileAt(parent, path, create, "write")
	if e != nil {
		return nil, e
	}
	if e = c.sys.verifyWriteHandle(f, path); e == nil {
		e = c.ownedIdentity(f, path, create)
	}
	if e != nil {
		_ = f.Close()
		if create {
			return nil, &createdObjectFailure{cause: e}
		}
		return nil, e
	} // NEVER path-delete on validation failure.
	if !create {
		if e = c.verifyNoNamedStreams(path); e != nil {
			_ = f.Close()
			return nil, e
		}
		if _, e = f.Seek(0, io.SeekEnd); e != nil {
			_ = f.Close()
			return nil, e
		}
	}
	return f, nil
}
func writeSyncClose(f *os.File, raw []byte) error {
	n, e := f.Write(raw)
	if e == nil && n != len(raw) {
		e = io.ErrShortWrite
	}
	if e == nil {
		e = f.Sync()
	}
	return errors.Join(e, f.Close())
}
func (c *controller) openOwnedRead(path string) (*os.File, error) {
	sys, e := c.filesystem()
	if e != nil {
		return nil, e
	}
	parent, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	f, e := sys.openFileAt(parent, path, false, "read")
	if e != nil {
		return nil, e
	}
	if e = c.ownedIdentity(f, path, false); e != nil {
		_ = f.Close()
		return nil, e
	}
	return f, nil
}
func (c *controller) readOwned(path string) ([]byte, error) {
	f, e := c.openOwnedRead(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if len(b) > 1<<20 {
		return nil, fail("OWNED_JSON_SIZE_LIMIT")
	}
	return b, e
}
func (c *controller) verifyCreatedPath(path string, directory bool) error {
	if directory {
		f, e := c.pinDirectory(path)
		if e != nil {
			return e
		}
		return c.ownedIdentity(f, path, false)
	}
	f, e := c.openOwnedRead(path)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = c.sys.verifyWriteHandle(f, path); e != nil {
		return e
	}
	links, e := c.sys.hardlinkCount(path)
	if e != nil {
		return e
	}
	if links != 1 {
		return fail("SLOT_HARDLINK_FORBIDDEN")
	}
	return c.verifyNoNamedStreams(path)
}
func (c *controller) removeOwned(path string) error {
	// Persistent guard, guard parent, evidence and source can never reach delete.
	if !withinPath(c.paths.testRoot, path) || !c.allowedWritePath(path) {
		return fail("DELETE_OUTSIDE_EXACT_TEST_ROOT")
	}
	key := pathKey(path)
	if c.created[key] == "" {
		return fail("FILESYSTEM_OBJECT_NOT_CREATED_BY_THIS_ATTEMPT")
	}
	sys, e := c.filesystem()
	if e != nil {
		return e
	}
	parent, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return e
	}
	// An identity check after the exclusive deletion handle opens closes the
	// release-to-open interval. It never deletes a replacement by pathname.
	if pinned := c.immutablePins[key]; pinned != nil {
		if e = pinned.Close(); e != nil {
			return e
		}
		delete(c.immutablePins, key)
	}
	if dir := c.dirPins[key]; dir != nil {
		if e = dir.Close(); e != nil {
			return e
		}
		delete(c.dirPins, key)
	}
	f, e := sys.openFileAt(parent, path, false, "delete")
	if e != nil {
		return e
	}
	defer f.Close()
	if e = c.ownedIdentity(f, path, false); e != nil {
		return e
	}
	st, e := f.Stat()
	if e != nil {
		return e
	}
	if !st.IsDir() {
		if e = c.verifyNoNamedStreams(path); e != nil {
			return e
		}
	}
	if e = sys.deleteHandle(f, path); e != nil {
		return e
	}
	delete(c.created, key)
	return nil
}

// The source handle is already flushed, re-opened and identity checked. The
// native operation is one same-directory NTFS rename; there is no copy/delete
// fallback and no removal of Current before replacement.
func (c *controller) publishOwned(temp, dst string, replace bool) error {
	if !samePath(filepath.Dir(temp), filepath.Dir(dst)) || !samePath(dst, currentPath(c.paths)) {
		return fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	sys, e := c.filesystem()
	if e != nil {
		return e
	}
	parent, e := c.pinDirectory(filepath.Dir(temp))
	if e != nil {
		return e
	}
	f, e := sys.openFileAt(parent, temp, false, "delete")
	if e != nil {
		return e
	}
	defer f.Close()
	if e = c.ownedIdentity(f, temp, false); e != nil {
		return e
	}
	if e = c.sys.verifyWriteHandle(f, temp); e != nil {
		return e
	}
	if e = c.verifyNoNamedStreams(temp); e != nil {
		return e
	}
	if replace {
		old, e := c.openOwnedRead(dst)
		if e != nil {
			return e
		}
		defer old.Close()
		if e = c.verifyNoNamedStreams(dst); e != nil {
			return e
		}
	}
	id := c.created[pathKey(temp)]
	err := sys.renameHandle(f, parent, dst, replace)
	// Only the new creation identity can establish commit after an ambiguous
	// return. No outside object is adopted into the ownership ledger.
	if resolved, re := c.sys.finalPath(dst); re == nil && samePath(resolved, dst) {
		post, pe := sys.openFileAt(parent, dst, false, "read")
		if pe == nil {
			got, ie := sys.handleIdentity(post)
			_ = post.Close()
			if ie == nil && got == id {
				c.created[pathKey(dst)] = id
				delete(c.created, pathKey(temp))
			}
		}
	}
	return err
}

// Freeze the actual payload/source object from attestation through use. Native
// read handles share only READ, so writers, unlink and rename cannot substitute
// a different file between hashing and launching the reviewed child.
func (c *controller) pinImmutable(path string, owned bool) (*os.File, error) {
	key := pathKey(path)
	if f := c.immutablePins[key]; f != nil {
		if owned {
			if e := c.ownedIdentity(f, path, false); e != nil {
				return nil, e
			}
		}
		return f, nil
	}
	sys, e := c.filesystem()
	if e != nil {
		return nil, e
	}
	parent, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	f, e := sys.openFileAt(parent, path, false, "immutable")
	if e != nil {
		return nil, e
	}
	if owned {
		e = c.ownedIdentity(f, path, false)
	}
	if e == nil {
		e = c.sys.verifyWriteHandle(f, path)
	}
	if e != nil {
		_ = f.Close()
		return nil, e
	}
	c.immutablePins[key] = f
	return f, nil
}

// CREATE_NEW succeeded, but a later gate failed. Such a file is retained for
// forensics. In particular it still consumes the one-shot Guard; the caller
// must not treat this as a pre-effect error or silently permit another attempt.
type createdObjectFailure struct{ cause error }

func (e *createdObjectFailure) Error() string {
	return "CREATED_OBJECT_VALIDATION_FAILED: " + e.cause.Error()
}
func (e *createdObjectFailure) Unwrap() error { return e.cause }

// Enumerate a fresh handle to the same pinned directory object; never enumerate
// a pathname that could refer to a different object. A fresh handle also resets
// the directory scan for repeated Guard Parent checks.
func (c *controller) readPinnedDirectory(path string) ([]os.DirEntry, error) {
	pinned, e := c.pinDirectory(path)
	if e != nil {
		return nil, e
	}
	sys, e := c.filesystem()
	if e != nil {
		return nil, e
	}
	parent, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	f, e := sys.openDirectoryAt(parent, path, false)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	expected, e := sys.handleIdentity(pinned)
	if e != nil {
		return nil, e
	}
	actual, e := sys.handleIdentity(f)
	if e != nil {
		return nil, e
	}
	if actual != expected {
		return nil, fail("DIRECTORY_ENUMERATION_IDENTITY_DRIFT")
	}
	return f.ReadDir(-1)
}
