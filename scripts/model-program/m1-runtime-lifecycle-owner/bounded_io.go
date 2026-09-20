package main

import "io"

// Recheck both sides of potentially blocking reads. A late read can never grant
// permission to write after expiry. Sync/Close and terminal evidence are cleanup.
func copyChecked(dst io.Writer, src io.Reader, check func() error) (int64, error) {
	buf := make([]byte, 64<<10)
	var total int64
	for {
		if e := check(); e != nil {
			return total, e
		}
		n, re := src.Read(buf)
		if e := check(); e != nil {
			return total, e
		}
		if n > 0 {
			written, e := dst.Write(buf[:n])
			total += int64(written)
			if e != nil {
				return total, e
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if re == io.EOF {
			return total, nil
		}
		if re != nil {
			return total, re
		}
	}
}
