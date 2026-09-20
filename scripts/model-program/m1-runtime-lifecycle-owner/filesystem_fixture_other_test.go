//go:build !windows

package main

import (
	"os"
)

func fixtureOpenDirectory(parent *os.File, path string, create bool) (*os.File, error) {
	if create {
		if e := os.Mkdir(path, 0700); e != nil {
			return nil, e
		}
	}
	return os.Open(path)
}
func fixtureOpenFile(parent *os.File, path string, create bool, access string) (*os.File, error) {
	flags := os.O_RDONLY
	if access == "write" {
		flags = os.O_RDWR
	}
	if create {
		flags |= os.O_CREATE | os.O_EXCL
	}
	return os.OpenFile(path, flags, 0600)
}
func fixtureDelete(file *os.File, path string) error { return os.Remove(path) }
func fixtureRename(file, parent *os.File, dst string, replace bool) error {
	if !replace {
		if _, e := os.Lstat(dst); e == nil {
			return fail("DESTINATION_EXISTS")
		}
	} else {
		if _, e := os.Lstat(dst); e != nil {
			return e
		}
	}
	return os.Rename(file.Name(), dst)
}
