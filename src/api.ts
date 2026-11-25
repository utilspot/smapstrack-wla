import type {
  ConnectRequest,
  ConnectResponse,
  DisconnectResponse,
  ProcessesResponse,
  SampleResponse,
} from './types';

/** Same-origin by default; override with VITE_API_BASE for split dev servers. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';

/**
 * Mirrors SMAPSTRACK_API_URL (CMakeLists.txt / config.h.in), which module.c
 * registers as `${SMAPSTRACK_ROOT_URL}api`. CMake passes the same base to the
 * build as `baseUrl` in config.json, which Vite exposes as BASE_URL (always
 * slash-terminated).
 */
const API_PATH = `${import.meta.env.BASE_URL}api`;

/** An error answer from the API, keeping the HTTP status around. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /** The SSH session is gone (idle timeout, transport failure, server restart). */
  get sessionLost(): boolean {
    return this.status === 404 || this.status === 502;
  }
}

async function postJSON<TRes>(body: object): Promise<TRes> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      `Could not reach the API at "${API_BASE || location.origin}${API_PATH}". ` +
        `Is the server running (npm run server)?`,
      0,
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        `Expected JSON from ${API_PATH} but got (${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }
  }

  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }

  return data as TRes;
}

export function connect(req: Omit<ConnectRequest, 'method'>): Promise<ConnectResponse> {
  return postJSON<ConnectResponse>({ method: 'connect', ...req });
}

export function listProcesses(session: string): Promise<ProcessesResponse> {
  return postJSON<ProcessesResponse>({ method: 'processes', session });
}

export function sample(session: string, pid: number): Promise<SampleResponse> {
  return postJSON<SampleResponse>({ method: 'sample', session, pid });
}

export function disconnect(session: string): Promise<DisconnectResponse> {
  return postJSON<DisconnectResponse>({ method: 'disconnect', session });
}
