//go:build windows

package devicecontrol

// One pinned thread per COM world.
//
// 🔑 COM/WinRT are thread-affine: initialisation applies per thread, and the
// Go runtime moves goroutines at any time. Without LockOSThread a call will
// eventually land on a thread without an apartment (CO_E_NOTINITIALIZED).
//
// 🔴 And it takes TWO of them: WASAPI runs in the STA (CoInitializeEx
// APARTMENTTHREADED, proven that way), WinRT radios need the MTA
// (RoInitialize MULTITHREADED). Both on the same thread makes Windows answer
// RPC_E_CHANGED_MODE — hence two workers instead of one.

import "runtime"

type comWorker struct {
	jobs chan func()
	ok   bool
}

// newWorker starts the thread and waits until init is done. If init fails,
// ok stays false and every do() call cleanly reports "not available".
func newWorker(init func() error, deinit func()) *comWorker {
	w := &comWorker{jobs: make(chan func())}
	ready := make(chan bool, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if err := init(); err != nil {
			ready <- false
			return
		}
		if deinit != nil {
			defer deinit()
		}
		ready <- true
		for job := range w.jobs {
			job()
		}
	}()
	w.ok = <-ready
	return w
}

// do runs fn on the dedicated thread and waits for the result.
func (w *comWorker) do(fn func() error) error {
	if !w.ok {
		return errUnsupported
	}
	done := make(chan error, 1)
	w.jobs <- func() { done <- fn() }
	return <-done
}
