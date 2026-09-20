package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// These operations are native, handle-relative on Windows. No caller can supply
// a filesystem implementation: the only alternate implementation is in _test.go.
const (
	fsRead = iota
	fsNew
	fsAppend
	fsDirectory
	fsNewDirectory
	fsDelete
	fsDeleteDirectory
)

type fileIdentity struct {
	volume, id string
	directory  bool
}
type filesystemPlatform interface {
	openRoot(string) (*os.File, error)
	guardIdentity(*os.File) (directoryIdentity, error)
	openRelative(*os.File, string, string, int) (*os.File, error)
	handleIdentity(*os.File) (fileIdentity, error)
	deleteByHandle(*os.File) error
	renameByHandle(*os.File, *os.File, string, bool) error
}

func fileKey(p string) string { return strings.ToLower(filepath.Clean(p)) }
func (c *controller) fsPlatform() (filesystemPlatform, error) {
	p, ok := c.sys.(filesystemPlatform)
	if !ok {
		return nil, fail("HANDLE_RELATIVE_FILESYSTEM_REQUIRED")
	}
	return p, nil
}

// Every directory component is opened relative to the already-pinned parent,
// without following a reparse point. Handles stay alive until finalization.
func (c *controller) pinDirectory(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || hasForbiddenWindowsPathSyntax(path) {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	path = filepath.Clean(path)
	key := fileKey(path)
	if f := c.directories[key]; f != nil {
		p, e := c.fsPlatform()
		if e != nil {
			return nil, e
		}
		id, e := p.handleIdentity(f)
		if e != nil {
			return nil, e
		}
		if !id.directory {
			return nil, fail("PINNED_DIRECTORY_REQUIRED")
		}
		return f, nil
	}
	p, e := c.fsPlatform()
	if e != nil {
		return nil, e
	}
	var f *os.File
	parent := filepath.Dir(path)
	if samePath(parent, path) {
		f, e = p.openRoot(path)
	} else {
		var d *os.File
		d, e = c.pinDirectory(parent)
		if e != nil {
			return nil, e
		}
		f, e = p.openRelative(d, filepath.Base(path), path, fsDirectory)
	}
	if e != nil {
		return nil, e
	}
	id, e := p.handleIdentity(f)
	if e != nil || !id.directory {
		f.Close()
		if e != nil {
			return nil, e
		}
		return nil, fail("PINNED_DIRECTORY_REQUIRED")
	}
	if old, ok := c.created[key]; ok && old != id {
		f.Close()
		return nil, fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	c.directories[key] = f
	return f, nil
}
func (c *controller) createOwnedDirectory(path string) error {
	if !c.allowedWritePath(path) {
		return fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	d, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return e
	}
	p, e := c.fsPlatform()
	if e != nil {
		return e
	}
	f, e := p.openRelative(d, filepath.Base(path), path, fsNewDirectory)
	if e != nil {
		return e
	}
	id, e := p.handleIdentity(f)
	if e != nil {
		f.Close()
		return e
	}
	c.created[fileKey(path)] = id
	c.directories[fileKey(path)] = f
	return nil
}

// Opening is not a write of payload bytes. Verification happens BEFORE the
// handle is returned to a writer; even an unsuccessful create is retained.
func (c *controller) openOwnedWrite(path string, appendExisting bool) (*os.File, error) {
	if !c.allowedWritePath(path) {
		return nil, fail("REPARSE_POINT_OR_PATH_ESCAPE_DETECTED")
	}
	d, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	p, e := c.fsPlatform()
	if e != nil {
		return nil, e
	}
	mode := fsNew
	old, known := c.created[fileKey(path)]
	if appendExisting {
		if !known {
			return nil, fail("UNOWNED_APPEND_FORBIDDEN")
		}
		mode = fsAppend
	}
	f, e := p.openRelative(d, filepath.Base(path), path, mode)
	if e != nil {
		return nil, e
	}
	id, e := p.handleIdentity(f)
	if e != nil {
		f.Close()
		return nil, e
	}
	if appendExisting && old != id {
		f.Close()
		return nil, fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	if !appendExisting {
		c.created[fileKey(path)] = id
	}
	if e = c.sys.verifyWriteHandle(f, path); e != nil {
		f.Close()
		return nil, e
	}
	if appendExisting {
		if _, e = f.Seek(0, io.SeekEnd); e != nil {
			f.Close()
			return nil, e
		}
	}
	return f, nil
}
func (c *controller) openBoundRead(path string) (*os.File, error) {
	d, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	p, e := c.fsPlatform()
	if e != nil {
		return nil, e
	}
	f, e := p.openRelative(d, filepath.Base(path), path, fsRead)
	if e != nil {
		return nil, e
	}
	id, e := p.handleIdentity(f)
	if e != nil {
		f.Close()
		return nil, e
	}
	if old, known := c.created[fileKey(path)]; known && old != id {
		f.Close()
		return nil, fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	return f, nil
}
func (c *controller) readBoundFile(path string) ([]byte, error) {
	f, e := c.openBoundRead(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if len(b) > 1<<20 {
		return nil, fail("STATE_FILE_SIZE_LIMIT")
	}
	return b, e
}

// Payload pins are read-only and deny new writers/deleters, and are held through
// the child lifetime. No closed validation handle is used as a launch guarantee.
func (c *controller) pinPayload(path string) error {
	key := fileKey(path)
	if c.payloadPins[key] != nil {
		return nil
	}
	f, e := c.openBoundRead(path)
	if e != nil {
		return e
	}
	c.payloadPins[key] = f
	return nil
}
func (c *controller) checkCreated(path string, directory bool) error {
	expected, ok := c.created[fileKey(path)]
	if !ok || expected.directory != directory {
		return fail("EXACT_CREATED_OBJECT_REQUIRED")
	}
	var f *os.File
	var e error
	if directory {
		f, e = c.pinDirectory(path)
	} else {
		f, e = c.openBoundRead(path)
		if e == nil {
			defer f.Close()
		}
	}
	if e != nil {
		return e
	}
	p, e := c.fsPlatform()
	if e != nil {
		return e
	}
	actual, e := p.handleIdentity(f)
	if e != nil {
		return e
	}
	if actual != expected {
		return fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	if !directory {
		if e = c.verifyNoNamedStreams(path); e != nil {
			return e
		}
		n, e := c.sys.hardlinkCount(path)
		if e != nil {
			return e
		}
		if n != 1 {
			return fail("SLOT_HARDLINK_FORBIDDEN")
		}
	}
	return nil
}
func (c *controller) removeCreated(path string) error {
	if !c.allowedWritePath(path) || samePath(path, c.paths.guard) || withinPath(c.paths.evidence, path) {
		return fail("PERSISTENT_OR_UNOWNED_DELETE_FORBIDDEN")
	}
	key := fileKey(path)
	expected, ok := c.created[key]
	if !ok {
		return fail("EXACT_CREATED_OBJECT_REQUIRED")
	}
	p, e := c.fsPlatform()
	if e != nil {
		return e
	}
	d, e := c.pinDirectory(filepath.Dir(path))
	if e != nil {
		return e
	}
	// Release only this object's read pin. The parent stays pinned. The actual
	// deletion handle must match the recorded creation identity after reopening.
	if f := c.payloadPins[key]; f != nil {
		if e = f.Close(); e != nil {
			return e
		}
		delete(c.payloadPins, key)
	}
	if f := c.directories[key]; f != nil {
		if e = f.Close(); e != nil {
			return e
		}
		delete(c.directories, key)
	}
	mode := fsDelete
	if expected.directory {
		mode = fsDeleteDirectory
	}
	f, e := p.openRelative(d, filepath.Base(path), path, mode)
	if e != nil {
		return e
	}
	defer f.Close()
	actual, e := p.handleIdentity(f)
	if e != nil {
		return e
	}
	if actual != expected {
		return fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	if !expected.directory {
		if e = c.verifyNoNamedStreams(path); e != nil {
			return e
		}
		if e = c.sys.verifyWriteHandle(f, path); e != nil {
			return e
		}
	}
	if e = p.deleteByHandle(f); e != nil {
		return e
	}
	delete(c.created, key)
	return nil
}
func (c *controller) publishOwnedFile(temp, dst string, replace bool) (commitState, error) {
	if !samePath(filepath.Dir(temp), filepath.Dir(dst)) || !c.allowedWritePath(temp) || !c.allowedWritePath(dst) {
		return notCommitted, fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN")
	}
	p, e := c.fsPlatform()
	if e != nil {
		return notCommitted, e
	}
	d, e := c.pinDirectory(filepath.Dir(temp))
	if e != nil {
		return notCommitted, e
	}
	expected, ok := c.created[fileKey(temp)]
	if !ok {
		return notCommitted, fail("EXACT_CREATED_OBJECT_REQUIRED")
	}
	old, oldKnown := c.created[fileKey(dst)]
	if replace {
		if e = c.checkCreated(dst, false); e != nil {
			return notCommitted, e
		}
	}
	f, e := p.openRelative(d, filepath.Base(temp), temp, fsDelete)
	if e != nil {
		return notCommitted, e
	}
	actual, e := p.handleIdentity(f)
	if e != nil {
		f.Close()
		return notCommitted, e
	}
	if actual != expected {
		f.Close()
		return notCommitted, fail("CREATED_OBJECT_IDENTITY_DRIFT")
	}
	if e = c.sys.verifyWriteHandle(f, temp); e != nil {
		f.Close()
		return notCommitted, e
	}
	renameErr := p.renameByHandle(f, d, filepath.Base(dst), replace)
	closeErr := f.Close() // release DELETE share conflict before post-open
	if renameErr == nil {
		delete(c.created, fileKey(temp))
		c.created[fileKey(dst)] = expected
		return committed, closeErr
	}
	// Query even on syscall failure. A result can be published despite a later
	// failure; retaining the exact new identity is required for recovery.
	current, openErr := p.openRelative(d, filepath.Base(dst), dst, fsRead)
	if os.IsNotExist(openErr) && !replace {
		return notCommitted, errors.Join(renameErr, closeErr)
	}
	if openErr != nil {
		return commitUnknown, errors.Join(renameErr, closeErr, openErr)
	}
	id, idErr := p.handleIdentity(current)
	readCloseErr := current.Close()
	if idErr != nil {
		return commitUnknown, errors.Join(renameErr, closeErr, idErr, readCloseErr)
	}
	if id == expected {
		delete(c.created, fileKey(temp))
		c.created[fileKey(dst)] = id
		return committed, errors.Join(renameErr, closeErr, readCloseErr)
	}
	if oldKnown && id == old {
		return notCommitted, errors.Join(renameErr, closeErr, readCloseErr)
	}
	return commitUnknown, errors.Join(renameErr, closeErr, readCloseErr, fail("CURRENT_MANIFEST_ATOMICITY_UNPROVEN"))
}
func (c *controller) closeFilesystem() error {
	var errs []error
	for k, f := range c.payloadPins {
		errs = append(errs, f.Close())
		delete(c.payloadPins, k)
	}
	for k, f := range c.directories {
		errs = append(errs, f.Close())
		delete(c.directories, k)
	}
	return errors.Join(errs...)
}
