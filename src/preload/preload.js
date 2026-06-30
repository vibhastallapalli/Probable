const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('probable', {
  appName: 'Probable',
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
