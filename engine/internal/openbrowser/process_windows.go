//go:build windows

package openbrowser

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

var (
	showWindowAsync     = windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindowAsync")
	processWindowLookup struct {
		sync.Mutex
		pid  uint32
		hwnd windows.HWND
	}
	enumProcessWindow = windows.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		var pid uint32
		_, err := windows.GetWindowThreadProcessId(hwnd, &pid)
		if err == nil && pid == processWindowLookup.pid && windows.IsWindowVisible(hwnd) {
			processWindowLookup.hwnd = hwnd
			return 0
		}
		return 1
	})
)

func visibleProcessWindow(pid uint32) windows.HWND {
	processWindowLookup.Lock()
	defer processWindowLookup.Unlock()
	processWindowLookup.pid = pid
	processWindowLookup.hwnd = 0
	_ = windows.EnumWindows(enumProcessWindow, nil)
	return processWindowLookup.hwnd
}

func maximizeOwnedProcessWindow(pid int, startToken uint64) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		exists, err := ownedProcessExists(pid, startToken)
		if err != nil || !exists {
			return
		}
		if hwnd := visibleProcessWindow(uint32(pid)); hwnd != 0 {
			_, _, _ = showWindowAsync.Call(uintptr(hwnd), windows.SW_MAXIMIZE)
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func ownedProcessStartTime(pid int) (uint64, error) {
	token, exists, err := ownedProcessState(pid)
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, fmt.Errorf("process %d is not running", pid)
	}
	return token, nil
}

func verifyOwnedProcess(pid int, startToken uint64) error {
	token, exists, err := ownedProcessState(pid)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("owned Chrome process %d is no longer running", pid)
	}
	if token != startToken {
		return fmt.Errorf("owned Chrome PID %d was reused", pid)
	}
	return nil
}

func ownedProcessExists(pid int, startToken uint64) (bool, error) {
	token, exists, err := ownedProcessState(pid)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	if token != startToken {
		return false, fmt.Errorf("owned Chrome PID %d was reused", pid)
	}
	return true, nil
}

func stopOwnedProcess(pid int, startToken uint64, force bool) error {
	if startToken != 0 {
		exists, err := ownedProcessExists(pid, startToken)
		if err != nil {
			return err
		}
		if !exists {
			return nil
		}
	}
	return ownedProcessCommand(pid, force).Run()
}

func ownedProcessCommand(pid int, force bool) *exec.Cmd {
	args := []string{"/T"}
	if force {
		args = append(args, "/F")
	}
	args = append(args, "/PID", strconv.Itoa(pid))
	return exec.Command("taskkill", args...)
}

func ownedProcessState(pid int) (uint64, bool, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return 0, false, nil
		}
		return 0, false, err
	}
	defer func() { _ = windows.CloseHandle(h) }()

	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return 0, false, err
	}
	return uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), true, nil
}
