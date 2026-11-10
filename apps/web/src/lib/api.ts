import type {
  DestinationCreateDto, DestinationDto, DestinationUpdateDto, EngineSettingsDto, EngineSettingsUpdateDto, JobDto, JobFilesDto, MeDto, SettingsDto,
  TestResultDto, UserDto, UserUpdateDto, VpnConfigCreateDto, VpnConfigDto, VpnConfigUpdateDto, VpnStatusDto,
} from '../../../api/src/lib/dto';

export type {
  DestinationCreateDto, DestinationDto, DestinationUpdateDto, EngineSettingsDto, EngineSettingsUpdateDto, JobDto, JobFilesDto, MeDto, SettingsDto,
  TestResultDto, UserDto, UserUpdateDto, VpnConfigCreateDto, VpnConfigDto, VpnConfigUpdateDto, VpnStatusDto,
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

let reloaded = false;

/** Same-origin JSON fetch. Errors are `{ error: { code, message } }` -> ApiError(message). */
export async function api<T>(path: string, init: { method?: string; body?: unknown | FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: init.method ?? 'GET', headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Network error: could not reach the server', 0, 'network');
  }
  if (res.status === 401 && !reloaded) {
    // The gateway redirects unauthenticated browsers to the login portal.
    reloaded = true;
    window.location.reload();
  }
  if (!res.ok) {
    let code = 'error';
    let message = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      if (j.error) { code = j.error.code ?? code; message = j.error.message ?? message; }
    } catch { /* not JSON */ }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const endpoints = {
  me: () => api<MeDto>('/me'),
  destinations: () => api<DestinationDto[]>('/destinations'),
  createDestination: (b: DestinationCreateDto) => api<DestinationDto>('/destinations', { method: 'POST', body: b }),
  updateDestination: (id: number, b: DestinationUpdateDto) => api<DestinationDto>(`/destinations/${id}`, { method: 'PATCH', body: b }),
  deleteDestination: (id: number) => api<void>(`/destinations/${id}`, { method: 'DELETE' }),
  testDestination: (id: number) => api<TestResultDto>(`/destinations/${id}/test`, { method: 'POST' }),
  jobs: () => api<JobDto[]>('/jobs'),
  addMagnet: (magnet: string, destinationId: number) => api<JobDto>('/jobs', { method: 'POST', body: { magnet, destinationId } }),
  addTorrentFile: (file: File, destinationId: number) => {
    const fd = new FormData();
    fd.append('torrent', file);
    fd.append('destinationId', String(destinationId));
    return api<JobDto>('/jobs', { method: 'POST', body: fd });
  },
  deleteJob: (id: number) => api<void>(`/jobs/${id}`, { method: 'DELETE' }),
  retryJob: (id: number) => api<JobDto>(`/jobs/${id}/retry`, { method: 'POST' }),
  jobFiles: (id: number) => api<JobFilesDto>(`/jobs/${id}/files`),
  admin: {
    destinations: () => api<DestinationDto[]>('/admin/destinations'),
    createDestination: (b: DestinationCreateDto) => api<DestinationDto>('/admin/destinations', { method: 'POST', body: b }),
    updateDestination: (id: number, b: DestinationUpdateDto) => api<DestinationDto>(`/admin/destinations/${id}`, { method: 'PATCH', body: b }),
    deleteDestination: (id: number) => api<void>(`/admin/destinations/${id}`, { method: 'DELETE' }),
    testDestination: (id: number) => api<TestResultDto>(`/admin/destinations/${id}/test`, { method: 'POST' }),
    vpnConfigs: () => api<VpnConfigDto[]>('/admin/vpn/configs'),
    createVpnConfig: (b: VpnConfigCreateDto) => api<VpnConfigDto>('/admin/vpn/configs', { method: 'POST', body: b }),
    updateVpnConfig: (id: number, b: VpnConfigUpdateDto) => api<VpnConfigDto>(`/admin/vpn/configs/${id}`, { method: 'PATCH', body: b }),
    deleteVpnConfig: (id: number) => api<void>(`/admin/vpn/configs/${id}`, { method: 'DELETE' }),
    vpnStatus: () => api<VpnStatusDto>('/admin/vpn/status'),
    vpnRotate: (configId?: number) => api<unknown>('/admin/vpn/rotate', { method: 'POST', body: configId === undefined ? {} : { configId } }),
    settings: () => api<SettingsDto>('/admin/settings'),
    updateSettings: (b: Partial<SettingsDto>) => api<SettingsDto>('/admin/settings', { method: 'PUT', body: b }),
    engineSettings: () => api<EngineSettingsDto>('/admin/engine/settings'),
    updateEngineSettings: (b: EngineSettingsUpdateDto) => api<EngineSettingsDto>('/admin/engine/settings', { method: 'PUT', body: b }),
    users: () => api<UserDto[]>('/admin/users'),
    updateUser: (id: number, b: UserUpdateDto) => api<UserDto>(`/admin/users/${id}`, { method: 'PATCH', body: b }),
    jobs: () => api<JobDto[]>('/admin/jobs'),
    deleteJob: (id: number) => api<void>(`/admin/jobs/${id}`, { method: 'DELETE' }),
  },
};
