"""Verify Stage 2 desktop Gecko overlay staging, KeePassXC NMH registration, launcher, and packaging."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_DIR = REPO_ROOT / "browser-desktop"
SANCTUARY_DIR = REPO_ROOT / "sanctuary"

for p in (str(DESKTOP_DIR), str(SANCTUARY_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import bootstrap_gecko  # noqa: E402
import desktop as sanctuary_desktop  # noqa: E402


def run_tests() -> None:
    # 1. Verify all tracked templates & zero forbidden endpoints
    bootstrap_gecko.verify_desktop_templates(REPO_ROOT)

    tmp_preflight = Path(tempfile.mkdtemp(prefix="sanctuary_mb_preflight_"))
    try:
        try:
            bootstrap_gecko.check_host_build_prereqs(
                platform="win32",
                env={},
                mozilla_build_dir=tmp_preflight / "missing",
            )
            raise AssertionError("Expected check_host_build_prereqs to fail without MozillaBuild")
        except RuntimeError as exc:
            assert "MozillaBuild" in str(exc), str(exc)

        bootstrap_gecko.check_host_build_prereqs(
            platform="win32",
            env={"MOZILLABUILD": "C:\\mozilla-build"},
        )
    finally:
        shutil.rmtree(tmp_preflight, ignore_errors=True)

    # 2. Verify synthetic Sval + Firefox ESR tree staging & auditing
    tmp_root = Path(tempfile.mkdtemp(prefix="sanctuary_stage2_test_"))
    try:
        sval_dir = tmp_root / "sval"
        ff_dir = tmp_root / "firefox"
        (sval_dir / "patches").mkdir(parents=True)
        (sval_dir / "branding" / "sval").mkdir(parents=True)
        (sval_dir / "chrome" / "browser" / "components" / "sval").mkdir(parents=True)
        (ff_dir / "browser").mkdir(parents=True)

        (sval_dir / "patches" / "series").write_text(
            "\n".join([
                "# Comment",
                "sval-component-dir.patch",
                "sval-app-vendor.patch",
                "feedback-page-opens-sval-form.patch",
                "about-dialog-describe-sval.patch",
            ]) + "\n",
            encoding="utf-8",
        )
        (sval_dir / "branding" / "sval" / "moz.build").write_text("# sval\n", encoding="utf-8")
        sval_comp = sval_dir / "chrome" / "browser" / "components" / "sval"
        (sval_comp / "moz.build").write_text(
            'MOZ_SRC_FILES += [\n  "SvalBlocking.sys.mjs",\n  "SvalQuickPeek.sys.mjs",\n  "SvalPasswordManager.sys.mjs",\n]\n',
            encoding="utf-8",
        )
        (sval_comp / "jar.mn").write_text(
            'browser.jar:\n  content/browser/sval/home/mark.svg (/browser/branding/sval/content/mark.svg)\n',
            encoding="utf-8",
        )
        (sval_comp / "SvalHome.worker.mjs").write_text(
            'import initWasm, {\n  greetUser,\n} from "chrome://browser/content/sval/sval_core.mjs";\n',
            encoding="utf-8",
        )
        (sval_comp / "SvalBlocking.sys.mjs").write_text("export const SvalBlocking = {};\n", encoding="utf-8")
        (sval_comp / "SvalPasswordManager.sys.mjs").write_text(
            'export const EXT = "keepassxc-browser@keepassxc.org";\n',
            encoding="utf-8",
        )
        (sval_comp / "SvalQuickPeek.sys.mjs").write_text("export const SvalQuickPeek = {};\n", encoding="utf-8")
        (sval_comp / "SvalQuickPeekTab.sys.mjs").write_text("export const SvalQuickPeekTab = {};\n", encoding="utf-8")
        (sval_comp / "SvalFeedbackForm.sys.mjs").write_text(
            'export const REPORT = "https://feedback.sval.app/report";\nexport const DL = "https://download.sval.app/";\n',
            encoding="utf-8",
        )

        # Pre-existing stale branding/sval should be wiped on stage
        (ff_dir / "browser" / "branding" / "sval").mkdir(parents=True)
        (ff_dir / "browser" / "branding" / "sval" / "old.txt").write_text("stale", encoding="utf-8")

        result = bootstrap_gecko.stage_overlay_tree(sval_dir, ff_dir, mode="artifact", repo_root=REPO_ROOT)
        assert result["series_count"] == 3, result

        series_text = (ff_dir / ".sanctuary-sval-series").read_text(encoding="utf-8")
        assert "sval-component-dir.patch" in series_text
        assert "sanctuary:sanctuary-app-vendor.patch" in series_text
        assert "feedback-page-opens-sval-form.patch" not in series_text
        assert "sval-app-vendor.patch\n" not in series_text

        staged_moz_build = (ff_dir / "browser" / "components" / "sval" / "moz.build").read_text(encoding="utf-8")
        assert "SvalQuickPeek.sys.mjs" not in staged_moz_build
        assert "SvalBlocking.sys.mjs" in staged_moz_build
        assert (ff_dir / "browser" / "branding" / "lm-sanctuary" / "default128.png").is_file()
        assert (ff_dir / "browser" / "branding" / "lm-sanctuary" / "firefox.ico").is_file()
        assert (ff_dir / "browser" / "branding" / "lm-sanctuary" / "pref" / "firefox-branding.js").is_file()
        assert (ff_dir / "browser" / "branding" / "lm-sanctuary" / "firefox.VisualElementsManifest.xml").is_file()
        staged_jar = (ff_dir / "browser" / "components" / "sval" / "jar.mn").read_text(encoding="utf-8")
        assert "/browser/branding/sval/" not in staged_jar
        assert "/browser/branding/lm-sanctuary/" in staged_jar
        staged_core = (ff_dir / "browser" / "components" / "sval" / "sval_core.mjs").read_text(encoding="utf-8")
        assert "export function greetUser()" in staged_core
        assert (ff_dir / "browser" / "components" / "sval" / "sval_core_bg.wasm").read_bytes()[:4] == b"\x00asm"
        assert (ff_dir / "browser" / "components" / "sanctuary" / "SanctuaryHostChild.sys.mjs").is_file()
        priv_home = (ff_dir / "browser" / "components" / "sval" / "home" / "private.html").read_text(encoding="utf-8")
        assert "Sanctuary Browser Private Browsing" in priv_home
        assert "starfield" not in priv_home
        assert (ff_dir / "browser" / "components" / "sval" / "home" / "private.css").is_file()
        assert (ff_dir / "browser" / "components" / "sval" / "home" / "private.js").is_file()
        assert (ff_dir / "browser" / "components" / "sval" / "home" / "favicon-private.svg").is_file()
        assert "content/browser/sval/home/private.css" in staged_jar
        assert "content/browser/sval/home/private.js" in staged_jar
        assert "chrome://browser/skin/privatebrowsing/favicon.svg" in staged_jar
        staged_mozconfig = (ff_dir / "mozconfig").read_text(encoding="utf-8")
        assert "--enable-artifact-builds" in staged_mozconfig
        assert "--with-app-name=firefox" in staged_mozconfig

        # Verify locale brand scrubber replaces user-facing Sval strings while preserving Ellm Tree copyright
        scrubbed_props = bootstrap_gecko._scrub_brand_locale_text(
            "chrome/en-US/locale/browser/appstrings.properties",
            "connectionFailure=Sval can’t establish a connection to %S.\n",
        )
        assert "Sanctuary Browser can’t establish" in scrubbed_props
        assert "Sval" not in scrubbed_props
        scrubbed_about = bootstrap_gecko._scrub_brand_locale_text(
            "localization/en-US/sval/about.ftl",
            "about-sval-description = Sval blocks trackers.\nabout-sval-copyright = © 2026 Ellm Tree, Inc.\n",
        )
        assert "Sanctuary Browser blocks trackers." in scrubbed_about
        assert "© 2026 Ellm Tree, Inc." in scrubbed_about

        # Verify upstream.txt Firefox ESR security pin sync
        fake_sval_pin = tmp_root / "sval_pin_check"
        fake_sval_pin.mkdir(parents=True)
        (fake_sval_pin / "upstream.txt").write_text(
            "# renovate: datasource=github-tags depName=mozilla-firefox/firefox tag=FIREFOX_153_8_0esr_RELEASE\n"
            "UPSTREAM_REF=1111111111111111111111111111111111111111\n",
            encoding="utf-8",
        )
        fake_cfg = {"firefox_rev": "0" * 40, "firefox_tag": "FIREFOX_153_7_0esr_RELEASE"}
        synced_pin = bootstrap_gecko.sync_upstream_firefox_pin(
            fake_sval_pin,
            fake_cfg,
            upstream_json_path=tmp_root / "nonexistent_upstream.json",
        )
        assert synced_pin["firefox_rev"] == "1" * 40
        assert synced_pin["firefox_tag"] == "FIREFOX_153_8_0esr_RELEASE"

        # Check find_gecko_binary prioritizes sanctuary-browser.exe and falls back cleanly
        fake_repo = tmp_root / "repo_bin_check"
        (fake_repo / "browser-desktop" / "dist" / "lm-sanctuary").mkdir(parents=True)
        fallback_bin = fake_repo / "browser-desktop" / "dist" / "lm-sanctuary" / ("firefox.exe" if sys.platform == "win32" else "firefox")
        fallback_bin.write_text("stub", encoding="utf-8")
        assert sanctuary_desktop.find_gecko_binary(str(fake_repo)) == str(fallback_bin)
        primary_bin = fake_repo / "browser-desktop" / "dist" / "lm-sanctuary" / ("sanctuary-browser.exe" if sys.platform == "win32" else "sanctuary-browser")
        primary_bin.write_text("stub", encoding="utf-8")
        assert sanctuary_desktop.find_gecko_binary(str(fake_repo)) == str(primary_bin)

        # 3. Verify Gecko desktop host delegates vault unlock & open prompts cleanly to shell
        parent_src = (DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryHostParent.sys.mjs").read_text(encoding="utf-8")
        assert "vault-unlock-requested" in parent_src
        assert "vault-open-requested" in parent_src
        window_host_src = (DESKTOP_DIR / "chrome" / "browser" / "components" / "sanctuary" / "SanctuaryWindowHost.sys.mjs").read_text(encoding="utf-8")
        assert "notifyShellEvent(" in window_host_src

        # 4. Verify sanctuary/desktop.py launcher helpers & absence of webbrowser.open
        desktop_src = (SANCTUARY_DIR / "desktop.py").read_text(encoding="utf-8")
        assert "webbrowser.open" not in desktop_src
        fake_bin = tmp_root / "lm-sanctuary.exe"
        fake_bin.write_text("stub", encoding="utf-8")
        old_env = sanctuary_desktop.os.environ.get("SANCTUARY_GECKO_BIN")
        try:
            sanctuary_desktop.os.environ["SANCTUARY_GECKO_BIN"] = str(fake_bin)
            assert sanctuary_desktop.find_gecko_binary() == str(fake_bin)
        finally:
            if old_env is None:
                sanctuary_desktop.os.environ.pop("SANCTUARY_GECKO_BIN", None)
            else:
                sanctuary_desktop.os.environ["SANCTUARY_GECKO_BIN"] = old_env

        user_js = Path(sanctuary_desktop.prepare_gecko_profile(str(tmp_root / "prof"), "http://127.0.0.1:5000"))
        user_js_text = user_js.read_text(encoding="utf-8")
        assert 'user_pref("browser.sanctuary.shellUrl", "http://127.0.0.1:5000");' in user_js_text
        assert 'user_pref("datareporting.healthreport.uploadEnabled", false);' in user_js_text
        assert 'user_pref("toolkit.legacyUserProfileCustomizations.windowIcon", true);' in user_js_text
        assert 'user_pref("media.videocontrols.picture-in-picture.video-toggle.enabled", false);' in user_js_text
        assert 'user_pref("print.prefer_system_dialog", true);' in user_js_text
        assert 'user_pref("browser.ml.chat.enabled", false);' in user_js_text
        assert 'user_pref("identity.fxaccounts.enabled", false);' in user_js_text
        assert 'user_pref("extensions.pocket.enabled", false);' in user_js_text
        prefs_src = (DESKTOP_DIR / "branding" / "lm-sanctuary" / "pref" / "00-lm-sanctuary-prefs.js").read_text(encoding="utf-8")
        assert 'pref("media.videocontrols.picture-in-picture.video-toggle.enabled", false);' in prefs_src
        assert 'pref("print.prefer_system_dialog", true);' in prefs_src
        assert 'pref("browser.ml.chat.enabled", false);' in prefs_src
        assert 'pref("identity.fxaccounts.enabled", false);' in prefs_src
        assert 'pref("extensions.pocket.enabled", false);' in prefs_src
        assert (tmp_root / "prof" / "chrome" / "icons" / "default" / "main-window.ico").is_file()
        assert (tmp_root / "prof" / "chrome" / "icons" / "default" / "default.ico").is_file()

        # Verify LM-Sanctuary branding SVG and PE icon payload extraction
        about_logo = (DESKTOP_DIR / "branding" / "lm-sanctuary" / "content" / "about-logo.svg").read_text(encoding="utf-8")
        assert "21.35" in about_logo and "linearGradient" in about_logo, "about-logo.svg should use LM-Sanctuary heart gradient logo"
        app_ico = REPO_ROOT / "web" / "assets" / "img" / "app_icon.ico"
        grp_bytes, icon_entries = bootstrap_gecko.build_pe_icon_payloads(app_ico.read_bytes())
        assert len(icon_entries) == 7, f"Expected 7 icon entries, got {len(icon_entries)}"
        assert len(grp_bytes) == 6 + 7 * 14

        # Verify PE icon and VS_VERSION_INFO patching on a temp executable copy when Windows build is present
        if sys.platform == "win32":
            import ctypes
            import re

            sample_candidates = (
                DESKTOP_DIR / "dist" / "lm-sanctuary" / "sanctuary-browser.exe",
                DESKTOP_DIR / "dist" / "lm-sanctuary" / "plugin-container.exe",
                DESKTOP_DIR / "dist" / "lm-sanctuary" / "private_browsing.exe",
            )
            sample_exe = next((c for c in sample_candidates if c.is_file()), None)
            if sample_exe is not None:
                tmp_exe = tmp_root / "sanctuary-browser.exe"
                shutil.copy2(sample_exe, tmp_exe)
                assert bootstrap_gecko.patch_windows_pe_exe_icon(tmp_exe, app_ico) is True
                assert bootstrap_gecko.patch_windows_pe_version_info(
                    tmp_exe,
                    file_description="Sanctuary Browser",
                    product_name="Sanctuary Browser",
                    company_name="",
                ) is True
                grp_res = bootstrap_gecko._enumerate_pe_resources(tmp_exe, 14)
                ico_res = bootstrap_gecko._enumerate_pe_resources(tmp_exe, 3)
                assert (1, 1033) in grp_res and (32512, 1033) in grp_res, grp_res
                assert len(ico_res) == 7, ico_res
                assert bootstrap_gecko._read_pe_resource_bytes(tmp_exe, 3, 1) == icon_entries[0][1]

                vsize = ctypes.windll.version.GetFileVersionInfoSizeW(str(tmp_exe), None)
                assert vsize > 0
                vbuf = ctypes.create_string_buffer(vsize)
                assert ctypes.windll.version.GetFileVersionInfoW(str(tmp_exe), 0, vsize, vbuf) != 0
                vtext = vbuf.raw.decode("utf-16le", errors="ignore")
                assert re.search(r"ProductName\x00+Sanctuary Browser", vtext), vtext
                assert re.search(r"FileDescription\x00+Sanctuary Browser", vtext), vtext
                assert "Mozilla Corporation" not in vtext
                assert "CompanyName" not in vtext

        # 5. Verify Windows packaging script (-VerifyOnly) on win32
        if sys.platform == "win32":
            ps_res = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(DESKTOP_DIR / "packaging" / "package_windows.ps1"),
                    "-VerifyOnly",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            assert "WINDOWS_PACKAGING_VERIFIED" in ps_res.stdout, ps_res.stdout

        print("DESKTOP_STAGE_2_VERIFIED")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
