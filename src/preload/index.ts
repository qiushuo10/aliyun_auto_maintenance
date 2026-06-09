import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentSendMessageInput,
  CancelRunInput,
  CreateSessionInput,
  DeleteSessionInput,
  DecideMemoryCandidateInput,
  DecideApprovalInput,
  AgentRendererEvents,
  SaveLlmSettingsInput,
  SaveProfileInput,
  SaveSkillInput,
  SelectSessionSkillInput,
  UpdateSessionTrustModeInput
} from '../shared/types';

function subscribe<K extends keyof AgentRendererEvents>(
  channel: K,
  callback: (payload: AgentRendererEvents[K]) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: AgentRendererEvents[K]): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  mountWorkspace: () => ipcRenderer.invoke('workspace:mount'),
  saveProfile: (input: SaveProfileInput) => ipcRenderer.invoke('profile:save', input),
  saveLlmSettings: (input: SaveLlmSettingsInput) => ipcRenderer.invoke('llm:saveSettings', input),
  refreshCatalog: () => ipcRenderer.invoke('catalog:refresh'),
  installSkillsFromDirectory: () => ipcRenderer.invoke('skill:installFromDirectory'),
  saveSkill: (input: SaveSkillInput) => ipcRenderer.invoke('skill:save', input),
  loadSkill: (id: string) => ipcRenderer.invoke('skill:load', id),
  selectSkillForSession: (input: SelectSessionSkillInput) => ipcRenderer.invoke('skill:selectForSession', input),
  removeSkillFromSession: (input: SelectSessionSkillInput) => ipcRenderer.invoke('skill:removeFromSession', input),
  createSession: (input: CreateSessionInput) => ipcRenderer.invoke('session:create', input),
  updateSessionTrustMode: (input: UpdateSessionTrustModeInput) => ipcRenderer.invoke('session:updateTrustMode', input),
  deleteSession: (input: DeleteSessionInput) => ipcRenderer.invoke('session:delete', input),
  sendMessage: (input: AgentSendMessageInput) => ipcRenderer.invoke('agent:sendMessage', input),
  cancelRun: (input: CancelRunInput) => ipcRenderer.invoke('agent:cancel', input),
  decideApproval: (input: DecideApprovalInput) => ipcRenderer.invoke('approval:decide', input),
  decideMemoryCandidate: (input: DecideMemoryCandidateInput) => ipcRenderer.invoke('memory:decideCandidate', input),
  onMessageAdded: (callback: (message: AgentRendererEvents['agent:message-added']) => void) => subscribe('agent:message-added', callback),
  onSessionUpdated: (callback: (session: AgentRendererEvents['agent:session-updated']) => void) => subscribe('agent:session-updated', callback),
  onMessageDelta: (callback: (event: AgentRendererEvents['agent:message-delta']) => void) => subscribe('agent:message-delta', callback),
  onActivity: (callback: (event: AgentRendererEvents['agent:activity']) => void) => subscribe('agent:activity', callback),
  onRunStepAdded: (callback: (step: AgentRendererEvents['agent:run-step-added']) => void) => subscribe('agent:run-step-added', callback),
  onApprovalRequested: (callback: (approval: AgentRendererEvents['agent:approval-requested']) => void) =>
    subscribe('agent:approval-requested', callback),
  onContextDocumentAdded: (callback: (document: AgentRendererEvents['agent:context-document-added']) => void) =>
    subscribe('agent:context-document-added', callback),
  onCatalogFactAdded: (callback: (fact: AgentRendererEvents['agent:catalog-fact-added']) => void) =>
    subscribe('agent:catalog-fact-added', callback),
  onRunCompleted: (callback: (event: AgentRendererEvents['agent:run-completed']) => void) => subscribe('agent:run-completed', callback)
};

contextBridge.exposeInMainWorld('aliyAgent', api);

export type AliyAgentApi = typeof api;
