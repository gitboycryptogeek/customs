// Electron entry point for the Customs Compliance desktop app.
//
// What this does when you double-click the app:
//   1. Copies the shipped, read-only SQLite database into a writable per-user
//      folder on first launch (the app records search misses, so the DB file
//      must be writable — app bundles are read-only).
//   2. Starts the Next.js production server (the same one `npm run start` runs)
//      as a child process on a free localhost port, using Electron's built-in
//      Node runtime — nothing needs to be installed on the machine.
//   3. Opens a native window pointing at that local server once it's ready.
//
// There is no telemetry. The app is offline by default: the lookup, the tariff,
// the search and every figure in an assessment are served from the bundled
// SQLite file and the local server, and none of it needs a connection.
//
// One feature can reach the network, and only after somebody switches it on
// under Settings and supplies an API key: the AI briefing (lib/ai/) sends a
// deterministic assessment to Anthropic's API and gets prose back. It never
// sends the officer's typed sentence or any trader identifier, and it decides
// nothing — see the note in CLAUDE.md. With no key configured the app behaves
// exactly as it did before that feature existed.

const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { createServer, connect } = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const { startAutoUpdates, checkForUpdates, DOWNLOAD_PAGE } = require("./updater");
const { buildMenu } = require("./menu");

const isDev = !app.isPackaged;

// Linux launch hardening. Many Ubuntu machines have no usable GPU for Electron
// (headless servers, VMs, remote desktops, or drivers Chromium rejects). When
// the GPU process can't start, Chromium aborts the whole app with
// "GPU process isn't usable. Goodbye." — which shows up as the window flashing
// and closing on double-click. We render this simple form UI on the CPU, so we
// turn hardware acceleration off and fall back to software rendering. We also
// drop the Chromium sandbox on Linux: it only guards against untrusted web
// content (we load our own localhost UI) and its SUID/user-namespace
// requirements are another common cause of an instant exit (e.g. Ubuntu 24.04's
// AppArmor restrictions on unprivileged user namespaces).
app.disableHardwareAcceleration();
if (process.platform === "linux") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("no-sandbox");
  // Use /tmp instead of /dev/shm for Chromium's shared memory. Small or
  // restricted /dev/shm (common in VMs, containers and some locked-down Ubuntu
  // installs) otherwise crashes the renderer on startup.
  app.commandLine.appendSwitch("disable-dev-shm-usage");
}

// In a packaged app the assembled Next standalone bundle lives under
// resources/; in dev we run it straight from the project's .next/standalone.
const projectRoot = path.join(__dirname, "..");
const standaloneDir = isDev
  ? path.join(projectRoot, ".next", "standalone")
  : path.join(process.resourcesPath, "standalone");

const serverEntry = path.join(standaloneDir, "server.js");

/**
 * Check the server bundle is actually there before trying to spawn it.
 *
 * `next dev` and `next build` both own `.next/`, so running `npm run dev`
 * replaces the assembled standalone bundle this app needs. Launching with
 * `electron .` afterwards then spawns a file that does not exist: the child dies
 * silently, and the only symptom is "Server did not start within 30000ms" thirty
 * seconds later, which says nothing about the cause. Fail immediately and say
 * what to run instead.
 */
function assertServerBundle() {
  if (fs.existsSync(serverEntry)) return;
  throw new Error(
    isDev
      ? "The app bundle is missing from .next/standalone.\n\n" +
        "Running `npm run dev` replaces .next, which removes it.\n\n" +
        "Use `npm run app:dev` to rebuild the bundle and open the app."
      : `The app bundle is missing (expected ${serverEntry}). This install looks incomplete — reinstall the app.`
  );
}

let serverProcess = null;
let mainWindow = null;
let serverPort = 0;

/** Ask the OS for a free TCP port so two copies (or another app) never clash. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve once the server is accepting connections on the port (or time out). */
function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}

/**
 * Copy the shipped SQLite database into the writable user-data directory the
 * first time the app runs, then return a `file:` URL Prisma can open. Later
 * launches reuse the user's copy, so their logged search misses persist.
 */
function ensureWritableDatabase() {
  const userDbPath = path.join(app.getPath("userData"), "customs.db");
  if (!fs.existsSync(userDbPath)) {
    const seedDbPath = isDev
      ? path.join(projectRoot, "prisma", "customs.db")
      : path.join(process.resourcesPath, "customs.db");
    fs.copyFileSync(seedDbPath, userDbPath);
  }
  return "file:" + userDbPath;
}

/**
 * Where source PDFs a user adds are kept.
 *
 * The four documents that ship with the app live inside the read-only bundle;
 * anything added afterwards cannot, so it goes here. The server is told the
 * path so it can serve those files back for the page-linked citations.
 */
function docsDir() {
  const dir = path.join(app.getPath("userData"), "docs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Bundled OCR language data, so scanned documents work with nothing installed. */
function tessdataDir() {
  return isDev
    ? path.join(projectRoot, "vendor", "tessdata")
    : path.join(process.resourcesPath, "tessdata");
}

async function startServer() {
  assertServerBundle();
  serverPort = await findFreePort();
  const databaseUrl = ensureWritableDatabase();

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      // Run Electron's bundled Node as a plain Node process for the server.
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      DB_PROVIDER: "sqlite",
      DATABASE_URL: databaseUrl,
      PORT: String(serverPort),
      HOSTNAME: "127.0.0.1",
      // Writable store for user-added source PDFs, and the OCR language data.
      // Both must be absolute: the server runs with cwd inside the bundle.
      DOCS_DIR: docsDir(),
      TESSDATA_PATH: tessdataDir(),
      // Where the AI briefing's settings file is kept. Same reasoning as
      // DOCS_DIR: the bundle is read-only, and the key belongs to this user.
      SETTINGS_DIR: app.getPath("userData"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => console.log(`[next] ${d}`));
  serverProcess.stderr.on("data", (d) => console.error(`[next] ${d}`));
  let exitedEarly = null;
  serverProcess.on("exit", (code) => {
    if (!app.isQuitting && code && code !== 0) {
      exitedEarly = code;
      if (mainWindow) {
        dialog.showErrorBox("Customs Compliance", `The app server stopped unexpectedly (exit ${code}).`);
      }
    }
  });

  // Race the readiness check against the process dying, so a server that fails
  // to boot reports that in a second rather than after a 30s port timeout.
  await Promise.race([
    waitForPort(serverPort),
    new Promise((_, reject) => {
      const poll = setInterval(() => {
        if (exitedEarly !== null) {
          clearInterval(poll);
          reject(new Error(`The app server exited immediately (code ${exitedEarly}). Check the log above.`));
        }
      }, 200);
      setTimeout(() => clearInterval(poll), 31000);
    }),
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 720,
    minHeight: 560,
    title: "Customs Compliance",
    backgroundColor: "#0b0b0c",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // Open target="_blank" / external links (e.g. PDF pages) in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${serverPort}`)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Single-instance: focus the existing window instead of launching a 2nd server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu({ checkForUpdates, downloadPage: DOWNLOAD_PAGE, docsDir });
    try {
      await startServer();
      createWindow();
      // Only once the app is actually usable — a failed start should surface as
      // a start failure, not as an update dialog on top of a dead window.
      startAutoUpdates();
    } catch (err) {
      dialog.showErrorBox("Customs Compliance", `Failed to start:\n\n${err && err.message ? err.message : err}`);
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
    });
  });
}

app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});

app.on("window-all-closed", () => {
  // Standard app behaviour: quit on non-macOS when the last window closes.
  if (process.platform !== "darwin") app.quit();
});
