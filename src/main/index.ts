import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { openDatabases } from './db';
import { AppServices } from './services';
import type {
  AgentSendMessageInput,
  CancelRunInput,
  CreateSessionInput,
  DeleteSessionInput,
  DecideMemoryCandidateInput,
  DecideApprovalInput,
  SaveLlmSettingsInput,
  SaveProfileInput,
  SaveSkillInput,
  SelectSessionSkillInput,
  UpdateSessionTrustModeInput
} from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let services: AppServices;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: 'Aliy Agent',
    backgroundColor: '#121215',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', () => services.bootstrap());

  ipcMain.handle('workspace:mount', async () => {
    const options: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const workspace = services.mountWorkspace(result.filePaths[0]);
    return workspace;
  });

  ipcMain.handle('profile:save', (_event, input: SaveProfileInput) => services.saveProfile(input));
  ipcMain.handle('llm:saveSettings', (_event, input: SaveLlmSettingsInput) => services.saveLlmSettings(input));
  ipcMain.handle('catalog:refresh', () => services.refreshCatalog());
  ipcMain.handle('skill:installFromDirectory', async () => {
    const options: OpenDialogOptions = {
      properties: ['openDirectory']
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return services.installSkillsFromDirectory(result.canceled ? null : result.filePaths[0]);
  });
  ipcMain.handle('skill:save', (_event, input: SaveSkillInput) => services.saveSkill(input));
  ipcMain.handle('skill:load', (_event, id: string) => services.loadSkill(id));
  ipcMain.handle('skill:selectForSession', (_event, input: SelectSessionSkillInput) => services.selectSessionSkill(input));
  ipcMain.handle('skill:removeFromSession', (_event, input: SelectSessionSkillInput) => services.removeSessionSkill(input));
  ipcMain.handle('session:create', (_event, input: CreateSessionInput) => services.createSession(input));
  ipcMain.handle('session:updateTrustMode', (_event, input: UpdateSessionTrustModeInput) => services.updateSessionTrustMode(input));
  ipcMain.handle('session:delete', (_event, input: DeleteSessionInput) => services.deleteSession(input));
  ipcMain.handle('agent:sendMessage', (_event, input: AgentSendMessageInput) => services.acceptMessage(input));
  ipcMain.handle('agent:cancel', (_event, input: CancelRunInput) => services.cancelRun(input));
  ipcMain.handle('approval:decide', (_event, input: DecideApprovalInput) => services.decideApproval(input));
  ipcMain.handle('memory:decideCandidate', (_event, input: DecideMemoryCandidateInput) => services.decideMemoryCandidate(input));
}

app.whenReady().then(async () => {
  const dbs = openDatabases(app.getPath('userData'));
  services = new AppServices(dbs);
  registerIpc();
  await createWindow();
  services.startScheduler();
});

app.on('window-all-closed', () => {
  services?.stopScheduler();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
