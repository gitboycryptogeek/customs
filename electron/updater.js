// Auto-update for the desktop app.
//
// Installers live on GitHub Releases; electron-updater reads the `latest.yml`
// feed electron-builder publishes beside them. There is no update server to run.
//
// Platform reality, stated plainly because it shapes what a user sees:
//   - Windows (NSIS): full auto-update, with differential downloads.
//   - Linux (AppImage): auto-update works. A .deb install cannot self-update —
//     it is owned by the system package manager — so we don't pretend otherwise.
//   - macOS: Squirrel.Mac refuses to apply an update that isn't code-signed,
//     and these builds are unsigned. Rather than surface a confusing failure we
//     check the version and send the user to the download page.
//
// Nothing here phones home with anything: the only request is a GET for the
// release feed. No identifiers, no usage data.

const { app, dialog, shell, BrowserWindow } = require("electron");

const DOWNLOAD_PAGE = process.env.CUSTOMS_DOWNLOAD_PAGE || "https://customs-compliance.herokuapp.com/";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours while running
const FIRST_CHECK_DELAY_MS = 10_000; // let the app finish starting first

let autoUpdater = null;
let checkTimer = null;
let updateDownloaded = false;
/** Set while a user-initiated check is in flight, so we can report "you're up to date". */
let interactiveCheck = false;

/** macOS can't apply unsigned updates; a .deb is the package manager's business. */
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === "darwin") return false;
  if (process.platform === "linux" && !process.env.APPIMAGE) return false;
  return true;
}

function load() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.autoDownload = true;
  // Never restart out from under someone mid-lookup; we ask first.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] ${info.version} available (running ${app.getVersion()})`);
  });

  autoUpdater.on("update-not-available", () => {
    if (!interactiveCheck) return;
    interactiveCheck = false;
    dialog.showMessageBox({
      type: "info",
      title: "Customs Compliance",
      message: "You're up to date.",
      detail: `Version ${app.getVersion()} is the latest release.`,
      buttons: ["OK"],
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater]", err && err.message ? err.message : err);
    if (!interactiveCheck) return; // silent in the background: a flaky network is not news
    interactiveCheck = false;
    dialog.showMessageBox({
      type: "warning",
      title: "Customs Compliance",
      message: "Couldn't check for updates.",
      detail: "The update service could not be reached. You can download the latest version manually.",
      buttons: ["Open download page", "Close"],
      defaultId: 1,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    updateDownloaded = true;
    interactiveCheck = false;
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Customs Compliance",
      message: `Version ${info.version} is ready to install.`,
      detail:
        "The update has been downloaded. It will be applied next time you close the app, " +
        "or you can restart now.\n\nYour documents and saved data are not affected.",
      buttons: ["Restart now", "Later"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) {
      app.isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  return autoUpdater;
}

/**
 * macOS fallback: read the feed to find out whether a newer version exists, and
 * point the user at the download page. We never try to apply it.
 */
async function checkManuallyOnMac(interactive) {
  try {
    const res = await fetch(`${DOWNLOAD_PAGE.replace(/\/$/, "")}/api/latest`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = await res.json();
    if (!latest.version || latest.version === app.getVersion()) {
      if (interactive) {
        await dialog.showMessageBox({
          type: "info",
          title: "Customs Compliance",
          message: "You're up to date.",
          detail: `Version ${app.getVersion()} is the latest release.`,
          buttons: ["OK"],
        });
      }
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Customs Compliance",
      message: `Version ${latest.version} is available.`,
      detail:
        `You're running ${app.getVersion()}. macOS builds are not code-signed, so this app ` +
        "can't update itself — download the new version and drag it over the old one.",
      buttons: ["Open download page", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
  } catch (err) {
    if (!interactive) return;
    await dialog.showMessageBox({
      type: "warning",
      title: "Customs Compliance",
      message: "Couldn't check for updates.",
      detail: String((err && err.message) || err),
      buttons: ["OK"],
    });
  }
}

/**
 * Check for an update.
 * @param {boolean} interactive true when a person clicked "Check for updates",
 *   which is the only case where "nothing to do" deserves a dialog.
 */
async function checkForUpdates(interactive = false) {
  if (!app.isPackaged) {
    if (interactive) {
      await dialog.showMessageBox({
        type: "info",
        title: "Customs Compliance",
        message: "Updates aren't checked in development.",
        detail: "This is a development build running from source.",
        buttons: ["OK"],
      });
    }
    return;
  }

  if (updateDownloaded) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Customs Compliance",
      message: "An update is already downloaded.",
      detail: "Restart the app to finish installing it.",
      buttons: ["Restart now", "Later"],
      defaultId: 1,
    });
    if (response === 0) {
      app.isQuitting = true;
      load().quitAndInstall();
    }
    return;
  }

  if (process.platform === "darwin") return checkManuallyOnMac(interactive);

  if (!canSelfUpdate()) {
    if (interactive) {
      await dialog.showMessageBox({
        type: "info",
        title: "Customs Compliance",
        message: "This install updates through your package manager.",
        detail: "Use apt/dpkg to install a newer .deb, or download the AppImage for self-updating builds.",
        buttons: ["OK"],
      });
    }
    return;
  }

  interactiveCheck = interactive;
  try {
    await load().checkForUpdates();
  } catch (err) {
    console.error("[updater] check failed:", err && err.message ? err.message : err);
  }
}

/** Start background update checks. Safe to call once the window exists. */
function startAutoUpdates() {
  if (!app.isPackaged) return;
  setTimeout(() => checkForUpdates(false), FIRST_CHECK_DELAY_MS);
  checkTimer = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
  app.on("before-quit", () => {
    if (checkTimer) clearInterval(checkTimer);
  });
}

module.exports = { startAutoUpdates, checkForUpdates, DOWNLOAD_PAGE };
