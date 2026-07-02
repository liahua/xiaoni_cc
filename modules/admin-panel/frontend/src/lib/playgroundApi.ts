import type {
  PlaygroundCase,
  PlaygroundExecutionMode,
  PlaygroundLibraryPayload,
  PlaygroundImportResolution,
  PlaygroundPromptInput,
  PlaygroundPromptMode,
  PlaygroundProviderConfig,
  PlaygroundRun,
} from '@/types/playground';

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(payload.message || payload.error || 'Request failed');
  }
  return payload.data as T;
}

export async function fetchPlaygroundLibrary(search?: string, promptId?: string | null): Promise<PlaygroundLibraryPayload> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (promptId) params.set('promptId', promptId);
  const response = await fetch(`/api/playground/cases${params.toString() ? `?${params}` : ''}`);
  return parseResponse<PlaygroundLibraryPayload>(response);
}

export async function createCaseFromTraffic(trafficId: number, promptId?: string | null): Promise<PlaygroundCase> {
  const response = await fetch(`/api/playground/cases/from-traffic/${trafficId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptId ? { promptId } : {}),
  });
  return parseResponse<PlaygroundCase>(response);
}

export function buildPlaygroundRecoveryUrl(message: string): string {
  const params = new URLSearchParams();
  params.set('importError', message);
  return `/playground?${params.toString()}`;
}

export async function createCaseFromSpan(payload: {
  traceId: string;
  spanId: string;
  promptId?: string | null;
}): Promise<PlaygroundCase> {
  const response = await fetch('/api/playground/cases/from-span', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse<PlaygroundCase>(response);
}

export async function resolvePlaygroundImportTarget(params: {
  conversationId?: string | null;
  traceId?: string | null;
}): Promise<PlaygroundImportResolution> {
  const searchParams = new URLSearchParams();
  if (params.conversationId) searchParams.set('conversationId', params.conversationId);
  if (params.traceId) searchParams.set('traceId', params.traceId);
  const response = await fetch(`/api/playground/import-target?${searchParams.toString()}`);
  return parseResponse<PlaygroundImportResolution>(response);
}

export async function openBestPlaygroundCase(params: {
  conversationId?: string | null;
  traceId?: string | null;
  promptId?: string | null;
}): Promise<PlaygroundCase> {
  const resolution = await resolvePlaygroundImportTarget(params);
  if (!resolution.importable) {
    throw new Error(resolution.reasonMessage || 'No viable Playground import source found');
  }

  if (resolution.sourceType === 'span' && resolution.traceId && resolution.spanId) {
    return createCaseFromSpan({
      traceId: resolution.traceId,
      spanId: resolution.spanId,
      promptId: params.promptId
    });
  }

  if (resolution.sourceType === 'traffic' && typeof resolution.trafficId === 'number') {
    return createCaseFromTraffic(resolution.trafficId, params.promptId);
  }

  throw new Error(resolution.reasonMessage || 'No viable Playground import source found');
}

export async function fetchPlaygroundCase(caseId: string): Promise<PlaygroundCase> {
  const response = await fetch(`/api/playground/cases/${caseId}`);
  return parseResponse<PlaygroundCase>(response);
}

export async function updatePlaygroundCase(caseId: string, payload: Partial<PlaygroundCase>): Promise<PlaygroundCase> {
  const response = await fetch(`/api/playground/cases/${caseId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse<PlaygroundCase>(response);
}

export async function fetchPlaygroundRuns(caseId: string): Promise<PlaygroundRun[]> {
  const response = await fetch(`/api/playground/cases/${caseId}/runs`);
  return parseResponse<PlaygroundRun[]>(response);
}

export async function createPlaygroundRun(payload: {
  caseId: string;
  executionMode?: PlaygroundExecutionMode;
  promptMode: PlaygroundPromptMode;
  promptId?: string | null;
  providerConfig: PlaygroundProviderConfig;
  promptInput: PlaygroundPromptInput;
  draftPrompt?: {
    systemInstruction?: string;
    userPromptTemplate?: string | null;
    contextVariables?: Record<string, unknown>;
  } | null;
}): Promise<PlaygroundRun> {
  const response = await fetch('/api/playground/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse<PlaygroundRun>(response);
}

export async function clonePlaygroundRun(runId: string): Promise<PlaygroundRun> {
  const response = await fetch(`/api/playground/runs/${runId}/clone`, {
    method: 'POST',
  });
  return parseResponse<PlaygroundRun>(response);
}
