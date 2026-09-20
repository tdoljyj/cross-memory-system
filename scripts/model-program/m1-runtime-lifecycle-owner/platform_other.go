//go:build !windows

package main

import (
	"io"
	"net/http"
)

type realPlatform struct{}

func (realPlatform) physical() (string, string, error)        { return "", "", fail("DEVICE_OS_DRIFT") }
func (realPlatform) windowsDirectory() (string, error)        { return "", fail("DEVICE_OS_DRIFT") }
func (realPlatform) pathIsReparse(string) (bool, error)       { return false, fail("DEVICE_OS_DRIFT") }
func (realPlatform) finalPath(string) (string, error)          { return "", fail("DEVICE_OS_DRIFT") }
func (realPlatform) directoryIdentity(string) (directoryIdentity, error) { return directoryIdentity{}, fail("DEVICE_OS_DRIFT") }
func (realPlatform) hardlinkCount(string) (uint32, error)          { return 0, fail("DEVICE_OS_DRIFT") }
func (realPlatform) namedStreams(string) ([]string, error)    { return nil, fail("DEVICE_OS_DRIFT") }
func (realPlatform) atomicPublish(string, string, bool) error { return fail("DEVICE_OS_DRIFT") }
func (realPlatform) start(launchEnvelope, io.Writer, io.Writer) (process, error) {
	return nil, fail("DEVICE_OS_DRIFT")
}
func (realPlatform) portFree() bool { return false }
func (realPlatform) roundTrip(*http.Request) (*http.Response, error) {
	return nil, fail("DEVICE_OS_DRIFT")
}
