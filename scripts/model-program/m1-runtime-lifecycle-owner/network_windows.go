//go:build windows

package main

import (
	"net"
	"net/http"
	"time"
)

func port18088Free() bool {
	l, e := net.Listen("tcp4", "127.0.0.1:18088")
	if e != nil {
		return false
	}
	_ = l.Close()
	return true
}
func (realPlatform) portFree() bool { return port18088Free() }

func (realPlatform) roundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil || req.URL.Scheme != "http" || req.URL.Host != "127.0.0.1:18088" {
		return nil, fail("NON_LOOPBACK_OR_ENDPOINT_DRIFT")
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DisableKeepAlives:     true,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fail("HTTP_REDIRECT_FORBIDDEN")
		},
	}
	return client.Do(req)
}
