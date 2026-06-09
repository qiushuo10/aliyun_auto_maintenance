export type TrustMode = 'strict' | 'autopilot';

export type DangerLevel = 'safe' | 'write' | 'dangerous';

export type InvocationStatus =
  | 'SUCCESS'
  | 'REJECTED_BY_GATEWAY'
  | 'REJECTED_BY_USER'
  | 'AWAITING_APPROVAL'
  | 'FAILED_BY_ALIYUN'
  | 'SKIPPED_DRY_RUN';

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  activeProfileId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Profile {
  id: string;
  name: string;
  akIdMasked: string | null;
  rdcId: string | null;
  defaultRegion: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  workspaceId: string;
  profileId: string;
  title: string;
  trustMode: TrustMode;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  runId: string | null;
  createdAt: number;
}

export interface RunStep {
  id: string;
  sessionId: string;
  runId: string;
  stepType: string;
  title: string;
  status: string;
  payloadJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface LlmSettings {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKeyMasked: string | null;
  updatedAt: number | null;
}

export interface CatalogStatus {
  exists: boolean;
  path: string;
  productCount: number;
  actionCount: number;
  schemaVersion: string | null;
  specSnapshotDate: string | null;
  lastRefreshStatus: string | null;
  lastRefreshMessage: string | null;
  refreshedAt: number | null;
}

export interface ContextDocumentPointer {
  sessionId: string;
  runId: string;
  path: string;
  title: string | null;
  mtime: number;
  size: number;
  usedAt: number;
}

export interface CatalogFactPointer {
  sessionId: string;
  runId: string;
  product: string;
  action: string;
  version: string;
  danger: DangerLevel;
  required: string[];
  replacedBy: string | null;
  updatedAt: number;
}

export interface SkillSummary {
  id: string;
  title: string;
  description: string;
}

export interface SessionSkillPointer extends SkillSummary {
  sessionId: string;
  selectedAt: number;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  keywords: string | null;
  sourcePath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InstallSkillsResult {
  installed: SkillSummary[];
  skipped: string[];
  rootPath: string | null;
}

export interface ScheduledTask {
  id: string;
  workspaceId: string;
  profileId: string;
  name: string;
  category: string;
  cronExpr: string;
  trustMode: TrustMode;
  danger: DangerLevel;
  status: string;
  firstSignStatus: string;
  scriptBody: string;
  updatedAt: number;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  logJson: string;
  summary: string | null;
}

export interface MemoryCandidate {
  id: string;
  workspaceId: string;
  profileId: string;
  fact: string;
  sourceMessageAt: number;
  factHash: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
}

export interface AuditRow {
  id: string;
  createdAt: number;
  toolName: string;
  product: string | null;
  action: string | null;
  status: InvocationStatus;
  resolvedEndpoint: string | null;
  requestId: string | null;
  akIdMasked: string | null;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  reason: string;
  danger: DangerLevel;
  summary: string;
  paramsJson: string;
  provenanceJson: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface AppStatus {
  appDbPath: string;
  catalogDbPath: string;
  workspaceIndexReady: boolean;
  catalogAttached: boolean;
}

export interface BootstrapState {
  status: AppStatus;
  llmSettings: LlmSettings;
  catalogStatus: CatalogStatus;
  workspaces: Workspace[];
  profiles: Profile[];
  sessions: Session[];
  messages: Message[];
  runSteps: RunStep[];
  contextDocuments: ContextDocumentPointer[];
  catalogFacts: CatalogFactPointer[];
  skills: SkillSummary[];
  sessionSkills: SessionSkillPointer[];
  scheduledTasks: ScheduledTask[];
  taskExecutions: TaskExecution[];
  memoryCandidates: MemoryCandidate[];
  auditRows: AuditRow[];
  approvalRequests: ApprovalRequest[];
}

export interface CreateSessionInput {
  workspaceId: string;
  profileId: string;
  title?: string;
}

export interface UpdateSessionTrustModeInput {
  sessionId: string;
  trustMode: TrustMode;
}

export interface CancelRunInput {
  sessionId: string;
}

export interface CancelRunResult {
  ok: boolean;
  cancelled: boolean;
}

export interface DeleteSessionInput {
  sessionId: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  sessionId: string;
}

export interface SaveProfileInput {
  id?: string;
  name: string;
  akId?: string;
  secret?: string;
  rdcId?: string;
  defaultRegion?: string;
}

export interface SaveLlmSettingsInput {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface SaveSkillInput {
  id?: string;
  title: string;
  description: string;
  body: string;
  keywords?: string;
  sourcePath?: string;
}

export interface SelectSessionSkillInput {
  sessionId: string;
  skillId: string;
}

export interface AgentSendMessageInput {
  sessionId: string;
  content: string;
}

export interface AgentSendMessageResult {
  runId: string;
  accepted: boolean;
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface DecideMemoryCandidateInput {
  candidateId: string;
  decision: 'approve' | 'reject';
}

export interface CatalogRefreshResult {
  status: CatalogStatus;
  changed: boolean;
}

export interface RunCompletedEvent {
  sessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'awaiting_approval' | 'cancelled';
  runStep?: RunStep;
}

export interface MessageDeltaEvent {
  sessionId: string;
  runId: string;
  delta: string;
  createdAt: number;
}

export interface AgentActivityEvent {
  sessionId: string;
  runId: string;
  label: string;
  createdAt: number;
}

export interface AgentRendererEvents {
  'agent:message-added': Message;
  'agent:session-updated': Session;
  'agent:message-delta': MessageDeltaEvent;
  'agent:activity': AgentActivityEvent;
  'agent:run-step-added': RunStep;
  'agent:approval-requested': ApprovalRequest;
  'agent:context-document-added': ContextDocumentPointer;
  'agent:catalog-fact-added': CatalogFactPointer;
  'agent:run-completed': RunCompletedEvent;
}
