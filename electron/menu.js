// Application menu.
//
// The app previously shipped with Electron's default menu, which offers a
// developer console and reload but no way to check for an update, reach the
// documents folder, or find out which version is running — all three of which a
// user needs when the whole point is that the data is auditable.

const { app, Menu, shell, dialog } = require("electron");
const path = require("node:path");

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.checkForUpdates
 * @param {string} deps.downloadPage
 * @param {() => string} deps.docsDir  where user-added source PDFs are stored
 */
function buildMenu({ checkForUpdates, downloadPage, docsDir }) {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open source documents folder",
          click: () => shell.openPath(docsDir()),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Check for updates…",
          click: () => checkForUpdates(true),
        },
        {
          label: "Download page",
          click: () => shell.openExternal(downloadPage),
        },
        { type: "separator" },
        {
          label: `About Customs Compliance`,
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "Customs Compliance",
              message: `Customs Compliance ${app.getVersion()}`,
              detail: [
                "Duty, levy and condition lookup against the loaded source documents.",
                "",
                "Every figure is produced by deterministic code and cites its legal",
                "reference and page. No model decides a rate.",
                "",
                `Electron ${process.versions.electron} · Node ${process.versions.node}`,
                `Data folder: ${app.getPath("userData")}`,
              ].join("\n"),
              buttons: ["OK"],
            }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
