//go:build windows

package main

import (
	"os"
)

func fixtureOpenDirectory(parent *os.File, path string, create bool) (*os.File, error) {
	return (realPlatform{}).openDirectoryAt(parent, path, create)
}
func fixtureOpenFile(parent *os.File, path string, create bool, access string) (*os.File, error) {
	return (realPlatform{}).openFileAt(parent, path, create, access)
}
func fixtureDelete(file *os.File, path string) error {
	return (realPlatform{}).deleteHandle(file, path)
}
func fixtureRename(file, parent *os.File, dst string, replace bool) error {
	return (realPlatform{}).renameHandle(file, parent, dst, replace)
}
