// Request/response shapes of the single JSON endpoint, POST <base-url>api.
// Every request names its "method"; module.c (and server/server.js, the
// emulation) answer each one. Sizes are kB, as the kernel prints them.

/** connect — opens an SSH session that later requests refer to by id. */
export interface ConnectRequest {
  method: 'connect';
  /** IPv4 address or host name of the target; the server resolves names to IPv4. */
  host: string;
  port?: number;
  user: string;
  password?: string;
  /** PEM/OpenSSH private key text; takes precedence over password. */
  private_key?: string;
  passphrase?: string;
}

export interface ConnectResponse {
  session: string;
  host: string;
  port: number;
  user: string;
  auth_method: 'publickey' | 'password' | 'keyboard-interactive' | 'none';
  hostkey_type: string;
  /** "SHA256:…", as `ssh-keygen -l` prints it. */
  fingerprint: string;
  banner?: string;
  /** `uname -snrm` of the remote host. */
  uname: string;
  libssh2_version: string;
}

export interface SessionRequest {
  method: 'processes' | 'disconnect';
  session: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  state?: string;
  uid?: number;
  user?: string;
  threads: number;
  /** Absent for kernel threads. */
  rss_kb?: number;
  swap_kb?: number;
  cmdline: string;
  kernel_thread: boolean;
}

export interface ProcessesResponse {
  time: number;
  processes: ProcessInfo[];
}

export interface SampleRequest {
  method: 'sample';
  session: string;
  pid: number;
}

/** Per-mapping smaps counters; older kernels print only a subset (see `fields`). */
export type SmapsField =
  | 'size'
  | 'rss'
  | 'pss'
  | 'pss_dirty'
  | 'pss_anon'
  | 'pss_file'
  | 'pss_shmem'
  | 'shared_clean'
  | 'shared_dirty'
  | 'private_clean'
  | 'private_dirty'
  | 'referenced'
  | 'anonymous'
  | 'ksm'
  | 'lazy_free'
  | 'anon_huge_pages'
  | 'shmem_pmd_mapped'
  | 'file_pmd_mapped'
  | 'shared_hugetlb'
  | 'private_hugetlb'
  | 'swap'
  | 'swap_pss'
  | 'locked';

export type SmapsValues = Partial<Record<SmapsField, number>> & {
  /** Number of mappings summed. */
  count: number;
};

export type ComponentKind = 'heap' | 'stack' | 'anon' | 'library' | 'file' | 'shmem' | 'kernel' | 'other';

/** All mappings of one backing object (a file, [heap], anonymous memory, …) summed. */
export type MemComponent = SmapsValues & {
  name: string;
  kind: ComponentKind;
};

export interface SampleResponse {
  pid: number;
  /** Unix ms when the sample was taken. */
  time: number;
  name?: string;
  state?: string;
  /** Round trip of the remote read, ms. */
  elapsed_ms: number;
  fields: SmapsField[];
  totals: SmapsValues;
  components: MemComponent[];
  /** Vm*, Rss*, Hugetlb* (kB) plus Threads and FDSize from /proc/<pid>/status. */
  status: Record<string, number>;
  /** /proc/meminfo, kB. */
  meminfo: Record<string, number>;
}

export interface DisconnectResponse {
  closed: boolean;
}
