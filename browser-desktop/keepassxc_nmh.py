# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
"""Auto-register KeePassXC Native Messaging for LM-Sanctuary's custom Gecko vendor/profile."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys
from typing import Any, Callable, Iterable, Mapping

KEEPASSXC_HOST_ID = "org.keepassxc.keepassxc_browser"
KEEPASSXC_EXTENSION_ID = "keepassxc-browser@keepassxc.org"
SANCTUARY_VENDOR = "LMSanctuary"
LINUX_USER_APPDIR = ".lm-sanctuary"


def build_keepassxc_manifest(proxy_path: str) -> dict[str, Any]:
    """Return a Firefox/Gecko Native Messaging host manifest for KeePassXC-Browser."""
    return {
        "name": KEEPASSXC_HOST_ID,
        "description": "KeePassXC integration with native messaging support",
        "path": str(proxy_path),
        "type": "stdio",
        "allowed_extensions": [KEEPASSXC_EXTENSION_ID],
    }


def _read_winreg_default_value(hive_name: str, subkey: str) -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg
    except ImportError:
        return None
    hive = winreg.HKEY_CURRENT_USER if hive_name == "HKCU" else winreg.HKEY_LOCAL_MACHINE
    try:
        with winreg.OpenKey(hive, subkey) as key:
            val, _typ = winreg.QueryValueEx(key, "")
            return str(val).strip() if val else None
    except OSError:
        return None


def _write_winreg_default_value(hive_name: str, subkey: str, value: str) -> None:
    if sys.platform != "win32":
        return
    import winreg

    hive = winreg.HKEY_CURRENT_USER if hive_name == "HKCU" else winreg.HKEY_LOCAL_MACHINE
    with winreg.CreateKey(hive, subkey) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(value))


def _proxy_path_from_manifest(manifest_path: str | Path) -> str | None:
    try:
        raw = Path(manifest_path).read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return None
    candidate = str(data.get("path") or "").strip()
    if candidate and Path(candidate).is_file():
        return str(Path(candidate))
    return None


def discover_keepassxc_proxy(
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    home_dir: str | Path | None = None,
    extra_manifest_paths: Iterable[str | Path] = (),
    extra_binary_paths: Iterable[str | Path] = (),
    winreg_reader: Callable[[str, str], str | None] | None = None,
) -> str | None:
    """Locate keepassxc-proxy via existing Mozilla Native Messaging manifests or standard install paths."""
    reader = winreg_reader or _read_winreg_default_value
    manifest_candidates: list[Path] = [Path(p) for p in extra_manifest_paths]

    if platform_name == "win32":
        subkey = f"Software\\Mozilla\\NativeMessagingHosts\\{KEEPASSXC_HOST_ID}"
        for hive in ("HKCU", "HKLM"):
            reg_val = reader(hive, subkey)
            if reg_val:
                manifest_candidates.append(Path(reg_val))
        local_app = env.get("LOCALAPPDATA", "")
        appdata = env.get("APPDATA", "")
        if local_app:
            manifest_candidates.append(
                Path(local_app) / "KeePassXC" / f"{KEEPASSXC_HOST_ID}_firefox.json"
            )
        if appdata:
            manifest_candidates.append(
                Path(appdata) / "Mozilla" / "NativeMessagingHosts" / f"{KEEPASSXC_HOST_ID}.json"
            )
    else:
        home = Path(home_dir) if home_dir is not None else Path.home()
        manifest_candidates.extend([
            home / ".mozilla" / "native-messaging-hosts" / f"{KEEPASSXC_HOST_ID}.json",
            Path(f"/usr/lib/mozilla/native-messaging-hosts/{KEEPASSXC_HOST_ID}.json"),
            Path(f"/usr/lib64/mozilla/native-messaging-hosts/{KEEPASSXC_HOST_ID}.json"),
        ])

    for mf in manifest_candidates:
        if mf.is_file():
            found = _proxy_path_from_manifest(mf)
            if found:
                return found

    binary_candidates: list[str] = []
    search_path = env.get("PATH") if env is not None else None
    which_proxy = shutil.which("keepassxc-proxy", path=search_path) if search_path else None
    if which_proxy:
        binary_candidates.append(which_proxy)

    if platform_name == "win32":
        binary_candidates.append(r"C:\Program Files\KeePassXC\keepassxc-proxy.exe")
        local_app = env.get("LOCALAPPDATA", "")
        if local_app:
            binary_candidates.append(str(Path(local_app) / "Programs" / "KeePassXC" / "keepassxc-proxy.exe"))
    else:
        binary_candidates.extend([
            "/usr/bin/keepassxc-proxy",
            "/usr/local/bin/keepassxc-proxy",
            "/snap/bin/keepassxc.proxy",
        ])

    binary_candidates.extend(str(p) for p in extra_binary_paths)

    for cand in binary_candidates:
        if cand and Path(cand).is_file():
            return str(Path(cand))

    return None


def ensure_keepassxc_native_messaging(
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    home_dir: str | Path | None = None,
    appdata_dir: str | Path | None = None,
    extra_manifest_paths: Iterable[str | Path] = (),
    extra_binary_paths: Iterable[str | Path] = (),
    winreg_reader: Callable[[str, str], str | None] | None = None,
    winreg_writer: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    """Register KeePassXC Native Messaging manifest for LM-Sanctuary's Gecko vendor/appdir."""
    proxy_path = discover_keepassxc_proxy(
        platform_name=platform_name,
        env=env,
        home_dir=home_dir,
        extra_manifest_paths=extra_manifest_paths,
        extra_binary_paths=extra_binary_paths,
        winreg_reader=winreg_reader,
    )
    if not proxy_path:
        return {"registered": False, "reason": "keepassxc-proxy not found", "manifest_path": ""}

    manifest = build_keepassxc_manifest(proxy_path)
    payload = json.dumps(manifest, indent=2) + "\n"

    if platform_name == "win32":
        base_appdata = Path(appdata_dir) if appdata_dir is not None else Path(
            env.get("APPDATA") or (Path.home() / "AppData" / "Roaming")
        )
        manifest_dir = base_appdata / SANCTUARY_VENDOR / "NativeMessagingHosts"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest_file = manifest_dir / f"{KEEPASSXC_HOST_ID}.json"
        manifest_file.write_text(payload, encoding="utf-8")
        writer = winreg_writer or _write_winreg_default_value
        writer("HKCU", f"Software\\{SANCTUARY_VENDOR}\\NativeMessagingHosts\\{KEEPASSXC_HOST_ID}", str(manifest_file))
    else:
        base_home = Path(home_dir) if home_dir is not None else Path.home()
        manifest_dir = base_home / LINUX_USER_APPDIR / "native-messaging-hosts"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest_file = manifest_dir / f"{KEEPASSXC_HOST_ID}.json"
        manifest_file.write_text(payload, encoding="utf-8")
        try:
            manifest_file.chmod(0o644)
        except OSError:
            pass

    return {
        "registered": True,
        "proxy_path": proxy_path,
        "manifest_path": str(manifest_file),
    }


if __name__ == "__main__":
    print(json.dumps(ensure_keepassxc_native_messaging(), indent=2))
