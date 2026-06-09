import {
  AlertTriangle,
  AtSign,
  BookOpen,
  Bot,
  Box,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  RefreshCcw,
  FileText,
  Folder,
  GitBranch,
  Globe,
  KeyRound,
  Library,
  Link2,
  Loader2,
  Lock,
  MessageSquarePlus,
  PanelRight,
  Plus,
  PlayCircle,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  UserRound,
  Wrench,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  BootstrapState,
  ApprovalRequest,
  CatalogStatus,
  CatalogFactPointer,
  ContextDocumentPointer,
  DangerLevel,
  InstallSkillsResult,
  LlmSettings,
  MemoryCandidate,
  Message,
  Profile,
  RunStep,
  ScheduledTask,
  Session,
  SkillDetail,
  SkillSummary,
  SessionSkillPointer,
  TaskExecution,
  TrustMode,
  Workspace
} from '../../shared/types';

type ModalState = 'profile' | 'model' | 'catalog' | 'skill' | 'skills' | 'tasks' | 'memory' | null;
type ToastTone = 'success' | 'error';
type Toast = { id: number; tone: ToastTone; message: string };
const STORAGE_KEYS = {
  workspace: 'aliy-agent:selected-workspace',
  profile: 'aliy-agent:selected-profile',
  session: 'aliy-agent:selected-session'
} as const;
const TWEAK_STORAGE_KEY = 'aliy-agent:ui-tweaks';
const TWEAK_DEFAULTS = {
  accent: '#2f6bd6',
  defaultMode: 'gate',
  density: 'regular'
} as const;
const ACCENT_MAP: Record<string, { press: string; weak: string; border: string }> = {
  '#2f6bd6': { press: '#245bbd', weak: '#eaf1fd', border: '#c2d6f6' },
  '#1f8a5b': { press: '#18764d', weak: '#e8f5ee', border: '#c2e3d2' },
  '#d97757': { press: '#c5663f', weak: '#fbeee8', border: '#f1cfc0' },
  '#7a5ae0': { press: '#6a4ad0', weak: '#efeafe', border: '#d6c9f7' }
};

type AgentMode = 'gate' | 'trust';
type Density = 'regular' | 'compact';
type UiTweaks = {
  accent: string;
  defaultMode: AgentMode;
  density: Density;
};
type InspectorTab = 'context' | 'memory' | 'playbooks';

export function App(): JSX.Element {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [profileModalProfile, setProfileModalProfile] = useState<Profile | null>(null);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isInstallingSkills, setIsInstallingSkills] = useState(false);
  const [isMountingWorkspace, setIsMountingWorkspace] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingTrustMode, setPendingTrustMode] = useState<TrustMode | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(() => new Set());
  const [pendingMemoryCandidateIds, setPendingMemoryCandidateIds] = useState<Set<string>>(() => new Set());
  const [pendingSkillIds, setPendingSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [thinkingSessionId, setThinkingSessionId] = useState<string | null>(null);
  const [activity, setActivity] = useState<{ sessionId: string; label: string } | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => readStoredId(STORAGE_KEYS.workspace));
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => readStoredId(STORAGE_KEYS.profile));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => readStoredId(STORAGE_KEYS.session));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [streamingMessages, setStreamingMessages] = useState<Message[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('context');
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [tweaks, setTweaks] = useState<UiTweaks>(() => readTweaks());

  const notify = useCallback((tone: ToastTone, message: string): void => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, tone, message }].slice(-4));
    window.setTimeout(() => {
      setToasts((items) => items.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);
  const setTweak = useCallback(<K extends keyof UiTweaks>(key: K, value: UiTweaks[K]): void => {
    setTweaks((current) => {
      const next = { ...current, [key]: value };
      writeTweaks(next);
      return next;
    });
  }, []);

  const activeWorkspace = useMemo(
    () => (state ? state.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? state.workspaces[0] ?? null : null),
    [selectedWorkspaceId, state]
  );
  const activeProfile = useMemo(
    () => (state ? state.profiles.find((profile) => profile.id === selectedProfileId) ?? state.profiles[0] ?? null : null),
    [selectedProfileId, state]
  );
  const visibleSessions = useMemo(
    () =>
      state && activeWorkspace
        ? state.sessions.filter((session) => session.workspaceId === activeWorkspace.id)
        : state?.sessions ?? [],
    [activeWorkspace, state]
  );
  const activeSession = useMemo(
    () => visibleSessions.find((session) => session.id === selectedSessionId) ?? visibleSessions[0] ?? null,
    [selectedSessionId, visibleSessions]
  );
  const selectedSessionSkills = useMemo(
    () => (activeSession && state ? state.sessionSkills.filter((skill) => skill.sessionId === activeSession.id) : []),
    [activeSession, state]
  );
  const activeRunId = useMemo(() => {
    if (!activeSession || !state) return null;
    const runMarkers = [
      ...state.messages
        .filter((message) => message.sessionId === activeSession.id && message.runId)
        .map((message) => ({ runId: message.runId as string, at: message.createdAt })),
      ...state.runSteps
        .filter((step) => step.sessionId === activeSession.id)
        .map((step) => ({ runId: step.runId, at: step.createdAt })),
      ...state.contextDocuments
        .filter((document) => document.sessionId === activeSession.id)
        .map((document) => ({ runId: document.runId, at: document.usedAt })),
      ...state.catalogFacts
        .filter((fact) => fact.sessionId === activeSession.id)
        .map((fact) => ({ runId: fact.runId, at: fact.updatedAt })),
      ...streamingMessages
        .filter((message) => message.sessionId === activeSession.id && message.runId)
        .map((message) => ({ runId: message.runId as string, at: message.createdAt }))
    ];
    return runMarkers.sort((left, right) => right.at - left.at)[0]?.runId ?? null;
  }, [activeSession, state, streamingMessages]);
  const activeContextDocuments = useMemo(
    () =>
      activeSession && state && activeRunId
        ? state.contextDocuments
            .filter((document) => document.sessionId === activeSession.id && document.runId === activeRunId)
            .sort((left, right) => right.usedAt - left.usedAt)
        : [],
    [activeRunId, activeSession, state]
  );
  const activeCatalogFacts = useMemo(
    () =>
      activeSession && state && activeRunId
        ? state.catalogFacts
            .filter((fact) => fact.sessionId === activeSession.id && fact.runId === activeRunId)
            .sort((left, right) => right.updatedAt - left.updatedAt)
        : [],
    [activeRunId, activeSession, state]
  );
  const activeMemoryCandidates = useMemo(
    () =>
      state && activeWorkspace && activeProfile
        ? state.memoryCandidates.filter(
            (candidate) => candidate.workspaceId === activeWorkspace.id && candidate.profileId === activeProfile.id
          )
        : [],
    [activeWorkspace, activeProfile, state]
  );
  const pendingMemoryCount = activeMemoryCandidates.filter((candidate) => candidate.status === 'pending').length;
  const activeMode = activeSession ? trustModeToAgentMode(activeSession.trustMode) : tweaks.defaultMode;

  async function refresh(): Promise<void> {
    try {
      const next = (await window.aliyAgent.bootstrap()) as BootstrapState;
      setState(next);
    } catch (error) {
      notify('error', errorMessage(error, '刷新状态失败'));
      throw error;
    }
  }

  useEffect(() => {
    refresh()
      .catch((error) => console.error(error))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!state) return;
    setSelectedWorkspaceId((current) =>
      current && state.workspaces.some((workspace) => workspace.id === current) ? current : state.workspaces[0]?.id ?? null
    );
    setSelectedProfileId((current) =>
      current && state.profiles.some((profile) => profile.id === current) ? current : state.profiles[0]?.id ?? null
    );
  }, [state]);

  useEffect(() => {
    setSelectedSessionId((current) =>
      current && visibleSessions.some((session) => session.id === current) ? current : visibleSessions[0]?.id ?? null
    );
  }, [visibleSessions]);

  useEffect(() => writeStoredId(STORAGE_KEYS.workspace, selectedWorkspaceId), [selectedWorkspaceId]);
  useEffect(() => writeStoredId(STORAGE_KEYS.profile, selectedProfileId), [selectedProfileId]);
  useEffect(() => writeStoredId(STORAGE_KEYS.session, selectedSessionId), [selectedSessionId]);
  useEffect(() => {
    const accent = ACCENT_MAP[tweaks.accent] ? tweaks.accent : TWEAK_DEFAULTS.accent;
    const palette = ACCENT_MAP[accent];
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-press', palette.press);
    root.style.setProperty('--accent-weak', palette.weak);
    root.style.setProperty('--accent-border', palette.border);
  }, [tweaks.accent]);

  useEffect(() => {
    const unsubscribe = [
      window.aliyAgent.onMessageAdded((message) => {
        setState((current) => (current ? { ...current, messages: upsertById(current.messages, message) } : current));
        if (message.role === 'user') {
          setOptimisticMessages((messages) =>
            messages.filter((item) => !(item.sessionId === message.sessionId && item.role === 'user' && item.content === message.content))
          );
        }
        if (message.role === 'assistant' && message.runId) {
          setStreamingMessages((messages) => messages.filter((item) => item.runId !== message.runId));
          setActivity((current) => (current && current.sessionId === message.sessionId ? null : current));
        }
      }),
      window.aliyAgent.onSessionUpdated((session) => {
        setState((current) => (current ? { ...current, sessions: upsertById(current.sessions, session) } : current));
      }),
      window.aliyAgent.onMessageDelta((event) => {
        if (!event.delta) return;
        setStreamingMessages((messages) => upsertStreamingMessage(messages, event));
        setActivity((current) => (current && current.sessionId === event.sessionId ? null : current));
      }),
      window.aliyAgent.onActivity((event) => {
        if (!event.label) return;
        setActivity({ sessionId: event.sessionId, label: event.label });
      }),
      window.aliyAgent.onRunStepAdded((step) => {
        setState((current) => (current ? { ...current, runSteps: upsertById(current.runSteps, step) } : current));
      }),
      window.aliyAgent.onApprovalRequested((approval) => {
        setState((current) =>
          current ? { ...current, approvalRequests: upsertById(current.approvalRequests, approval, 'createdAt', 'desc') } : current
        );
      }),
      window.aliyAgent.onContextDocumentAdded((document) => {
        setState((current) =>
          current ? { ...current, contextDocuments: upsertContextDocument(current.contextDocuments, document) } : current
        );
      }),
      window.aliyAgent.onCatalogFactAdded((fact) => {
        setState((current) => (current ? { ...current, catalogFacts: upsertCatalogFact(current.catalogFacts, fact) } : current));
      }),
      window.aliyAgent.onRunCompleted((event) => {
        setThinkingSessionId((current) => (current === event.sessionId ? null : current));
        setActivity((current) => (current && current.sessionId === event.sessionId ? null : current));
        const completedStep = event.runStep;
        if (!completedStep) return;
        setState((current) => (current ? { ...current, runSteps: upsertById(current.runSteps, completedStep) } : current));
      })
    ];
    return () => unsubscribe.forEach((dispose) => dispose());
  }, []);

  const canCreateSession = Boolean(activeWorkspace && activeProfile);
  const canSend = Boolean(activeSession && input.trim() && !pendingTrustMode);

  function openProfileModal(profile: Profile | null): void {
    setProfileModalProfile(profile);
    setModal('profile');
  }

  async function mountWorkspace(): Promise<void> {
    if (isMountingWorkspace) return;
    setIsMountingWorkspace(true);
    try {
      const workspace = (await window.aliyAgent.mountWorkspace()) as Workspace | null;
      await refresh();
      if (workspace) {
        setSelectedWorkspaceId(workspace.id);
        notify('success', `已挂载工作空间：${workspace.name}`);
      }
    } catch (error) {
      notify('error', errorMessage(error, '挂载工作空间失败'));
    } finally {
      setIsMountingWorkspace(false);
    }
  }

  async function createSession(): Promise<void> {
    if (!activeWorkspace || !activeProfile || isCreatingSession) return;
    setIsCreatingSession(true);
    try {
      const session = (await window.aliyAgent.createSession({
        workspaceId: activeWorkspace.id,
        profileId: activeProfile.id,
        title: '未命名会话'
      })) as Session;
      setSelectedSessionId(session.id);
      await refresh();
      notify('success', `已创建会话：${session.title}`);
    } catch (error) {
      notify('error', errorMessage(error, '创建会话失败'));
    } finally {
      setIsCreatingSession(false);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!activeSession || !input.trim() || isSending) return;
    const content = input.trim();
    const sessionId = activeSession.id;
    setInput('');
    setOptimisticMessages((messages) => [
      ...messages,
      {
        id: `optimistic-${Date.now()}`,
        sessionId,
        role: 'user',
        content,
        runId: null,
        createdAt: Date.now()
      }
    ]);
    setThinkingSessionId(sessionId);
    setIsSending(true);
    try {
      await window.aliyAgent.sendMessage({ sessionId, content });
      await refresh();
    } catch (error) {
      notify('error', errorMessage(error, '发送消息失败'));
    } finally {
      setOptimisticMessages((messages) => messages.filter((message) => message.sessionId !== sessionId));
      setStreamingMessages((messages) => messages.filter((message) => message.sessionId !== sessionId));
      setThinkingSessionId(null);
      setIsSending(false);
    }
  }

  async function stopRun(): Promise<void> {
    if (!activeSession) return;
    try {
      const result = (await window.aliyAgent.cancelRun({ sessionId: activeSession.id })) as {
        ok: boolean;
        cancelled: boolean;
      };
      notify('success', result.cancelled ? '已请求取消本轮运行' : '当前没有正在运行的任务');
    } catch (error) {
      notify('error', errorMessage(error, '取消运行失败'));
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    if (deletingSessionId) return;
    const target = visibleSessions.find((session) => session.id === sessionId);
    const confirmed = window.confirm(`确定删除会话「${target?.title ?? sessionId}」吗？该会话的消息、运行步骤与审批记录都会一并删除，且不可恢复。`);
    if (!confirmed) return;
    setDeletingSessionId(sessionId);
    try {
      await window.aliyAgent.deleteSession({ sessionId });
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      setOptimisticMessages((messages) => messages.filter((message) => message.sessionId !== sessionId));
      setStreamingMessages((messages) => messages.filter((message) => message.sessionId !== sessionId));
      setThinkingSessionId((current) => (current === sessionId ? null : current));
      await refresh();
      notify('success', '已删除会话');
    } catch (error) {
      notify('error', errorMessage(error, '删除会话失败'));
    } finally {
      setDeletingSessionId(null);
    }
  }

  async function updateTrustMode(trustMode: TrustMode): Promise<void> {
    if (!activeSession || pendingTrustMode) return;
    setPendingTrustMode(trustMode);
    try {
      const updatedSession = (await window.aliyAgent.updateSessionTrustMode({ sessionId: activeSession.id, trustMode })) as Session;
      setState((current) => (current ? { ...current, sessions: upsertById(current.sessions, updatedSession) } : current));
      await refresh();
      notify('success', trustMode === 'strict' ? '已切换到严控核签' : '已切换到信任执行');
    } catch (error) {
      notify('error', errorMessage(error, '更新信任模式失败'));
    } finally {
      setPendingTrustMode(null);
    }
  }

  async function installSkillsFromDirectory(): Promise<void> {
    if (isInstallingSkills) return;
    setIsInstallingSkills(true);
    try {
      const result = (await window.aliyAgent.installSkillsFromDirectory()) as InstallSkillsResult;
      await refresh();
      if (result.rootPath) {
        notify('success', `已安装 ${result.installed.length} 个技能${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ''}。`);
      }
    } catch (error) {
      notify('error', errorMessage(error, '装载技能失败'));
    } finally {
      setIsInstallingSkills(false);
    }
  }

  async function openSkill(skill: SkillSummary): Promise<void> {
    try {
      const detail = (await window.aliyAgent.loadSkill(skill.id)) as SkillDetail;
      setSelectedSkill(detail);
      setModal('skill');
    } catch (error) {
      notify('error', errorMessage(error, '读取技能失败'));
    }
  }

  async function selectSkillForSession(skillId: string): Promise<void> {
    const pendingKey = `select:${skillId}`;
    if (!activeSession || pendingSkillIds.has(pendingKey)) return;
    setPendingSkillIds((items) => new Set(items).add(pendingKey));
    try {
      await window.aliyAgent.selectSkillForSession({ sessionId: activeSession.id, skillId });
      await refresh();
      notify('success', '已选入当前会话');
    } catch (error) {
      notify('error', errorMessage(error, '选入技能失败'));
    } finally {
      setPendingSkillIds((items) => withoutSetItem(items, pendingKey));
    }
  }

  async function removeSkillFromSession(skillId: string): Promise<void> {
    const pendingKey = `remove:${skillId}`;
    if (!activeSession || pendingSkillIds.has(pendingKey)) return;
    setPendingSkillIds((items) => new Set(items).add(pendingKey));
    try {
      await window.aliyAgent.removeSkillFromSession({ sessionId: activeSession.id, skillId });
      await refresh();
      notify('success', '已移出当前会话');
    } catch (error) {
      notify('error', errorMessage(error, '移出技能失败'));
    } finally {
      setPendingSkillIds((items) => withoutSetItem(items, pendingKey));
    }
  }

  async function decideApproval(approvalId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (pendingApprovalIds.has(approvalId)) return;
    setPendingApprovalIds((items) => new Set(items).add(approvalId));
    try {
      const result = (await window.aliyAgent.decideApproval({ approvalId, decision })) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? '审批处理失败');
      await refresh();
      notify('success', decision === 'approve' ? '已批准审批请求' : '已拒绝审批请求');
    } catch (error) {
      notify('error', errorMessage(error, '审批处理失败'));
    } finally {
      setPendingApprovalIds((items) => withoutSetItem(items, approvalId));
    }
  }

  async function decideMemoryCandidate(candidateId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (pendingMemoryCandidateIds.has(candidateId)) return;
    setPendingMemoryCandidateIds((items) => new Set(items).add(candidateId));
    try {
      const result = (await window.aliyAgent.decideMemoryCandidate({ candidateId, decision })) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? '记忆候选处理失败');
      await refresh();
      notify('success', decision === 'approve' ? '已写入记忆' : '已拒绝记忆候选');
    } catch (error) {
      notify('error', errorMessage(error, '记忆候选处理失败'));
    } finally {
      setPendingMemoryCandidateIds((items) => withoutSetItem(items, candidateId));
    }
  }

  async function changeMode(mode: AgentMode): Promise<void> {
    setTweak('defaultMode', mode);
    if (activeSession) {
      await updateTrustMode(agentModeToTrustMode(mode));
    }
  }

  async function changeTweakDefaultMode(mode: AgentMode): Promise<void> {
    setTweak('defaultMode', mode);
    if (activeSession && activeSession.trustMode !== agentModeToTrustMode(mode)) {
      await updateTrustMode(agentModeToTrustMode(mode));
    }
  }

  if (loading || !state) {
    return (
      <main className="boot-screen">
        <Loader2 className="spin" size={28} />
        <span>正在打开本地客户端...</span>
      </main>
    );
  }

  return (
    <div className={`app${tweaks.density === 'compact' ? ' compact' : ''}`}>
      <AgentTitlebar
        profiles={state.profiles}
        profile={activeProfile}
        catalogStatus={state.catalogStatus}
        llmSettings={state.llmSettings}
        skillCount={state.skills.length}
        taskCount={state.scheduledTasks.length}
        pendingMemoryCount={pendingMemoryCount}
        onSelectProfile={setSelectedProfileId}
        onOpenProfile={() => openProfileModal(activeProfile)}
        onNewProfile={() => openProfileModal(null)}
        onOpenModel={() => setModal('model')}
        onOpenCatalog={() => setModal('catalog')}
        onOpenSkills={() => setModal('skills')}
        onOpenTasks={() => setModal('tasks')}
        onOpenMemory={() => setModal('memory')}
      />

      <div className="main">
        <AgentSidebar
          workspaces={state.workspaces}
          activeWorkspace={activeWorkspace}
          activeProfile={activeProfile}
          sessions={visibleSessions}
          activeSession={activeSession}
          canCreate={canCreateSession}
          mounting={isMountingWorkspace}
          creating={isCreatingSession}
          deletingSessionId={deletingSessionId}
          onMountWorkspace={mountWorkspace}
          onSelectWorkspace={setSelectedWorkspaceId}
          onCreateSession={createSession}
          onSelectSession={setSelectedSessionId}
          onDeleteSession={deleteSession}
        />

        <main className="center">
          <AgentSessionHeader
            session={activeSession}
            profile={activeProfile}
            llmSettings={state.llmSettings}
            mode={activeMode}
            updatingTrustMode={pendingTrustMode !== null}
            onModeChange={changeMode}
            onOpenModel={() => setModal('model')}
          />
          <AgentTimeline
            state={state}
            activeSession={activeSession}
            optimisticMessages={optimisticMessages}
            streamingMessages={streamingMessages}
            thinkingSessionId={thinkingSessionId}
            activity={activity}
            pendingApprovalIds={pendingApprovalIds}
            onDecideApproval={decideApproval}
          />
          <AgentComposer
            value={input}
            disabled={!activeSession}
            sending={isSending}
            canSend={canSend}
            onChange={setInput}
            onSend={sendMessage}
            onStop={stopRun}
            onReference={() => setInput((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@`)}
            onOpenPlaybooks={() => setModal('skills')}
          />
        </main>

        <AgentInspector
          state={state}
          activeRunId={activeRunId}
          activeSession={activeSession}
          activeContextDocuments={activeContextDocuments}
          activeCatalogFacts={activeCatalogFacts}
          activeMemoryCandidates={activeMemoryCandidates}
          pendingMemoryCount={pendingMemoryCount}
          selectedSessionSkills={selectedSessionSkills}
          tab={inspectorTab}
          collapsed={inspectorCollapsed}
          pendingSkillIds={pendingSkillIds}
          onTabChange={setInspectorTab}
          onCollapsedChange={setInspectorCollapsed}
          onOpenCatalog={() => setModal('catalog')}
          onOpenMemory={() => setModal('memory')}
          onOpenSkills={() => setModal('skills')}
          onInstallSkills={installSkillsFromDirectory}
          onOpenSkill={openSkill}
          onSelectSkill={selectSkillForSession}
          onRemoveSkill={removeSkillFromSession}
          installingSkills={isInstallingSkills}
        />
      </div>

      {modal === 'profile' && (
        <ProfileModal
          profile={profileModalProfile}
          notify={notify}
          onClose={() => setModal(null)}
          onSaved={async (profile) => {
            setModal(null);
            setSelectedProfileId(profile.id);
            await refresh();
          }}
        />
      )}
      {modal === 'model' && (
        <ModelModal
          settings={state.llmSettings}
          notify={notify}
          onClose={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            await refresh();
          }}
        />
      )}
      {modal === 'catalog' && (
        <CatalogModal
          status={state.catalogStatus}
          notify={notify}
          onClose={() => setModal(null)}
          onRefreshed={async () => {
            await refresh();
          }}
        />
      )}
      {modal === 'skill' && selectedSkill && (
        <SkillModal
          skill={selectedSkill}
          onClose={() => {
            setSelectedSkill(null);
            setModal(null);
          }}
        />
      )}
      {modal === 'skills' && (
        <SkillManagerModal
          skills={state.skills}
          selectedSkills={selectedSessionSkills}
          activeSession={activeSession}
          installing={isInstallingSkills}
          onClose={() => setModal(null)}
          onInstall={installSkillsFromDirectory}
          onOpenSkill={openSkill}
          onSelect={selectSkillForSession}
          onRemove={removeSkillFromSession}
          pendingSkillIds={pendingSkillIds}
        />
      )}
      {modal === 'tasks' && (
        <ScheduledTasksModal tasks={state.scheduledTasks} executions={state.taskExecutions} onClose={() => setModal(null)} />
      )}
      {modal === 'memory' && (
        <MemoryModal
          candidates={activeMemoryCandidates}
          pendingCandidateIds={pendingMemoryCandidateIds}
          onClose={() => setModal(null)}
          onDecide={decideMemoryCandidate}
        />
      )}
      <ToastViewport toasts={toasts} onDismiss={(id) => setToasts((items) => items.filter((toast) => toast.id !== id))} />
      <TweaksPanel
        tweaks={tweaks}
        onAccentChange={(accent) => setTweak('accent', accent)}
        onDensityChange={(density) => setTweak('density', density)}
        onDefaultModeChange={changeTweakDefaultMode}
      />
    </div>
  );
}

function AgentTitlebar({
  profiles,
  profile,
  catalogStatus,
  llmSettings,
  skillCount,
  taskCount,
  pendingMemoryCount,
  onSelectProfile,
  onOpenProfile,
  onNewProfile,
  onOpenModel,
  onOpenCatalog,
  onOpenSkills,
  onOpenTasks,
  onOpenMemory
}: {
  profiles: Profile[];
  profile: Profile | null;
  catalogStatus: CatalogStatus;
  llmSettings: LlmSettings;
  skillCount: number;
  taskCount: number;
  pendingMemoryCount: number;
  onSelectProfile: (profileId: string) => void;
  onOpenProfile: () => void;
  onNewProfile: () => void;
  onOpenModel: () => void;
  onOpenCatalog: () => void;
  onOpenSkills: () => void;
  onOpenTasks: () => void;
  onOpenMemory: () => void;
}): JSX.Element {
  return (
    <header className="titlebar">
      <div className="tb-brand">
        <ShieldCheck size={17} className="logo" />
        Aliy Agent <span className="tb-sub">· Local-first Ops</span>
      </div>
      <div className="tb-spacer" />
      <div className="tb-profile-control">
        <UserRound size={14} />
        <select
          value={profile?.id ?? ''}
          onChange={(event) => onSelectProfile(event.target.value)}
          disabled={profiles.length === 0}
          title="选择执行主体"
        >
          {profiles.length === 0 ? (
            <option value="">Profile</option>
          ) : (
            profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))
          )}
        </select>
        <button onClick={onOpenProfile} disabled={!profile} title="编辑当前主体">
          <Settings size={13} />
        </button>
        <button onClick={onNewProfile} title="新增主体">
          <Plus size={13} />
        </button>
      </div>
      <button className="tb-tool wide" onClick={onOpenModel} title="模型配置">
        <TerminalSquare size={14} />
        <span>{llmSettings.model ?? 'Model'}</span>
      </button>
      <button className="tb-tool" onClick={onOpenCatalog} title={`接口事实库：${catalogStatus.productCount} 产品 / ${catalogStatus.actionCount} Action`}>
        <Database size={14} />
        <span className={catalogStatus.exists ? 'mini-dot ok' : 'mini-dot warn'} />
      </button>
      <button className="tb-tool" onClick={onOpenSkills} title={`技能库：${skillCount} 个`}>
        <Library size={14} />
        {skillCount > 0 && <b>{skillCount}</b>}
      </button>
      <button className="tb-tool" onClick={onOpenTasks} title={`定时任务：${taskCount} 个`}>
        <PlayCircle size={14} />
        {taskCount > 0 && <b>{taskCount}</b>}
      </button>
      <button className="tb-tool" onClick={onOpenMemory} title={`记忆候选：${pendingMemoryCount} 条待确认`}>
        <Bot size={14} />
        {pendingMemoryCount > 0 && <b>{pendingMemoryCount}</b>}
      </button>
      <div className="tb-status">
        <span className="tb-region">{profile?.defaultRegion ?? 'region unset'}</span>
        <span>
          <span className="dot" />
          {catalogStatus.exists ? '本地索引已同步' : '本地索引待初始化'}
        </span>
      </div>
    </header>
  );
}

function AgentSidebar({
  workspaces,
  activeWorkspace,
  activeProfile,
  sessions,
  activeSession,
  canCreate,
  mounting,
  creating,
  deletingSessionId,
  onMountWorkspace,
  onSelectWorkspace,
  onCreateSession,
  onSelectSession,
  onDeleteSession
}: {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeProfile: Profile | null;
  sessions: Session[];
  activeSession: Session | null;
  canCreate: boolean;
  mounting: boolean;
  creating: boolean;
  deletingSessionId: string | null;
  onMountWorkspace: () => void | Promise<void>;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: () => void | Promise<void>;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <aside className="rail">
      <div className="rail-scroll">
        <div className="proj-card">
          <button className="proj-head" onClick={() => void onMountWorkspace()} disabled={mounting} title="选择项目目录">
            <div className="proj-mark">{activeWorkspace?.name?.slice(0, 1).toLowerCase() || 'a'}</div>
            <div className="proj-main">
              <div className="proj-name">{activeWorkspace?.name ?? '未挂载工作空间'}</div>
              <div className="proj-path">{activeWorkspace?.rootPath ?? '选择一个本地项目后开始'}</div>
            </div>
            {mounting ? <Loader2 className="spin proj-chev" size={15} /> : <ChevronDown size={15} className="proj-chev" />}
          </button>
          {workspaces.length > 1 && (
            <div className="proj-switch">
              <select value={activeWorkspace?.id ?? ''} onChange={(event) => onSelectWorkspace(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="proj-cred">
            <div className="cred-row passive">
              <KeyRound size={13} />
              <span className="k">凭据</span>
              <span className="v">{activeProfile?.name ?? '未配置'}</span>
              <span className="v dim">{activeProfile?.akIdMasked ?? 'AK unset'}</span>
            </div>
            <div className="cred-row passive">
              <Globe size={13} />
              <span className="k">地域</span>
              <span className="v">{activeProfile?.defaultRegion ?? '未设置'}</span>
              <span className="v dim">Aliyun OpenAPI</span>
            </div>
          </div>
        </div>

        <div className="rail-section-h">
          <span className="eyebrow">Sessions</span>
          <span className="count">{sessions.length}</span>
          <button className="add" disabled={!canCreate || creating} onClick={() => void onCreateSession()} title="新建会话">
            {creating ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
          </button>
        </div>

        <div className="sess-list">
          {sessions.length === 0 ? (
            <div className="empty-skill">{canCreate ? '尚无会话' : '先挂载 Workspace 并配置 Profile'}</div>
          ) : (
            sessions.map((session) => (
              <div className={`sess${session.id === activeSession?.id ? ' active' : ''}`} key={session.id}>
                <button className="sess-main" onClick={() => onSelectSession(session.id)}>
                  <div className="sess-top">
                    <span className="sess-title">{session.title}</span>
                    {session.id !== activeSession?.id && <span className="run-dot done" />}
                  </div>
                  <div className="sess-meta">
                    {session.id === activeSession?.id && <span className="run-dot running" />}
                    <span className="last">{session.trustMode === 'strict' ? '严控核签' : '信任执行'}</span>
                    <span>{formatFullDateTime(session.updatedAt)}</span>
                  </div>
                </button>
                <button
                  className="sess-delete"
                  disabled={deletingSessionId === session.id}
                  onClick={() => void onDeleteSession(session.id)}
                  title="删除会话"
                >
                  {deletingSessionId === session.id ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rail-foot">
        <ShieldCheck size={16} className="logo" />
        <div className="rail-foot-id">
          <div className="who">{activeProfile?.name ?? 'Profile'}</div>
          <div className="ak">{activeProfile?.akIdMasked ?? 'AK unset'}</div>
        </div>
      </div>
    </aside>
  );
}

function AgentSessionHeader({
  session,
  profile,
  llmSettings,
  mode,
  updatingTrustMode,
  onModeChange,
  onOpenModel
}: {
  session: Session | null;
  profile: Profile | null;
  llmSettings: LlmSettings;
  mode: AgentMode;
  updatingTrustMode: boolean;
  onModeChange: (mode: AgentMode) => void | Promise<void>;
  onOpenModel: () => void;
}): JSX.Element {
  return (
    <div className="sess-header">
      <div className="sh-top">
        <div className="sh-intent">
          <div className="sh-eyebrow">
            <span className="eyebrow">运维意图 · {session ? shortId(session.id) : '未建立会话'}</span>
            {session && <span className="run-dot running" />}
          </div>
          <div className="sh-title">{session?.title ?? '挂载工作空间、配置凭证后即可开始新的运维会话'}</div>
        </div>
        <button className="sh-model" onClick={onOpenModel} title="切换模型">
          <span className="m-ava">
            <Zap size={11} />
          </span>
          <span className="m-name">{llmSettings.model ?? 'model unset'}</span>
          <span className="m-vendor">{llmSettings.provider ?? profile?.defaultRegion ?? 'runtime'}</span>
          <ChevronDown size={14} style={{ color: 'var(--text-4)' }} />
        </button>
      </div>
      <ModeBar mode={mode} disabled={!session || updatingTrustMode} onModeChange={onModeChange} />
    </div>
  );
}

function ModeBar({
  mode,
  disabled,
  onModeChange
}: {
  mode: AgentMode;
  disabled: boolean;
  onModeChange: (mode: AgentMode) => void | Promise<void>;
}): JSX.Element {
  return (
    <div className="modebar">
      <div className="seg">
        <button className={`mode-gate${mode === 'gate' ? ' on' : ''}`} disabled={disabled} onClick={() => void onModeChange('gate')}>
          <Lock size={14} className="ic" /> 严控核签
        </button>
        <button className={`mode-trust${mode === 'trust' ? ' on' : ''}`} disabled={disabled} onClick={() => void onModeChange('trust')}>
          <Zap size={14} className="ic" /> 信任执行
        </button>
      </div>
      <span className="mode-hint">
        {mode === 'gate' ? (
          <>
            每个 <b>write</b> 操作都会暂停，等待你核签。
          </>
        ) : (
          <>
            read / <b>write</b> / dangerous 自动执行并记录。
          </>
        )}
      </span>
    </div>
  );
}

function AgentTimeline({
  state,
  activeSession,
  optimisticMessages,
  streamingMessages,
  thinkingSessionId,
  activity,
  pendingApprovalIds,
  onDecideApproval
}: {
  state: BootstrapState;
  activeSession: Session | null;
  optimisticMessages: Message[];
  streamingMessages: Message[];
  thinkingSessionId: string | null;
  activity: { sessionId: string; label: string } | null;
  pendingApprovalIds: Set<string>;
  onDecideApproval: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionMessages = useMemo(
    () =>
      activeSession
        ? [
            ...state.messages.filter((message) => message.sessionId === activeSession.id && isTimelineChatMessage(message)),
            ...optimisticMessages.filter((message) => message.sessionId === activeSession.id),
            ...streamingMessages.filter((message) => message.sessionId === activeSession.id)
          ]
        : [],
    [activeSession, state.messages, optimisticMessages, streamingMessages]
  );
  const sessionSteps = useMemo(
    () =>
      activeSession
        ? state.runSteps.filter((step) => step.sessionId === activeSession.id && shouldShowTimelineStep(step))
        : [],
    [activeSession, state.runSteps]
  );
  const sessionAllSteps = useMemo(
    () => (activeSession ? state.runSteps.filter((step) => step.sessionId === activeSession.id) : []),
    [activeSession, state.runSteps]
  );
  const chainGroups = useMemo(() => buildCallChainGroups(sessionAllSteps), [sessionAllSteps]);
  const pendingApprovals = useMemo(
    () =>
      activeSession
        ? state.approvalRequests.filter((approval) => approval.sessionId === activeSession.id && approval.status === 'pending')
        : [],
    [activeSession, state.approvalRequests]
  );
  const timelineItems = useMemo(
    () =>
      [
        ...sessionMessages.map((message) => ({ kind: 'message' as const, id: message.id, at: message.createdAt, message })),
        ...sessionSteps.map((step) => ({ kind: 'step' as const, id: step.id, at: step.createdAt, step })),
        ...chainGroups.map((chain) => ({ kind: 'chain' as const, id: chain.runId, at: chain.updatedAt + 1, chain })),
        ...pendingApprovals.map((approval) => ({ kind: 'approval' as const, id: approval.id, at: approval.createdAt, approval }))
      ].sort((left, right) => left.at - right.at),
    [sessionMessages, sessionSteps, chainGroups, pendingApprovals]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [timelineItems.length, thinkingSessionId, activity?.label]);

  if (!activeSession) {
    return (
      <div className="timeline-wrap empty-timeline">
        <ShieldAlert size={34} />
        <h2>等待建立安全会话</h2>
        <p>这里不会注入示例数据。挂载 Workspace、配置 Profile 后，新建会话即可开始。</p>
      </div>
    );
  }

  return (
    <div className="timeline-wrap" ref={scrollRef}>
      <div className="timeline">
        <div className="t-rail" />
        {timelineItems.map((item) => {
          if (item.kind === 'message') return <TimelineMessage key={item.id} message={item.message} />;
          if (item.kind === 'approval') {
            return (
              <ApprovalGateCard
                key={item.id}
                approval={item.approval}
                pending={pendingApprovalIds.has(item.approval.id)}
                trustMode={activeSession.trustMode}
                onDecide={onDecideApproval}
              />
            );
          }
          if (item.kind === 'chain') return <CallChainCard key={`chain:${item.id}`} chain={item.chain} />;
          return <TimelineStep key={item.id} step={item.step} />;
        })}
        {thinkingSessionId === activeSession.id && (
          <div className="step fresh">
            <div className="step-node ok">
              <Loader2 className="spin" />
            </div>
            <div className="step-card thinking-inline">
              <strong>正在执行</strong>
              <span>{activity && activity.sessionId === activeSession.id ? activity.label : '整理上下文、选择工具、等待 Gateway 返回...'}</span>
              <div className="thinking-dots">
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        )}
        {timelineItems.length === 0 && (
          <div className="quiet-note">
            当前会话还没有消息或运行步骤。输入运维意图后，真实执行链路会显示在这里。
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineMessage({ message }: { message: Message }): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="umsg">
        <div>
          <div className="bubble">{message.content}</div>
          <div className="who">用户 · {formatDateTime(message.createdAt)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="anote message-note fresh">
      <MarkdownContent content={message.content} />
    </div>
  );
}

function CallChainCard({ chain }: { chain: CallChainGroup }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="call-chain">
      <div className="call-chain-node">
        <GitBranch size={14} />
      </div>
      <div className={`call-chain-card${open ? ' open' : ''}`}>
        <button className="call-chain-head" onClick={() => setOpen((current) => !current)}>
          <span className="step-verb">call_chain</span>
          <span className="step-target">run {shortId(chain.runId)}</span>
          <span className="step-sum">{chain.steps.length} 步 · {chain.statusLabel}</span>
          <span className="step-time mono">{formatDateTime(chain.updatedAt)}</span>
          <ChevronRight size={14} className="step-chev" />
        </button>
        {open && (
          <div className="call-chain-detail">
            {chain.steps.map((step, index) => (
              <div className="chain-row" key={step.id}>
                <span className="chain-index">{String(index + 1).padStart(2, '0')}</span>
                <span className={`chain-dot ${stepNodeClass(step)}`} />
                <span className="chain-type">{step.title}</span>
                <span className="chain-title">{step.stepType}</span>
                <span className="chain-status">{step.status}</span>
                <time>{formatDateTime(step.createdAt)}</time>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const HeadingTag = `h${block.level}` as keyof JSX.IntrinsicElements;
          return <HeadingTag key={index}>{renderInlineMarkdown(block.text)}</HeadingTag>;
        }
        if (block.type === 'code') {
          return (
            <pre className="md-code" key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'quote') return <blockquote key={index}>{renderInlineMarkdown(block.text)}</blockquote>;
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === 'table') {
          return (
            <div className="md-table-wrap" key={index}>
              <table>
                <thead>
                  <tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}>{renderInlineMarkdown(header)}</th>)}</tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function TimelineStep({ step }: { step: RunStep }): JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = summarizeStepForTimeline(step);
  return (
    <div className="step">
      <div className={`step-node ${detail.node}`}>{stepIcon(detail.verb)}</div>
      <div className={`step-card${open ? ' open' : ''}`}>
        <button className="step-line" onClick={() => setOpen((current) => !current)}>
          <span className="step-verb">{detail.verbLabel}</span>
          <span className="step-target">{detail.target}</span>
          {detail.danger && <DangerTagPill danger={detail.danger} />}
          <span className="step-sum">{detail.summary}</span>
          <span className="step-time mono">{formatDateTime(step.createdAt)}</span>
          <ChevronRight size={14} className="step-chev" />
        </button>
        {open && (
          <div className="step-detail">
            {detail.candidates ? (
              <div className="cand-list">
                {detail.candidates.map((candidate, index) => (
                  <div className="cand" key={`${candidate.name}:${index}`}>
                    <Wrench size={12} className="mono" style={{ color: 'var(--text-4)' }} />
                    <span className="nm">{candidate.name}</span>
                    {candidate.picked && <span className="picked">已选用</span>}
                  </div>
                ))}
              </div>
            ) : (
              <pre className="code">{detail.code}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalGateCard({
  approval,
  pending,
  trustMode,
  onDecide
}: {
  approval: ApprovalRequest;
  pending: boolean;
  trustMode: TrustMode;
  onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): JSX.Element {
  const gate = approvalToGate(approval);
  const trust = trustMode === 'autopilot';
  const gateLabel = trust
    ? '信任执行 · 历史待处理核签'
    : approval.danger === 'dangerous'
      ? '高危核签 · dangerous 需确认'
      : '严控核签 · write 需确认';
  return (
    <div className="gate">
      <div className="gate-node">{trust ? <Zap /> : <Lock />}</div>
      <div className={`gate-card${trust ? ' trust' : ''}`}>
        <div className="gate-bar">
          {trust ? <Zap size={15} style={{ color: 'var(--accent)' }} /> : <Lock size={15} style={{ color: 'var(--write)' }} />}
          <span className="lbl">{gateLabel}</span>
          <span className="tag-write">
            <DangerTagPill danger={approval.danger} />
          </span>
        </div>
        <div className="gate-body">
          <div className="gate-cmd">
            <span className="api">{gate.api}</span>
            {gate.version && <span className="ver">v{gate.version}</span>}
            {gate.region && <span className="ver">{gate.region}</span>}
          </div>
          <p className="gate-summary">{approval.summary}</p>
          <div className="gate-params">
            {gate.params.length === 0 ? (
              <div className="gp-row">
                <div className="gk">params</div>
                <div className="gv">无可展示参数</div>
              </div>
            ) : (
              gate.params.map(([key, value, masked]) => (
                <div className="gp-row" key={key}>
                  <div className="gk">{key}</div>
                  <div className={`gv${masked ? ' mask' : ''}`}>{value}</div>
                </div>
              ))
            )}
          </div>
          <div className="gate-meta">
            <span className="dry">
              <CheckCircle2 size={14} /> status <b className="mono">{approval.status}</b>
            </span>
            <span className="gate-note">
              <AlertTriangle size={13} /> {approval.reason}
            </span>
          </div>
        </div>
        <div className="gate-actions">
          <button className="btn confirm" disabled={pending} onClick={() => void onDecide(approval.id, 'approve')}>
            {pending ? <Loader2 className="spin" size={15} /> : <Check size={15} />} 确认执行
          </button>
          <button className="btn ghost-danger" disabled={pending} onClick={() => void onDecide(approval.id, 'reject')}>
            <X size={15} /> 拒绝
          </button>
          <span className="spacer" />
          <span className="editlink">修改意图后可重新规划参数</span>
        </div>
      </div>
    </div>
  );
}

function AgentComposer({
  value,
  disabled,
  sending,
  canSend,
  onChange,
  onSend,
  onStop,
  onReference,
  onOpenPlaybooks
}: {
  value: string;
  disabled: boolean;
  sending: boolean;
  canSend: boolean;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onReference: () => void;
  onOpenPlaybooks: () => void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <footer className="composer">
      <div className="composer-inner">
        <div className="composer-box">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={disabled ? '先创建会话' : '输入运维意图，使用 @ 引用本地文件 / 接口…'}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (canSend) void onSend();
              }
            }}
          />
          <div className="composer-bar">
            <button className="chip" type="button" disabled={disabled} onClick={onReference}>
              <AtSign size={12} /> 引用
            </button>
            <button className="chip" type="button" disabled={disabled} onClick={onOpenPlaybooks}>
              <BookOpen size={12} /> Playbook
            </button>
            <span className="spacer" />
            <span className="mono shortcut">⌘⏎ 发送</span>
            {sending ? (
              <button className="send stop" type="button" title="停止本轮运行" onClick={() => void onStop()}>
                <Square size={15} />
              </button>
            ) : (
              <button className="send" type="button" disabled={!canSend} onClick={() => void onSend()}>
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}

function AgentInspector({
  state,
  activeRunId,
  activeSession,
  activeContextDocuments,
  activeCatalogFacts,
  activeMemoryCandidates,
  pendingMemoryCount,
  selectedSessionSkills,
  tab,
  collapsed,
  pendingSkillIds,
  installingSkills,
  onTabChange,
  onCollapsedChange,
  onOpenCatalog,
  onOpenMemory,
  onOpenSkills,
  onInstallSkills,
  onOpenSkill,
  onSelectSkill,
  onRemoveSkill
}: {
  state: BootstrapState;
  activeRunId: string | null;
  activeSession: Session | null;
  activeContextDocuments: ContextDocumentPointer[];
  activeCatalogFacts: CatalogFactPointer[];
  activeMemoryCandidates: MemoryCandidate[];
  pendingMemoryCount: number;
  selectedSessionSkills: SessionSkillPointer[];
  tab: InspectorTab;
  collapsed: boolean;
  pendingSkillIds: Set<string>;
  installingSkills: boolean;
  onTabChange: (tab: InspectorTab) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenCatalog: () => void;
  onOpenMemory: () => void;
  onOpenSkills: () => void;
  onInstallSkills: () => void | Promise<void>;
  onOpenSkill: (skill: SkillSummary) => void | Promise<void>;
  onSelectSkill: (skillId: string) => void | Promise<void>;
  onRemoveSkill: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const tabs: Array<{ id: InspectorTab; label: string; icon: JSX.Element; badge?: number }> = [
    { id: 'context', label: 'Context', icon: <GitBranch size={14} /> },
    { id: 'memory', label: 'Memory', icon: <Brain size={14} />, badge: pendingMemoryCount },
    { id: 'playbooks', label: 'Playbooks', icon: <BookOpen size={14} /> }
  ];
  return (
    <aside className={`inspector${collapsed ? ' collapsed' : ''}`}>
      <div className="collapsed-rail">
        <button title="展开" onClick={() => onCollapsedChange(false)}>
          <PanelRight size={16} />
        </button>
        {tabs.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'on' : ''}
            title={item.label}
            onClick={() => {
              onTabChange(item.id);
              onCollapsedChange(false);
            }}
          >
            {item.icon}
            {item.badge ? <span className="b">{item.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="insp-tabs">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? 'on' : ''} onClick={() => onTabChange(item.id)}>
            {item.icon} {item.label}
            {item.badge ? <span className="b">{item.badge}</span> : null}
          </button>
        ))}
        <button className="insp-collapse" title="折叠" onClick={() => onCollapsedChange(true)}>
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="insp-scroll">
        {tab === 'context' && (
          <InspectorContextTab
            activeRunId={activeRunId}
            docs={activeContextDocuments}
            facts={activeCatalogFacts}
            catalogAttached={state.status.catalogAttached}
            onOpenCatalog={onOpenCatalog}
          />
        )}
        {tab === 'memory' && (
          <InspectorMemoryTab
            candidates={activeMemoryCandidates}
            pendingMemoryCount={pendingMemoryCount}
            onOpenMemory={onOpenMemory}
          />
        )}
        {tab === 'playbooks' && (
          <InspectorPlaybooksTab
            skills={state.skills}
            selectedSkills={selectedSessionSkills}
            activeSession={activeSession}
            pendingSkillIds={pendingSkillIds}
            installing={installingSkills}
            onOpenSkills={onOpenSkills}
            onInstall={onInstallSkills}
            onOpenSkill={onOpenSkill}
            onSelect={onSelectSkill}
            onRemove={onRemoveSkill}
          />
        )}
      </div>
    </aside>
  );
}

function InspectorContextTab({
  activeRunId,
  docs,
  facts,
  catalogAttached,
  onOpenCatalog
}: {
  activeRunId: string | null;
  docs: ContextDocumentPointer[];
  facts: CatalogFactPointer[];
  catalogAttached: boolean;
  onOpenCatalog: () => void;
}): JSX.Element {
  const groupedFacts = groupCatalogFacts(facts);
  return (
    <div>
      <div className="insp-h">
        <span className="eyebrow">已发现接口 · 本会话</span>
        <button className="act" onClick={onOpenCatalog}>
          FTS 检索
        </button>
      </div>
      {groupedFacts.length === 0 ? (
        <div className="empty-skill">{catalogAttached ? (activeRunId ? '本轮还没有检索接口事实' : '当前会话还没有运行上下文') : 'catalog.db 尚未初始化'}</div>
      ) : (
        groupedFacts.map((group) => (
          <div className="prod-group" key={group.product}>
            <div className="prod-h">
              <Database size={13} style={{ color: 'var(--text-3)' }} />
              <span className="pn">{group.product}</span>
              <span className="pc">{group.facts.length} apis</span>
            </div>
            {group.facts.map((fact) => (
              <div className="api-row" key={`${fact.product}:${fact.action}:${fact.version}`}>
                <span className="an">{fact.action}</span>
                <span className="av">v{fact.version}</span>
                <DangerTagPill danger={fact.danger} />
              </div>
            ))}
          </div>
        ))
      )}
      <div className="insp-h with-gap">
        <span className="eyebrow">已装载业务文档</span>
      </div>
      {docs.length === 0 ? (
        <div className="empty-skill">本轮还没有读取工作空间文档</div>
      ) : (
        docs.map((doc) => (
          <div className="doc-row" key={`${doc.runId}:${doc.path}`}>
            <FileText size={13} />
            <div>
              <strong>{doc.title || doc.path}</strong>
              <span>{doc.path} · {formatBytes(doc.size)} · {formatDateTime(doc.usedAt)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function InspectorMemoryTab({
  candidates,
  pendingMemoryCount,
  onOpenMemory
}: {
  candidates: MemoryCandidate[];
  pendingMemoryCount: number;
  onOpenMemory: () => void;
}): JSX.Element {
  const pending = candidates.filter((candidate) => candidate.status === 'pending').slice(0, 4);
  const decided = candidates.filter((candidate) => candidate.status !== 'pending').slice(0, 6);
  return (
    <div>
      <div className="insp-h">
        <span className="eyebrow">主体专属记忆</span>
        <button className="act" onClick={onOpenMemory}>
          管理
        </button>
      </div>
      <div className="mem-cta">
        <div className="big">
          <span className="n mono">{pendingMemoryCount}</span> 条候选待确认
        </div>
        <div className="sub">确认后写入 .agent-memory 并进入本地检索</div>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onOpenMemory}>
          <Check size={14} /> 审核并写入
        </button>
      </div>
      <div className="eyebrow memory-subhead">待确认候选</div>
      {pending.length === 0 ? (
        <div className="empty-skill">暂无待确认记忆。</div>
      ) : (
        pending.map((candidate) => (
          <div className="mem-item" key={candidate.id}>
            <span className="mk">pending</span>
            <span>{candidate.fact}</span>
          </div>
        ))
      )}
      <div className="eyebrow memory-subhead">最近处理</div>
      {decided.length === 0 ? (
        <div className="empty-skill">还没有已处理候选。</div>
      ) : (
        decided.map((candidate) => (
          <div className="mem-item" key={candidate.id}>
            <span className="mk">{candidate.status}</span>
            <span>{candidate.fact}</span>
          </div>
        ))
      )}
    </div>
  );
}

function InspectorPlaybooksTab({
  skills,
  selectedSkills,
  activeSession,
  pendingSkillIds,
  installing,
  onOpenSkills,
  onInstall,
  onOpenSkill,
  onSelect,
  onRemove
}: {
  skills: SkillSummary[];
  selectedSkills: SessionSkillPointer[];
  activeSession: Session | null;
  pendingSkillIds: Set<string>;
  installing: boolean;
  onOpenSkills: () => void;
  onInstall: () => void | Promise<void>;
  onOpenSkill: (skill: SkillSummary) => void | Promise<void>;
  onSelect: (skillId: string) => void | Promise<void>;
  onRemove: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const selectedIds = useMemo(() => new Set(selectedSkills.map((skill) => skill.id)), [selectedSkills]);
  return (
    <div>
      <div className="insp-h">
        <span className="eyebrow">Global Playbooks</span>
        <button className="act" onClick={onOpenSkills}>
          管理
        </button>
      </div>
      <button className="pb install-pb" disabled={installing} onClick={() => void onInstall()}>
        <span className="pbi">{installing ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}</span>
        <div>
          <div className="pbn">从本地文件夹装载</div>
          <div className="pbd">读取 Skill 文件并加入库</div>
        </div>
      </button>
      {skills.length === 0 ? (
        <div className="empty-skill">尚未装载 Skill 文件夹</div>
      ) : (
        skills.map((skill) => {
          const selected = selectedIds.has(skill.id);
          const pendingSelect = pendingSkillIds.has(`select:${skill.id}`);
          const pendingRemove = pendingSkillIds.has(`remove:${skill.id}`);
          return (
            <div className="pb" key={skill.id}>
              <button className="pbi" onClick={() => void onOpenSkill(skill)} title="查看">
                <Box size={15} />
              </button>
              <button className="pb-main" onClick={() => void onOpenSkill(skill)}>
                <div className="pbn">{skill.title}</div>
                <div className="pbd">{skill.description}</div>
              </button>
              {selected ? (
                <button className="pbadd selected" disabled={!activeSession || pendingRemove} onClick={() => void onRemove(skill.id)} title="移出当前会话">
                  {pendingRemove ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
                </button>
              ) : (
                <button className="pbadd" disabled={!activeSession || pendingSelect} onClick={() => void onSelect(skill.id)} title="选入当前会话">
                  {pendingSelect ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                </button>
              )}
            </div>
          );
        })
      )}
      {activeSession && selectedSkills.length === 0 && <div className="empty-skill">本次对话尚未选入技能 · 点击上方加入</div>}
    </div>
  );
}

function TweaksPanel({
  tweaks,
  onAccentChange,
  onDensityChange,
  onDefaultModeChange
}: {
  tweaks: UiTweaks;
  onAccentChange: (accent: string) => void;
  onDensityChange: (density: Density) => void;
  onDefaultModeChange: (mode: AgentMode) => void | Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="twk-fab" onClick={() => setOpen(true)} title="Tweaks">
        <Settings size={16} />
      </button>
    );
  }
  return (
    <aside className="twk-panel">
      <div className="twk-hd">
        <b>Tweaks</b>
        <button className="twk-x" onClick={() => setOpen(false)} title="收起">
          ×
        </button>
      </div>
      <div className="twk-body">
        <div className="twk-sect">外观</div>
        <div className="twk-row">
          <div className="twk-lbl">
            <span>主题色</span>
            <span className="twk-val">{tweaks.accent}</span>
          </div>
          <div className="twk-chips">
            {Object.keys(ACCENT_MAP).map((accent) => (
              <button
                className="twk-chip"
                data-on={tweaks.accent === accent ? '1' : '0'}
                key={accent}
                style={{ background: accent }}
                onClick={() => onAccentChange(accent)}
                title={accent}
              />
            ))}
          </div>
        </div>
        <TweakSegment<UiTweaks['density']>
          label="时间线密度"
          value={tweaks.density}
          options={[
            ['regular', 'regular'],
            ['compact', 'compact']
          ]}
          onChange={onDensityChange}
        />
        <div className="twk-sect">网关</div>
        <TweakSegment<AgentMode>
          label="默认模式"
          value={tweaks.defaultMode}
          options={[
            ['gate', 'gate'],
            ['trust', 'trust']
          ]}
          onChange={(mode) => void onDefaultModeChange(mode)}
        />
      </div>
    </aside>
  );
}

function TweakSegment<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="twk-row">
      <div className="twk-lbl">
        <span>{label}</span>
      </div>
      <div className="twk-seg">
        {options.map(([option, text]) => (
          <button className={value === option ? 'on' : ''} key={option} onClick={() => onChange(option)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function AppMark(): JSX.Element {
  return (
    <div className="app-mark">
      <div className="logo">
        <ShieldCheck size={21} />
      </div>
      <div>
        <div className="brand">Aliy Agent</div>
        <div className="caption">Local-first Ops</div>
      </div>
    </div>
  );
}

function WorkspacePanel({
  workspaces,
  activeWorkspace,
  mounting,
  onMount,
  onSelect
}: {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  mounting: boolean;
  onMount: () => void | Promise<void>;
  onSelect: (workspaceId: string) => void;
}): JSX.Element {
  return (
    <section className="rail-section project-section">
      <div className="section-heading">
        <SectionLabel icon={<Folder size={15} />} label="项目" />
        <button className="icon-button" disabled={mounting} onClick={() => void onMount()} title="选择项目">
          {mounting ? <Loader2 className="spin" size={15} /> : <Folder size={15} />}
        </button>
      </div>
      {workspaces.length > 0 ? (
        <div className="selected-box project-box">
          <strong>{activeWorkspace?.name ?? '请选择工作空间'}</strong>
          <span>{activeWorkspace?.rootPath ?? '未选中'}</span>
          {workspaces.length > 1 && (
            <select value={activeWorkspace?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <EmptyBox text="未挂载工作空间" />
      )}
      {workspaces.length > 1 && <div className="mini-note">{workspaces.length} 个工作空间已注册</div>}
    </section>
  );
}

function SessionPanel({
  sessions,
  activeSession,
  canCreate,
  creating,
  deletingSessionId,
  onCreate,
  onSelect,
  onDelete
}: {
  sessions: Session[];
  activeSession: Session | null;
  canCreate: boolean;
  creating: boolean;
  deletingSessionId: string | null;
  onCreate: () => void | Promise<void>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <section className="rail-section sessions-section">
      <div className="section-heading">
        <SectionLabel icon={<MessageSquarePlus size={15} />} label="Sessions" />
        <button className="icon-button" disabled={!canCreate || creating} onClick={() => void onCreate()} title="新建会话">
          {creating ? <Loader2 className="spin" size={15} /> : <MessageSquarePlus size={15} />}
        </button>
      </div>
      <div className="session-list">
        {sessions.length === 0 ? (
          <EmptyBox text={canCreate ? '尚无会话' : '先挂载 Workspace 并配置 Profile'} />
        ) : (
          sessions.map((session) => (
            <div className={`session-card ${activeSession?.id === session.id ? 'active' : ''}`} key={session.id}>
              <button className="session-card-main" onClick={() => onSelect(session.id)}>
                <div className="session-title">{session.title}</div>
                <div className="session-meta">
                  <span>
                    <Lock size={12} />
                    {session.trustMode === 'strict' ? '严控核签' : '信任执行'}
                  </span>
                  <time>{formatFullDateTime(session.updatedAt)}</time>
                </div>
              </button>
              <button
                className="session-delete"
                title="删除会话"
                disabled={deletingSessionId === session.id}
                onClick={() => void onDelete(session.id)}
              >
                {deletingSessionId === session.id ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function WorkbenchHeader({
  session,
  profile,
  catalogStatus,
  llmSettings,
  skillCount,
  taskCount,
  pendingMemoryCount,
  updatingTrustMode,
  onOpenProfile,
  onOpenModel,
  onOpenCatalog,
  onOpenSkills,
  onOpenTasks,
  onOpenMemory,
  onTrustModeChange
}: {
  session: Session | null;
  profile: Profile | null;
  catalogStatus: CatalogStatus;
  llmSettings: LlmSettings;
  skillCount: number;
  taskCount: number;
  pendingMemoryCount: number;
  updatingTrustMode: boolean;
  onOpenProfile: () => void;
  onOpenModel: () => void;
  onOpenCatalog: () => void;
  onOpenSkills: () => void;
  onOpenTasks: () => void;
  onOpenMemory: () => void;
  onTrustModeChange: (trustMode: TrustMode) => void | Promise<void>;
}): JSX.Element {
  return (
    <header className="workbench-header">
      <div>
        <div className="caption">Action & Gatekeeping Panel</div>
        <h1>{session?.title ?? '等待新建会话'}</h1>
      </div>
      <div className="header-controls">
        <HeaderToolButton icon={<UserRound size={15} />} label={profile?.name ?? 'Profile'} detail={profile?.akIdMasked ?? 'AK 未配置'} onClick={onOpenProfile} />
        <HeaderToolButton icon={<TerminalSquare size={15} />} label={llmSettings.model ?? 'Model'} detail={llmSettings.provider ?? '未配置'} onClick={onOpenModel} />
        <button className="header-icon-button" onClick={onOpenCatalog} title={`接口事实库：${catalogStatus.productCount} 产品 / ${catalogStatus.actionCount} Action`}>
          <Database size={16} />
          <span className={catalogStatus.exists ? 'dot ok' : 'dot warn'} />
        </button>
        <button className="header-icon-button" onClick={onOpenSkills} title={`技能库：${skillCount} 个`}>
          <Library size={16} />
          {skillCount > 0 && <b>{skillCount}</b>}
        </button>
        <button className="header-icon-button" onClick={onOpenTasks} title={`定时任务：${taskCount} 个`}>
          <PlayCircle size={16} />
          {taskCount > 0 && <b>{taskCount}</b>}
        </button>
        <button className="header-icon-button" onClick={onOpenMemory} title={`记忆候选：${pendingMemoryCount} 条待确认`}>
          <Bot size={16} />
          {pendingMemoryCount > 0 && <b>{pendingMemoryCount}</b>}
        </button>
        <div className="trust-mode-control" aria-label="执行信任度">
          <Lock size={14} />
          <button
            className={session?.trustMode === 'strict' ? 'active' : ''}
            disabled={!session || updatingTrustMode}
            onClick={() => void onTrustModeChange('strict')}
            title="写操作和高风险工具需要确认"
          >
            严控核签
          </button>
          <button
            className={session?.trustMode === 'autopilot' ? 'active' : ''}
            disabled={!session || updatingTrustMode}
            onClick={() => void onTrustModeChange('autopilot')}
            title="允许 safe / write / dangerous 操作自动执行并记录审计"
          >
            信任执行
          </button>
        </div>
      </div>
    </header>
  );
}

function HeaderToolButton({
  icon,
  label,
  detail,
  onClick
}: {
  icon: JSX.Element;
  label: string;
  detail: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button className="header-tool-button" onClick={onClick}>
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <Settings size={13} />
    </button>
  );
}

function GatewayStrip({ status }: { status: BootstrapState['status'] }): JSX.Element {
  return (
    <div className="gateway-strip">
      <StatusPill ok={status.workspaceIndexReady} label="Workspace FTS" />
      <StatusPill ok={status.catalogAttached} label="catalog.db" />
      <StatusPill ok label="app.db" detail={status.appDbPath} />
    </div>
  );
}

function ActionStream({
  state,
  activeSession,
  optimisticMessages,
  streamingMessages,
  thinkingSessionId,
  activity,
  pendingApprovalIds,
  onDecideApproval
}: {
  state: BootstrapState;
  activeSession: Session | null;
  optimisticMessages: Message[];
  streamingMessages: Message[];
  thinkingSessionId: string | null;
  activity: { sessionId: string; label: string } | null;
  pendingApprovalIds: Set<string>;
  onDecideApproval: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): JSX.Element {
  const sessionMessages = useMemo(
    () =>
      activeSession
        ? [
            ...state.messages.filter((message) => message.sessionId === activeSession.id),
            ...optimisticMessages.filter((message) => message.sessionId === activeSession.id),
            ...streamingMessages.filter((message) => message.sessionId === activeSession.id)
          ]
        : [],
    [activeSession, state.messages, optimisticMessages, streamingMessages]
  );
  const sessionSteps = useMemo(
    () => (activeSession ? state.runSteps.filter((step) => step.sessionId === activeSession.id) : []),
    [activeSession, state.runSteps]
  );
  const pendingApprovals = useMemo(
    () =>
      activeSession
        ? state.approvalRequests.filter((approval) => approval.sessionId === activeSession.id && approval.status === 'pending')
        : [],
    [activeSession, state.approvalRequests]
  );
  const timelineItems = useMemo(
    () =>
      [
        ...sessionMessages.map((message) => ({ kind: 'message' as const, id: message.id, createdAt: message.createdAt, message })),
        ...sessionSteps.map((step) => ({ kind: 'step' as const, id: step.id, createdAt: step.createdAt, step })),
        ...pendingApprovals.map((approval) => ({ kind: 'approval' as const, id: approval.id, createdAt: approval.createdAt, approval }))
      ].sort((left, right) => left.createdAt - right.createdAt),
    [sessionMessages, sessionSteps, pendingApprovals]
  );
  const hasAnyOperationalData = useMemo(
    () => state.auditRows.length > 0 || state.scheduledTasks.length > 0 || sessionMessages.length > 0 || sessionSteps.length > 0,
    [state.auditRows.length, state.scheduledTasks.length, sessionMessages.length, sessionSteps.length]
  );

  if (!activeSession) {
    return (
      <div className="stream empty-stream">
        <ShieldAlert size={34} />
        <h2>等待建立安全会话</h2>
        <p>挂载 Workspace、配置 Profile 后，新建会话即可开始。这里不会显示示例操作。</p>
      </div>
    );
  }

  return (
    <div className="stream">
      {timelineItems.map((item) =>
        item.kind === 'message' ? (
          <MessageBubble key={item.id} message={item.message} />
        ) : item.kind === 'approval' ? (
          <ApprovalCard
            key={item.id}
            approval={item.approval}
            pending={pendingApprovalIds.has(item.approval.id)}
            onDecide={onDecideApproval}
          />
        ) : (
          <RunStepCard key={item.id} step={item.step} />
        )
      )}
      {thinkingSessionId === activeSession.id && (
        <ThinkingCard label={activity && activity.sessionId === activeSession.id ? activity.label : null} />
      )}
      {!hasAnyOperationalData && (
        <div className="quiet-note">
          真实本地库当前没有任务、审计或运行步骤记录。系统没有注入 mock 数据。
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  pending,
  onDecide
}: {
  approval: ApprovalRequest;
  pending: boolean;
  onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): JSX.Element {
  const params = parseApprovalParams(approval.paramsJson);
  return (
    <div className="run-step-card approval-card">
      <div>
        <strong>{approval.summary}</strong>
        <span>{approval.reason}</span>
        {params?.path && <p>{params.path}</p>}
        {params?.api && <p>{params.api}</p>}
      </div>
      <div className="approval-actions">
        <button className="tiny-action" disabled={pending} onClick={() => void onDecide(approval.id, 'reject')}>
          拒绝
        </button>
        <button className="tiny-action" disabled={pending} onClick={() => void onDecide(approval.id, 'approve')}>
          {pending ? <Loader2 className="spin" size={13} /> : '批准'}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }): JSX.Element {
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">{message.role === 'user' ? '用户' : message.role}</div>
      <div className="message-content">{message.content}</div>
      <time>{formatDateTime(message.createdAt)}</time>
    </div>
  );
}

function ThinkingCard({ label }: { label?: string | null }): JSX.Element {
  return (
    <div className="thinking-card">
      <Loader2 className="spin" size={17} />
      <div>
        <strong>正在执行</strong>
        <span>{label || '整理上下文、选择工具、等待 Gateway 返回...'}</span>
      </div>
      <div className="thinking-dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function RunStepCard({ step }: { step: RunStep }): JSX.Element {
  const detail = summarizeRunStepPayload(step.payloadJson);
  return (
    <div className="run-step-card">
      <div>
        <strong>{step.title}</strong>
        <span>{step.stepType}</span>
        {detail && <p>{detail}</p>}
      </div>
      <b>{step.status}</b>
    </div>
  );
}

function Composer({
  value,
  disabled,
  sending,
  canSend,
  onChange,
  onSend,
  onStop
}: {
  value: string;
  disabled: boolean;
  sending: boolean;
  canSend: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}): JSX.Element {
  return (
    <footer className="composer">
      <textarea
        value={value}
        disabled={disabled}
        placeholder={disabled ? '先创建会话' : '输入运维意图，使用 @ 引用本地文件'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (canSend) void onSend();
          }
        }}
      />
      {sending ? (
        <button className="send-button stop-button" title="停止本轮运行" onClick={() => void onStop()}>
          <Square size={15} />
        </button>
      ) : (
        <button className="send-button" disabled={!canSend} onClick={() => void onSend()}>
          <Send size={17} />
        </button>
      )}
    </footer>
  );
}

function ProfileModal({
  profile,
  notify,
  onClose,
  onSaved
}: {
  profile: Profile | null;
  notify: (tone: ToastTone, message: string) => void;
  onClose: () => void;
  onSaved: (profile: Profile) => void | Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(profile?.name ?? '');
  const [akId, setAkId] = useState('');
  const [secret, setSecret] = useState('');
  const [rdcId, setRdcId] = useState(profile?.rdcId ?? '');
  const [defaultRegion, setDefaultRegion] = useState(profile?.defaultRegion ?? '');

  async function save(): Promise<void> {
    try {
      const savedProfile = (await window.aliyAgent.saveProfile({
        id: profile?.id,
        name: name.trim(),
        akId,
        secret,
        rdcId,
        defaultRegion
      })) as Profile;
      notify('success', `已保存 Profile：${savedProfile.name}`);
      await onSaved(savedProfile);
    } catch (error) {
      notify('error', errorMessage(error, '保存 Profile 失败'));
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="profile-modal">
        <header>
          <div>
            <div className="caption">Profile Settings</div>
            <h2>{profile ? `[${profile.name}] 主体专属配置控制面板` : '新建主体专属配置控制面板'}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <nav className="modal-tabs">
            <button className="active">
              <KeyRound size={16} />
              阿里云凭证与环境
            </button>
            <button disabled>
              <Bot size={16} />
              专属代理记忆
            </button>
          </nav>
          <div className="form-grid">
            <label>
              Profile 名称
              <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label>
              AccessKey ID
              <input value={akId} onChange={(event) => setAkId(event.target.value)} placeholder={profile?.akIdMasked ?? ''} />
            </label>
            <label>
              AccessKey Secret
              <input value={secret} onChange={(event) => setSecret(event.target.value)} type="password" />
            </label>
            <label>
              云效组织 ID (organizationId)
              <input value={rdcId} onChange={(event) => setRdcId(event.target.value)} />
            </label>
            <label>
              默认解析地域
              <input value={defaultRegion} onChange={(event) => setDefaultRegion(event.target.value)} />
            </label>
            <p className="form-note">
              AK/SK 由主进程使用 Electron safeStorage 加密后保存；renderer 只显示脱敏值。OpenAPI 通过 SDK 直调，不依赖本机 aliyun CLI profile。
            </p>
          </div>
        </div>
        <footer>
          <button className="secondary-action" onClick={onClose}>
            取消
          </button>
          <button className="primary-action" disabled={!name.trim()} onClick={() => void save()}>
            保存并应用
          </button>
        </footer>
      </section>
    </div>
  );
}

function ModelModal({
  settings,
  notify,
  onClose,
  onSaved
}: {
  settings: LlmSettings;
  notify: (tone: ToastTone, message: string) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}): JSX.Element {
  const [provider, setProvider] = useState(settings.provider ?? 'openai');
  const [model, setModel] = useState(settings.model ?? '');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');

  async function save(): Promise<void> {
    try {
      await window.aliyAgent.saveLlmSettings({
        provider: provider.trim(),
        model: model.trim(),
        baseUrl,
        apiKey
      });
      notify('success', '已保存模型配置');
      await onSaved();
    } catch (error) {
      notify('error', errorMessage(error, '保存模型配置失败'));
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="profile-modal">
        <header>
          <div>
            <div className="caption">Model Runtime</div>
            <h2>大模型配置</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body single">
          <div className="form-grid">
            <label>
              Provider
              <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="openai" autoFocus />
            </label>
            <label>
              Model
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-4.1 / gpt-4.1-mini" />
            </label>
            <label>
              Base URL
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="默认使用官方 OpenAI endpoint" />
            </label>
            <label>
              API Key
              <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={settings.apiKeyMasked ?? ''} />
            </label>
            <p className="form-note">
              API Key 由主进程使用 Electron safeStorage 加密后保存；renderer 只显示脱敏值。发送消息会通过主进程调用 OpenAI Agents SDK。
            </p>
          </div>
        </div>
        <footer>
          <button className="secondary-action" onClick={onClose}>
            取消
          </button>
          <button className="primary-action" disabled={!provider.trim() || !model.trim()} onClick={() => void save()}>
            保存模型配置
          </button>
        </footer>
      </section>
    </div>
  );
}

function PanelHeader({ eyebrow, title, icon }: { eyebrow: string; title: string; icon: JSX.Element }): JSX.Element {
  return (
    <header className="panel-header">
      <div className="caption">{eyebrow}</div>
      <h2>
        {icon}
        {title}
      </h2>
    </header>
  );
}

function CatalogModal({
  status,
  notify,
  onClose,
  onRefreshed
}: {
  status: CatalogStatus;
  notify: (tone: ToastTone, message: string) => void;
  onClose: () => void;
  onRefreshed: () => void | Promise<void>;
}): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);

  async function refreshCatalog(): Promise<void> {
    setRefreshing(true);
    try {
      await window.aliyAgent.refreshCatalog();
      await onRefreshed();
      notify('success', 'catalog 已刷新');
    } catch (error) {
      notify('error', errorMessage(error, '刷新 catalog 失败'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="profile-modal">
        <header>
          <div>
            <div className="caption">Catalog Manager</div>
            <h2>接口事实库管理</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="catalog-details">
          <InfoRow label="状态" value={status.exists ? '已初始化' : '未初始化'} />
          <InfoRow label="路径" value={status.path} />
          <InfoRow label="Schema" value={status.schemaVersion || '未知'} />
          <InfoRow label="Spec Snapshot" value={status.specSnapshotDate || '未生成'} />
          <InfoRow label="产品数量" value={`${status.productCount}`} />
          <InfoRow label="Action 数量" value={`${status.actionCount}`} />
          <InfoRow label="最近刷新" value={status.refreshedAt ? formatFullDateTime(status.refreshedAt) : '尚未刷新'} />
          <InfoRow label="刷新结果" value={status.lastRefreshMessage || '无'} />
          <p className="form-note">
            当前刷新会从已安装的阿里云官方 SDK 抽取真实元数据并重建本地 catalog.db，不写入伪造产品数据。
          </p>
        </div>
        <footer>
          <button className="secondary-action" onClick={onClose}>
            关闭
          </button>
          <button className="primary-action" onClick={() => void refreshCatalog()} disabled={refreshing}>
            {refreshing ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
            主动刷新
          </button>
        </footer>
      </section>
    </div>
  );
}

function ScheduledTasksModal({
  tasks,
  executions,
  onClose
}: {
  tasks: ScheduledTask[];
  executions: TaskExecution[];
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<'business' | 'system'>('system');
  const visibleTasks = tasks.filter((task) => (tab === 'system' ? task.category === 'system' : task.category !== 'system'));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(visibleTasks[0]?.id ?? tasks[0]?.id ?? null);
  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0] ?? null;
  const selectedExecutions = selectedTask ? executions.filter((execution) => execution.taskId === selectedTask.id).slice(0, 8) : [];
  const script = selectedTask ? parseTaskScript(selectedTask.scriptBody) : null;

  return (
    <div className="modal-backdrop">
      <section className="profile-modal scheduler-modal">
        <header>
          <div>
            <div className="caption">Local Daemon</div>
            <h2>本地周期定时任务控制台</h2>
            <p>完全依赖本地常驻 Daemon 运行，运行时自动加载并配置所绑定的主体环境与云凭证。</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="scheduler-layout">
          <aside className="scheduler-list">
            <div className="scheduler-tabs">
              <button className={tab === 'business' ? 'active' : ''} onClick={() => setTab('business')}>
                业务运维定时任务
              </button>
              <button className={tab === 'system' ? 'active' : ''} onClick={() => setTab('system')}>
                软件系统自维护任务
              </button>
            </div>
            <div className="scheduler-task-list">
              {visibleTasks.length === 0 ? (
                <div className="scheduler-empty">当前分类还没有任务。</div>
              ) : (
                visibleTasks.map((task) => (
                  <button
                    className={`scheduler-task-card ${selectedTask?.id === task.id ? 'active' : ''}`}
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                  >
                    <span>
                      <strong>{task.name}</strong>
                      <small>{task.category} · {task.status}</small>
                    </span>
                    <b>{cronShortLabel(task.cronExpr)}</b>
                  </button>
                ))
              )}
            </div>
          </aside>
          <section className="scheduler-inspector">
            {selectedTask ? (
              <>
                <div className="inspector-title-row">
                  <div>
                    <span className="pill">{selectedTask.category === 'system' ? '系统自愈任务' : '业务运维任务'}</span>
                    <h3>{selectedTask.name}</h3>
                  </div>
                  <code>{selectedTask.cronExpr}</code>
                </div>
                <div className="inspector-card">
                  <h4>任务行为说明</h4>
                  <p>{script?.description || '未写入说明。'}</p>
                  <div className="inline-facts">
                    <span>状态：{selectedTask.status}</span>
                    <span>安全评级：{selectedTask.danger}</span>
                    <span>首次签署：{selectedTask.firstSignStatus}</span>
                  </div>
                </div>
                <div className="inspector-card">
                  <h4>Agent 提示词契约</h4>
                  <pre>{script?.agentPrompt || '该任务未声明 agentPrompt；系统会在下次启动时自动迁移。'}</pre>
                </div>
                <div className="inspector-card">
                  <h4>分析依据</h4>
                  <p>{script?.evidence || '未声明分析依据。'}</p>
                </div>
                <div className="inspector-card">
                  <h4>受限 Action Graph</h4>
                  <pre>{selectedTask.scriptBody}</pre>
                </div>
                <div className="inspector-card">
                  <h4>任务执行日志流</h4>
                  {selectedExecutions.length === 0 ? (
                    <p>暂无执行记录，Daemon 会在 cron 命中后写入 task_executions。</p>
                  ) : (
                    selectedExecutions.map((execution) => (
                      <div className="execution-row" key={execution.id}>
                        <time>{formatFullDateTime(execution.startedAt)}</time>
                        <strong className={execution.status === 'success' ? 'ok' : 'bad'}>{execution.status}</strong>
                        <span>{execution.summary || summarizeExecutionLog(execution.logJson)}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="scheduler-empty">没有可展示的定时任务。</div>
            )}
          </section>
        </div>
        <footer>
          <span className="scheduler-safety">本地安全性：系统任务仅执行白名单 action graph，不执行自由 JavaScript。</span>
          <button className="secondary-action" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function MemoryModal({
  candidates,
  pendingCandidateIds,
  onClose,
  onDecide
}: {
  candidates: MemoryCandidate[];
  pendingCandidateIds: Set<string>;
  onClose: () => void;
  onDecide: (candidateId: string, decision: 'approve' | 'reject') => Promise<void>;
}): JSX.Element {
  const pending = candidates.filter((candidate) => candidate.status === 'pending');
  const decided = candidates.filter((candidate) => candidate.status !== 'pending').slice(0, 20);

  return (
    <div className="modal-backdrop">
      <section className="profile-modal memory-modal">
        <header>
          <div>
            <div className="caption">Profile Memory</div>
            <h2>主体专属记忆确认</h2>
            <p>后台任务只生成候选；确认后才写入当前工作空间的 .agent-memory。</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="memory-review">
          <section className="inspector-card">
            <h4>待确认候选</h4>
            {pending.length === 0 ? (
              <p>暂无待确认记忆。系统任务会从历史会话中提取长期有效事实。</p>
            ) : (
              pending.map((candidate) => (
                <div className="memory-candidate" key={candidate.id}>
                  <p>{candidate.fact}</p>
                  <span>
                    来源：{formatFullDateTime(candidate.sourceMessageAt)} · fact-hash:{candidate.factHash}
                  </span>
                  <div className="approval-actions">
                    <button
                      className="tiny-action"
                      disabled={pendingCandidateIds.has(candidate.id)}
                      onClick={() => void onDecide(candidate.id, 'reject')}
                    >
                      拒绝
                    </button>
                    <button
                      className="tiny-action"
                      disabled={pendingCandidateIds.has(candidate.id)}
                      onClick={() => void onDecide(candidate.id, 'approve')}
                    >
                      {pendingCandidateIds.has(candidate.id) ? <Loader2 className="spin" size={13} /> : '写入记忆'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
          <section className="inspector-card">
            <h4>最近处理</h4>
            {decided.length === 0 ? (
              <p>还没有已处理候选。</p>
            ) : (
              decided.map((candidate) => (
                <div className="memory-candidate compact" key={candidate.id}>
                  <p>{candidate.fact}</p>
                  <span>
                    {candidate.status} · {candidate.decidedAt ? formatFullDateTime(candidate.decidedAt) : '未记录时间'}
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
        <footer>
          <span className="scheduler-safety">确认写入后，记忆会重新进入 workspace FTS，后续 Agent 可用 search_memory 接地。</span>
          <button className="secondary-action" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function SkillManagerModal({
  skills,
  selectedSkills,
  activeSession,
  installing,
  pendingSkillIds,
  onClose,
  onInstall,
  onOpenSkill,
  onSelect,
  onRemove
}: {
  skills: SkillSummary[];
  selectedSkills: SessionSkillPointer[];
  activeSession: Session | null;
  installing: boolean;
  pendingSkillIds: Set<string>;
  onClose: () => void;
  onInstall: () => void | Promise<void>;
  onOpenSkill: (skill: SkillSummary) => void | Promise<void>;
  onSelect: (skillId: string) => void | Promise<void>;
  onRemove: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const selectedIds = useMemo(() => new Set(selectedSkills.map((skill) => skill.id)), [selectedSkills]);

  return (
    <div className="modal-backdrop">
      <section className="profile-modal skills-manager-modal">
        <header>
          <div>
            <div className="caption">Skill Library</div>
            <h2>技能库管理</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="skills-manager">
          <div className="manager-toolbar">
            <div>
              <strong>{skills.length} 个已装载技能</strong>
              <span>{activeSession ? `${selectedSkills.length} 个已选入当前会话` : '当前没有活动会话'}</span>
            </div>
            <button className="primary-action" disabled={installing} onClick={() => void onInstall()}>
              {installing ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              从本地文件夹装载
            </button>
          </div>
          <div className="skills-table">
            {skills.length === 0 ? (
              <EmptyBox text="尚未装载 Skill 文件夹" />
            ) : (
              skills.map((skill) => {
                const selected = selectedIds.has(skill.id);
                const pendingSelect = pendingSkillIds.has(`select:${skill.id}`);
                const pendingRemove = pendingSkillIds.has(`remove:${skill.id}`);
                return (
                  <div className="skill-row" key={skill.id}>
                    <div>
                      <strong>{skill.title}</strong>
                      <span>{skill.description}</span>
                    </div>
                    <div className="skill-row-actions">
                      <button className="tiny-action" onClick={() => void onOpenSkill(skill)}>
                        <BookOpen size={13} />
                        查看
                      </button>
                      {selected ? (
                        <button className="tiny-action" disabled={!activeSession || pendingRemove} onClick={() => void onRemove(skill.id)}>
                          {pendingRemove ? <Loader2 className="spin" size={13} /> : '移出会话'}
                        </button>
                      ) : (
                        <button className="tiny-action" disabled={!activeSession || pendingSelect} onClick={() => void onSelect(skill.id)}>
                          {pendingSelect ? <Loader2 className="spin" size={13} /> : '选入会话'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <footer>
          <button className="secondary-action" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function SkillModal({
  skill,
  onClose
}: {
  skill: SkillDetail;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="modal-backdrop">
      <section className="profile-modal skill-modal">
        <header>
          <div>
            <div className="caption">Global Playbook</div>
            <h2>{skill.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="skill-details">
          <InfoRow label="描述" value={skill.description} />
          <InfoRow label="来源目录" value={skill.sourcePath || '未知'} />
          <InfoRow label="更新时间" value={formatFullDateTime(skill.updatedAt)} />
          <pre>{skill.body}</pre>
        </div>
        <footer>
          <button className="secondary-action" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function parseTaskScript(scriptBody: string): { description?: string; agentPrompt?: string; evidence?: string } | null {
  try {
    return JSON.parse(scriptBody) as { description?: string; agentPrompt?: string; evidence?: string };
  } catch {
    return null;
  }
}

function parseApprovalParams(paramsJson: string): { path?: string; api?: string } | null {
  try {
    const params = JSON.parse(paramsJson) as { path?: string; product?: string; action?: string; regionId?: string };
    if (params && typeof params.path === 'string') return { path: params.path };
    if (params && typeof params.product === 'string' && typeof params.action === 'string') {
      return { api: `${params.product}/${params.action}${params.regionId ? ` · ${params.regionId}` : ''}` };
    }
    return null;
  } catch {
    return null;
  }
}

function cronShortLabel(expr: string): string {
  const everyMinutes = expr.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMinutes) return `*/${everyMinutes[1]}`;
  return expr;
}

function summarizeExecutionLog(logJson: string): string {
  try {
    const logs = JSON.parse(logJson) as Array<{ message?: string }>;
    return logs.at(-1)?.message || '无摘要';
  } catch {
    return '无摘要';
  }
}

function ContextSection({
  icon,
  title,
  action,
  children
}: {
  icon: JSX.Element;
  title: string;
  action?: JSX.Element;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="context-section">
      <div className="context-section-head">
        <h3>
          {icon}
          {title}
        </h3>
        {action}
      </div>
      <div className="context-list">{children}</div>
    </section>
  );
}

function PointerRow({ title, meta, action }: { title: string; meta: string; action?: JSX.Element }): JSX.Element {
  return (
    <div className="pointer-row">
      <div>
        <strong>{title}</strong>
        {action}
      </div>
      <span>{meta}</span>
    </div>
  );
}

function SectionLabel({ icon, label }: { icon: JSX.Element; label: string }): JSX.Element {
  return (
    <div className="section-label">
      {icon}
      {label}
    </div>
  );
}

function EmptyBox({ text }: { text: string }): JSX.Element {
  return <div className="empty-box">{text}</div>;
}

function EmptyLine({ text }: { text: string }): JSX.Element {
  return <div className="empty-line">{text}</div>;
}

function StatusPill({ ok, label, detail }: { ok: boolean; label: string; detail?: string }): JSX.Element {
  return (
    <span className={ok ? 'status-pill ok' : 'status-pill warn'} title={detail}>
      {ok ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
      {label}
    </span>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button className={`toast ${toast.tone}`} key={toast.id} onClick={() => onDismiss(toast.id)}>
          <strong>{toast.tone === 'success' ? '成功' : '错误'}</strong>
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}

type CallChainGroup = {
  runId: string;
  steps: RunStep[];
  updatedAt: number;
  statusLabel: string;
};

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] };

function buildCallChainGroups(steps: RunStep[]): CallChainGroup[] {
  const grouped = new Map<string, RunStep[]>();
  for (const step of steps) {
    const existing = grouped.get(step.runId) ?? [];
    existing.push(step);
    grouped.set(step.runId, existing);
  }
  return [...grouped.entries()]
    .map(([runId, items]) => {
      const sorted = [...items].sort((left, right) => left.createdAt - right.createdAt);
      const latest = sorted.reduce((max, step) => Math.max(max, step.updatedAt, step.createdAt), 0);
      return {
        runId,
        steps: sorted,
        updatedAt: latest,
        statusLabel: callChainStatusLabel(sorted)
      };
    })
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

function callChainStatusLabel(steps: RunStep[]): string {
  if (steps.some((step) => step.status === 'awaiting_approval')) return '等待核签';
  if (steps.some((step) => step.status === 'running')) return '运行中';
  if (steps.some((step) => step.status === 'failed')) return '有失败步骤';
  return '已完成';
}

function stepNodeClass(step: RunStep): 'ok' | 'safe' | 'write' | 'err' {
  const detail = summarizeStepForTimeline(step);
  return detail.node;
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, text: heading[2] });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitMarkdownTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /\|/.test(lines[index] ?? '') && lines[index]?.trim()) {
        rows.push(splitMarkdownTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const parts: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^>\s?(.*)$/);
        if (!match) break;
        parts.push(match[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', text: parts.join('\n') });
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!match || /\d+\./.test(match[2]) !== ordered) break;
        items.push(match[3]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]?.trim() && !isMarkdownBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(line);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return /^```/.test(line) || /^#{1,4}\s+/.test(line) || /^>\s?/.test(line) || /^(\s*)([-*+]|\d+\.)\s+/.test(line) || isTableStart(lines, index);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const divider = lines[index + 1] ?? '';
  return /\|/.test(header) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${match.index}:${token}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a href={safeMarkdownHref(link[2])} key={key} rel="noreferrer" target="_blank">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  const withBreaks: ReactNode[] = [];
  nodes.forEach((node, index) => {
    if (typeof node !== 'string') {
      withBreaks.push(node);
      return;
    }
    const parts = node.split('\n');
    parts.forEach((part, partIndex) => {
      withBreaks.push(part);
      if (partIndex < parts.length - 1) withBreaks.push(<br key={`${index}:${partIndex}`} />);
    });
  });
  return withBreaks;
}

function safeMarkdownHref(href: string): string {
  return /^(https?:|mailto:)/i.test(href) ? href : '#';
}

function DangerTagPill({ danger }: { danger: DangerLevel }): JSX.Element {
  const kind = danger === 'dangerous' ? 'danger' : danger;
  return (
    <span className={`tag ${kind}`}>
      <span className="d" />
      {kind}
    </span>
  );
}

function isTimelineChatMessage(message: Message): boolean {
  return message.role === 'user' || message.role === 'assistant';
}

function trustModeToAgentMode(trustMode: TrustMode): AgentMode {
  return trustMode === 'strict' ? 'gate' : 'trust';
}

function agentModeToTrustMode(mode: AgentMode): TrustMode {
  return mode === 'gate' ? 'strict' : 'autopilot';
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function stepIcon(verb: 'discover' | 'resolve' | 'call' | 'note'): JSX.Element {
  if (verb === 'discover') return <Search />;
  if (verb === 'resolve') return <SlidersIcon />;
  if (verb === 'call') return <Link2 />;
  return <CheckCircle2 />;
}

function SlidersIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M4 12h10M4 17h7" />
    </svg>
  );
}

type TimelineStepSummary = {
  verb: 'discover' | 'resolve' | 'call' | 'note';
  verbLabel: string;
  node: 'ok' | 'safe' | 'write' | 'err';
  target: string;
  danger: DangerLevel | null;
  summary: string;
  code: string;
  candidates?: Array<{ name: string; picked: boolean }>;
};

function shouldShowTimelineStep(step: RunStep): boolean {
  if (step.stepType === 'tool_call' || step.stepType === 'awaiting_approval' || step.stepType === 'approval_resume') return true;
  return false;
}

function summarizeStepForTimeline(step: RunStep): TimelineStepSummary {
  const payload = parseJsonRecord(step.payloadJson);
  const stepType = step.stepType.toLowerCase();
  const status = step.status.toLowerCase();
  const product = stringValue(payload.product) ?? stringValue(nestedRecord(payload.result)?.product);
  const action = stringValue(payload.action) ?? stringValue(nestedRecord(payload.result)?.action);
  const query = stringValue(payload.query);
  const danger = dangerValue(payload.danger) ?? dangerValue(nestedRecord(payload.result)?.danger);
  const error = stringValue(payload.error) ?? stringValue(payload.errorMessage) ?? stringValue(nestedRecord(payload.result)?.errorMessage);
  const toolName = step.title;
  const target = timelineStepTarget(toolName, product, action, query, payload);
  const verb = timelineStepVerb(toolName, stepType, product);
  const node = error || status.includes('fail') || status.includes('error') ? 'err' : danger === 'safe' ? 'safe' : danger === 'write' || danger === 'dangerous' ? 'write' : 'ok';
  const verbLabel = timelineStepLabel(toolName, verb);
  const candidates = toolName === 'discover_api' ? discoverCandidates(payload) : undefined;
  return {
    verb,
    verbLabel,
    node,
    target,
    danger,
    summary: timelineStepSummaryText(step, payload, error),
    code: timelineStepDetailCode(step, payload),
    candidates
  };
}

function timelineStepVerb(toolName: string, stepType: string, product: string | null): TimelineStepSummary['verb'] {
  if (toolName === 'discover_api' || toolName.startsWith('search_') || toolName === 'list_workspace') return 'discover';
  if (toolName === 'get_api_params' || toolName === 'read_workspace_file' || toolName === 'load_skill' || stepType === 'awaiting_approval') {
    return 'resolve';
  }
  if (toolName === 'call_openapi' || toolName === 'approval_resume' || product) return 'call';
  return 'note';
}

function timelineStepLabel(toolName: string, verb: TimelineStepSummary['verb']): string {
  if (toolName === 'get_api_params') return 'get_params';
  if (toolName === 'approval_resume') return 'call_openapi';
  if (toolName === 'awaiting_approval') return 'get_params';
  if (toolName === 'discover_api' || toolName === 'call_openapi') return toolName;
  if (verb === 'discover') return 'discover_api';
  if (verb === 'resolve') return 'get_params';
  if (verb === 'call') return 'call_openapi';
  return 'agent_note';
}

function timelineStepTarget(
  toolName: string,
  product: string | null,
  action: string | null,
  query: string | null,
  payload: Record<string, unknown>
): string {
  if (product && action) return `${product} / ${action}`;
  if (toolName === 'discover_api') return query ? `catalog · ${query}` : 'catalog · 接口检索';
  if (toolName === 'list_workspace') return `workspace / ${stringValue(payload.path) ?? '.'}`;
  if (toolName === 'search_workspace') return query ? `workspace · ${query}` : 'workspace · 检索';
  if (toolName === 'read_workspace_file') return `workspace / ${stringValue(payload.path) ?? 'file'}`;
  if (toolName === 'search_memory') return query ? `memory · ${query}` : 'memory · 检索';
  if (toolName === 'search_skills') return query ? `playbooks · ${query}` : 'playbooks · 检索';
  if (toolName === 'load_skill') return `playbooks / ${stringValue(payload.title) ?? stringValue(payload.id) ?? 'skill'}`;
  if (toolName === 'awaiting_approval') return 'openapi / 等待核签';
  if (toolName === 'approval_resume') return 'openapi / 审批后继续执行';
  return toolName;
}

function timelineStepSummaryText(step: RunStep, payload: Record<string, unknown>, error: string | null): string {
  if (error) return error;
  if (step.status === 'failed') return '执行失败 · 可展开查看详情';
  if (step.title === 'discover_api') return `命中 ${numberValue(payload.resultCount) ?? 0} 个候选接口`;
  if (step.title === 'get_api_params') {
    const result = nestedRecord(payload.result);
    if (result && result.ok === false) return `${stringValue(result.errorCode) ?? '解析失败'} · ${stringValue(result.errorMessage) ?? '接口参数未解析'}`;
    const required = arrayValue(result?.required);
    return required.length > 0 ? `参数已就绪 · 必填 ${required.slice(0, 3).join('、')}` : '参数已就绪 · 接口事实已接地';
  }
  if (step.title === 'call_openapi') {
    const status = stringValue(payload.status) ?? step.status;
    const dryRun = payload.dryRun === true ? ' · dry_run' : '';
    return `${status}${dryRun}`;
  }
  if (step.title === 'list_workspace') return `列出 ${numberValue(payload.resultCount) ?? 0} 项`;
  if (step.title === 'search_workspace') return `命中 ${numberValue(payload.resultCount) ?? 0} 个文件`;
  if (step.title === 'read_workspace_file') return payload.ok === false ? '读取失败' : '文件已装载到上下文';
  if (step.title === 'search_memory') return `命中 ${numberValue(payload.resultCount) ?? 0} 条记忆`;
  if (step.title === 'search_skills') return `命中 ${numberValue(payload.resultCount) ?? 0} 个 Playbook`;
  if (step.title === 'load_skill') return `已读取 ${stringValue(payload.title) ?? 'Playbook'}`;
  if (step.stepType === 'awaiting_approval') return '参数已就绪 · 等待核签后调用';
  if (step.stepType === 'approval_resume') return step.status === 'completed' ? '审批后运行完成' : '审批后继续运行';
  return step.status;
}

function timelineStepDetailCode(step: RunStep, payload: Record<string, unknown>): string {
  if (step.title === 'get_api_params') {
    const result = nestedRecord(payload.result);
    return keyValueLines({
      Product: stringValue(payload.product),
      Action: stringValue(payload.action),
      Version: stringValue(payload.version) ?? stringValue(result?.version),
      Danger: dangerValue(result?.danger),
      Required: arrayValue(result?.required).join(', ') || null
    });
  }
  if (step.title === 'call_openapi') {
    return keyValueLines({
      Product: stringValue(payload.product),
      Action: stringValue(payload.action),
      Version: stringValue(payload.version),
      RegionId: stringValue(payload.regionId),
      DryRun: payload.dryRun === undefined ? null : String(Boolean(payload.dryRun)),
      Status: stringValue(payload.status),
      ErrorCode: stringValue(payload.errorCode),
      ErrorMessage: stringValue(payload.errorMessage)
    });
  }
  if (step.stepType === 'awaiting_approval') {
    return keyValueLines({
      ApprovalId: stringValue(payload.approvalId),
      Product: stringValue(payload.product),
      Action: stringValue(payload.action),
      Danger: dangerValue(payload.danger)
    });
  }
  if (step.stepType === 'approval_resume') {
    return keyValueLines({
      ApprovalId: stringValue(payload.approvalId),
      Decision: stringValue(payload.decision),
      ToolCallId: stringValue(payload.toolCallId),
      FinalOutputLength: numberValue(payload.finalOutputLength)?.toString()
    });
  }
  return keyValueLines(payload) || prettyPayload(step.payloadJson);
}

function discoverCandidates(payload: Record<string, unknown>): Array<{ name: string; picked: boolean }> {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .map((item, index) => {
      const row = nestedRecord(item);
      const product = stringValue(row?.product);
      const action = stringValue(row?.action);
      return action ? { name: product ? `${product} / ${action}` : action, picked: index < 2 } : null;
    })
    .filter((item): item is { name: string; picked: boolean } => Boolean(item));
}

function keyValueLines(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key.padEnd(16, ' ')} ${String(value)}`)
    .join('\n');
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function approvalToGate(approval: ApprovalRequest): {
  api: string;
  version: string | null;
  region: string | null;
  params: Array<[string, string, boolean]>;
} {
  const params = parseJsonRecord(approval.paramsJson);
  const provenance = parseJsonRecord(approval.provenanceJson);
  const product = stringValue(params.product) ?? stringValue(provenance.product);
  const action = stringValue(params.action) ?? stringValue(provenance.action);
  const path = stringValue(params.path);
  const version = stringValue(params.version) ?? stringValue(provenance.version);
  const region = stringValue(params.regionId) ?? stringValue(params.region) ?? stringValue(provenance.regionId);
  const api = product && action ? `${product} / ${action}` : path ?? approval.summary;
  const requestParams = nestedRecord(params.params);
  const baseRows: Array<[string, unknown]> = [
    ['RegionId', region],
    ['Endpoint', params.endpoint]
  ];
  const requestRows = requestParams ? Object.entries(requestParams) : [];
  const fallbackRows = Object.entries(params).filter(([key]) => !['kind', 'profileId', 'profileName', 'product', 'action', 'version', 'regionId', 'endpoint', 'params'].includes(key));
  const sourceRows = requestRows.length > 0 ? [...baseRows, ...requestRows] : [...baseRows, ...fallbackRows];
  const rows = sourceRows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]): [string, string, boolean] => [key, formatApprovalValue(value, key), shouldMaskKey(key)])
    .slice(0, 18);
  return { api, version, region, params: rows };
}

function groupCatalogFacts(facts: CatalogFactPointer[]): Array<{ product: string; facts: CatalogFactPointer[] }> {
  const groups = new Map<string, CatalogFactPointer[]>();
  for (const fact of facts) {
    const existing = groups.get(fact.product) ?? [];
    existing.push(fact);
    groups.set(fact.product, existing);
  }
  return [...groups.entries()].map(([product, items]) => ({
    product,
    facts: items.sort((left, right) => left.action.localeCompare(right.action))
  }));
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function dangerValue(value: unknown): DangerLevel | null {
  if (value === 'safe' || value === 'write' || value === 'dangerous') return value;
  if (value === 'danger') return 'dangerous';
  return null;
}

function prettyPayload(payloadJson: string): string {
  try {
    return JSON.stringify(JSON.parse(payloadJson) as unknown, null, 2);
  } catch {
    return payloadJson || '无详细 payload';
  }
}

function shouldMaskKey(key: string): boolean {
  return /secret|password|token|key|credential/i.test(key);
}

function formatApprovalValue(value: unknown, key: string): string {
  if (shouldMaskKey(key) && typeof value === 'string' && value.length > 4) return `${value.slice(0, 4)}••••`;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return shouldMaskKey(key) ? '••••' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function readTweaks(): UiTweaks {
  try {
    const raw = window.localStorage.getItem(TWEAK_STORAGE_KEY);
    if (!raw) return { ...TWEAK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UiTweaks>;
    return {
      accent: parsed.accent && ACCENT_MAP[parsed.accent] ? parsed.accent : TWEAK_DEFAULTS.accent,
      defaultMode: parsed.defaultMode === 'trust' ? 'trust' : 'gate',
      density: parsed.density === 'compact' ? 'compact' : 'regular'
    };
  } catch {
    return { ...TWEAK_DEFAULTS };
  }
}

function writeTweaks(value: UiTweaks): void {
  try {
    window.localStorage.setItem(TWEAK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // UI tweaks are local presentation preferences only.
  }
}

function readStoredId(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function writeStoredId(key: string, value: string | null): void {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Local storage is a convenience only; DB state remains authoritative.
  }
}

function upsertById<T extends { id: string }>(
  items: T[],
  nextItem: T,
  sortKey: keyof T = 'createdAt' as keyof T,
  sortDirection: 'asc' | 'desc' = 'asc'
): T[] {
  const nextItems = items.some((item) => item.id === nextItem.id)
    ? items.map((item) => (item.id === nextItem.id ? nextItem : item))
    : [...items, nextItem];
  return nextItems.sort((left, right) => {
    const leftValue = Number(left[sortKey] ?? 0);
    const rightValue = Number(right[sortKey] ?? 0);
    return sortDirection === 'asc' ? leftValue - rightValue : rightValue - leftValue;
  });
}

function upsertStreamingMessage(
  messages: Message[],
  event: { sessionId: string; runId: string; delta: string; createdAt: number }
): Message[] {
  const id = `streaming-${event.runId}`;
  const existing = messages.find((message) => message.id === id);
  if (!existing) {
    return [
      ...messages,
      {
        id,
        sessionId: event.sessionId,
        role: 'assistant',
        content: event.delta,
        runId: event.runId,
        createdAt: event.createdAt
      }
    ];
  }
  return messages.map((message) =>
    message.id === id ? { ...message, content: `${message.content}${event.delta}`, createdAt: event.createdAt } : message
  );
}

function upsertContextDocument(items: ContextDocumentPointer[], nextItem: ContextDocumentPointer): ContextDocumentPointer[] {
  const key = (item: ContextDocumentPointer): string => `${item.sessionId}:${item.runId}:${item.path}`;
  return upsertByKey(items, nextItem, key, 'usedAt');
}

function upsertCatalogFact(items: CatalogFactPointer[], nextItem: CatalogFactPointer): CatalogFactPointer[] {
  const key = (item: CatalogFactPointer): string => `${item.sessionId}:${item.runId}:${item.product}:${item.action}:${item.version}`;
  return upsertByKey(items, nextItem, key, 'updatedAt');
}

function upsertByKey<T>(items: T[], nextItem: T, getKey: (item: T) => string, sortKey: keyof T): T[] {
  const nextKey = getKey(nextItem);
  const nextItems = items.some((item) => getKey(item) === nextKey)
    ? items.map((item) => (getKey(item) === nextKey ? nextItem : item))
    : [...items, nextItem];
  return nextItems.sort((left, right) => Number(right[sortKey] ?? 0) - Number(left[sortKey] ?? 0));
}

function withoutSetItem<T>(items: Set<T>, item: T): Set<T> {
  const nextItems = new Set(items);
  nextItems.delete(item);
  return nextItems;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatFullDateTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function summarizeRunStepPayload(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as {
      note?: string;
      selectedSkillCount?: number;
      selectedSkills?: string[];
      recentMessageCount?: number;
      goal?: string;
      policy?: string;
      expectedTools?: string[];
      model?: string | null;
      baseUrl?: string | null;
      maxTurns?: number;
      tools?: string[];
      query?: string;
      resultCount?: number;
      product?: string;
      action?: string;
      version?: string | null;
      regionId?: string | null;
      dryRun?: boolean;
      status?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
      result?: {
        ok?: boolean;
        product?: string;
        action?: string;
        version?: string;
        danger?: string;
        required?: string[];
        errorCode?: string | null;
        errorMessage?: string | null;
      };
      finalOutputLength?: number;
      error?: string;
    };
    if (payload.error) return payload.error;
    if (payload.goal) {
      const tools = payload.expectedTools?.length ? `工具：${payload.expectedTools.join(' -> ')}` : '';
      return [`目标：${payload.goal}`, payload.policy, tools].filter(Boolean).join('；');
    }
    if (typeof payload.selectedSkillCount === 'number') {
      const names = payload.selectedSkills?.length ? `：${payload.selectedSkills.join('、')}` : '';
      return `已读取 ${payload.recentMessageCount ?? 0} 条最近消息，选入 ${payload.selectedSkillCount} 个技能${names}`;
    }
    if (payload.model) {
      const tools = payload.tools?.length ? ` · 工具 ${payload.tools.join('、')}` : '';
      return `模型 ${payload.model}${payload.baseUrl ? ` · ${payload.baseUrl}` : ''}${payload.maxTurns ? ` · maxTurns ${payload.maxTurns}` : ''}${tools}`;
    }
    if (payload.query && typeof payload.resultCount === 'number') return `搜索 "${payload.query}"，命中 ${payload.resultCount} 个候选接口`;
    if (payload.result) {
      if (payload.result.ok) {
        const required = payload.result.required?.length ? `，必填 ${payload.result.required.join('、')}` : '';
        return `解析为 ${payload.result.product}/${payload.result.action}/${payload.result.version}，danger=${payload.result.danger}${required}`;
      }
      return `${payload.result.errorCode || '解析失败'}：${payload.result.errorMessage || '无错误消息'}`;
    }
    if (payload.product && payload.action) {
      const region = payload.regionId ? ` · region ${payload.regionId}` : '';
      const version = payload.version ? ` · version ${payload.version}` : '';
      const dryRun = payload.dryRun ? ' · dry-run' : '';
      const status = payload.status ? ` · ${payload.status}` : '';
      const error = payload.errorCode ? ` · ${payload.errorCode}: ${payload.errorMessage || ''}` : '';
      return `${payload.product}/${payload.action}${version}${region}${dryRun}${status}${error}`;
    }
    if (typeof payload.finalOutputLength === 'number') return `回答长度 ${payload.finalOutputLength} 字符`;
    return payload.note ?? null;
  } catch {
    return null;
  }
}
