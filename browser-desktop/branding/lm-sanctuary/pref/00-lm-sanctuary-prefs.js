/* SPDX-License-Identifier: AGPL-3.0-or-later */

// Disable telemetry, studies, and background crash auto-submission.
pref("datareporting.healthreport.uploadEnabled", false, locked);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.archive.enabled", false);
pref("app.shield.optoutstudies.enabled", false, locked);
pref("browser.discovery.enabled", false, locked);
pref("browser.crashReports.unsubmittedCheck.enabled", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked);
pref("browser.tabs.crashReporting.sendReport", false);

// Clear upstream/vendor update and feedback endpoints.
pref("app.update.url", "");
pref("app.update.url.manual", "");
pref("app.feedback.baseURL", "");

// Default privacy, content blocking, GPC, fingerprinting, HTTPS-only, and Windows Mica chrome.
pref("browser.sanctuary.adblock.level", "balanced");
pref("browser.contentblocking.category", "standard");
pref("privacy.trackingprotection.enabled", true);
pref("privacy.trackingprotection.socialtracking.enabled", true);
pref("privacy.trackingprotection.cryptomining.enabled", true);
pref("privacy.trackingprotection.fingerprinting.enabled", true);
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.fingerprintingProtection", true);
pref("privacy.fingerprintingProtection.pbmode", true);
pref("dom.security.https_only_mode", true);
pref("widget.windows.mica", true);
pref("widget.windows.mica.toplevel-backdrop", 2);

// LM-Sanctuary shell origin gate, window icon, & KeePassXC-Browser integration.
pref("browser.sanctuary.shellUrl", "http://127.0.0.1:5000");
pref("browser.sanctuary.passwordManager", "keepassxc");
pref("toolkit.legacyUserProfileCustomizations.windowIcon", true);

// Prevent Firefox Picture-in-Picture hover pill from overlapping video mute/volume controls,
// and route Ctrl+P to the OS system print dialog so it never hides behind native browser panes.
pref("media.videocontrols.picture-in-picture.video-toggle.enabled", false);
pref("print.prefer_system_dialog", true);

// Disable stock Mozilla AI Chatbot, Firefox Accounts / Send to Mobile, Pocket, and Firefox View.
pref("browser.ml.enable", false);
pref("browser.ml.chat.enabled", false);
pref("browser.ml.chat.menu", false);
pref("browser.ml.chat.page", false);
pref("identity.fxaccounts.enabled", false);
pref("extensions.pocket.enabled", false);
pref("browser.tabs.firefox-view", false);
pref("browser.formfill.enable", false);
