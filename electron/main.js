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
// There is no telemetry and no network access: everything is served from the
// bundled SQLite file and the local server.

const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { createServer, connect } = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

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

async function startServer() {
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => console.log(`[next] ${d}`));
  serverProcess.stderr.on("data", (d) => console.error(`[next] ${d}`));
  serverProcess.on("exit", (code) => {
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox("Customs Compliance", `The app server stopped unexpectedly (exit ${code}).`);
    }
  });

  await waitForPort(serverPort);
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
    try {
      await startServer();
      createWindow();
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
