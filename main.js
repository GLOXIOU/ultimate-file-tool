const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
  });
  
  win.setMenu(null);
  win.loadFile('src/index.html');
}

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});