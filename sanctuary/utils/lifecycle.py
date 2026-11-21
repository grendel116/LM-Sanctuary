"""
lifecycle.py — Owns every child process LM-Sanctuary spawns and shuts them all down on exit.

Two layers keep exit clean:
  1. Every Popen the app creates is registered with track(). shutdown() terminates them directly.
  2. On Windows, the main process is bound to a Job Object with KILL_ON_JOB_CLOSE, so the OS
     reaps every descendant (grandchildren, shell-spawned tasks) the moment the main process ends,
     even on a crash or a Task Manager kill.
"""

import os
import sys
import atexit
import signal
import subprocess
import threading
import time

_children: set = set()
_children_lock = threading.Lock()
_shutdown_done = False
_popen_wrapped = False
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
_CREATE_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)


def _apply_no_window_popen_defaults(kwargs: dict) -> None:
    """Inject CREATE_NO_WINDOW and a hidden STARTUPINFO for headless Windows child processes."""
    if os.name != "nt":
        return
    flags = int(kwargs.get("creationflags") or 0)
    if (flags & _CREATE_NEW_CONSOLE) == 0:
        kwargs["creationflags"] = flags | _CREATE_NO_WINDOW
    if kwargs.get("startupinfo") is None and hasattr(subprocess, "STARTUPINFO"):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        si.wShowWindow = 0
        kwargs["startupinfo"] = si


def _suppress_headless_windows_consoles(*, force: bool = False) -> bool:
    """Ensure child processes spawned inside a windowless Windows host never flash a console."""
    global _popen_wrapped
    if sys.platform != "win32" or _popen_wrapped:
        return False
    if not force:
        try:
            import ctypes
            if ctypes.windll.kernel32.GetConsoleWindow() != 0:
                return False
        except Exception:
            return False

    orig_init = subprocess.Popen.__init__

    def _no_window_popen_init(self, *args, **kwargs):
        _apply_no_window_popen_defaults(kwargs)
        return orig_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _no_window_popen_init
    _popen_wrapped = True
    return True


def track(proc: subprocess.Popen) -> subprocess.Popen:
    """Registers a child process for termination on app exit and returns it unchanged."""
    with _children_lock:
        for finished in [p for p in _children if p.poll() is not None]:
            _children.discard(finished)
        _children.add(proc)
    return proc


def _terminate_children(grace: float = 3.0):
    with _children_lock:
        running = [p for p in _children if p.poll() is None]
        _children.clear()

    for proc in running:
        try:
            proc.terminate()
        except Exception:
            pass

    deadline = time.monotonic() + grace
    for proc in running:
        try:
            proc.wait(timeout=max(0.0, deadline - time.monotonic()))
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def shutdown():
    """Terminates all tracked child processes. Runs once."""
    global _shutdown_done
    with _children_lock:
        if _shutdown_done:
            return
        _shutdown_done = True

    try:
        from tools import antigravity_job

        antigravity_job.cancel_all_antigravity_jobs(grace=0.3, timeout=1.5)
    except Exception:
        pass

    _terminate_children()


def _bind_children_to_job():
    """Binds this process to a Windows Job Object so every descendant dies with it."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoCounters", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryLimit", ctypes.c_size_t),
                ("PeakJobMemoryLimit", ctypes.c_size_t),
            ]

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
        JobObjectExtendedLimitInformation = 9

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        h_job = kernel32.CreateJobObjectW(None, None)
        if not h_job:
            return

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if kernel32.SetInformationJobObject(h_job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            # The handle stays open for the life of the process; the OS closes it on exit, which kills the job.
            kernel32.AssignProcessToJobObject(h_job, kernel32.GetCurrentProcess())
    except Exception as e:
        print(f"[lifecycle] Could not bind Job Object: {e}", flush=True)


def install():
    """Sets up exit handling. Call once from the main thread of the entry-point process.

    Under the Flask reloader, the parent process owns the lifecycle: its Job Object covers the
    reloading child and everything it spawns, so llama-server and ComfyUI survive code reloads
    and still die when the developer stops the app.
    """
    _suppress_headless_windows_consoles()
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        return
    _bind_children_to_job()
    atexit.register(shutdown)
    # Route SIGTERM through normal interpreter exit so atexit runs.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
