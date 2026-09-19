//go:build !windows

package main

import (
	"io"
	"time"
)

type realPlatform struct{}

func (realPlatform) physical() (string, string, error) { return "", "", fail("DEVICE_OS_DRIFT") }
func (realPlatform) attestFiles(time.Time) error       { return fail("DEVICE_OS_DRIFT") }
func (realPlatform) start([]string, io.Writer, io.Writer) (process, error) {
	return nil, fail("DEVICE_OS_DRIFT")
}
