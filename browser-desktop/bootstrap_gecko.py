# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
"""Bootstrap, stage, audit, and build LM-Sanctuary's desktop Sval / Firefox ESR Gecko host."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import sys
import zipfile
from typing import Any, Iterable

DESKTOP_DIR = Path(__file__).resolve().parent
REPO_ROOT = DESKTOP_DIR.parent
UPSTREAM_JSON = DESKTOP_DIR / "upstream.json"
BUILD_DIR = DESKTOP_DIR / "build"

_TEXT_SUFFIXES = frozenset({
    ".js", ".mjs", ".sys.mjs", ".ftl", ".properties", ".html", ".xhtml",
    ".css", ".json", ".ini", ".in", ".j2", ".sh", ".desktop", ".build", ".mn", ".txt", ".md",
})
_ICON_SIZES = (16, 32, 48, 64, 128)


def load_upstream_config(path: Path = UPSTREAM_JSON) -> dict[str, Any]:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in (
        "sval_remote",
        "firefox_remote",
        "firefox_rev",
        "app_name",
        "app_basename",
        "app_displayname",
        "excluded_sval_patches",
        "pruned_sval_paths",
        "forbidden_endpoints",
    ):
        if key not in cfg:
            raise ValueError(f"upstream.json missing required key: {key}")
    return cfg


def _is_text_file(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith(".sys.mjs"):
        return True
    return path.suffix.lower() in _TEXT_SUFFIXES


def _scrub_forbidden_endpoints(root_dir: Path, forbidden: Iterable[str]) -> list[Path]:
    touched: list[Path] = []
    endpoints = [str(e) for e in forbidden if e]
    if not endpoints or not root_dir.exists():
        return touched
    for item in root_dir.rglob("*"):
        if not item.is_file() or not _is_text_file(item):
            continue
        text = item.read_text(encoding="utf-8", errors="ignore")
        updated = text
        for ep in endpoints:
            if ep in updated:
                updated = updated.replace(f"https://{ep}/report", "")
                updated = updated.replace(f"https://{ep}", "")
                updated = updated.replace(f"http://{ep}", "")
                updated = updated.replace(ep, "")
        if updated != text:
            item.write_text(updated, encoding="utf-8")
            touched.append(item)
    return touched


def _prune_sval_moz_build(moz_build_path: Path, pruned_basenames: set[str]) -> None:
    if not moz_build_path.is_file():
        return
    kept = []
    for line in moz_build_path.read_text(encoding="utf-8").splitlines(keepends=True):
        if any(name in line for name in pruned_basenames):
            continue
        kept.append(line)
    moz_build_path.write_text("".join(kept), encoding="utf-8")


def _write_resized_or_copy(src: Path, dest: Path, size: tuple[int, int] | None = None, pil_image: Any = None) -> None:
    if pil_image is not None and size is not None:
        with pil_image.open(src) as img:
            img.convert("RGBA").resize(size).save(dest, format="PNG")
    else:
        shutil.copy2(src, dest)


def _visual_elements_manifest_xml(square_150: str, square_70: str) -> str:
    return (
        "<Application xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'>\n"
        "  <VisualElements\n"
        "      ShowNameOnSquare150x150Logo='on'\n"
        f"      Square150x150Logo='{square_150}'\n"
        f"      Square70x70Logo='{square_70}'\n"
        "      ForegroundText='light'\n"
        "      BackgroundColor='#121214'/>\n"
        "</Application>\n"
    )


def _write_solid_bmp(dest: Path, width: int, height: int, rgb: tuple[int, int, int] = (18, 18, 20)) -> None:
    row_raw = bytes([rgb[2], rgb[1], rgb[0]]) * width
    pad = (4 - (len(row_raw) % 4)) % 4
    row = row_raw + (b"\x00" * pad)
    pixel_bytes = row * height
    file_size = 54 + len(pixel_bytes)
    header = (
        b"BM"
        + file_size.to_bytes(4, "little")
        + b"\x00\x00\x00\x00"
        + (54).to_bytes(4, "little")
        + (40).to_bytes(4, "little")
        + width.to_bytes(4, "little")
        + height.to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + (24).to_bytes(2, "little")
        + (0).to_bytes(4, "little")
        + len(pixel_bytes).to_bytes(4, "little")
        + (2835).to_bytes(4, "little")
        + (2835).to_bytes(4, "little")
        + (0).to_bytes(4, "little")
        + (0).to_bytes(4, "little")
    )
    dest.write_bytes(header + pixel_bytes)


# Minimal valid 1x1 dark RGB JPEG used only when Pillow is unavailable.
_MINIMAL_DARK_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000"
    "ffdb004300030202030202030303030403030405"
    "0805050404050a070706080c0a0c0c0b0a0b0b"
    "0d0e12100d0e110e0b0b101610111314151515"
    "0c0f171816141812141514ffc0000b0800010001"
    "01011100ffc40014000100000000000000000000"
    "000000000009ffc4001410010000000000000000"
    "0000000000000000ffda0008010100003f00d2cf"
    "20ffd9"
)


def _write_installer_banner(
    dest: Path,
    src_png: Path,
    width: int,
    height: int,
    fmt: str,
    pil_image: Any = None,
) -> None:
    if pil_image is not None:
        bg = pil_image.new("RGB", (width, height), (18, 18, 20))
        if src_png.is_file():
            with pil_image.open(src_png) as icon:
                rgba = icon.convert("RGBA")
                side = max(16, min(width, height) - 16)
                side = min(side, 96)
                resized = rgba.resize((side, side))
                bg.paste(resized, ((width - side) // 2, (height - side) // 2), resized)
        bg.save(dest, format=fmt)
    elif fmt == "BMP":
        _write_solid_bmp(dest, width, height)
    else:
        dest.write_bytes(_MINIMAL_DARK_JPEG)


def _materialize_branding_icons(
    dest_branding: Path,
    repo_root: Path = REPO_ROOT,
    ff_path: Path | None = None,
) -> None:
    src_png = repo_root / "web" / "assets" / "img" / "app_icon.png"
    src_ico = repo_root / "web" / "assets" / "img" / "app_icon.ico"
    dest_content = dest_branding / "content"
    dest_content.mkdir(parents=True, exist_ok=True)
    dest_pref = dest_branding / "pref"
    dest_pref.mkdir(parents=True, exist_ok=True)
    dest_stub = dest_branding / "stubinstaller"
    dest_stub.mkdir(parents=True, exist_ok=True)

    # Mirror 00-lm-sanctuary-prefs.js -> firefox-branding.js so stock package-manifest.in
    # automatically ships LM-Sanctuary defaults without editing Mozilla manifests.
    sanctuary_prefs = dest_pref / "00-lm-sanctuary-prefs.js"
    branding_prefs = dest_pref / "firefox-branding.js"
    if sanctuary_prefs.is_file() and not branding_prefs.exists():
        shutil.copy2(sanctuary_prefs, branding_prefs)

    pil_image = None
    try:
        from PIL import Image  # type: ignore

        pil_image = Image
    except ImportError:
        pil_image = None

    if src_png.is_file():
        for sz in _ICON_SIZES:
            _write_resized_or_copy(src_png, dest_branding / f"default{sz}.png", (sz, sz), pil_image)
        for name, sz in (
            ("about.png", 128),
            ("about-logo.png", 128),
            ("about-logo@2x.png", 256),
            ("about-logo-private.png", 128),
            ("about-logo-private@2x.png", 256),
        ):
            _write_resized_or_copy(src_png, dest_content / name, (sz, sz), pil_image)
        for name, sz in (
            ("VisualElements_70.png", 70),
            ("VisualElements_150.png", 150),
            ("PrivateBrowsing_70.png", 70),
            ("PrivateBrowsing_150.png", 150),
        ):
            _write_resized_or_copy(src_png, dest_branding / name, (sz, sz), pil_image)

    _write_installer_banner(dest_branding / "wizHeader.bmp", src_png, 150, 57, "BMP", pil_image)
    _write_installer_banner(dest_branding / "wizHeaderRTL.bmp", src_png, 150, 57, "BMP", pil_image)
    _write_installer_banner(dest_branding / "wizWatermark.bmp", src_png, 164, 314, "BMP", pil_image)
    _write_installer_banner(dest_stub / "bgstub.jpg", src_png, 1344, 822, "JPEG", pil_image)

    svg_logo = dest_content / "about-logo.svg"
    svg_wordmark = dest_content / "about-wordmark.svg"
    if svg_logo.is_file() and not (dest_content / "document_pdf.svg").exists():
        shutil.copy2(svg_logo, dest_content / "document_pdf.svg")
    if svg_wordmark.is_file() and not (dest_content / "firefox-wordmark.svg").exists():
        shutil.copy2(svg_wordmark, dest_content / "firefox-wordmark.svg")

    (dest_branding / "firefox.VisualElementsManifest.xml").write_text(
        _visual_elements_manifest_xml(
            "browser/VisualElements/VisualElements_150.png",
            "browser/VisualElements/VisualElements_70.png",
        ),
        encoding="utf-8",
    )
    (dest_branding / "private_browsing.VisualElementsManifest.xml").write_text(
        _visual_elements_manifest_xml(
            "browser/VisualElements/PrivateBrowsing_150.png",
            "browser/VisualElements/PrivateBrowsing_70.png",
        ),
        encoding="utf-8",
    )

    if src_ico.is_file():
        for ico_name in (
            "firefox.ico",
            "firefox64.ico",
            "default.ico",
            "main-window.ico",
            "document.ico",
            "document_pdf.ico",
            "newtab.ico",
            "newwindow.ico",
            "pbmode.ico",
        ):
            shutil.copy2(src_ico, dest_branding / ico_name)

    if ff_path is not None:
        stub_dir = ff_path / "other-licenses" / "7zstub" / "firefox"
        for sfx_name in ("7zSD.Win32.sfx", "7zSD.ARM64.sfx"):
            src_sfx = stub_dir / sfx_name
            dest_sfx = dest_branding / sfx_name
            if src_sfx.is_file() and not dest_sfx.exists():
                shutil.copy2(src_sfx, dest_sfx)


def build_pe_icon_payloads(ico_bytes: bytes) -> tuple[bytes, list[tuple[int, bytes]]]:
    """Parse a Windows .ico file into (RT_GROUP_ICON payload, [(icon_id, RT_ICON bytes), ...])."""
    if len(ico_bytes) < 6:
        raise ValueError("Invalid .ico data: file too small")
    reserved, img_type, count = struct.unpack_from("<HHH", ico_bytes, 0)
    if reserved != 0 or img_type != 1 or count <= 0:
        raise ValueError(f"Unsupported .ico header: reserved={reserved}, type={img_type}, count={count}")
    if len(ico_bytes) < 6 + count * 16:
        raise ValueError("Truncated .ico directory entries")

    group_parts = [struct.pack("<HHH", 0, 1, count)]
    icon_entries: list[tuple[int, bytes]] = []
    for idx in range(count):
        width, height, color_count, _res, planes, bit_count, size, offset = struct.unpack_from(
            "<BBBBHHII", ico_bytes, 6 + idx * 16
        )
        if offset + size > len(ico_bytes):
            raise ValueError(f"Truncated .ico image payload at entry {idx}")
        icon_id = idx + 1
        group_parts.append(
            struct.pack(
                "<BBBBHHIH",
                width,
                height,
                color_count,
                0,
                planes or 1,
                bit_count or 32,
                size,
                icon_id,
            )
        )
        icon_entries.append((icon_id, ico_bytes[offset : offset + size]))

    return b"".join(group_parts), icon_entries


def _pe_resource_api():
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
    k32.LoadLibraryExW.restype = ctypes.c_void_p
    k32.FreeLibrary.argtypes = [ctypes.c_void_p]
    k32.FreeLibrary.restype = ctypes.c_int
    k32.EnumResourceNamesW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t]
    k32.EnumResourceNamesW.restype = ctypes.c_int
    k32.EnumResourceLanguagesW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_ssize_t,
    ]
    k32.EnumResourceLanguagesW.restype = ctypes.c_int
    k32.BeginUpdateResourceW.argtypes = [ctypes.c_wchar_p, ctypes.c_int]
    k32.BeginUpdateResourceW.restype = ctypes.c_void_p
    k32.UpdateResourceW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint16,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    k32.UpdateResourceW.restype = ctypes.c_int
    k32.EndUpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    k32.EndUpdateResourceW.restype = ctypes.c_int
    return k32


def _enumerate_pe_resources(exe_path: Path, res_type: int) -> list[tuple[int | str, int]]:
    k32 = _pe_resource_api()
    h_mod = k32.LoadLibraryExW(str(exe_path), None, 0x00000002)
    if not h_mod:
        raise ctypes.WinError(ctypes.get_last_error())
    items: list[tuple[int | str, int]] = []
    EnumNamesProc = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t
    )
    EnumLangsProc = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint16, ctypes.c_ssize_t
    )
    try:
        names: list[int | str] = []

        def on_name(_mod: int, _rt: int, lp_name: int, _param: int) -> int:
            val = int(lp_name or 0)
            names.append(val if val < 65536 else ctypes.wstring_at(val))
            return 1

        cb_name = EnumNamesProc(on_name)
        k32.EnumResourceNamesW(h_mod, ctypes.c_void_p(res_type), cb_name, 0)
        for name in names:
            keep_buf = None if isinstance(name, int) else ctypes.create_unicode_buffer(name)
            lp_name = ctypes.c_void_p(name) if isinstance(name, int) else ctypes.cast(keep_buf, ctypes.c_void_p)

            def on_lang(_mod: int, _rt: int, _ln: int, lang: int, _param: int) -> int:
                items.append((name, int(lang)))
                return 1

            cb_lang = EnumLangsProc(on_lang)
            k32.EnumResourceLanguagesW(h_mod, ctypes.c_void_p(res_type), lp_name, cb_lang, 0)
    finally:
        k32.FreeLibrary(h_mod)
    return items


def _read_pe_resource_bytes(exe_path: Path, res_type: int, res_name: int | str) -> bytes | None:
    """Test/verification helper returning raw bytes for a named PE resource."""
    if sys.platform != "win32":
        return None
    k32 = _pe_resource_api()
    k32.FindResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    k32.FindResourceW.restype = ctypes.c_void_p
    k32.LoadResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    k32.LoadResource.restype = ctypes.c_void_p
    k32.LockResource.argtypes = [ctypes.c_void_p]
    k32.LockResource.restype = ctypes.c_void_p
    k32.SizeofResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    k32.SizeofResource.restype = ctypes.c_uint32
    h_mod = k32.LoadLibraryExW(str(exe_path), None, 0x00000002)
    if not h_mod:
        return None
    try:
        buf = None if isinstance(res_name, int) else ctypes.create_unicode_buffer(res_name)
        lp_name = ctypes.c_void_p(res_name) if isinstance(res_name, int) else ctypes.cast(buf, ctypes.c_void_p)
        h_res = k32.FindResourceW(h_mod, lp_name, ctypes.c_void_p(res_type))
        if not h_res:
            return None
        size = k32.SizeofResource(h_mod, h_res)
        h_data = k32.LoadResource(h_mod, h_res)
        ptr = k32.LockResource(h_data)
        if not ptr or size <= 0:
            return None
        return ctypes.string_at(ptr, size)
    finally:
        k32.FreeLibrary(h_mod)


def patch_windows_pe_exe_icon(exe_path: Path, ico_path: Path) -> bool:
    """Replace RT_GROUP_ICON / RT_ICON resources in an unsigned Windows PE binary with ico_path."""
    if sys.platform != "win32" or not exe_path.is_file() or not ico_path.is_file():
        return False

    group_bytes, icon_entries = build_pe_icon_payloads(ico_path.read_bytes())
    existing_groups = _enumerate_pe_resources(exe_path, 14)
    existing_icons = _enumerate_pe_resources(exe_path, 3)

    target_group_ids: set[int | str] = {1, 32512}
    for name, _lang in existing_groups:
        target_group_ids.add(name)

    k32 = _pe_resource_api()
    h_update = k32.BeginUpdateResourceW(str(exe_path), 0)
    if not h_update:
        raise ctypes.WinError(ctypes.get_last_error())

    commit = False
    try:
        lang_en_us = 1033
        for old_name, old_lang in existing_icons:
            buf = None if isinstance(old_name, int) else ctypes.create_unicode_buffer(old_name)
            lp_name = ctypes.c_void_p(old_name) if isinstance(old_name, int) else ctypes.cast(buf, ctypes.c_void_p)
            k32.UpdateResourceW(h_update, ctypes.c_void_p(3), lp_name, old_lang, None, 0)

        for old_name, old_lang in existing_groups:
            if old_lang != lang_en_us or old_name not in target_group_ids:
                buf = None if isinstance(old_name, int) else ctypes.create_unicode_buffer(old_name)
                lp_name = ctypes.c_void_p(old_name) if isinstance(old_name, int) else ctypes.cast(buf, ctypes.c_void_p)
                k32.UpdateResourceW(h_update, ctypes.c_void_p(14), lp_name, old_lang, None, 0)

        for icon_id, payload in icon_entries:
            raw_buf = ctypes.create_string_buffer(payload, len(payload))
            if not k32.UpdateResourceW(
                h_update,
                ctypes.c_void_p(3),
                ctypes.c_void_p(icon_id),
                lang_en_us,
                ctypes.cast(raw_buf, ctypes.c_void_p),
                len(payload),
            ):
                raise ctypes.WinError(ctypes.get_last_error())

        grp_buf = ctypes.create_string_buffer(group_bytes, len(group_bytes))
        for grp_name in sorted(target_group_ids, key=lambda v: (0, v) if isinstance(v, int) else (1, str(v))):
            str_buf = None if isinstance(grp_name, int) else ctypes.create_unicode_buffer(grp_name)
            lp_grp = ctypes.c_void_p(grp_name) if isinstance(grp_name, int) else ctypes.cast(str_buf, ctypes.c_void_p)
            if not k32.UpdateResourceW(
                h_update,
                ctypes.c_void_p(14),
                lp_grp,
                lang_en_us,
                ctypes.cast(grp_buf, ctypes.c_void_p),
                len(group_bytes),
            ):
                raise ctypes.WinError(ctypes.get_last_error())

        commit = True
    finally:
        ok = k32.EndUpdateResourceW(h_update, 0 if commit else 1)
        if commit and not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    return True


def _pad4(raw: bytes) -> bytes:
    rem = len(raw) % 4
    return raw + (b"\x00" * (4 - rem)) if rem else raw


def _pack_vs_version_node(
    key: str,
    value: bytes = b"",
    *,
    is_text: bool = True,
    children: Iterable[bytes] = (),
) -> bytes:
    key_bytes = (key + "\x00").encode("utf-16le")
    head_len = 6 + len(key_bytes)
    pad_after_key = b"\x00" * ((4 - (head_len % 4)) % 4)
    w_type = 1 if is_text else 0
    w_val_len = (len(value) // 2) if is_text else len(value)

    body = bytearray()
    body.extend(key_bytes)
    body.extend(pad_after_key)
    if value:
        body.extend(value)

    child_list = list(children)
    if child_list:
        if len(body) % 4:
            body.extend(b"\x00" * (4 - (len(body) % 4)))
        for idx, ch in enumerate(child_list):
            body.extend(ch)
            if idx + 1 < len(child_list) and (len(body) % 4):
                body.extend(b"\x00" * (4 - (len(body) % 4)))

    total_len = 6 + len(body)
    header = struct.pack("<HHH", total_len, w_val_len, w_type)
    return header + bytes(body)


def _extract_existing_vs_fixed_and_versions(raw: bytes | None) -> tuple[bytes, dict[str, str]]:
    default_fixed = struct.pack(
        "<13I",
        0xFEEF04BD,
        0x00010000,
        (153 << 16) | 7,
        0,
        (153 << 16) | 7,
        0,
        0x3F,
        0,
        0x00040004,
        0x00000001,
        0,
        0,
        0,
    )
    meta = {"FileVersion": "153.7.0", "ProductVersion": "153.7.0"}
    if not raw or len(raw) < 92:
        return default_fixed, meta
    try:
        _wlen, wval, _wtype = struct.unpack_from("<HHH", raw, 0)
        if wval == 52 and struct.unpack_from("<I", raw, 40)[0] == 0xFEEF04BD:
            default_fixed = raw[40:92]
        text = raw.decode("utf-16le", errors="ignore")
        for field in ("FileVersion", "ProductVersion", "BuildID"):
            m = re.search(field + r"\x00+([^\x00]+)", text)
            if m and m.group(1).strip():
                meta[field] = m.group(1).strip()
    except Exception:
        pass
    return default_fixed, meta


def build_pe_version_info_bytes(
    *,
    original_filename: str = "sanctuary-browser.exe",
    file_description: str = "Sanctuary Browser",
    product_name: str = "Sanctuary Browser",
    internal_name: str = "Sanctuary Browser",
    company_name: str = "",
    legal_copyright: str = "© 2026 Ellm Tree, Inc. & Mozilla Contributors (AGPL-3.0 / MPL-2.0)",
    existing_raw: bytes | None = None,
) -> bytes:
    """Build a Win32 VS_VERSIONINFO (RT_VERSION) binary payload with Sanctuary Browser metadata."""
    fixed_info, meta = _extract_existing_vs_fixed_and_versions(existing_raw)
    fields: list[tuple[str, str]] = []
    if company_name:
        fields.append(("CompanyName", company_name))
    fields.extend([
        ("FileDescription", file_description),
        ("FileVersion", meta["FileVersion"]),
        ("InternalName", internal_name),
        ("LegalCopyright", legal_copyright),
        ("OriginalFilename", original_filename),
        ("ProductName", product_name),
        ("ProductVersion", meta["ProductVersion"]),
    ])
    if "BuildID" in meta:
        fields.append(("BuildID", meta["BuildID"]))

    string_nodes = [
        _pack_vs_version_node(k, (v + "\x00").encode("utf-16le"), is_text=True)
        for k, v in fields
    ]
    string_table = _pack_vs_version_node("000004b0", is_text=True, children=string_nodes)
    string_file_info = _pack_vs_version_node("StringFileInfo", is_text=True, children=[string_table])
    translation_node = _pack_vs_version_node("Translation", b"\x00\x00\xb0\x04", is_text=False)
    var_file_info = _pack_vs_version_node("VarFileInfo", is_text=True, children=[translation_node])
    return _pack_vs_version_node(
        "VS_VERSION_INFO",
        fixed_info,
        is_text=False,
        children=[string_file_info, var_file_info],
    )


def patch_windows_pe_version_info(
    exe_path: Path,
    *,
    file_description: str = "Sanctuary Browser",
    product_name: str = "Sanctuary Browser",
    company_name: str = "",
) -> bool:
    """Rewrite RT_VERSION (res_type=16) on an unsigned Windows PE executable."""
    if sys.platform != "win32" or not exe_path.is_file():
        return False
    existing_vers = _enumerate_pe_resources(exe_path, 16)
    existing_raw = _read_pe_resource_bytes(exe_path, 16, 1)
    payload = build_pe_version_info_bytes(
        original_filename=exe_path.name,
        file_description=file_description,
        product_name=product_name,
        internal_name=product_name,
        company_name=company_name,
        existing_raw=existing_raw,
    )

    k32 = _pe_resource_api()
    h_update = k32.BeginUpdateResourceW(str(exe_path), 0)
    if not h_update:
        raise ctypes.WinError(ctypes.get_last_error())

    commit = False
    try:
        lang_en_us = 1033
        for old_name, old_lang in existing_vers:
            if old_name != 1 or old_lang != lang_en_us:
                buf = None if isinstance(old_name, int) else ctypes.create_unicode_buffer(old_name)
                lp_name = ctypes.c_void_p(old_name) if isinstance(old_name, int) else ctypes.cast(buf, ctypes.c_void_p)
                k32.UpdateResourceW(h_update, ctypes.c_void_p(16), lp_name, old_lang, None, 0)

        ver_buf = ctypes.create_string_buffer(payload, len(payload))
        if not k32.UpdateResourceW(
            h_update,
            ctypes.c_void_p(16),
            ctypes.c_void_p(1),
            lang_en_us,
            ctypes.cast(ver_buf, ctypes.c_void_p),
            len(payload),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        commit = True
    finally:
        ok = k32.EndUpdateResourceW(h_update, 0 if commit else 1)
        if commit and not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    return True


def patch_windows_pe_icons(target_dir: Path, ico_path: Path | None = None) -> list[str]:
    """Patch PE icons and VS_VERSION_INFO on staged Sanctuary Browser Windows binaries."""
    if sys.platform != "win32":
        return []
    resolved_ico = Path(ico_path) if ico_path else (REPO_ROOT / "web" / "assets" / "img" / "app_icon.ico")
    if not resolved_ico.is_file():
        raise FileNotFoundError(f"Missing Sanctuary Browser icon file: {resolved_ico}")

    base = Path(target_dir)
    patched: list[str] = []
    main_exes = (
        "sanctuary-browser.exe",
        "lm-sanctuary.exe",
        "firefox.exe",
        "private_browsing.exe",
        "desktop-launcher.exe",
        "desktop-launcher/desktop-launcher.exe",
    )
    for rel in main_exes:
        candidate = base / rel
        if candidate.is_file() and patch_windows_pe_exe_icon(candidate, resolved_ico):
            patch_windows_pe_version_info(
                candidate,
                file_description="Sanctuary Browser",
                product_name="Sanctuary Browser",
                company_name="",
            )
            patched.append(rel)

    for helper_rel, desc in (
        ("plugin-container.exe", "Sanctuary Browser Content Process"),
        ("nmhproxy.exe", "Sanctuary Browser Native Messaging Proxy"),
    ):
        helper = base / helper_rel
        if helper.is_file():
            patch_windows_pe_version_info(
                helper,
                file_description=desc,
                product_name="Sanctuary Browser",
                company_name="",
            )

    if patched:
        try:
            ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
        except Exception:
            pass
    return patched


def _scrub_brand_locale_text(rel_name: str, text: str) -> str:
    """Replace user-facing Sval brand strings in .ftl / .properties while preserving copyright & SPDX lines."""
    out_lines: list[str] = []
    is_sval_about = rel_name.replace("\\", "/").endswith("sval/about.ftl")
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#") or "SPDX-License-Identifier" in line:
            out_lines.append(line)
            continue
        if "Ellm Tree" in line or stripped.startswith("about-sval-copyright"):
            out_lines.append(line)
            continue
        if "=" in line:
            lhs, rhs = line.split("=", 1)
            rhs = rhs.replace("Sval Home", "Sanctuary Home").replace("Sval View", "Sanctuary View")
            rhs = re.sub(r"\bSval\b", "Sanctuary Browser", rhs)
            if is_sval_about:
                rhs = re.sub(r"\bLM-Sanctuary\b", "Sanctuary Browser", rhs)
            out_lines.append(f"{lhs}={rhs}")
        else:
            updated = line.replace("Sval Home", "Sanctuary Home").replace("Sval View", "Sanctuary View")
            updated = re.sub(r"\bSval\b", "Sanctuary Browser", updated)
            out_lines.append(updated)
    return "".join(out_lines)


def scrub_user_facing_brand_locales(ff_path: Path) -> int:
    """Scrub user-facing Sval strings from Firefox/Toolkit locale files after upstream patches apply."""
    touched = 0
    targets: list[Path] = []
    sval_locales = ff_path / "browser" / "components" / "sval" / "locales"
    if sval_locales.is_dir():
        targets.extend(sval_locales.rglob("*.ftl"))
    for rel in (
        "browser/locales/en-US/chrome/browser/appstrings.properties",
        "toolkit/locales/en-US/toolkit/branding/brandings.ftl",
    ):
        cand = ff_path / rel
        if cand.is_file():
            targets.append(cand)
    for path in targets:
        orig = path.read_text(encoding="utf-8", errors="ignore")
        updated = _scrub_brand_locale_text(path.as_posix(), orig)
        if updated != orig:
            path.write_text(updated, encoding="utf-8")
            touched += 1
    return touched


def _rewrite_sval_jar_and_engine_stubs(ff_path: Path) -> None:
    sval_dir = ff_path / "browser" / "components" / "sval"
    if not sval_dir.is_dir():
        return

    private_src_dir = DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "private"
    home_dest_dir = sval_dir / "home"
    if private_src_dir.is_dir():
        home_dest_dir.mkdir(parents=True, exist_ok=True)
        for priv_file in private_src_dir.iterdir():
            if priv_file.is_file():
                shutil.copy2(priv_file, home_dest_dir / priv_file.name)

    jar_mn = sval_dir / "jar.mn"
    if jar_mn.is_file():
        text = jar_mn.read_text(encoding="utf-8")
        updated = text.replace(
            "/browser/branding/sval/src/masters/04-wordmark-light-on-dark.svg",
            "/browser/branding/lm-sanctuary/content/about-wordmark.svg",
        )
        updated = re.sub(
            r"/browser/branding/sval/[^\s)]+",
            "/browser/branding/lm-sanctuary/content/about-logo.svg",
            updated,
        )
        sanctuary_private_entries = [
            (
                "chrome://browser/content/sval/home/favicon-private.svg",
                "% override chrome://browser/skin/privatebrowsing/favicon.svg chrome://browser/content/sval/home/favicon-private.svg",
            ),
            ("content/browser/sval/home/private.html", "    content/browser/sval/home/private.html (home/private.html)"),
            ("content/browser/sval/home/private.css", "    content/browser/sval/home/private.css (home/private.css)"),
            ("content/browser/sval/home/private.js", "    content/browser/sval/home/private.js (home/private.js)"),
            ("content/browser/sval/home/favicon-private.svg", "    content/browser/sval/home/favicon-private.svg (home/favicon-private.svg)"),
        ]
        missing_entries = [line for marker, line in sanctuary_private_entries if marker not in updated]
        if missing_entries and "browser.jar:" in updated:
            updated = updated.replace(
                "browser.jar:",
                "browser.jar:\n" + "\n".join(missing_entries),
                1,
            )
        if updated != text:
            jar_mn.write_text(updated, encoding="utf-8")

    logo_svg = ff_path / "browser" / "branding" / "lm-sanctuary" / "content" / "about-logo.svg"
    glyph_svg = sval_dir / "sval-glyph.svg"
    if logo_svg.is_file() and glyph_svg.is_file():
        shutil.copy2(logo_svg, glyph_svg)

    home_html = sval_dir / "home" / "home.html"
    if home_html.is_file():
        p_txt = home_html.read_text(encoding="utf-8")
        home_html.write_text(re.sub(r"\bSval\b", "Sanctuary Browser", p_txt), encoding="utf-8")

    scrub_user_facing_brand_locales(ff_path)

    # Match Sval sync-files.sh stubbing when its Rust/WASM engine artifacts are absent.
    worker_imports: set[str] = set()
    for worker in sval_dir.glob("*.worker.mjs"):
        w_text = worker.read_text(encoding="utf-8", errors="ignore")
        match = re.search(
            r"import\s+initWasm\s*,\s*\{([\s\S]*?)\}\s+from\s+[\"']chrome://browser/content/sval/sval_core\.mjs[\"'];",
            w_text,
        )
        if not match:
            continue
        for token in match.group(1).split(","):
            name = re.sub(r"\s+as\s+.*$", "", token.strip()).strip()
            if name and name not in ("SvalDocument", "SyncOutcome", "initSync"):
                worker_imports.add(name)

    core_mjs = sval_dir / "sval_core.mjs"
    if not core_mjs.exists():
        lines = [
            "/* eslint-disable -- generated stub when Sval WASM engine is not built */",
            'const MESSAGE = "sval: the engine artifact is not built";',
            "function unavailable() {",
            '  throw Object.assign(new Error(MESSAGE), { code: "engine_not_built" });',
            "}",
            "export class SvalDocument {",
            "  constructor() { unavailable(); }",
            "  static loadJson() { unavailable(); }",
            "}",
            "export class SyncOutcome {}",
            "export function initSync() { unavailable(); }",
            "export default function () { unavailable(); }",
        ]
        for fn_name in sorted(worker_imports):
            lines.append(f"export function {fn_name}() {{ unavailable(); }}")
        core_mjs.write_text("\n".join(lines) + "\n", encoding="utf-8")

    core_wasm = sval_dir / "sval_core_bg.wasm"
    if not core_wasm.exists():
        core_wasm.write_bytes(b"\x00asm\x01\x00\x00\x00")

    sval_manifest = sval_dir / "sval.manifest"
    if sval_manifest.is_file():
        kept_manifest = [
            line
            for line in sval_manifest.read_text(encoding="utf-8").splitlines(keepends=True)
            if not line.strip()
            or line.lstrip().startswith("#")
            or any(sym in line for sym in ("SvalBlocking.", "SvalPageRules.", "SvalScriptlets."))
        ]
        sval_manifest.write_text("".join(kept_manifest), encoding="utf-8")

    # Replace static top-level imports of pruned Sval modules with inert stubs so
    # remaining Sval components never throw ChromeUtils import errors.
    stub_replacements = (
        (
            re.compile(r'import\s+\{\s*isQuickPeek\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalQuickPeekTab\.sys\.mjs";'),
            'const isQuickPeek = tab => tab?.hasAttribute?.("sval-quick-peek") === true;',
        ),
        (
            re.compile(r'import\s+\{\s*SvalQuickPeek\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalQuickPeek\.sys\.mjs";'),
            "const SvalQuickPeek = { mountLinkItem() {}, tabOf: () => null, close() {}, openClick: () => false, open() {} };",
        ),
        (
            re.compile(r'import\s+\{\s*SvalPeek\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalPeek\.sys\.mjs";'),
            "const SvalPeek = { isOpening: () => false, isPeek: () => false, mount() {}, loadWindow() {}, startWindow() {}, windows: () => [], closeAll() {} };",
        ),
        (
            re.compile(r'import\s+\{\s*SYNC_RULES\s+as\s+PEEK_RULES\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalPeek\.sys\.mjs";'),
            "const PEEK_RULES = [];",
        ),
        (
            re.compile(r'import\s+\{\s*SvalFeedbackForm\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalFeedbackForm\.sys\.mjs";'),
            "const SvalFeedbackForm = { mountWindow() {}, open: async () => false, toggle() {}, report: async () => false };",
        ),
        (
            re.compile(r'import\s+\{\s*HELP_MENU_ITEM_ID\s+as\s+FEEDBACK_ITEM_ID\s*\}\s+from\s+"moz-src:///browser/components/sval/SvalFeedbackForm\.sys\.mjs";'),
            'const FEEDBACK_ITEM_ID = "sval-help-send-feedback";',
        ),
    )
    for mod in sval_dir.glob("*.sys.mjs"):
        src = mod.read_text(encoding="utf-8", errors="ignore")
        patched = src
        for pat, rep in stub_replacements:
            patched = pat.sub(rep, patched)
        if patched != src:
            mod.write_text(patched, encoding="utf-8")


def _should_prune(rel_chrome_path: Path, pruned_prefixes: Iterable[str]) -> bool:
    posix_path = f"chrome/{rel_chrome_path.as_posix()}"
    for prefix in pruned_prefixes:
        clean_prefix = str(prefix).strip("/")
        if posix_path == clean_prefix or posix_path.startswith(f"{clean_prefix}/"):
            return True
    return False


def stage_overlay_tree(
    sval_dir: Path,
    firefox_dir: Path,
    *,
    mode: str = "artifact",
    repo_root: Path = REPO_ROOT,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Copy filtered Sval chrome + LM-Sanctuary branding/actors/mozconfig onto firefox_dir."""
    if mode not in ("artifact", "gecko"):
        raise ValueError(f"Invalid mode: {mode}")
    cfg = config or load_upstream_config()
    sval_path = Path(sval_dir)
    ff_path = Path(firefox_dir)
    excluded_patches = set(cfg["excluded_sval_patches"])
    pruned_paths = list(cfg["pruned_sval_paths"])

    # 1. Compute combined patch series
    kept_series: list[str] = []
    sval_series = sval_path / "patches" / "series"
    if sval_series.is_file():
        for raw_line in sval_series.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or line in excluded_patches:
                continue
            kept_series.append(line)
    for local_patch in sorted((DESKTOP_DIR / "patches").glob("*.patch")):
        kept_series.append(f"sanctuary:{local_patch.name}")
    (ff_path / ".sanctuary-sval-series").write_text("\n".join(kept_series) + "\n", encoding="utf-8")

    # 2. Remove any stock Sval branding directory
    stale_sval_branding = ff_path / "browser" / "branding" / "sval"
    if stale_sval_branding.exists():
        shutil.rmtree(stale_sval_branding)

    # 3. Copy Sval chrome files, dropping Quick Peek / Feedback / pruned paths
    sval_chrome = sval_path / "chrome"
    copied_chrome = 0
    if sval_chrome.is_dir():
        for src_file in sval_chrome.rglob("*"):
            if not src_file.is_file() or src_file.name == ".gitkeep":
                continue
            rel = src_file.relative_to(sval_chrome)
            if _should_prune(rel, pruned_paths):
                continue
            dest_file = ff_path / rel
            dest_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, dest_file)
            copied_chrome += 1

    # 4. Update Sval moz.build and scrub any leftover vendor endpoints
    _prune_sval_moz_build(
        ff_path / "browser" / "components" / "sval" / "moz.build",
        {Path(p).name for p in pruned_paths if p.endswith(".mjs")},
    )
    scrubbed = _scrub_forbidden_endpoints(ff_path / "browser", cfg["forbidden_endpoints"])

    # 5. Stage LM-Sanctuary branding + resized icons & rewrite Sval jar/engine stubs
    dest_branding = ff_path / "browser" / "branding" / "lm-sanctuary"
    if dest_branding.exists():
        shutil.rmtree(dest_branding)
    shutil.copytree(DESKTOP_DIR / "branding" / "lm-sanctuary", dest_branding)
    _materialize_branding_icons(dest_branding, repo_root=repo_root, ff_path=ff_path)
    _rewrite_sval_jar_and_engine_stubs(ff_path)

    # 6. Stage LM-Sanctuary native chrome actors
    dest_sanctuary = ff_path / "browser" / "components" / "sanctuary"
    if dest_sanctuary.exists():
        shutil.rmtree(dest_sanctuary)
    shutil.copytree(
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary",
        dest_sanctuary,
    )

    # 7. Write combined mozconfig
    base_moz = (DESKTOP_DIR / "mozconfig").read_text(encoding="utf-8").rstrip()
    frag_moz = (DESKTOP_DIR / f"mozconfig.{mode}").read_text(encoding="utf-8").lstrip()
    (ff_path / "mozconfig").write_text(f"{base_moz}\n\n{frag_moz}", encoding="utf-8")

    audit_staged_tree(ff_path, config=cfg)
    return {
        "series_count": len(kept_series),
        "copied_chrome": copied_chrome,
        "scrubbed_files": [str(p) for p in scrubbed],
    }


def audit_staged_tree(firefox_dir: Path, *, config: dict[str, Any] | None = None) -> None:
    cfg = config or load_upstream_config()
    ff_path = Path(firefox_dir)
    if (ff_path / "browser" / "branding" / "sval").exists():
        raise AssertionError("Staged tree must not contain branding/sval")

    for forbidden_name in (
        "SvalQuickPeek.sys.mjs",
        "SvalQuickPeekTab.sys.mjs",
        "SvalPeek.sys.mjs",
        "SvalFeedbackForm.sys.mjs",
        "SvalFeedback.sys.mjs",
    ):
        matches = list((ff_path / "browser").rglob(forbidden_name))
        if matches:
            raise AssertionError(f"Pruned Sval module still present: {matches}")

    endpoints = [str(e) for e in cfg["forbidden_endpoints"] if e]
    for item in (ff_path / "browser").rglob("*"):
        if not item.is_file() or not _is_text_file(item):
            continue
        txt = item.read_text(encoding="utf-8", errors="ignore")
        for ep in endpoints:
            if ep in txt:
                raise AssertionError(f"Forbidden endpoint {ep} found in {item}")

    required_files = [
        ff_path / "browser" / "components" / "sval" / "SvalBlocking.sys.mjs",
        ff_path / "browser" / "components" / "sval" / "SvalPasswordManager.sys.mjs",
        ff_path / "browser" / "components" / "sanctuary" / "SanctuaryHostChild.sys.mjs",
        ff_path / "browser" / "components" / "sanctuary" / "SanctuaryHostParent.sys.mjs",
        ff_path / "browser" / "components" / "sanctuary" / "SanctuaryWindowHost.sys.mjs",
        ff_path / "browser" / "branding" / "lm-sanctuary" / "moz.build",
    ]
    for req in required_files:
        if not req.is_file():
            raise AssertionError(f"Missing required staged file: {req}")


def verify_desktop_templates(repo_root: Path = REPO_ROOT) -> None:
    cfg = load_upstream_config()
    required = [
        DESKTOP_DIR / "mozconfig",
        DESKTOP_DIR / "mozconfig.artifact",
        DESKTOP_DIR / "mozconfig.gecko",
        DESKTOP_DIR / "README.md",
        DESKTOP_DIR / "patches" / "sanctuary-app-vendor.patch",
        DESKTOP_DIR / "patches" / "sanctuary-actor-registration.patch",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "moz.build",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryHostChild.sys.mjs",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryHostParent.sys.mjs",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryWindowHost.sys.mjs",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "private" / "private.html",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "private" / "private.css",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "private" / "private.js",
        DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "private" / "favicon-private.svg",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "branding.nsi",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "configure.sh",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "moz.build",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "locales" / "en-US" / "brand.ftl",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "locales" / "en-US" / "brand.properties",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "pref" / "00-lm-sanctuary-prefs.js",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "stubinstaller" / "installing_page.css",
        DESKTOP_DIR / "branding" / "lm-sanctuary" / "stubinstaller" / "profile_cleanup_page.css",
        DESKTOP_DIR / "packaging" / "package_windows.ps1",
        DESKTOP_DIR / "packaging" / "package_linux.sh",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "control.in",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "rules",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "install.in",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "links.in",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "distribution.ini",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "package-prefs.js",
        DESKTOP_DIR / "packaging" / "linux" / "debian" / "lm-sanctuary.desktop",
        DESKTOP_DIR / "packaging" / "linux" / "rpm" / "firefox.spec.j2",
        DESKTOP_DIR / "packaging" / "linux" / "rpm" / "distribution.ini",
        DESKTOP_DIR / "packaging" / "linux" / "rpm" / "package-prefs.js",
        DESKTOP_DIR / "packaging" / "linux" / "rpm" / "lm-sanctuary.desktop",
        DESKTOP_DIR / "packaging" / "linux" / "appimage" / "AppRun",
        DESKTOP_DIR / "packaging" / "linux" / "appimage" / "lm-sanctuary.desktop",
    ]
    for path in required:
        if not path.is_file():
            raise FileNotFoundError(f"Missing browser-desktop template: {path}")

    child_src = (DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryHostChild.sys.mjs").read_text(encoding="utf-8")
    if "win.location?.origin === allowedOrigin" not in child_src or "browser.sanctuary.shellUrl" not in child_src:
        raise AssertionError("SanctuaryHostChild.sys.mjs must gate injection by shell origin pref")

    endpoints = [str(e) for e in cfg["forbidden_endpoints"] if e]
    for sub in ("branding", "chrome", "patches", "packaging"):
        for item in (DESKTOP_DIR / sub).rglob("*"):
            if not item.is_file():
                continue
            txt = item.read_text(encoding="utf-8", errors="ignore")
            for ep in endpoints:
                if ep in txt:
                    raise AssertionError(f"Forbidden endpoint {ep} in template {item}")
            if sub == "packaging" and "sval.app" in txt:
                raise AssertionError(f"sval.app URL found in packaging template {item}")

    print("DESKTOP_TEMPLATES_VERIFIED")


def _subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    if sys.platform == "win32":
        mb_root = _find_mozilla_build_dir(env=env)
        if mb_root is not None and not str(env.get("MOZILLABUILD") or "").strip():
            env["MOZILLABUILD"] = f"{mb_root}/"
        env.setdefault("MSYS2_PATH_TYPE", "inherit")
    return env


def _run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=str(cwd), env=_subprocess_env(), check=True)


def _find_mozilla_build_dir(
    env: dict[str, str] | None = None,
    mozilla_build_dir: Path | None = None,
) -> Path | None:
    env_map = env if env is not None else os.environ
    candidates: list[Path] = []
    if mozilla_build_dir is not None:
        candidates.append(mozilla_build_dir)
    if str(env_map.get("MOZILLABUILD") or "").strip():
        candidates.append(Path(str(env_map["MOZILLABUILD"]).strip()))
    candidates.append(Path("C:/mozilla-build"))
    local_appdata = str(env_map.get("LOCALAPPDATA") or os.environ.get("LOCALAPPDATA") or "").strip()
    if local_appdata:
        candidates.append(Path(local_appdata) / "mozilla-build")
    for cand in candidates:
        if (cand / "start-shell.bat").is_file() or (cand / "msys2" / "usr" / "bin" / "bash.exe").is_file():
            return cand
    return None


def _bash_executable() -> str:
    if sys.platform == "win32":
        mb_root = _find_mozilla_build_dir() or Path("C:/mozilla-build")
        msys_bash = mb_root / "msys2" / "usr" / "bin" / "bash.exe"
        if msys_bash.is_file():
            return str(msys_bash)
    return "bash"


def check_host_build_prereqs(
    platform: str = sys.platform,
    env: dict[str, str] | None = None,
    mozilla_build_dir: Path | None = None,
) -> None:
    """Fail fast before cloning Firefox ESR if Windows MozillaBuild is missing or inactive."""
    if platform != "win32":
        return
    env_map = env if env is not None else os.environ
    if str(env_map.get("MOZILLABUILD") or "").strip():
        return
    if mozilla_build_dir is not None and not (mozilla_build_dir / "start-shell.bat").is_file():
        mb_dir = None
    else:
        mb_dir = _find_mozilla_build_dir(env=env_map, mozilla_build_dir=mozilla_build_dir)
    if mb_dir is not None:
        raise RuntimeError(
            f"Run bootstrap_gecko.py inside {mb_dir / 'start-shell.bat'} so Firefox's ./mach build environment is active."
        )
    raise RuntimeError(
        "MozillaBuild is required on Windows to compile lm-sanctuary.exe. "
        "Install https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe to C:\\mozilla-build, "
        "open start-shell.bat, and run: python browser-desktop/bootstrap_gecko.py --mode artifact"
    )


def _apply_patch_file(patch_path: Path, ff_dir: Path) -> None:
    res = subprocess.run(["git", "-c", "core.longpaths=true", "apply", str(patch_path)], cwd=str(ff_dir))
    if res.returncode == 0:
        return
    res3 = subprocess.run(["git", "-c", "core.longpaths=true", "apply", "--3way", str(patch_path)], cwd=str(ff_dir))
    if res3.returncode != 0:
        raise RuntimeError(f"Failed to apply patch: {patch_path.name} (exit {res3.returncode})")


def _rewrite_omni_jar_entries(jar_path: Path, replacements: dict[str, bytes], text_scrub_suffixes: tuple[str, ...] = (".ftl", ".properties")) -> int:
    """Update and scrub entries inside a Gecko omni.ja archive using mozpack.mozjar or zipfile."""
    if not jar_path.is_file():
        return 0
    mozbuild_py = BUILD_DIR / "firefox" / "python" / "mozbuild"
    JarReader = None
    JarWriter = None
    if mozbuild_py.is_dir():
        if str(mozbuild_py) not in sys.path:
            sys.path.insert(0, str(mozbuild_py))
        try:
            from mozpack.mozjar import JarReader as _JR, JarWriter as _JW  # type: ignore

            JarReader, JarWriter = _JR, _JW
        except Exception:
            JarReader, JarWriter = None, None

    changed = 0
    tmp_path = jar_path.with_suffix(".ja.tmp")
    if JarReader is not None and JarWriter is not None:
        reader = JarReader(file=str(jar_path))
        seen: set[str] = set()
        items: list[tuple[str, bytes, bool]] = []
        for entry in reader:
            name = entry.filename
            seen.add(name)
            orig_bytes = entry.read()
            new_bytes = replacements.get(name, orig_bytes)
            if name not in replacements and name.endswith(text_scrub_suffixes):
                decoded = orig_bytes.decode("utf-8", errors="ignore")
                scrubbed = _scrub_brand_locale_text(name, decoded)
                if scrubbed != decoded:
                    new_bytes = scrubbed.encode("utf-8")
            if new_bytes != orig_bytes:
                changed += 1
            items.append((name, new_bytes, bool(entry.compressed)))
        reader.close()
        for name, new_bytes in replacements.items():
            if name not in seen:
                items.append((name, new_bytes, True))
                changed += 1
        if changed:
            with JarWriter(file=str(tmp_path), compress=True) as writer:
                for name, data, comp in items:
                    writer.add(name, data, compress=comp)
            os.replace(tmp_path, jar_path)
        return changed

    with zipfile.ZipFile(jar_path, "r") as zin:
        infos = zin.infolist()
        raw_map = {info.filename: (info, zin.read(info.filename)) for info in infos}

    out_items: list[tuple[str, bytes, int]] = []
    for name, (info, orig_bytes) in raw_map.items():
        new_bytes = replacements.get(name, orig_bytes)
        if name not in replacements and name.endswith(text_scrub_suffixes):
            decoded = orig_bytes.decode("utf-8", errors="ignore")
            scrubbed = _scrub_brand_locale_text(name, decoded)
            if scrubbed != decoded:
                new_bytes = scrubbed.encode("utf-8")
        if new_bytes != orig_bytes:
            changed += 1
        out_items.append((name, new_bytes, info.compress_type))
    for name, new_bytes in replacements.items():
        if name not in raw_map:
            out_items.append((name, new_bytes, zipfile.ZIP_DEFLATED))
            changed += 1
    if changed:
        with zipfile.ZipFile(tmp_path, "w") as zout:
            for name, data, ctype in out_items:
                zout.writestr(name, data, compress_type=ctype)
        os.replace(tmp_path, jar_path)
    return changed


def rebrand_packaged_dist(target_dir: Path, repo_root: Path = REPO_ROOT) -> dict[str, int]:
    """Sync Sanctuary Browser brand files, host actors, and scrubbed locales into a packaged dist folder."""
    dist_path = Path(target_dir)
    desktop_root = repo_root / "browser-desktop"
    branding_root = desktop_root / "branding" / "lm-sanctuary"
    sanctuary_comp = desktop_root / "chrome" / "browser" / "components" / "sanctuary"

    for ini_rel in ("application.ini", "browser/application.ini"):
        ini_file = dist_path / ini_rel
        if ini_file.is_file():
            ini_txt = ini_file.read_text(encoding="utf-8", errors="ignore")
            updated_ini = re.sub(r"(?m)^CodeName=.*$", "CodeName=Sanctuary Browser", ini_txt)
            if updated_ini != ini_txt:
                ini_file.write_text(updated_ini, encoding="utf-8")

    root_replacements: dict[str, bytes] = {}
    for mod_name in ("SanctuaryWindowHost.sys.mjs", "SanctuaryHostParent.sys.mjs", "SanctuaryHostChild.sys.mjs"):
        src_mod = sanctuary_comp / mod_name
        if src_mod.is_file():
            root_replacements[f"moz-src/browser/components/sanctuary/{mod_name}"] = src_mod.read_bytes()

    browser_replacements: dict[str, bytes] = {}
    file_pairs = (
        (branding_root / "locales" / "en-US" / "brand.ftl", "localization/en-US/branding/brand.ftl"),
        (branding_root / "locales" / "en-US" / "brand.properties", "chrome/en-US/locale/branding/brand.properties"),
        (branding_root / "content" / "about-wordmark.svg", "chrome/browser/content/branding/about-wordmark.svg"),
        (branding_root / "content" / "about-wordmark.svg", "chrome/browser/content/branding/firefox-wordmark.svg"),
        (branding_root / "content" / "about-logo.svg", "chrome/browser/content/branding/about-logo.svg"),
        (sanctuary_comp / "private" / "private.html", "chrome/browser/content/browser/sval/home/private.html"),
        (sanctuary_comp / "private" / "private.css", "chrome/browser/content/browser/sval/home/private.css"),
        (sanctuary_comp / "private" / "private.js", "chrome/browser/content/browser/sval/home/private.js"),
        (sanctuary_comp / "private" / "favicon-private.svg", "chrome/browser/content/browser/sval/home/favicon-private.svg"),
        (branding_root / "pref" / "00-lm-sanctuary-prefs.js", "defaults/preferences/firefox-branding.js"),
        (branding_root / "pref" / "00-lm-sanctuary-prefs.js", "defaults/preferences/00-lm-sanctuary-prefs.js"),
    )
    for src_path, jar_dest in file_pairs:
        if src_path.is_file():
            browser_replacements[jar_dest] = src_path.read_bytes()

    omni_changed = _rewrite_omni_jar_entries(dist_path / "omni.ja", root_replacements)
    browser_omni_changed = _rewrite_omni_jar_entries(dist_path / "browser" / "omni.ja", browser_replacements)
    return {"omni_changed": omni_changed, "browser_omni_changed": browser_omni_changed}


def sync_upstream_firefox_pin(sval_dir: Path, cfg: dict[str, Any], upstream_json_path: Path = UPSTREAM_JSON) -> dict[str, str]:
    """Align firefox_rev & firefox_tag with Sval's upstream.txt security point-release pin when present."""
    upstream_txt = Path(sval_dir) / "upstream.txt"
    if not upstream_txt.is_file():
        return {"firefox_rev": str(cfg["firefox_rev"]), "firefox_tag": str(cfg.get("firefox_tag", ""))}
    raw = upstream_txt.read_text(encoding="utf-8", errors="ignore")
    ref_match = re.search(r"(?m)^UPSTREAM_REF=([0-9a-fA-F]{40})\s*$", raw)
    tag_match = re.search(r"tag=(FIREFOX_[A-Za-z0-9_]+)", raw)
    changed = False
    if ref_match and ref_match.group(1) != cfg.get("firefox_rev"):
        cfg["firefox_rev"] = ref_match.group(1)
        changed = True
    if tag_match and tag_match.group(1) != cfg.get("firefox_tag"):
        cfg["firefox_tag"] = tag_match.group(1)
        changed = True
    if changed and upstream_json_path.is_file():
        upstream_json_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return {"firefox_rev": str(cfg["firefox_rev"]), "firefox_tag": str(cfg.get("firefox_tag", ""))}


def run_full_build(mode: str, run_bootstrap: bool = False) -> None:
    check_host_build_prereqs()
    cfg = load_upstream_config()
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    sval_dir = BUILD_DIR / "sval"
    ff_dir = BUILD_DIR / "firefox"

    if not sval_dir.exists():
        _run(
            ["git", "-c", "core.longpaths=true", "clone", "--depth=1", "--branch", cfg["sval_branch"], cfg["sval_remote"], str(sval_dir)],
            BUILD_DIR,
        )
    else:
        _run(["git", "-c", "core.longpaths=true", "fetch", "origin", cfg["sval_branch"]], sval_dir)
        _run(["git", "-c", "core.longpaths=true", "reset", "--hard", f"origin/{cfg['sval_branch']}"], sval_dir)

    sync_upstream_firefox_pin(sval_dir, cfg)

    if not ff_dir.exists():
        _run(["git", "-c", "core.longpaths=true", "clone", "--depth=1", cfg["firefox_remote"], str(ff_dir)], BUILD_DIR)
    _run(["git", "config", "core.longpaths", "true"], ff_dir)
    _run(["git", "-c", "core.longpaths=true", "fetch", "--depth=1", "origin", cfg["firefox_rev"]], ff_dir)
    _run(["git", "-c", "core.longpaths=true", "checkout", "-f", cfg["firefox_rev"]], ff_dir)
    _run(["git", "-c", "core.longpaths=true", "reset", "--hard", cfg["firefox_rev"]], ff_dir)
    _run(["git", "-c", "core.longpaths=true", "clean", "-fd", "-e", "objdir-*", "-e", "mozconfig"], ff_dir)

    bash_bin = _bash_executable()
    if run_bootstrap:
        app_choice = "browser_artifact_mode" if mode == "artifact" else "browser"
        # Bootstrap before writing mozconfig because `mach bootstrap` overwrites mozconfig.
        _run([bash_bin, "-lc", f"./mach --no-interactive bootstrap --application-choice={shlex.quote(app_choice)}"], ff_dir)

    stage_overlay_tree(sval_dir, ff_dir, mode=mode, repo_root=REPO_ROOT, config=cfg)

    excluded = set(cfg["excluded_sval_patches"])
    sval_path_series = sval_dir / "patches" / "series"
    if sval_path_series.is_file():
        for raw_line in sval_path_series.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or line in excluded:
                continue
            patch_file = sval_dir / "patches" / line
            if patch_file.is_file():
                _apply_patch_file(patch_file, ff_dir)

    for local_patch in sorted((DESKTOP_DIR / "patches").glob("*.patch")):
        _apply_patch_file(local_patch, ff_dir)

    scrub_user_facing_brand_locales(ff_dir)
    _scrub_forbidden_endpoints(ff_dir / "browser", cfg["forbidden_endpoints"])
    _scrub_forbidden_endpoints(ff_dir / "build", cfg["forbidden_endpoints"])
    audit_staged_tree(ff_dir, config=cfg)

    _run([bash_bin, "-lc", "./mach --no-interactive configure && ./mach --no-interactive build && ./mach --no-interactive package"], ff_dir)
    dist_base = ff_dir / f"objdir-sanctuary-{mode}" / "dist"
    for candidate_dir in (dist_base / "bin", dist_base / "lm-sanctuary", dist_base / "firefox"):
        if candidate_dir.is_dir():
            rebrand_packaged_dist(candidate_dir, repo_root=REPO_ROOT)
            patch_windows_pe_icons(candidate_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanctuary Browser Desktop Gecko Bootstrapper")
    parser.add_argument("--verify-templates", action="store_true")
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--patch-pe-icons", default="")
    parser.add_argument("--rebrand-dist", default="")
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--sval-dir", default="")
    parser.add_argument("--firefox-dir", default="")
    parser.add_argument("--mode", choices=("artifact", "gecko"), default="artifact")
    args = parser.parse_args()

    if args.verify_templates:
        verify_desktop_templates()
        return 0
    if args.rebrand_dist:
        stats = rebrand_packaged_dist(Path(args.rebrand_dist), repo_root=REPO_ROOT)
        print(f"REBRANDED_DIST:{stats['omni_changed']}:{stats['browser_omni_changed']}")
        if not args.patch_pe_icons:
            return 0
    if args.patch_pe_icons:
        patched = patch_windows_pe_icons(Path(args.patch_pe_icons))
        print(f"PATCHED_PE_ICONS:{len(patched)}")
        return 0
    if args.stage_only:
        if not args.sval_dir or not args.firefox_dir:
            parser.error("--stage-only requires --sval-dir and --firefox-dir")
        stage_overlay_tree(Path(args.sval_dir), Path(args.firefox_dir), mode=args.mode)
        print("DESKTOP_OVERLAY_STAGED")
        return 0

    run_full_build(args.mode, run_bootstrap=args.bootstrap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
