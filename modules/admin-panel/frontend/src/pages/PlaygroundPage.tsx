import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { SampleLibraryPanel } from '@/components/SampleLibraryPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { ResizableSplit } from '@/components/ui/resizable-split';
import { PageShell } from '@/components/console/PageShell';
import {
  createPlaygroundToolDefinition,
  derivePlaygroundModelOverride,
  duplicatePlaygroundToolDefinition,
  getPromptDefaultModelName,
  getPlaygroundToolDefinitionName,
  normalizePlaygroundTools,
  PLAYGROUND_PROVIDER_MODEL_OPTIONS,
} from '@/lib/playground-models';
import {
  asRecord,
  createDefaultPlaygroundProviderConfig,
  getPlaygroundProviderId,
  getPlaygroundProviderSpecific,
  normalizePlaygroundProviderConfig,
  parseMaybeJson,
  resolvePromptProviderConfig,
  withPlaygroundProviderId,
  withPlaygroundProviderSpecific,
} from '@/lib/provider-config';
import { formatConfiguredValue, formatReturnedValue } from '@/lib/contract-display';
import { cn, formatTimestamp } from '@/lib/utils';
import {
  clonePlaygroundRun,
  createCaseFromTraffic,
  createPlaygroundRun,
  fetchPlaygroundCase,
  fetchPlaygroundLibrary,
  fetchPlaygroundRuns,
  updatePlaygroundCase,
} from '@/lib/playgroundApi';
import type {
  PlaygroundBaselineOutput,
  PlaygroundCase,
  PlaygroundPromptInput,
  PlaygroundPromptMode,
  PlaygroundProviderConfig,
  PlaygroundRun,
} from '@/types/playground';
import {
  Database,
  FileJson2,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  AlertCircle,
  Copy,
  Wand2,
  Plus,
  Trash2,
} from 'lucide-react';

type PromptSummary = {
  id: string;
  prompt_name: string;
  model_name?: string | null;
  system_instructions?: unknown;
  user_prompt_template?: string | null;
  context_variables?: unknown;
  model_config?: unknown;
  advanced_config?: unknown;
};

type OutputView = 'text' | 'tool' | 'raw';
type DesktopWindowId = 'params' | 'compare';
type DesktopWindowState = { collapsed: boolean };

type ToolCallPreview = {
  name: string;
  status?: string;
  provider?: string;
  modelName?: string;
  arguments?: unknown;
  result?: unknown;
  raw?: unknown;
};

type ToolEditorEntry = {
  key: string;
  label: string;
  value: unknown;
  onChange: (nextText: string) => void;
};

function parseJsonText<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function isJsonTextValid(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function parsePromptSystemInstruction(value: unknown): string {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join('\n\n');
  }

  return typeof parsed === 'string' ? parsed : '';
}

function parsePromptContextVariables(value: unknown): Record<string, unknown> {
  const parsed = parseMaybeJson(value);
  return asRecord(parsed) || {};
}

function normalizeOptionalModelName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickFirstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function getToolEditorKeys(tools: Record<string, unknown> | undefined): string[] {
  const normalized = normalizePlaygroundTools(tools);
  return [
    ...normalized.definitions.map((_, index) => `definitions:${index}`),
    'toolChoice',
  ];
}

function findToolCallCandidate(value: unknown, depth = 0): ToolCallPreview | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findToolCallCandidate(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const functionCall = asRecord(record.functionCall);
  if (functionCall && typeof functionCall.name === 'string') {
    return {
      name: functionCall.name,
      arguments: parseMaybeJson(functionCall.args),
      result: pickFirstDefined(record.result, record.output, record.response, record.functionResponse),
      raw: record,
    };
  }

  if (Array.isArray(record.functionCalls) && record.functionCalls.length > 0) {
    const first = asRecord(record.functionCalls[0]);
    if (first && typeof first.name === 'string') {
      return {
        name: first.name,
        arguments: parseMaybeJson(first.args),
        result: pickFirstDefined(record.result, record.output, record.response),
        raw: record,
      };
    }
  }

  if (record.type === 'function_call' && typeof record.name === 'string') {
    return {
      name: record.name,
      status: typeof record.status === 'string' ? record.status : undefined,
      arguments: parseMaybeJson(record.arguments),
      result: pickFirstDefined(record.result, record.output, record.response),
      raw: record,
    };
  }

  if (typeof record.toolName === 'string') {
    return {
      name: record.toolName,
      status: typeof record.status === 'string' ? record.status : undefined,
      arguments: pickFirstDefined(record.arguments, record.args, record.input),
      result: pickFirstDefined(record.result, record.output, record.response),
      raw: record,
    };
  }

  const outputItems = Array.isArray(record.output) ? record.output : Array.isArray(record.items) ? record.items : null;
  if (outputItems) {
    for (const item of outputItems) {
      const nested = findToolCallCandidate(item, depth + 1);
      if (nested) return nested;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findToolCallCandidate(nestedValue, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function inferToolCall(run: PlaygroundRun | null): ToolCallPreview | null {
  if (!run?.outputSnapshot) {
    return null;
  }

  const candidates = [
    run.outputSnapshot.metadata,
    run.outputSnapshot.rawResponse,
    run.outputSnapshot.canonicalResponse,
    run.outputSnapshot.wireResponse,
    run.outputSnapshot.canonicalRequest,
    run.outputSnapshot.wireRequest,
  ];

  for (const candidate of candidates) {
    const preview = findToolCallCandidate(candidate);
    if (preview) {
      return {
        ...preview,
        status: preview.status || run.status,
        provider: preview.provider || run.outputSnapshot.provider || run.provider || undefined,
        modelName: preview.modelName || run.outputSnapshot.modelName || run.modelName || undefined,
      };
    }
  }

  return null;
}

function getRawProviderPayload(run: PlaygroundRun | null): unknown {
  if (!run?.outputSnapshot) {
    return null;
  }

  return pickFirstDefined(
    run.outputSnapshot.rawResponse,
    run.outputSnapshot.canonicalResponse,
    run.outputSnapshot.wireResponse,
    run.outputSnapshot.metadata,
    run.outputSnapshot.canonicalRequest,
    run.outputSnapshot.wireRequest
  );
}

function getPrimaryUserMessage(messages: PlaygroundPromptInput['messages']): string {
  return messages.find((message) => message.role === 'user')?.content || '';
}

function buildPromptPreview(
  promptMode: PlaygroundPromptMode,
  draftSystemInstruction: string,
  draftUserPromptTemplate: string,
  promptInput: PlaygroundPromptInput
): string {
  const parts = [
    `mode: ${promptMode}`,
    '',
    'system:',
    promptMode === 'draft' ? draftSystemInstruction || promptInput.systemInstruction : promptInput.systemInstruction,
    '',
    'messages:',
    ...promptInput.messages.map((message) => `[${message.role}] ${message.content}`),
  ];

  if (promptMode === 'draft' && draftUserPromptTemplate) {
    parts.push('', 'draft_template:', draftUserPromptTemplate);
  }

  return parts.join('\n');
}

function JsonBlock({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'overflow-auto rounded-2xl border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-6 text-foreground',
        className
      )}
    >
      {typeof value === 'string' ? value : stringifyJson(value)}
    </pre>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-2 text-xs leading-6 text-muted-foreground">{description}</div>
    </div>
  );
}

const DEFAULT_PROVIDER_CONFIG: PlaygroundProviderConfig = createDefaultPlaygroundProviderConfig('google-gemini-cli');

const DEFAULT_PROMPT_INPUT: PlaygroundPromptInput = {
  systemInstruction: '',
  messages: [{ role: 'user', content: '' }],
  contextVariables: {},
};

const DEFAULT_DESKTOP_WINDOWS: Record<DesktopWindowId, DesktopWindowState> = {
  params: { collapsed: false },
  compare: { collapsed: true },
};

export function PlaygroundPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [promptMode, setPromptMode] = useState<PlaygroundPromptMode>('draft');
  const [promptId, setPromptId] = useState<string | null>(searchParams.get('promptId'));
  const [promptInput, setPromptInput] = useState<PlaygroundPromptInput>(DEFAULT_PROMPT_INPUT);
  const [providerConfig, setProviderConfig] = useState<PlaygroundProviderConfig>(DEFAULT_PROVIDER_CONFIG);
  const [providerSelectionDirty, setProviderSelectionDirty] = useState(false);
  const [modelOverrideText, setModelOverrideText] = useState('');
  const [draftSystemInstruction, setDraftSystemInstruction] = useState('');
  const [draftUserPromptTemplate, setDraftUserPromptTemplate] = useState('');
  const [contextVariablesText, setContextVariablesText] = useState(stringifyJson({}));
  const [providerSpecificText, setProviderSpecificText] = useState(stringifyJson({}));
  const [safetyText, setSafetyText] = useState(stringifyJson([]));
  const [toolEditorTexts, setToolEditorTexts] = useState<Record<string, string>>({});
  const [outputView, setOutputView] = useState<OutputView>('text');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryActionError, setLibraryActionError] = useState<string | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [mobileParamsOpen, setMobileParamsOpen] = useState(false);
  const [mobileCompareOpen, setMobileCompareOpen] = useState(false);
  const [desktopWindows, setDesktopWindows] = useState(DEFAULT_DESKTOP_WINDOWS);
  const [comparePromptIds, setComparePromptIds] = useState<string[]>([]);
  const [expandedToolKey, setExpandedToolKey] = useState<string | null>(null);
  const [editorView, setEditorView] = useState<'prompt' | 'preview'>('prompt');
  const [editorEmptyStateDismissed, setEditorEmptyStateDismissed] = useState(false);
  const [isDesktopLayout, setIsDesktopLayout] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 1024));
  const bootstrappedRef = useRef(false);

  const { data: promptData } = useQuery({
    queryKey: ['prompts'],
    queryFn: async () => {
      const response = await fetch('/api/prompts');
      const payload = await response.json();
      if (!response.ok || payload.success !== true) {
        throw new Error(payload.message || payload.error || 'Failed to fetch prompts');
      }
      return payload.data as PromptSummary[];
    },
  });

  const libraryQuery = useQuery({
    queryKey: ['playground-library', librarySearch, promptId],
    queryFn: () => fetchPlaygroundLibrary(librarySearch, promptId),
  });

  const selectedCaseQuery = useQuery({
    queryKey: ['playground-case', selectedCaseId],
    queryFn: () => fetchPlaygroundCase(selectedCaseId!),
    enabled: Boolean(selectedCaseId),
  });

  const runsQuery = useQuery({
    queryKey: ['playground-runs', selectedCaseId],
    queryFn: () => fetchPlaygroundRuns(selectedCaseId!),
    enabled: Boolean(selectedCaseId),
  });
  const prompts = promptData || [];

  const createFromTrafficMutation = useMutation({
    mutationFn: (trafficId: number) => createCaseFromTraffic(trafficId, promptId),
    onMutate: () => {
      setLibraryActionError(null);
    },
    onSuccess: (record) => {
      setSelectedCaseId(record.id);
      setLibraryOpen(false);
      setLibraryActionError(null);
      queryClient.invalidateQueries({ queryKey: ['playground-library'] });
    },
    onError: (error) => {
      setLibraryActionError(error instanceof Error ? error.message : '无法从该 traffic sample 创建 Playground Case');
    },
  });

  const updateCaseMutation = useMutation({
    mutationFn: (payload: Partial<PlaygroundCase>) => updatePlaygroundCase(selectedCaseId!, payload),
    onSuccess: (record) => {
      queryClient.setQueryData(['playground-case', record.id], record);
      queryClient.invalidateQueries({ queryKey: ['playground-library'] });
    },
  });

  const runMutation = useMutation({
    onMutate: () => {
      setLibraryActionError(null);
    },
    mutationFn: () =>
      createPlaygroundRun({
        caseId: selectedCaseId!,
        promptMode,
        promptId,
        providerConfig: buildCurrentProviderConfig(),
        promptInput: buildCurrentPromptInput(),
        draftPrompt: {
          systemInstruction: draftSystemInstruction,
          userPromptTemplate: draftUserPromptTemplate,
          contextVariables: parseJsonText<Record<string, unknown>>(contextVariablesText, {}),
        },
      }),
    onSuccess: (run) => {
      setActiveRunId(run.id);
      queryClient.invalidateQueries({ queryKey: ['playground-runs', selectedCaseId] });
      queryClient.invalidateQueries({ queryKey: ['playground-library'] });
    },
    onError: (error) => {
      setLibraryActionError(error instanceof Error ? error.message : 'Playground 运行失败');
    },
  });

  const cloneRunMutation = useMutation({
    mutationFn: (runId: string) => clonePlaygroundRun(runId),
    onMutate: () => {
      setLibraryActionError(null);
    },
    onSuccess: (run) => {
      setSelectedCaseId(run.caseId);
      setActiveRunId(run.id);
      setLibraryActionError(null);
      queryClient.invalidateQueries({ queryKey: ['playground-runs', run.caseId] });
      queryClient.invalidateQueries({ queryKey: ['playground-library'] });
    },
    onError: (error) => {
      setLibraryActionError(error instanceof Error ? error.message : '无法克隆该 Playground Run');
    },
  });

  useEffect(() => {
    const handleResize = () => {
      setIsDesktopLayout(window.innerWidth >= 1024);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const importError = searchParams.get('importError');
    if (importError) {
      setLibraryActionError(importError);
    }
  }, [searchParams]);

  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }

    const caseId = searchParams.get('caseId');
    const trafficId = searchParams.get('trafficId');
    if (caseId) {
      bootstrappedRef.current = true;
      setSelectedCaseId(caseId);
      return;
    }

    if (trafficId) {
      bootstrappedRef.current = true;
      createFromTrafficMutation.mutate(Number(trafficId));
      return;
    }
  }, [createFromTrafficMutation, searchParams]);

  useEffect(() => {
    const currentCase = selectedCaseQuery.data;
    if (!currentCase) {
      return;
    }

    const currentPromptId = currentCase.promptId || searchParams.get('promptId');
    const currentPrompt = prompts.find((prompt) => prompt.id === currentPromptId) || null;

    setPromptMode(currentCase.promptModeDefault);
    setPromptId(currentPromptId);
    setPromptInput(currentCase.promptInput);
    const promptResolvedProviderConfig = currentPrompt ? resolvePromptProviderConfig(currentPrompt) : null;
    const normalizedProviderConfig = normalizePlaygroundProviderConfig(
      currentCase.providerConfig || promptResolvedProviderConfig || DEFAULT_PROVIDER_CONFIG,
      promptResolvedProviderConfig ? getPlaygroundProviderId(promptResolvedProviderConfig) : undefined
    );
    setProviderConfig(normalizedProviderConfig);
    setProviderSelectionDirty(false);
    setModelOverrideText(derivePlaygroundModelOverride(normalizedProviderConfig, currentPrompt));
    setDraftSystemInstruction(currentCase.promptInput.systemInstruction || '');
    setDraftUserPromptTemplate('');
    setContextVariablesText(stringifyJson(currentCase.promptInput.contextVariables || {}));
    setProviderSpecificText(stringifyJson(getPlaygroundProviderSpecific(normalizedProviderConfig)));
    setSafetyText(stringifyJson(currentCase.providerConfig.safety || []));
    setToolEditorTexts({});
    const toolKeys = getToolEditorKeys(currentCase.providerConfig.tools);
    setExpandedToolKey(toolKeys[0] || null);
    setActiveRunId(null);
  }, [prompts, searchParams, selectedCaseQuery.data]);

  const runs = runsQuery.data || [];
  const currentRun = useMemo<PlaygroundRun | null>(() => {
    if (runs.length === 0) {
      return null;
    }
    return runs.find((run) => run.id === activeRunId) || runs[0];
  }, [activeRunId, runs]);
  const baselineSnapshot = selectedCaseQuery.data?.baselineSnapshot || null;
  const currentExecutionMode = currentRun?.executionMode
    || (selectedCaseQuery.data?.source === 'span' ? 'exact_replay' : null);

  const toolCall = useMemo(() => inferToolCall(currentRun), [currentRun]);
  const rawProviderPayload = useMemo(() => getRawProviderPayload(currentRun), [currentRun]);

  useEffect(() => {
    if (toolCall) {
      setOutputView('tool');
      return;
    }
    if (currentRun?.outputSnapshot?.responseText || currentRun?.outputSnapshot?.error) {
      setOutputView('text');
      return;
    }
    if (rawProviderPayload) {
      setOutputView('raw');
    }
  }, [currentRun, rawProviderPayload, toolCall]);

  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => prompt.id === promptId) || null,
    [promptId, prompts]
  );
  const promptDefaultModel = useMemo(
    () => getPromptDefaultModelName(selectedPrompt),
    [selectedPrompt]
  );
  const modelOverride = modelOverrideText.trim();
  const hasModelOverride = modelOverride.length > 0;
  const providerId = getPlaygroundProviderId(providerConfig);
  const effectiveModelName = hasModelOverride
    ? modelOverride
    : promptDefaultModel || null;
  const effectiveModelSource = hasModelOverride
    ? 'override'
    : promptDefaultModel
      ? 'prompt-default'
      : 'unconfigured';
  const effectiveModelSourceLabel = effectiveModelSource === 'override'
    ? 'Playground override'
    : effectiveModelSource === 'prompt-default'
      ? 'Prompt default'
      : '未配置';
  const presetModelOptions = PLAYGROUND_PROVIDER_MODEL_OPTIONS[providerId] || [];
  const modelPresetValue = hasModelOverride
    ? (presetModelOptions.includes(modelOverride) ? modelOverride : '__custom__')
    : '__inherit__';
  const comparePromptOptions = prompts.filter((prompt) => prompt.id !== promptId);

  const currentPromptText =
    promptMode === 'draft' ? draftSystemInstruction : promptInput.systemInstruction;
  const isImportingCase = createFromTrafficMutation.isPending;
  const isCaseReady = Boolean(selectedCaseId);
  const isDraftOnly = !isCaseReady && (editorEmptyStateDismissed || currentPromptText.trim().length > 0);
  const showStartupState = !isCaseReady && !isDraftOnly;
  const showEditorEmptyState = editorView === 'prompt' && !selectedCaseId && !currentPromptText.trim() && !editorEmptyStateDismissed;
  const libraryErrorMessage =
    libraryActionError || (libraryQuery.error instanceof Error ? libraryQuery.error.message : null);

  const buildCurrentPromptInput = (): PlaygroundPromptInput => ({
    ...promptInput,
    systemInstruction: promptMode === 'draft' ? draftSystemInstruction : promptInput.systemInstruction,
    contextVariables: parseJsonText<Record<string, unknown>>(contextVariablesText, {}),
  });

  const buildCurrentProviderConfig = (): PlaygroundProviderConfig => {
    const promptResolvedProviderConfig = selectedPrompt ? resolvePromptProviderConfig(selectedPrompt) : null;
    const fallbackProvider = promptResolvedProviderConfig
      ? getPlaygroundProviderId(promptResolvedProviderConfig)
      : undefined;
    const persistedProviderConfig = selectedCaseQuery.data?.providerConfig || null;
    const normalizedStateConfig = normalizePlaygroundProviderConfig(providerConfig, fallbackProvider);
    const normalizedPersistedConfig = persistedProviderConfig
      ? normalizePlaygroundProviderConfig(persistedProviderConfig, fallbackProvider)
      : null;
    const normalizedBaseConfig = normalizedPersistedConfig || normalizedStateConfig;
    const explicitModelOverride = normalizeOptionalModelName(modelOverrideText);
    const effectiveModelName = explicitModelOverride
      || normalizedBaseConfig.model.name
      || promptDefaultModel
      || null;
    const effectiveProvider = providerSelectionDirty
      ? normalizedStateConfig.model.provider
      : normalizedBaseConfig.model.provider;
    const providerSpecific = parseJsonText<Record<string, unknown>>(providerSpecificText, {});
    const nextContext = {
      ...(normalizedBaseConfig.context || {}),
      ...(normalizedStateConfig.context || {}),
    } as Record<string, unknown>;

    if (effectiveModelName) {
      nextContext.modelName = effectiveModelName;
    } else {
      delete nextContext.modelName;
    }

    return {
      ...normalizedBaseConfig,
      generation: normalizedStateConfig.generation || normalizedBaseConfig.generation,
      thinking: normalizedStateConfig.thinking || normalizedBaseConfig.thinking,
      safety: parseJsonText<Array<Record<string, unknown>>>(safetyText, []),
      tools: normalizedStateConfig.tools || normalizedBaseConfig.tools,
      context: nextContext,
      performance: normalizedStateConfig.performance || normalizedBaseConfig.performance,
      version: normalizedBaseConfig.version,
      model: {
        ...normalizedBaseConfig.model,
        provider: effectiveProvider,
        name: effectiveModelName,
        providerSpecific,
      },
    };
  };

  const normalizedTools = useMemo(
    () => normalizePlaygroundTools(providerConfig.tools),
    [providerConfig.tools]
  );

  const applyToolMutation = (
    mutator: (tools: Record<string, unknown>) => Record<string, unknown>,
    preferredExpandedKey?: string | null
  ) => {
    const nextTools = mutator(providerConfig.tools || {});
    const nextKeys = getToolEditorKeys(nextTools);
    setProviderConfig((prev) => ({
      ...prev,
      tools: nextTools,
    }));
    setExpandedToolKey((prev) => {
      if (preferredExpandedKey && nextKeys.includes(preferredExpandedKey)) {
        return preferredExpandedKey;
      }

      return prev && nextKeys.includes(prev) ? prev : nextKeys[0] || null;
    });
  };

  const updateToolEditorText = (
    key: string,
    nextText: string,
    onValidJson: (parsed: unknown) => void
  ) => {
    setToolEditorTexts((prev) => ({
      ...prev,
      [key]: nextText,
    }));

    try {
      onValidJson(JSON.parse(nextText));
    } catch {
      // Preserve invalid drafts locally until the JSON is valid again.
    }
  };

  const addToolDefinition = () => {
    const nextDefinition = createPlaygroundToolDefinition(normalizedTools.definitions);
    applyToolMutation((tools) => ({
      ...tools,
      definitions: [...normalizedTools.definitions, nextDefinition],
    }), `definitions:${normalizedTools.definitions.length}`);
  };

  const duplicateToolDefinitionAt = (definitionIndex: number) => {
    const target = normalizedTools.definitions[definitionIndex];
    const duplicated = duplicatePlaygroundToolDefinition(target, normalizedTools.definitions);
    applyToolMutation((tools) => ({
      ...tools,
      definitions: [...normalizedTools.definitions, duplicated],
    }), `definitions:${normalizedTools.definitions.length}`);
  };

  const removeToolDefinitionAt = (definitionIndex: number) => {
    applyToolMutation((tools) => ({
      ...tools,
      definitions: normalizedTools.definitions.filter((_, index) => index !== definitionIndex),
    }));
  };

  const updateToolDefinition = (definitionIndex: number, nextText: string) => {
    updateToolEditorText(`definitions:${definitionIndex}`, nextText, (parsed) => {
      applyToolMutation((tools) => ({
        ...tools,
        definitions: normalizedTools.definitions.map((definition, index) =>
          index === definitionIndex ? parsed : definition
        ),
      }), `definitions:${definitionIndex}`);
    });
  };

  const updateToolChoice = (nextText: string) => {
    updateToolEditorText('toolChoice', nextText, (parsed) => {
      applyToolMutation((tools) => ({
        ...tools,
        toolChoice: parsed,
      }), 'toolChoice');
    });
  };

  const resetToolChoice = () => {
    applyToolMutation((tools) => ({
      ...tools,
      toolChoice: null,
    }), 'toolChoice');
    setToolEditorTexts((prev) => ({
      ...prev,
      toolChoice: 'null',
    }));
  };

  const applyPromptSelectionToWorkspace = (nextPromptId: string | null) => {
    if (!nextPromptId) {
      return;
    }

    const prompt = prompts.find((item) => item.id === nextPromptId);
    if (!prompt) {
      return;
    }

    const systemInstruction = parsePromptSystemInstruction(prompt.system_instructions);
    const contextVariables = parsePromptContextVariables(prompt.context_variables);

    setPromptInput((prev) => ({
      ...prev,
      systemInstruction,
      contextVariables,
    }));
    setDraftSystemInstruction(systemInstruction);
    setDraftUserPromptTemplate(prompt.user_prompt_template || '');
    setContextVariablesText(stringifyJson(contextVariables));
    setProviderSelectionDirty(false);
    syncProviderTextFields(resolvePromptProviderConfig(prompt));
  };

  const handlePromptModeChange = (value: PlaygroundPromptMode) => {
    if (value === promptMode) {
      return;
    }

    if (value === 'saved' && promptId) {
      applyPromptSelectionToWorkspace(promptId);
    }

    if (value === 'draft') {
      setDraftSystemInstruction(promptInput.systemInstruction);
      if (!draftUserPromptTemplate && selectedPrompt?.user_prompt_template) {
        setDraftUserPromptTemplate(selectedPrompt.user_prompt_template);
      }
    }

    setPromptMode(value);
  };

  const handlePromptSelectionChange = (value: string) => {
    const nextPromptId = value === 'none' ? null : value;
    setPromptId(nextPromptId);

    if (promptMode === 'saved') {
      applyPromptSelectionToWorkspace(nextPromptId);
    }
  };

  const openDesktopWindow = (id: DesktopWindowId) => {
    setDesktopWindows((prev) => ({
      ...prev,
      [id]: { collapsed: false },
    }));
  };

  const closeDesktopWindow = (id: DesktopWindowId) => {
    setDesktopWindows((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        collapsed: true,
      },
    }));
  };

  const toggleDesktopWindow = (id: DesktopWindowId) => {
    if (desktopWindows[id].collapsed) {
      openDesktopWindow(id);
      return;
    }

    closeDesktopWindow(id);
  };

  const syncProviderTextFields = (next: PlaygroundProviderConfig) => {
    const normalizedNext = normalizePlaygroundProviderConfig(next);
    setProviderConfig(normalizedNext);
    setProviderSpecificText(stringifyJson(getPlaygroundProviderSpecific(normalizedNext)));
    setSafetyText(stringifyJson(normalizedNext.safety || []));
    setToolEditorTexts({});
    const keys = getToolEditorKeys(normalizedNext.tools);
    setExpandedToolKey((prev) => (prev && keys.includes(prev) ? prev : keys[0] || null));
  };

  const updateProviderSelection = (nextProvider: PlaygroundProviderConfig['model']['provider']) => {
    setProviderSelectionDirty(true);
    syncProviderTextFields(withPlaygroundProviderId(providerConfig, nextProvider));
  };

  const setModelOverride = (nextValue: string) => {
    setModelOverrideText(nextValue);
  };

  const handleSaveCase = () => {
    if (!selectedCaseId) {
      return;
    }

    updateCaseMutation.mutate({
      promptId,
      promptModeDefault: promptMode,
      promptInput: buildCurrentPromptInput(),
      providerConfig: buildCurrentProviderConfig(),
    });
  };

  const handleSetBaseline = (run: PlaygroundRun) => {
    if (!selectedCaseId || !run.outputSnapshot?.responseText) {
      return;
    }

    const baseline: PlaygroundBaselineOutput = {
      sourceKind: 'manual',
      responseText: run.outputSnapshot.responseText,
      thinking: run.outputSnapshot.thinking,
      provider: run.outputSnapshot.provider || run.provider || undefined,
      modelName: run.outputSnapshot.modelName || run.modelName || undefined,
      usage: run.outputSnapshot.usage,
      canonicalRequest: run.outputSnapshot.canonicalRequest,
      canonicalResponse: run.outputSnapshot.canonicalResponse,
      wireRequest: run.outputSnapshot.wireRequest,
      wireResponse: run.outputSnapshot.wireResponse,
      rawResponse: run.outputSnapshot.rawResponse,
      metadata: run.outputSnapshot.metadata,
    };

    updateCaseMutation.mutate({
      baselineOutput: baseline,
    });
  };

  const setGenerationNumber = (key: string, value: number) => {
    setProviderConfig((prev) => ({
      ...prev,
      generation: {
        ...(prev.generation || {}),
        [key]: value,
      },
    }));
  };

  const primaryUserMessage = getPrimaryUserMessage(promptInput.messages);
  const outputText = currentRun?.outputSnapshot?.responseText || currentRun?.outputSnapshot?.error || '';
  const promptPreview = buildPromptPreview(promptMode, draftSystemInstruction, draftUserPromptTemplate, promptInput);
  const toolEditorSources = useMemo(() => ([
    ...normalizedTools.definitions.map((definition, index) => ({
      key: `definitions:${index}`,
      label: `tool / definitions / ${getPlaygroundToolDefinitionName(definition, index)}`,
      value: definition,
    })),
  ]), [normalizedTools]);

  const toolEditorEntries = useMemo<ToolEditorEntry[]>(() => toolEditorSources.map((entry) => ({
    ...entry,
    onChange: (nextText: string) => updateToolDefinition(Number(entry.key.split(':')[1]), nextText),
  })), [toolEditorSources, updateToolDefinition]);

  useEffect(() => {
    const sourceEntries = [
      { key: 'toolChoice', value: normalizedTools.toolChoice },
      ...toolEditorSources.map((entry) => ({ key: entry.key, value: entry.value })),
    ];

    setToolEditorTexts((prev) => {
      const next: Record<string, string> = {};
      sourceEntries.forEach((entry) => {
        next[entry.key] = prev[entry.key] ?? stringifyJson(entry.value ?? null);
      });
      return next;
    });
  }, [normalizedTools.toolChoice, toolEditorSources]);

  const modelSourceDescription = hasModelOverride
    ? `Current override: ${effectiveModelName}`
    : promptDefaultModel
      ? `Using prompt default: ${promptDefaultModel}`
      : 'No model configured yet';
  const canRunCurrentConfig = Boolean(selectedCaseId && effectiveModelName);

  const renderToolsSection = (className: string) => {
    const toolChoiceText = toolEditorTexts.toolChoice ?? stringifyJson(normalizedTools.toolChoice);
    const toolChoiceExpanded = expandedToolKey === 'toolChoice';

    return (
      <div className={className}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileJson2 className="h-4 w-4 text-primary" />
            Tools
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addToolDefinition}>
            <Plus className="mr-2 h-4 w-4" />
            Add Tool
          </Button>
        </div>

        <div className="space-y-3">
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-background">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  'flex flex-1 items-center justify-between px-3 py-3 text-left text-sm font-medium transition',
                  toolChoiceExpanded ? 'bg-primary/10' : 'bg-background hover:bg-muted/40'
                )}
                onClick={() => setExpandedToolKey((prev) => (prev === 'toolChoice' ? null : 'toolChoice'))}
              >
                <span>tool / toolChoice</span>
                <span className="text-xs text-muted-foreground">{toolChoiceExpanded ? '收起编辑' : '点击展开'}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-2"
                onClick={resetToolChoice}
              >
                Reset
              </Button>
            </div>
            {toolChoiceExpanded ? (
              <div className="border-t border-border/70 p-3">
                <Textarea
                  value={toolChoiceText}
                  onChange={(event) => updateToolChoice(event.target.value)}
                  className="min-h-[120px] bg-background font-mono text-xs"
                />
                {!isJsonTextValid(toolChoiceText) ? (
                  <div className="mt-2 text-xs text-destructive">Invalid JSON. Changes apply after the JSON becomes valid.</div>
                ) : null}
              </div>
            ) : null}
          </div>

          {toolEditorEntries.length > 0 ? (
            <div className="space-y-2">
              {toolEditorEntries.map((entry) => {
                const isExpanded = expandedToolKey === entry.key;
                const editorText = toolEditorTexts[entry.key] ?? stringifyJson(entry.value);
                const invalidJson = !isJsonTextValid(editorText);
                const definitionIndex = Number(entry.key.split(':')[1]);

                return (
                  <div key={entry.key} className="overflow-hidden rounded-2xl border border-border/70 bg-background">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={cn(
                          'flex flex-1 items-center justify-between px-3 py-3 text-left text-sm font-medium transition',
                          isExpanded ? 'bg-primary/10' : 'bg-background hover:bg-muted/40'
                        )}
                        onClick={() => setExpandedToolKey((prev) => (prev === entry.key ? null : entry.key))}
                      >
                        <span>{entry.label}</span>
                        <span className="text-xs text-muted-foreground">{isExpanded ? '收起编辑' : '点击展开'}</span>
                      </button>
                      <div className="mr-2 flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => duplicateToolDefinitionAt(definitionIndex)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeToolDefinitionAt(definitionIndex)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {isExpanded ? (
                      <div className="border-t border-border/70 p-3">
                        <Textarea
                          value={editorText}
                          onChange={(event) => entry.onChange(event.target.value)}
                          className="min-h-[140px] bg-background font-mono text-xs"
                        />
                        {!invalidJson ? null : (
                          <div className="mt-2 text-xs text-destructive">Invalid JSON. Changes apply after the JSON becomes valid.</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No tool definitions yet" description="现在可以直接新增 definition，不必先回到 Prompt 配置页。" />
          )}
        </div>
      </div>
    );
  };

  const renderModelControlSection = () => (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Model</div>
          <div className="mt-1 text-sm font-medium text-foreground">{formatConfiguredValue(effectiveModelName)}</div>
        </div>
        <Badge variant={hasModelOverride ? 'default' : 'outline'}>{effectiveModelSourceLabel}</Badge>
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Preset Model</Label>
        <Select
          value={modelPresetValue}
          onValueChange={(value) => {
            if (value === '__inherit__') {
              setModelOverride('');
              return;
            }

            if (value === '__custom__') {
              return;
            }

            setModelOverride(value);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__inherit__">
              {promptDefaultModel ? `Use prompt model (${promptDefaultModel})` : '不覆盖，保持未配置'}
            </SelectItem>
            {presetModelOptions.map((modelName: string) => (
              <SelectItem key={modelName} value={modelName}>
                {modelName}
              </SelectItem>
            ))}
            {hasModelOverride && !presetModelOptions.includes(modelOverride) ? (
              <SelectItem value="__custom__">Custom override ({modelOverride})</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Custom Model Override</Label>
        <Input
          value={modelOverrideText}
          placeholder="显式填写模型 ID"
          onChange={(event) => setModelOverride(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{modelSourceDescription}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!hasModelOverride}
          onClick={() => setModelOverride('')}
        >
          清空覆盖
        </Button>
      </div>
    </div>
  );

  useEffect(() => {
    if (selectedCaseId || currentPromptText.trim()) {
      setEditorEmptyStateDismissed(false);
    }
  }, [currentPromptText, selectedCaseId]);

  const paramsPanelContent = (
    <ResizableSplit
      direction="vertical"
      disabled={!isDesktopLayout}
      defaultSize={34}
      minFirstSize={140}
      minSecondSize={150}
      className="h-full"
      firstClassName="h-full"
      secondClassName="h-full"
      handleLabel="调整参数区与工具区高度"
      first={(
        <div className="h-full min-h-0 overflow-auto rounded-2xl border border-border/70 bg-muted/15 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Settings2 className="h-4 w-4 text-primary" />
            Common Params
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-muted-foreground">
                <span>Temperature</span>
                <span>{String(providerConfig.generation.temperature ?? 0.7)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={Number(providerConfig.generation.temperature ?? 0.7)}
                onChange={(event) => setGenerationNumber('temperature', Number(event.target.value))}
                className="w-full accent-[hsl(var(--info))]"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-muted-foreground">
                <span>Top P</span>
                <span>{String(providerConfig.generation.topP ?? 0.95)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={Number(providerConfig.generation.topP ?? 0.95)}
                onChange={(event) => setGenerationNumber('topP', Number(event.target.value))}
                className="w-full accent-[hsl(var(--info))]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Max Tokens</Label>
                <Input
                  value={String(providerConfig.generation.maxOutputTokens ?? 2048)}
                  onChange={(event) => setGenerationNumber('maxOutputTokens', Number(event.target.value || 0))}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Model Provider</Label>
                <Select
                  value={providerId}
                  onValueChange={(value) => updateProviderSelection(value as PlaygroundProviderConfig['model']['provider'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="google-gemini-cli">Google Gemini CLI</SelectItem>
                    <SelectItem value="google-legacy">Google Legacy API</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {renderModelControlSection()}

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Provider Specific</Label>
              <Textarea
                value={providerSpecificText}
                onChange={(event) => {
                  setProviderSpecificText(event.target.value);
                  setProviderConfig((prev) => withPlaygroundProviderSpecific(
                    prev,
                    parseJsonText<Record<string, unknown>>(event.target.value, {})
                  ));
                }}
                className="min-h-[96px] bg-background font-mono text-xs"
              />
            </div>
          </div>
        </div>
      )}
      second={(
        <ResizableSplit
          direction="vertical"
          disabled={!isDesktopLayout}
          defaultSize={76}
          minFirstSize={96}
          minSecondSize={72}
          className="h-full"
          firstClassName="h-full"
          secondClassName="h-full"
          handleLabel="调整工具区与辅助 JSON 高度"
          first={renderToolsSection('h-full min-h-0 overflow-auto rounded-2xl border border-border/70 bg-muted/15 p-4')}
          second={(
            <div className="h-full min-h-0 overflow-auto rounded-2xl border border-border/70 bg-muted/15 p-4">
              <div className="mb-3 text-sm font-semibold text-foreground">Auxiliary JSON</div>
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Safety</Label>
                  <Textarea
                    value={safetyText}
                    onChange={(event) => {
                      setSafetyText(event.target.value);
                      setProviderConfig((prev) => ({
                        ...prev,
                        safety: parseJsonText<Array<Record<string, unknown>>>(event.target.value, []),
                      }));
                    }}
                    className="min-h-[84px] bg-background font-mono text-xs"
                  />
                </div>
              </div>
            </div>
          )}
        />
      )}
    />
  );
  const comparePanelContent = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
        选择 1 到 3 个预存 Prompt，作为后续同 input 横向对比的候选节点。
      </div>
      <div className="rounded-2xl border border-border/70 bg-background p-3">
        <div className="mb-3 flex items-center justify-between text-sm font-semibold text-foreground">
          <span>Prompt Candidates</span>
          <Badge variant="outline">{comparePromptIds.length} / 3</Badge>
        </div>
        <div className="space-y-2">
          {comparePromptOptions.slice(0, 8).map((prompt) => {
            const checked = comparePromptIds.includes(prompt.id);
            return (
              <label
                key={prompt.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-3 transition',
                  checked ? 'border-primary/30 bg-primary/10' : 'border-border/70 bg-background'
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-border"
                  checked={checked}
                  onChange={(event) => {
                    setComparePromptIds((prev) => {
                      if (event.target.checked) {
                        return [...prev, prompt.id].slice(0, 3);
                      }
                      return prev.filter((item) => item !== prompt.id);
                    });
                  }}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{prompt.prompt_name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatConfiguredValue(prompt.model_name)}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
      <div className="rounded-2xl border border-border/70 bg-background p-3">
        <div className="mb-3 text-sm font-semibold text-foreground">Run History</div>
        {runs.length > 0 ? (
          <div className="space-y-3">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setActiveRunId(run.id)}
                className={cn(
                  'w-full rounded-2xl border px-4 py-3 text-left transition',
                  currentRun?.id === run.id
                    ? 'border-primary/30 bg-primary/10'
                    : 'border-border/70 bg-background hover:border-primary/20'
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">{run.modelName || run.provider || 'Run'}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatTimestamp(run.createdAt)}</div>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant={run.status === 'completed' ? 'default' : 'destructive'}>{run.status}</Badge>
                    {typeof run.comparisonSnapshot?.similarity === 'number' ? (
                      <Badge variant="outline">{run.comparisonSnapshot.similarity}%</Badge>
                    ) : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="No compare signals yet" description="先运行当前 Prompt，再决定要不要展开 Compare Nodes 做横向比较。" />
        )}
      </div>
    </div>
  );

  const editorPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/70 bg-white/80 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.35)]">
      <div className="border-b border-border/70 px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {selectedCaseQuery.data?.name || 'Draft Prompt'}
            </div>
            {selectedCaseQuery.data?.caseMode ? <Badge variant="secondary">{selectedCaseQuery.data.caseMode}</Badge> : null}
            <Button
              variant={editorView === 'prompt' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setEditorView('prompt')}
            >
              Prompt
            </Button>
            <Button
              variant={editorView === 'preview' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setEditorView('preview')}
            >
              Rendered Preview
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline">Resizable editor</Badge>
            {promptMode === 'draft' ? <Badge variant="secondary">Draft mode</Badge> : <Badge variant="outline">Saved mode</Badge>}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {editorView === 'prompt' ? (
          <div className="flex h-full flex-col">
            {showEditorEmptyState ? (
              <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(248,103,34,0.07),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,253,248,0.92))] px-6 py-6">
                <div className="grid w-full max-w-5xl gap-4 xl:grid-cols-2">
                  <div className="rounded-[28px] border border-border/80 bg-white/90 p-6 shadow-[0_24px_60px_-44px_rgba(15,23,42,0.28)]">
                    <div className="text-sm font-semibold text-foreground">从样本开始</div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      先从真实流量或历史会话生成 Case，参数、输出、对比面板都会立即有上下文，不会再出现一整块无意义白板。
                    </div>
                    <div className="mt-5">
                      <Button onClick={() => setLibraryOpen(true)}>
                        <Database className="mr-2 h-4 w-4" />
                        Open Library
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-dashed border-border/80 bg-white/75 p-6">
                    <div className="text-sm font-semibold text-foreground">直接写 Draft</div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      如果你只是想起草 Prompt，也可以直接进入编辑器。这个入口只在空态出现，避免宽屏下整块区域看起来像布局坏掉。
                    </div>
                    <div className="mt-5 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPromptMode('draft');
                          setEditorEmptyStateDismissed(true);
                        }}
                      >
                        Start Writing
                      </Button>
                      <Button variant="ghost" onClick={() => setInputOpen(true)}>
                        <Wand2 className="mr-2 h-4 w-4" />
                        User Input
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <Textarea
                value={currentPromptText}
                onChange={(event) => {
                  if (promptMode === 'draft') {
                    setDraftSystemInstruction(event.target.value);
                  }
                  setPromptInput((prev) => ({
                    ...prev,
                    systemInstruction: event.target.value,
                  }));
                }}
                placeholder="从 Library 选择一个样本 Case，或者直接在这里输入 Draft Prompt。"
                className="h-full min-h-0 resize-none border-0 bg-transparent px-5 py-4 font-mono text-sm leading-7 shadow-none focus-visible:ring-0"
              />
            )}
          </div>
        ) : (
          <div className="h-full px-5 py-4">
            <JsonBlock value={promptPreview} className="h-full bg-background/90 text-xs" />
          </div>
        )}
      </div>
    </div>
  );

  const textResponsePane = (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Text Response</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {outputText ? (
          <div className="whitespace-pre-wrap text-sm leading-7 text-foreground">{outputText}</div>
        ) : (
          <EmptyState title="No text output yet" description="先运行当前 Prompt，或者切到 Tool / Raw 看其他结果。" />
        )}
      </div>
    </div>
  );

  const runSummaryPane = (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Run Summary</div>
      </div>
      <div className="space-y-3 overflow-auto p-4 text-sm">
        <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Status</div>
          <div className="mt-2 font-medium text-foreground">{currentRun?.status || 'idle'}</div>
        </div>
        <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Executed At</div>
          <div className="mt-2 font-medium text-foreground">
            {currentRun ? formatTimestamp(currentRun.createdAt) : '-'}
          </div>
        </div>
        <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Actions</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!currentRun}
              onClick={() => currentRun && cloneRunMutation.mutate(currentRun.id)}
            >
              Clone Run
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!currentRun}
              onClick={() => currentRun && handleSetBaseline(currentRun)}
            >
              Set Baseline
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  const toolCallPane = (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Tool / Function Call</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {toolCall ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Tool</div>
              <div className="font-medium text-foreground">{toolCall.name}</div>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Status</div>
              <div className="font-medium text-foreground">{formatReturnedValue(toolCall.status || currentRun?.status)}</div>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Provider</div>
              <div className="font-medium text-foreground">
                {formatReturnedValue(toolCall.provider || currentRun?.provider)}
                {toolCall.modelName ? ` / ${toolCall.modelName}` : ''}
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">Arguments</div>
              <JsonBlock value={toolCall.arguments ?? {}} />
            </div>
          </div>
        ) : (
          <EmptyState title="No tool call inferred" description="如果当前执行是纯文本输出，这里会为空。存在 function/tool 调用时，会优先展示结构化调用卡片。" />
        )}
      </div>
    </div>
  );

  const toolResultPane = (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Tool Result Summary</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {toolCall ? (
          <div className="space-y-3">
            <JsonBlock value={toolCall.result ?? toolCall.raw ?? {}} />
            {outputText ? (
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">Assistant Interpretation</div>
                <div className="whitespace-pre-wrap text-sm leading-7 text-foreground">{outputText}</div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState title="No tool result yet" description="没有可归一的 tool result 时，会退回到 Raw Provider Response 查看原始结构。" />
        )}
      </div>
    </div>
  );

  const rawOutputPane = (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-[18px] border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Raw Provider Response</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {rawProviderPayload ? (
          <JsonBlock value={rawProviderPayload} className="h-full min-h-[220px]" />
        ) : (
          <EmptyState title="No raw payload available" description="当前执行没有可展示的 provider 原始结果，先运行一次或者切回 Text / Tool。" />
        )}
      </div>
    </div>
  );

  const outputPanel = (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/70 bg-white/80 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.35)]">
      <div className="border-b border-border/70 bg-white/60 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Current Output</div>
            <div className="mt-1 text-xs text-muted-foreground">文本、工具调用和原始响应在这里切换查看。</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={outputView === 'text' ? 'default' : 'outline'} size="sm" onClick={() => setOutputView('text')}>
              Text
            </Button>
            <Button variant={outputView === 'tool' ? 'default' : 'outline'} size="sm" onClick={() => setOutputView('tool')}>
              Tool
            </Button>
            <Button variant={outputView === 'raw' ? 'default' : 'outline'} size="sm" onClick={() => setOutputView('raw')}>
              Raw
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-4">
        {outputView === 'raw' ? (
          rawOutputPane
        ) : (
          <ResizableSplit
            direction="horizontal"
            disabled={!isDesktopLayout}
            defaultSize={53}
            minFirstSize={320}
            minSecondSize={280}
            className="h-full"
            firstClassName="h-full"
            secondClassName="h-full"
            handleLabel="调整输出双栏宽度"
            first={outputView === 'text' ? textResponsePane : toolCallPane}
            second={outputView === 'text' ? runSummaryPane : toolResultPane}
          />
        )}
      </div>
    </section>
  );

  const startupPanel = (
    <section className="rounded-[24px] border border-border/70 bg-white/85 p-6 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.35)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-foreground">
            {isImportingCase ? '正在准备 Playground Case' : libraryErrorMessage ? '导入失败，需要恢复路径' : '先拿到可用 Case'}
          </div>
          <div className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {isImportingCase
              ? '正在从当前 trace / conversation / traffic 样本构建 Playground case，准备完成后再进入参数、输出和对比工作台。'
              : libraryErrorMessage
                ? '当前入口无法直接把你带进一个可运行的 Playground case。先回到样本库选一个可用样本，或者直接起草 Draft Prompt。'
                : 'Playground 的主路径应该是先选样本，再调 Prompt 和参数。没有 case 时，不再先展示一整套空白参数区和输出区。'}
          </div>
        </div>
        <Badge variant={isImportingCase ? 'default' : libraryErrorMessage ? 'destructive' : 'outline'}>
          {isImportingCase ? 'importing' : libraryErrorMessage ? 'import_failed' : 'need_case'}
        </Badge>
      </div>

      {libraryErrorMessage ? (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{libraryErrorMessage}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <div className="rounded-[28px] border border-border/80 bg-white/90 p-6 shadow-[0_24px_60px_-44px_rgba(15,23,42,0.28)]">
          <div className="text-sm font-semibold text-foreground">从真实样本开始</div>
          <div className="mt-2 text-sm leading-6 text-muted-foreground">
            优先从 Trace / Traffic / 已保存 Case 进入。这样参数、基线输出和对比节点都会立即有上下文。
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => setLibraryOpen(true)} disabled={isImportingCase}>
              <Database className="mr-2 h-4 w-4" />
              打开样本库
            </Button>
            <Button variant="outline" onClick={() => libraryQuery.refetch()} disabled={isImportingCase}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新样本
            </Button>
          </div>
        </div>

        <div className="rounded-[28px] border border-dashed border-border/80 bg-white/75 p-6">
          <div className="text-sm font-semibold text-foreground">直接起草 Draft</div>
          <div className="mt-2 text-sm leading-6 text-muted-foreground">
            如果你现在只是想写 Prompt，可以先进入草稿编辑态。草稿态不展示对比、运行结果和参数侧栏，避免空壳工作台干扰。
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPromptMode('draft');
                setEditorEmptyStateDismissed(true);
              }}
              disabled={isImportingCase}
            >
              Start Writing
            </Button>
            <Button variant="ghost" onClick={() => setInputOpen(true)} disabled={isImportingCase}>
              <Wand2 className="mr-2 h-4 w-4" />
              User Input
            </Button>
          </div>
        </div>
      </div>
    </section>
  );

  return (
    <PageShell>
      <div className="relative overflow-visible rounded-[28px] border border-border/70 bg-[linear-gradient(180deg,#fffdf8_0%,#f7f2ea_100%)] shadow-[0_24px_80px_-45px_rgba(15,23,42,0.4)]">
        <div className="border-b border-border/70 px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[1.5rem] font-semibold text-foreground">Prompt Workspace</h2>
                {selectedCaseQuery.data?.caseMode ? <Badge variant="secondary">{selectedCaseQuery.data.caseMode}</Badge> : null}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                编辑当前 Prompt，并观察当前运行输出。
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => libraryQuery.refetch()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
                <Database className="mr-2 h-4 w-4" />
                Library
              </Button>
              <Button variant="outline" size="sm" onClick={() => setInputOpen(true)}>
                <Wand2 className="mr-2 h-4 w-4" />
                User Input
              </Button>
              {isCaseReady ? (
                <>
                  <Button variant="outline" size="sm" onClick={handleSaveCase} disabled={updateCaseMutation.isPending}>
                    <Save className="mr-2 h-4 w-4" />
                    Save Case
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => (isDesktopLayout ? toggleDesktopWindow('params') : setMobileParamsOpen(true))}
                  >
                    <Settings2 className="mr-2 h-4 w-4" />
                    {isDesktopLayout && !desktopWindows.params.collapsed ? '隐藏参数' : '参数'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => (isDesktopLayout ? toggleDesktopWindow('compare') : setMobileCompareOpen(true))}
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    {isDesktopLayout && !desktopWindows.compare.collapsed ? '隐藏对比' : '对比'}
                  </Button>
                  <Button onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
                    <Play className="mr-2 h-4 w-4" />
                    {runMutation.isPending ? 'Running...' : 'Run'}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Select value={promptMode} onValueChange={(value) => handlePromptModeChange(value as PlaygroundPromptMode)}>
              <SelectTrigger className="h-9 w-[min(100%,180px)] bg-background sm:w-[clamp(150px,14vw,196px)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="saved">Saved Prompt</SelectItem>
                <SelectItem value="draft">Draft Prompt</SelectItem>
              </SelectContent>
            </Select>

            <Select value={promptId || 'none'} onValueChange={handlePromptSelectionChange}>
              <SelectTrigger className="h-9 w-[min(100%,320px)] bg-background sm:w-[clamp(220px,24vw,320px)]">
                <SelectValue placeholder="选择 Prompt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不绑定 Prompt</SelectItem>
                {prompts.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.prompt_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
              Current Prompt: {promptId || 'draft only'}
            </div>
            <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
              Source: {selectedCaseQuery.data?.source || (isDraftOnly ? 'draft only' : 'need case')}
            </div>
            <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
              Model: {formatConfiguredValue(effectiveModelName)}
            </div>
            <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
              Model Source: {effectiveModelSourceLabel}
            </div>
          </div>

          {promptMode === 'saved' ? (
            <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-xs leading-6 text-muted-foreground">
              Saved Prompt 会以数据库里的 Prompt 作为基线，但当前工作台里改过的 System Instruction 和 Context Variables 会作为当前实验执行的临时覆盖，不会回写正式 Prompt。
            </div>
          ) : null}

          {libraryErrorMessage ? (
            <Alert variant="destructive" className="mt-3">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                样本库当前不可用：{libraryErrorMessage}。你仍可直接起草 Prompt，但无法从真实样本创建 Case。
              </AlertDescription>
            </Alert>
          ) : null}

          {selectedCaseQuery.data?.source === 'span' && baselineSnapshot ? (
            <div className="mt-4 rounded-2xl border border-[hsl(var(--info))]/20 bg-[hsl(var(--info))]/5 px-4 py-3 text-xs leading-6 text-foreground/85">
              <div className="font-medium text-foreground">Span Baseline</div>
              <div className="mt-1">
                当前 Playground 基线来自真实 generation span。未修改时会做 exact replay；修改 prompt、tools 或参数后会切到 patched replay。
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {baselineSnapshot.traceId ? <span className="rounded-full border border-border/70 bg-background px-2 py-0.5">trace: {baselineSnapshot.traceId}</span> : null}
                {baselineSnapshot.spanId ? <span className="rounded-full border border-border/70 bg-background px-2 py-0.5">span: {baselineSnapshot.spanId}</span> : null}
                {baselineSnapshot.llmCallId ? <span className="rounded-full border border-border/70 bg-background px-2 py-0.5">llm_call: {baselineSnapshot.llmCallId}</span> : null}
                {currentExecutionMode ? <span className="rounded-full border border-border/70 bg-background px-2 py-0.5">mode: {currentExecutionMode}</span> : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
          {showStartupState || isImportingCase ? (
            startupPanel
          ) : isDesktopLayout && isCaseReady ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_380px]">
              <ResizableSplit
                direction="vertical"
                disabled={!isDesktopLayout}
                defaultSize={58}
                minFirstSize={320}
                minSecondSize={260}
                className="h-[clamp(760px,78vh,1100px)]"
                firstClassName="h-full"
                secondClassName="h-full"
                handleLabel="调整编辑区与输出区高度"
                first={editorPanel}
                second={outputPanel}
              />

              <aside className="hidden lg:block">
                <div className="space-y-4 lg:sticky lg:top-24">
                  <section className="rounded-[24px] border border-border/70 bg-white/85 p-4 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.32)]">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-foreground">使用顺序</div>
                        <div className="mt-1 text-xs leading-5 text-muted-foreground">
                          先拿到 Case，再改 Prompt，再跑结果。右侧参数和对比固定停靠，不再漂浮遮挡主画布。
                        </div>
                      </div>
                      <Badge variant="outline">{selectedCaseId ? 'Case ready' : 'Need case'}</Badge>
                    </div>
                    <div className="mt-4 grid gap-2">
                      <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
                        <Database className="mr-2 h-4 w-4" />
                        1. 选择样本
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setInputOpen(true)}>
                        <Wand2 className="mr-2 h-4 w-4" />
                        2. 编辑输入
                      </Button>
                      <Button size="sm" onClick={() => runMutation.mutate()} disabled={!canRunCurrentConfig || runMutation.isPending}>
                        <Play className="mr-2 h-4 w-4" />
                        3. 运行当前配置
                      </Button>
                    </div>
                  </section>

                  {!desktopWindows.params.collapsed ? (
                    <section className="overflow-hidden rounded-[24px] border border-border/70 bg-white/85 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.32)]">
                      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold text-foreground">参数与工具</div>
                          <div className="mt-1 text-xs text-muted-foreground">固定在右侧，边改边看输出。</div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => closeDesktopWindow('params')}>
                          收起
                        </Button>
                      </div>
                      <div className="max-h-[calc(100vh-19rem)] overflow-auto p-4">
                        {paramsPanelContent}
                      </div>
                    </section>
                  ) : (
                    <Button variant="outline" className="w-full justify-start" onClick={() => openDesktopWindow('params')}>
                      <Settings2 className="mr-2 h-4 w-4" />
                      展开参数与工具
                    </Button>
                  )}

                  {!desktopWindows.compare.collapsed ? (
                    <section className="overflow-hidden rounded-[24px] border border-border/70 bg-white/85 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.32)]">
                      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold text-foreground">对比节点</div>
                          <div className="mt-1 text-xs text-muted-foreground">对比候选和运行历史固定在同一位置。</div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => closeDesktopWindow('compare')}>
                          收起
                        </Button>
                      </div>
                      <div className="max-h-[calc(100vh-21rem)] overflow-auto p-4">
                        {comparePanelContent}
                      </div>
                    </section>
                  ) : (
                    <Button variant="outline" className="w-full justify-start" onClick={() => openDesktopWindow('compare')}>
                      <Sparkles className="mr-2 h-4 w-4" />
                      展开对比节点
                    </Button>
                  )}
                </div>
              </aside>
            </div>
          ) : isDesktopLayout ? (
            <div className="grid gap-4">
              <div className="h-[clamp(560px,68vh,920px)]">
                {editorPanel}
              </div>
            </div>
          ) : (
            isCaseReady ? (
              <ResizableSplit
                direction="vertical"
                disabled={!isDesktopLayout}
                defaultSize={58}
                minFirstSize={320}
                minSecondSize={260}
                className="h-[clamp(760px,78vh,1100px)]"
                firstClassName="h-full"
                secondClassName="h-full"
                handleLabel="调整编辑区与输出区高度"
                first={editorPanel}
                second={outputPanel}
              />
            ) : (
              <div className="h-[clamp(560px,68vh,920px)]">
                {editorPanel}
              </div>
            )
          )}
        </div>
      </div>

      <Sheet open={libraryOpen} onOpenChange={setLibraryOpen}>
        <SheetContent side="left" className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Library</SheetTitle>
            <SheetDescription>Traffic 样本、已保存 Cases 和近期实验执行。</SheetDescription>
          </SheetHeader>
          <div className="mt-4 flex-1 overflow-hidden">
            {libraryErrorMessage ? (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{libraryErrorMessage}</AlertDescription>
              </Alert>
            ) : null}
            <SampleLibraryPanel
              library={libraryQuery.data}
              selectedCaseId={selectedCaseId}
              search={librarySearch}
              onSearchChange={setLibrarySearch}
              onCreateFromTraffic={(trafficId) => createFromTrafficMutation.mutate(trafficId)}
              onSelectCase={(caseId) => {
                setSelectedCaseId(caseId);
                setLibraryOpen(false);
              }}
              onCloneRun={(runId) => cloneRunMutation.mutate(runId)}
              isCreatingCase={createFromTrafficMutation.isPending}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={inputOpen} onOpenChange={setInputOpen}>
        <SheetContent side="right" className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>User Input</SheetTitle>
            <SheetDescription>默认不占主画布。这里只编辑消息输入和上下文变量。</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4 overflow-y-auto pr-1">
            <div className="rounded-2xl border border-border/70 bg-background p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold text-foreground">Primary User Input</div>
                <Badge variant="outline">{primaryUserMessage.length} chars</Badge>
              </div>

              <div className="space-y-3">
                {promptInput.messages.map((message, index) => (
                  <div key={`${message.role}-${index}`} className="rounded-2xl border border-border/70 bg-muted/15 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant={message.role === 'assistant' ? 'secondary' : message.role === 'system' ? 'destructive' : 'outline'}>
                          {message.role}
                        </Badge>
                        {message.role === 'system' ? (
                          <div className="text-xs text-destructive">Unsupported here. Move this content to systemInstruction.</div>
                        ) : (
                          <Select
                            value={message.role}
                            onValueChange={(value) =>
                              setPromptInput((prev) => ({
                                ...prev,
                                messages: prev.messages.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, role: value as 'user' | 'assistant' }
                                    : item
                                ),
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 w-[120px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="user">user</SelectItem>
                              <SelectItem value="assistant">assistant</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setPromptInput((prev) => ({
                            ...prev,
                            messages: prev.messages.filter((_, itemIndex) => itemIndex !== index),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    <Textarea
                      value={message.content}
                      onChange={(event) =>
                        setPromptInput((prev) => ({
                          ...prev,
                          messages: prev.messages.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, content: event.target.value } : item
                          ),
                        }))
                      }
                      className="min-h-[120px] bg-background text-sm"
                    />
                  </div>
                ))}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() =>
                  setPromptInput((prev) => ({
                    ...prev,
                    messages: [...prev.messages, { role: 'user', content: '' }],
                  }))
                }
              >
                Add Message
              </Button>
            </div>

            {promptMode === 'draft' ? (
              <div className="rounded-2xl border border-border/70 bg-background p-4">
                <div className="mb-3 text-sm font-semibold text-foreground">Draft User Template</div>
                <Textarea
                  value={draftUserPromptTemplate}
                  onChange={(event) => setDraftUserPromptTemplate(event.target.value)}
                  className="min-h-[140px] bg-background font-mono text-xs"
                />
              </div>
            ) : null}

            <div className="rounded-2xl border border-border/70 bg-background p-4">
              <div className="mb-3 text-sm font-semibold text-foreground">Context Variables</div>
              <Textarea
                value={contextVariablesText}
                onChange={(event) => {
                  setContextVariablesText(event.target.value);
                  setPromptInput((prev) => ({
                    ...prev,
                    contextVariables: parseJsonText<Record<string, unknown>>(event.target.value, {}),
                  }));
                }}
                className="min-h-[140px] bg-background font-mono text-xs"
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobileParamsOpen} onOpenChange={setMobileParamsOpen}>
        <SheetContent side="right" className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Params & Tools</SheetTitle>
            <SheetDescription>移动端降级为抽屉，桌面端使用可拉伸侧栏。</SheetDescription>
          </SheetHeader>
          <div className="mt-4 overflow-y-auto pr-1">
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/70 bg-background p-4">
                <div className="mb-3 text-sm font-semibold text-foreground">Common Params</div>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Model Provider</Label>
                    <Select
                      value={providerId}
                      onValueChange={(value) => updateProviderSelection(value as PlaygroundProviderConfig['model']['provider'])}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="google-gemini-cli">Google Gemini CLI</SelectItem>
                        <SelectItem value="google-legacy">Google Legacy API</SelectItem>
                        <SelectItem value="openai">OpenAI</SelectItem>
                        <SelectItem value="codex">Codex</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {renderModelControlSection()}
                  <div className="space-y-2">
                    <Label>Temperature</Label>
                    <Input
                      value={String(providerConfig.generation.temperature ?? 0.7)}
                      onChange={(event) => setGenerationNumber('temperature', Number(event.target.value || 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Top P</Label>
                    <Input
                      value={String(providerConfig.generation.topP ?? 0.95)}
                      onChange={(event) => setGenerationNumber('topP', Number(event.target.value || 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Tokens</Label>
                    <Input
                      value={String(providerConfig.generation.maxOutputTokens ?? 2048)}
                      onChange={(event) => setGenerationNumber('maxOutputTokens', Number(event.target.value || 0))}
                    />
                  </div>
                </div>
              </div>

              {renderToolsSection('rounded-2xl border border-border/70 bg-background p-4')}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobileCompareOpen} onOpenChange={setMobileCompareOpen}>
        <SheetContent side="bottom" className="max-h-[85vh]">
          <SheetHeader>
            <SheetTitle>Compare Nodes</SheetTitle>
            <SheetDescription>移动端里作为底部抽屉查看和选择对比候选。</SheetDescription>
          </SheetHeader>
          <div className="mt-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              {comparePromptOptions.slice(0, 8).map((prompt) => {
                const checked = comparePromptIds.includes(prompt.id);
                return (
                  <label
                    key={prompt.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-3 transition',
                      checked ? 'border-primary/30 bg-primary/10' : 'border-border/70 bg-background'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-border"
                      checked={checked}
                      onChange={(event) => {
                        setComparePromptIds((prev) => {
                          if (event.target.checked) {
                            return [...prev, prompt.id].slice(0, 3);
                          }
                          return prev.filter((item) => item !== prompt.id);
                        });
                      }}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{prompt.prompt_name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{formatConfiguredValue(prompt.model_name)}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </PageShell>
  );
}
