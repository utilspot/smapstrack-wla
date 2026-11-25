#include "config.h"

#include <libnetq/Library.h>
#include <libnetq/fs/Path.h>
#include <libnetq/ErrorCode.h>
#include <libnetq/http/HttpHeader.h>
#include <libnetq/http/HttpMethod.h>
#include <libnetq/http/HttpStatus.h>
#include <libnetq/http/HttpRequest.h>
#include <libnetq/http/MediaType.h>
#include <libnetq/Module.h>
#include <libnetq/Malloc.h>
#include <libnetq/Mutex.h>
#include <libnetq/ByteBuffer.h>
#include <libnetq/Base64.h>
#include <libnetq/JSON.h>
#include <libnetq/Poll.h>
#include <libnetq/String.h>
#include <libnetq/Time.h>
#include <libnetq/UUID.h>
#include <libnetq/net/GetAddrInfo.h>
#include <libnetq/net/EndPoint.h>
#include <libnetq/net/SocketHandle.h>
#include <libnetq/string/String.h>
#include <libnetq/string/Sprintf.h>
#include <libnetq/string/Strtox.h>
#include <libnetq/web/WebRequest.h>
#include <libnetq/web/WebResponse.h>
#include <libnetq/web/WebServer.h>
#include <libnetq/web/WebManifest.h>

#include <libssh2.h>

/* Largest JSON body accepted on the endpoint (a pasted private key fits easily). */
#define SMAPSTRACK_REQUEST_BODY_MAX (64 * 1024)

/* Largest remote command output read back; /proc/<pid>/smaps of a big process is a few MB. */
#define SMAPSTRACK_OUTPUT_MAX (64 * 1024 * 1024)

#define SMAPSTRACK_SESSIONS_MAX 16
#define SMAPSTRACK_SESSION_IDLE_MS (15 * 60 * 1000)
#define SMAPSTRACK_CONNECT_TIMEOUT_MS (10 * 1000)
#define SMAPSTRACK_SSH_TIMEOUT_MS (20 * 1000)

typedef struct WebSmapstrackExecutor WebSmapstrackExecutor;
struct WebSmapstrackExecutor {
  NQWebExecutor executor;
  NQWebManifestListeners manifestListeners;
  struct NQWebRequestListener apiListener;
};

/* ------------------------------------------------------------ SSH sessions */

/*
 * One authenticated SSH connection, addressed by the client through `id`.
 * libssh2 sessions are not thread-safe and civetweb answers requests on a
 * pool of threads, so every use of `ssh` happens under `lock`. `refs` and
 * `closed` are guarded by s_sessionsLock instead: a session removed from the
 * table is only destroyed once the last request still holding it lets go.
 */
typedef struct SshSession SshSession;
struct SshSession {
  NQUUIDBuffer id;
  NQMutex lock;
  int refs;
  bool closed;
  NQTimeMs lastUsed;

  NQSocketHandle socket;
  LIBSSH2_SESSION* ssh;

  /* Answer for keyboard-interactive prompts, set only while authenticating. */
  const char* kbdintPassword;
};

static NQ_MUTEX_DEFINE(s_sessionsLock);
static SshSession* s_sessions[SMAPSTRACK_SESSIONS_MAX];

/* libssh2 allocates through libnetq, so its buffers show up in the same accounting. */
static LIBSSH2_ALLOC_FUNC(sshAlloc)
{
  NQ_UNUSED_PARAM(abstract);
  return NQMalloc(count);
}

static LIBSSH2_REALLOC_FUNC(sshRealloc)
{
  NQ_UNUSED_PARAM(abstract);
  return NQRealloc(ptr, count);
}

static LIBSSH2_FREE_FUNC(sshFree)
{
  NQ_UNUSED_PARAM(abstract);
  NQFree(ptr);
}

/* Answers every keyboard-interactive prompt with the password ("Password:" is the usual one). */
static LIBSSH2_USERAUTH_KBDINT_RESPONSE_FUNC(sshKbdintResponse)
{
  NQ_UNUSED_PARAM(name);
  NQ_UNUSED_PARAM(name_len);
  NQ_UNUSED_PARAM(instruction);
  NQ_UNUSED_PARAM(instruction_len);
  NQ_UNUSED_PARAM(prompts);

  SshSession* session = (SshSession*)*abstract;
  const char* password = session->kbdintPassword != NULL ? session->kbdintPassword : "";

  for (int i = 0; i < num_prompts; ++i) {
    /* Released by libssh2 through sshFree. */
    responses[i].text = NQCStrDuplicate(password);
    responses[i].length = responses[i].text != NULL ? (unsigned int)NQStrlen(password) : 0;
  }
}

static void sessionDestroy(SshSession* session)
{
  if (session->ssh != NULL) {
    libssh2_session_disconnect(session->ssh, "smapstrack: session closed");
    libssh2_session_free(session->ssh);
  }
  NQSocketClose(session->socket);
  NQMutex_finalize(&session->lock);
  NQFree(session);
}

/* Looks a session up by id and takes a reference on it; NULL when unknown or closed. */
static SshSession* sessionAcquire(const char* id)
{
  SshSession* found = NULL;

  NQMutex_lock(&s_sessionsLock);
  for (size_t i = 0; i < SMAPSTRACK_SESSIONS_MAX; ++i) {
    SshSession* session = s_sessions[i];
    if (session != NULL && NQStrcmp(session->id, id) == 0) {
      session->refs++;
      session->lastUsed = NQGetTimeMs();
      found = session;
      break;
    }
  }
  NQMutex_unlock(&s_sessionsLock);

  return found;
}

static void sessionRelease(SshSession* session)
{
  NQMutex_lock(&s_sessionsLock);
  bool destroy = --session->refs == 0 && session->closed;
  NQMutex_unlock(&s_sessionsLock);

  if (destroy)
    sessionDestroy(session);
}

/* Drops the table's hold on `session`; the caller still owns its own reference. */
static void sessionClose(SshSession* session)
{
  NQMutex_lock(&s_sessionsLock);
  for (size_t i = 0; i < SMAPSTRACK_SESSIONS_MAX; ++i) {
    if (s_sessions[i] == session) {
      s_sessions[i] = NULL;
      session->closed = true;
      session->refs--;
      break;
    }
  }
  NQMutex_unlock(&s_sessionsLock);
}

/* Inserts `session` (one reference, the table's) into a free slot. */
static bool sessionInsert(SshSession* session)
{
  bool inserted = false;

  NQMutex_lock(&s_sessionsLock);
  for (size_t i = 0; i < SMAPSTRACK_SESSIONS_MAX; ++i) {
    if (s_sessions[i] == NULL) {
      s_sessions[i] = session;
      session->refs = 1;
      session->lastUsed = NQGetTimeMs();
      inserted = true;
      break;
    }
  }
  NQMutex_unlock(&s_sessionsLock);

  return inserted;
}

/*
 * Closes sessions nobody has used for SMAPSTRACK_SESSION_IDLE_MS — a browser
 * tab that went away without disconnecting. With `all`, closes every session
 * regardless (module shutdown).
 */
static void sessionsReap(bool all)
{
  SshSession* reaped[SMAPSTRACK_SESSIONS_MAX];
  size_t count = 0;
  NQTimeMs now = NQGetTimeMs();

  NQMutex_lock(&s_sessionsLock);
  for (size_t i = 0; i < SMAPSTRACK_SESSIONS_MAX; ++i) {
    SshSession* session = s_sessions[i];
    if (session == NULL)
      continue;
    if (!all && (session->refs > 1 || now - session->lastUsed < SMAPSTRACK_SESSION_IDLE_MS))
      continue;
    s_sessions[i] = NULL;
    session->closed = true;
    if (--session->refs == 0)
      reaped[count++] = session;
  }
  NQMutex_unlock(&s_sessionsLock);

  for (size_t i = 0; i < count; ++i)
    sessionDestroy(reaped[i]);
}

/* ------------------------------------------------------------ SSH plumbing */

static void sshErrorMessage(LIBSSH2_SESSION* ssh, const char* what, char* error, size_t errorSize)
{
  char* message = NULL;
  int code = libssh2_session_last_error(ssh, &message, NULL, 0);
  if (code == LIBSSH2_ERROR_TIMEOUT)
    NQSnprintf(error, errorSize, "%s: timed out", what);
  else if (message != NULL && message[0] != '\0')
    NQSnprintf(error, errorSize, "%s: %s", what, message);
  else
    NQSnprintf(error, errorSize, "%s failed (libssh2 error %d)", what, code);
}

/*
 * Resolves `host`, an IPv4 address or a name, to its first IPv4 address. A name
 * lookup blocks and is not bounded by SMAPSTRACK_CONNECT_TIMEOUT_MS.
 */
static bool resolveHost(const char* host, uint16_t port, NQIPv4EndPoint* result, char* error, size_t errorSize)
{
  NQAddrInfo hints = {
    .family = NQ_AF_INET,
    .socktype = NQ_SOCK_STREAM,
    .protocol = NQ_IPPROTO_TCP,
  };
  NQAddrInfo* list = NULL;
  int ret = NQGetAddrInfo(host, NULL, &hints, &list);
  if (ret != 0) {
    NQSnprintf(error, errorSize, "Could not resolve %s: %s", host, NQGaiStrError(ret));
    return false;
  }
  NQIPv4EndPoint_init(result, &list->address.ip4ep.address, port);
  NQFreeAddrInfo(list);
  return true;
}

/* TCP connect bounded by SMAPSTRACK_CONNECT_TIMEOUT_MS, leaving the socket blocking again. */
static int socketConnect(const NQIPv4EndPoint* ep, NQSocketHandle* result, char* error, size_t errorSize)
{
  NQSocketHandle sock;
  int ret = NQSocketOpen(NQ_AF_INET, NQ_SOCK_STREAM, NQ_IPPROTO_TCP, &sock);
  if (ret != 0) {
    NQSnprintf(error, errorSize, "Could not open a socket: %s", strerror(-ret));
    return ret;
  }

  NQSocketSetNonBlocking(sock, true);
  ret = NQSocketConnect4(sock, ep);
  if (ret == -NQ_EINPROGRESS) {
    NQPollSocket poll = { .socket = sock, .events = NQ_POLLOUT, .revents = 0 };
    ret = NQPollWait(&poll, 1, SMAPSTRACK_CONNECT_TIMEOUT_MS);
    if (ret == 0) {
      ret = -NQ_ETIMEDOUT;
    } else if (ret > 0) {
      int soError = 0;
      ret = NQSocketGetOptInt(sock, NQ_SOL_SOCKET, NQ_SO_ERROR, &soError);
      if (ret == 0 && soError != 0)
        ret = -soError;
    }
  }
  if (ret != 0) {
    NQSnprintf(error, errorSize, "Could not connect: %s", strerror(-ret));
    NQSocketClose(sock);
    return ret;
  }
  NQSocketSetNonBlocking(sock, false);

  *result = sock;
  return 0;
}

static const char* hostKeyTypeName(int type)
{
  switch (type) {
  case LIBSSH2_HOSTKEY_TYPE_RSA:
    return "ssh-rsa";
  case LIBSSH2_HOSTKEY_TYPE_DSS:
    return "ssh-dss";
  case LIBSSH2_HOSTKEY_TYPE_ECDSA_256:
    return "ecdsa-sha2-nistp256";
  case LIBSSH2_HOSTKEY_TYPE_ECDSA_384:
    return "ecdsa-sha2-nistp384";
  case LIBSSH2_HOSTKEY_TYPE_ECDSA_521:
    return "ecdsa-sha2-nistp521";
  case LIBSSH2_HOSTKEY_TYPE_ED25519:
    return "ssh-ed25519";
  default:
    return "unknown";
  }
}

/* "SHA256:<unpadded base64>", the way `ssh-keygen -l` prints it. */
static void hostKeyFingerprint(LIBSSH2_SESSION* ssh, char* buffer, size_t size)
{
  const char* hash = libssh2_hostkey_hash(ssh, LIBSSH2_HOSTKEY_HASH_SHA256);
  if (hash == NULL || size < 8) {
    NQSnprintf(buffer, size, "unknown");
    return;
  }
  NQMemcpy(buffer, "SHA256:", 7);
  int len = NQBase64EncodeEx(hash, 32, buffer + 7, size - 7, NQ_BASE64_NONPAD);
  buffer[len > 0 ? 7 + (size_t)len : 7] = '\0';
}

typedef struct ConnectParams ConnectParams;
struct ConnectParams {
  const char* host;
  uint16_t port;
  const char* user;
  const char* password;
  const char* privateKey;
  const char* passphrase;
};

/*
 * Authenticates with the private key when one is given, otherwise with the
 * password — first as "password", then as "keyboard-interactive" for servers
 * that only offer the latter (PAM setups, mostly). Returns the method used.
 */
static const char* sshAuthenticate(SshSession* session, const ConnectParams* params, char* error, size_t errorSize)
{
  LIBSSH2_SESSION* ssh = session->ssh;
  unsigned int userLen = (unsigned int)NQStrlen(params->user);

  const char* methods = libssh2_userauth_list(ssh, params->user, userLen);
  if (methods == NULL) {
    if (libssh2_userauth_authenticated(ssh))
      return "none";
    sshErrorMessage(ssh, "Listing authentication methods", error, errorSize);
    return NULL;
  }

  if (params->privateKey != NULL && params->privateKey[0] != '\0') {
    int ret = libssh2_userauth_publickey_frommemory(ssh, params->user, userLen, NULL, 0,
                                                    params->privateKey, NQStrlen(params->privateKey),
                                                    params->passphrase);
    if (ret == 0)
      return "publickey";
    sshErrorMessage(ssh, "Public key authentication", error, errorSize);
    return NULL;
  }

  const char* password = params->password != NULL ? params->password : "";

  if (NQStrstr(methods, "password") != NULL) {
    if (libssh2_userauth_password(ssh, params->user, password) == 0)
      return "password";
  }

  if (NQStrstr(methods, "keyboard-interactive") != NULL) {
    session->kbdintPassword = password;
    int ret = libssh2_userauth_keyboard_interactive_ex(ssh, params->user, userLen, &sshKbdintResponse);
    session->kbdintPassword = NULL;
    if (ret == 0)
      return "keyboard-interactive";
  }

  if (NQStrstr(methods, "password") == NULL && NQStrstr(methods, "keyboard-interactive") == NULL)
    NQSnprintf(error, errorSize, "Server does not accept passwords (offers: %s)", methods);
  else
    sshErrorMessage(ssh, "Authentication", error, errorSize);
  return NULL;
}

typedef struct ExecResult ExecResult;
struct ExecResult {
  NQByteBuffer out;
  NQByteBuffer err;
  int exitStatus;
};

static void execResultInit(ExecResult* result)
{
  NQByteBuffer_init(&result->out);
  NQByteBuffer_init(&result->err);
  result->exitStatus = -1;
}

static void execResultFinalize(ExecResult* result)
{
  NQByteBuffer_finalize(&result->out);
  NQByteBuffer_finalize(&result->err);
}

typedef enum ReadStatus {
  READ_OK,
  READ_FAILED,
  READ_TOO_LARGE,
} ReadStatus;

/* Reads one stream of `channel` to EOF; stream 0 is stdout, SSH_EXTENDED_DATA_STDERR stderr. */
static ReadStatus channelReadAll(LIBSSH2_CHANNEL* channel, int stream, NQByteBuffer* buffer, size_t limit)
{
  char chunk[32 * 1024];
  for (;;) {
    ssize_t n = libssh2_channel_read_ex(channel, stream, chunk, sizeof(chunk));
    if (n == 0)
      return READ_OK;
    if (n < 0)
      return READ_FAILED;
    if (NQByteBuffer_size(buffer) + (size_t)n > limit)
      return READ_TOO_LARGE;
    if (!NQByteBuffer_append(buffer, (const uint8_t*)chunk, (size_t)n))
      return READ_FAILED;
  }
}

/*
 * Runs `command` through the remote user's shell on a fresh channel, collecting
 * stdout and stderr (both NUL-terminated on success) and the exit status. The
 * caller holds session->lock. stdout is drained before stderr; the scripts
 * below only ever write a line or two to stderr, far below the channel window.
 */
static bool sshExec(SshSession* session, const char* command, ExecResult* result, char* error, size_t errorSize)
{
  LIBSSH2_SESSION* ssh = session->ssh;

  LIBSSH2_CHANNEL* channel = libssh2_channel_open_session(ssh);
  if (channel == NULL) {
    sshErrorMessage(ssh, "Opening a channel", error, errorSize);
    return false;
  }

  bool ok = false;
  ReadStatus status;
  if (libssh2_channel_exec(channel, command) != 0) {
    sshErrorMessage(ssh, "Running the remote command", error, errorSize);
  } else if ((status = channelReadAll(channel, 0, &result->out, SMAPSTRACK_OUTPUT_MAX)) != READ_OK) {
    if (status == READ_TOO_LARGE)
      NQSnprintf(error, errorSize, "Remote output exceeds %d MB", SMAPSTRACK_OUTPUT_MAX / (1024 * 1024));
    else
      sshErrorMessage(ssh, "Reading the remote output", error, errorSize);
  } else if (channelReadAll(channel, SSH_EXTENDED_DATA_STDERR, &result->err, 64 * 1024) != READ_OK) {
    sshErrorMessage(ssh, "Reading the remote error output", error, errorSize);
  } else {
    ok = true;
  }

  libssh2_channel_close(channel);
  if (ok) {
    libssh2_channel_wait_closed(channel);
    result->exitStatus = libssh2_channel_get_exit_status(channel);
  }
  libssh2_channel_free(channel);

  if (!ok)
    return false;

  const uint8_t nul = '\0';
  if (!NQByteBuffer_append(&result->out, &nul, 1) || !NQByteBuffer_append(&result->err, &nul, 1)) {
    NQSnprintf(error, errorSize, "Out of memory");
    return false;
  }
  return true;
}

/* The remote command's own complaint (first stderr line) when it exited non-zero. */
static void execFailureMessage(const ExecResult* result, char* error, size_t errorSize)
{
  const char* stderrText = (const char*)NQByteBuffer_data(&result->err);
  size_t len = 0;
  while (stderrText[len] != '\0' && stderrText[len] != '\n')
    len++;
  if (len > 0)
    NQSnprintf(error, errorSize, "%.*s", (int)len, stderrText);
  else
    NQSnprintf(error, errorSize, "Remote command failed (exit status %d)", result->exitStatus);
}

/* ------------------------------------------------------------ text parsing */

/* Splits the NUL-terminated text at *cursor into lines in place; NULL at the end. */
static char* nextLine(char** cursor)
{
  char* line = *cursor;
  if (*line == '\0')
    return NULL;
  char* eol = NQStrchr(line, '\n');
  if (eol != NULL) {
    *eol = '\0';
    *cursor = eol + 1;
  } else {
    *cursor = line + NQStrlen(line);
  }
  return line;
}

/* "Key:   value" → key, value (leading blanks skipped); false when there is no ':'. */
static bool splitField(char* line, char** key, char** value)
{
  char* colon = NQStrchr(line, ':');
  if (colon == NULL)
    return false;
  *colon = '\0';
  char* v = colon + 1;
  while (*v == ' ' || *v == '\t')
    v++;
  *key = line;
  *value = v;
  return true;
}

/* "1234 kB" or "1234" → 1234; anything else after the number is rejected. */
static bool parseCount(const char* value, uint64_t* result)
{
  char* end = NULL;
  uint64_t n = NQSimpleStrtoull(value, &end, 10);
  if (end == value)
    return false;
  while (*end == ' ' || *end == '\t')
    end++;
  if (*end != '\0' && NQStrcmp(end, "kB") != 0)
    return false;
  *result = n;
  return true;
}

static void trimRight(char* s)
{
  size_t len = NQStrlen(s);
  while (len > 0 && (s[len - 1] == ' ' || s[len - 1] == '\t' || s[len - 1] == '\r'))
    s[--len] = '\0';
}

/* ------------------------------------------------------------ JSON plumbing */

/* Accumulate-and-decode plumbing for the endpoint's JSON body. */
typedef struct RequestContext RequestContext;
struct RequestContext {
  NQByteBuffer body;
  bool tooLarge;
};

static bool responseJsonWrite(void* userdata, const char* characters, size_t size)
{
  NQWebResponse* response = (NQWebResponse*)userdata;
  return NQWebResponse_write(response, characters, size) >= 0;
}

/* { "error": "..." } — the shape the client's api.ts unwraps for its messages. */
static int responseJsonError(NQJSONWriter* writer, int status, const char* message)
{
  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyString(writer, "error", message);
  NQJSONWriter_writeObjectEnd(writer);
  NQJSONWriter_finalize(writer);
  return status;
}

static int responseFinish(NQJSONWriter* writer)
{
  NQJSONWriter_finalize(writer);
  return writer->hasError ? NQ_HTTP_INTERNAL_SERVER_ERROR : NQ_HTTP_OK;
}

static int requestBodyInit(NQWebRequest* request, void* data)
{
  NQ_UNUSED_PARAM(data);

  RequestContext* ctx = (RequestContext*)NQMalloc(sizeof(*ctx));
  if (ctx == NULL)
    return -NQ_ENOMEM;

  ctx->tooLarge = false;
  NQByteBuffer_init(&ctx->body);

  request->userdata = ctx;
  return 0;
}

static size_t requestBodyReceive(NQWebRequest* request, const char* data, size_t size)
{
  RequestContext* ctx = (RequestContext*)request->userdata;

  /* Drain oversized bodies rather than aborting, so the handler can answer in JSON. */
  if (ctx->tooLarge)
    return size;

  if (NQByteBuffer_size(&ctx->body) + size > SMAPSTRACK_REQUEST_BODY_MAX) {
    ctx->tooLarge = true;
    NQByteBuffer_clear(&ctx->body);
    return size;
  }

  (void)NQByteBuffer_append(&ctx->body, (const uint8_t*)data, size);
  return size;
}

static void requestBodyRelease(NQWebRequest* request)
{
  RequestContext* ctx = (RequestContext*)request->userdata;
  if (ctx == NULL)
    return;
  NQByteBuffer_finalize(&ctx->body);
  NQFree(ctx);
  request->userdata = NULL;
}

static NQJSON* requestBodyDecode(RequestContext* ctx, NQJSONWriter* writer, int* status)
{
  if (ctx->tooLarge) {
    *status = responseJsonError(writer, NQ_HTTP_REQUEST_ENTITY_TOO_LARGE, "Request body too large");
    return NULL;
  }

  size_t size = NQByteBuffer_size(&ctx->body);
  if (size == 0) {
    *status = responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "Request body must be valid JSON");
    return NULL;
  }

  NQJSON* root = NQJSON_parse2((const char*)NQByteBuffer_data(&ctx->body), size);
  if (root == NULL || !NQJSON_isObject(root)) {
    NQJSON_release(root);
    *status = responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "Request body must be a JSON object");
    return NULL;
  }

  return root;
}

static const char* optionalString(const NQJSON* json, const char* key)
{
  const char* value = NULL;
  if (!NQJSON_objectGetString(json, key, &value))
    return NULL;
  return value;
}

/* ------------------------------------------------------------------ connect */

static int connectRespond(const NQJSON* root, NQJSONWriter* writer)
{
  ConnectParams params = {
    .host = optionalString(root, "host"),
    .port = 22,
    .user = optionalString(root, "user"),
    .password = optionalString(root, "password"),
    .privateKey = optionalString(root, "private_key"),
    .passphrase = optionalString(root, "passphrase"),
  };

  if (params.host == NULL || params.host[0] == '\0')
    return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"host\" is required");
  if (params.user == NULL || params.user[0] == '\0')
    return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"user\" is required");

  int64_t port = 22;
  if (NQJSON_objectGet(root, "port") != NULL) {
    if (!NQJSON_objectGetInt64(root, "port", &port) || port < 1 || port > 65535)
      return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"port\" must be between 1 and 65535");
  }
  params.port = (uint16_t)port;

  char error[512];

  NQIPv4EndPoint ep;
  if (!resolveHost(params.host, params.port, &ep, error, sizeof(error)))
    return responseJsonError(writer, NQ_HTTP_BAD_GATEWAY, error);

  SshSession* session = (SshSession*)NQZeroMalloc(sizeof(*session));
  if (session == NULL)
    return responseJsonError(writer, NQ_HTTP_INTERNAL_SERVER_ERROR, "Out of memory");
  NQMutex_init(&session->lock);
  NQGenerateUUIDStringLower(session->id, sizeof(session->id));

  if (socketConnect(&ep, &session->socket, error, sizeof(error)) != 0) {
    NQMutex_finalize(&session->lock);
    NQFree(session);
    return responseJsonError(writer, NQ_HTTP_BAD_GATEWAY, error);
  }

  session->ssh = libssh2_session_init_ex(&sshAlloc, &sshFree, &sshRealloc, session);
  if (session->ssh == NULL) {
    sessionDestroy(session);
    return responseJsonError(writer, NQ_HTTP_INTERNAL_SERVER_ERROR, "Could not create an SSH session");
  }
  libssh2_session_set_blocking(session->ssh, 1);
  libssh2_session_set_timeout(session->ssh, SMAPSTRACK_SSH_TIMEOUT_MS);

  if (libssh2_session_handshake(session->ssh, (libssh2_socket_t)session->socket) != 0) {
    sshErrorMessage(session->ssh, "SSH handshake", error, sizeof(error));
    sessionDestroy(session);
    return responseJsonError(writer, NQ_HTTP_BAD_GATEWAY, error);
  }

  const char* authMethod = sshAuthenticate(session, &params, error, sizeof(error));
  if (authMethod == NULL) {
    sessionDestroy(session);
    return responseJsonError(writer, NQ_HTTP_UNAUTHORIZED, error);
  }

  /* One cheap round trip that also proves the remote side has a usable /proc. */
  ExecResult uname;
  execResultInit(&uname);
  bool probed = sshExec(session, "uname -snrm && test -r /proc/self/smaps", &uname, error, sizeof(error));
  if (probed && uname.exitStatus != 0) {
    NQSnprintf(error, sizeof(error), "Remote host has no readable /proc/<pid>/smaps (Linux required)");
    probed = false;
  }
  if (!probed) {
    execResultFinalize(&uname);
    sessionDestroy(session);
    return responseJsonError(writer, NQ_HTTP_BAD_GATEWAY, error);
  }
  char* unameText = (char*)NQByteBuffer_data(&uname.out);
  trimRight(unameText);
  char* unameEol = NQStrchr(unameText, '\n');
  if (unameEol != NULL)
    *unameEol = '\0';

  int keyType = LIBSSH2_HOSTKEY_TYPE_UNKNOWN;
  size_t keyLen = 0;
  (void)libssh2_session_hostkey(session->ssh, &keyLen, &keyType);
  char fingerprint[64];
  hostKeyFingerprint(session->ssh, fingerprint, sizeof(fingerprint));
  const char* banner = libssh2_session_banner_get(session->ssh);

  if (!sessionInsert(session)) {
    execResultFinalize(&uname);
    sessionDestroy(session);
    return responseJsonError(writer, NQ_HTTP_SERVICE_UNAVAILABLE, "Too many open SSH sessions, try again later");
  }

  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyString(writer, "session", session->id);
  NQJSONWriter_writeKeyString(writer, "host", params.host);
  NQJSONWriter_writeKeyInt32(writer, "port", params.port);
  NQJSONWriter_writeKeyString(writer, "user", params.user);
  NQJSONWriter_writeKeyString(writer, "auth_method", authMethod);
  NQJSONWriter_writeKeyString(writer, "hostkey_type", hostKeyTypeName(keyType));
  NQJSONWriter_writeKeyString(writer, "fingerprint", fingerprint);
  if (banner != NULL)
    NQJSONWriter_writeKeyString(writer, "banner", banner);
  NQJSONWriter_writeKeyString(writer, "uname", unameText);
  NQJSONWriter_writeKeyString(writer, "libssh2_version", libssh2_version(0));
  NQJSONWriter_writeObjectEnd(writer);

  execResultFinalize(&uname);
  return responseFinish(writer);
}

/* --------------------------------------------------------------- processes */

/*
 * POSIX sh, so busybox targets work too. Prints the user table, then one
 * record per process: "@<pid>", its status file, and "#<cmdline>" with the
 * NUL separators turned into spaces. Processes that exit mid-walk just leave
 * an empty record behind, which the parser skips.
 */
static const char kProcessesCommand[] =
  "echo '@@passwd'; (getent passwd || cat /etc/passwd) 2>/dev/null; "
  "cd /proc || exit 2; "
  "for p in [0-9]*; do "
  "echo \"@$p\"; cat \"$p/status\" 2>/dev/null; "
  "printf '#'; tr '\\000' ' ' < \"$p/cmdline\" 2>/dev/null; echo; "
  "done";

typedef struct UserEntry UserEntry;
struct UserEntry {
  uint64_t uid;
  const char* name;
};

typedef struct ProcessInfo ProcessInfo;
struct ProcessInfo {
  uint64_t pid;
  const char* name;
  const char* state;
  const char* cmdline;
  uint64_t ppid;
  uint64_t uid;
  uint64_t threads;
  uint64_t rss;
  uint64_t swap;
  bool hasUid;
  bool hasRss;
};

static const char* userName(const UserEntry* users, size_t count, uint64_t uid)
{
  for (size_t i = 0; i < count; ++i) {
    if (users[i].uid == uid)
      return users[i].name;
  }
  return NULL;
}

static void processWrite(NQJSONWriter* writer, const ProcessInfo* proc, const UserEntry* users, size_t userCount)
{
  /* Gone before its status could be read. */
  if (proc->name == NULL)
    return;

  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyUint64(writer, "pid", proc->pid);
  NQJSONWriter_writeKeyUint64(writer, "ppid", proc->ppid);
  NQJSONWriter_writeKeyString(writer, "name", proc->name);
  if (proc->state != NULL)
    NQJSONWriter_writeKeyString(writer, "state", proc->state);
  if (proc->hasUid) {
    NQJSONWriter_writeKeyUint64(writer, "uid", proc->uid);
    const char* user = userName(users, userCount, proc->uid);
    if (user != NULL)
      NQJSONWriter_writeKeyString(writer, "user", user);
  }
  NQJSONWriter_writeKeyUint64(writer, "threads", proc->threads);
  if (proc->hasRss) {
    NQJSONWriter_writeKeyUint64(writer, "rss_kb", proc->rss);
    NQJSONWriter_writeKeyUint64(writer, "swap_kb", proc->swap);
  }
  NQJSONWriter_writeKeyString(writer, "cmdline", proc->cmdline != NULL ? proc->cmdline : "");
  /* Kernel threads have no user address space, hence nothing to track. */
  NQJSONWriter_writeKeyBool(writer, "kernel_thread", !proc->hasRss && (proc->cmdline == NULL || proc->cmdline[0] == '\0'));
  NQJSONWriter_writeObjectEnd(writer);
}

static int processesWrite(char* text, NQJSONWriter* writer)
{
  UserEntry* users = NULL;
  size_t userCount = 0;
  size_t userCapacity = 0;

  char* cursor = text;
  char* line = nextLine(&cursor);

  /* "name:x:uid:gid:..." lines up to the first process record. */
  if (line != NULL && NQStrcmp(line, "@@passwd") == 0) {
    while ((line = nextLine(&cursor)) != NULL && line[0] != '@') {
      char* nameEnd = NQStrchr(line, ':');
      char* uidField = nameEnd != NULL ? NQStrchr(nameEnd + 1, ':') : NULL;
      if (uidField == NULL)
        continue;
      *nameEnd = '\0';
      char* end = NULL;
      uint64_t uid = NQSimpleStrtoull(uidField + 1, &end, 10);
      if (end == uidField + 1)
        continue;
      if (userCount == userCapacity) {
        size_t capacity = userCapacity == 0 ? 64 : userCapacity * 2;
        UserEntry* grown = (UserEntry*)NQRealloc(users, capacity * sizeof(*users));
        if (grown == NULL)
          break;
        users = grown;
        userCapacity = capacity;
      }
      users[userCount].uid = uid;
      users[userCount].name = line;
      userCount++;
    }
  }

  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyInt64(writer, "time", NQGetTimeMs());
  NQJSONWriter_writeKeyArrayBegin(writer, "processes");

  ProcessInfo proc;
  NQMemset(&proc, 0, sizeof(proc));
  bool open = false;

  for (; line != NULL; line = nextLine(&cursor)) {
    if (line[0] == '@') {
      if (open)
        processWrite(writer, &proc, users, userCount);
      NQMemset(&proc, 0, sizeof(proc));
      proc.pid = NQSimpleStrtoull(line + 1, NULL, 10);
      open = true;
      continue;
    }
    if (!open)
      continue;
    if (line[0] == '#') {
      proc.cmdline = line + 1;
      trimRight(line + 1);
      continue;
    }

    char* key;
    char* value;
    if (!splitField(line, &key, &value))
      continue;

    if (NQStrcmp(key, "Name") == 0) {
      proc.name = value;
    } else if (NQStrcmp(key, "State") == 0) {
      proc.state = value;
    } else if (NQStrcmp(key, "PPid") == 0) {
      proc.ppid = NQSimpleStrtoull(value, NULL, 10);
    } else if (NQStrcmp(key, "Uid") == 0) {
      /* Real uid first; effective, saved and fs uids follow. */
      proc.uid = NQSimpleStrtoull(value, NULL, 10);
      proc.hasUid = true;
    } else if (NQStrcmp(key, "Threads") == 0) {
      proc.threads = NQSimpleStrtoull(value, NULL, 10);
    } else if (NQStrcmp(key, "VmRSS") == 0) {
      proc.hasRss = parseCount(value, &proc.rss);
    } else if (NQStrcmp(key, "VmSwap") == 0) {
      (void)parseCount(value, &proc.swap);
    }
  }
  if (open)
    processWrite(writer, &proc, users, userCount);

  NQJSONWriter_writeArrayEnd(writer);
  NQJSONWriter_writeObjectEnd(writer);

  NQFree(users);
  return responseFinish(writer);
}

/* ------------------------------------------------------------------ sample */

/* Every per-mapping counter smaps can carry, in kB; older kernels print a subset. */
static const struct {
  const char* smaps;
  const char* json;
} kSmapsFields[] = {
  { "Size", "size" },
  { "Rss", "rss" },
  { "Pss", "pss" },
  { "Pss_Dirty", "pss_dirty" },
  { "Pss_Anon", "pss_anon" },
  { "Pss_File", "pss_file" },
  { "Pss_Shmem", "pss_shmem" },
  { "Shared_Clean", "shared_clean" },
  { "Shared_Dirty", "shared_dirty" },
  { "Private_Clean", "private_clean" },
  { "Private_Dirty", "private_dirty" },
  { "Referenced", "referenced" },
  { "Anonymous", "anonymous" },
  { "KSM", "ksm" },
  { "LazyFree", "lazy_free" },
  { "AnonHugePages", "anon_huge_pages" },
  { "ShmemPmdMapped", "shmem_pmd_mapped" },
  { "FilePmdMapped", "file_pmd_mapped" },
  { "Shared_Hugetlb", "shared_hugetlb" },
  { "Private_Hugetlb", "private_hugetlb" },
  { "Swap", "swap" },
  { "SwapPss", "swap_pss" },
  { "Locked", "locked" },
};

#define SMAPS_FIELD_COUNT (sizeof(kSmapsFields) / sizeof(kSmapsFields[0]))

/* All mappings of one backing object (a file, [heap], anonymous memory, ...) summed. */
typedef struct MemComponent MemComponent;
struct MemComponent {
  const char* name;
  const char* kind;
  uint32_t count;
  uint64_t values[SMAPS_FIELD_COUNT];
};

typedef struct SmapsSummary SmapsSummary;
struct SmapsSummary {
  MemComponent* items;
  size_t count;
  size_t capacity;
  MemComponent totals;
  uint32_t present;
};

static int smapsFieldIndex(const char* key)
{
  for (size_t i = 0; i < SMAPS_FIELD_COUNT; ++i) {
    if (NQStrcmp(kSmapsFields[i].smaps, key) == 0)
      return (int)i;
  }
  return -1;
}

static bool hasSharedObjectName(const char* path)
{
  const char* base = NQStrrchr(path, '/');
  const char* so = NQStrstr(base != NULL ? base : path, ".so");
  return so != NULL && (so[3] == '\0' || so[3] == '.' || so[3] == ' ');
}

/* Coarse category, so the client can group and colour components. */
static const char* mappingKind(const char* name)
{
  if (name[0] == '\0' || NQCStrStartsWith(name, "[anon:"))
    return "anon";
  if (NQStrcmp(name, "[heap]") == 0)
    return "heap";
  if (NQCStrStartsWith(name, "[stack"))
    return "stack";
  if (NQCStrStartsWith(name, "[anon_shmem") || NQCStrStartsWith(name, "/memfd:")
      || NQCStrStartsWith(name, "/dev/shm/") || NQCStrStartsWith(name, "/SYSV"))
    return "shmem";
  if (name[0] == '[')
    return "kernel";
  if (name[0] == '/')
    return hasSharedObjectName(name) ? "library" : "file";
  return "other";
}

/* "start-end perms offset dev inode [path]" — told apart from "Key: value" lines by its first token. */
static bool isMappingHeader(const char* line)
{
  const char* p = line;
  bool dash = false;
  while (*p != '\0' && *p != ' ') {
    if (*p == '-')
      dash = true;
    p++;
  }
  return dash && p > line && p[-1] != ':';
}

static char* mappingName(char* header)
{
  char* p = header;
  for (int field = 0; field < 5; ++field) {
    while (*p != '\0' && *p != ' ')
      p++;
    while (*p == ' ')
      p++;
  }
  trimRight(p);
  return p;
}

static MemComponent* smapsComponent(SmapsSummary* summary, const char* name)
{
  /* Consecutive mappings usually belong to the same object, so check the last one first. */
  if (summary->count > 0 && NQStrcmp(summary->items[summary->count - 1].name, name) == 0)
    return &summary->items[summary->count - 1];
  for (size_t i = 0; i < summary->count; ++i) {
    if (NQStrcmp(summary->items[i].name, name) == 0)
      return &summary->items[i];
  }

  if (summary->count == summary->capacity) {
    size_t capacity = summary->capacity == 0 ? 128 : summary->capacity * 2;
    MemComponent* grown = (MemComponent*)NQRealloc(summary->items, capacity * sizeof(*grown));
    if (grown == NULL)
      return NULL;
    summary->items = grown;
    summary->capacity = capacity;
  }

  MemComponent* component = &summary->items[summary->count++];
  NQMemset(component, 0, sizeof(*component));
  component->name = name;
  component->kind = mappingKind(name);
  return component;
}

static void memComponentWriteValues(NQJSONWriter* writer, const MemComponent* component, uint32_t present)
{
  NQJSONWriter_writeKeyUint32(writer, "count", component->count);
  for (size_t i = 0; i < SMAPS_FIELD_COUNT; ++i) {
    if (present & (1u << i))
      NQJSONWriter_writeKeyUint64(writer, kSmapsFields[i].json, component->values[i]);
  }
}

/* status lines worth plotting: the Vm*, Rss* and Hugetlb* sizes plus a couple of counts. */
static bool isStatusMemoryKey(const char* key)
{
  return NQCStrStartsWith(key, "Vm") || NQCStrStartsWith(key, "Rss") || NQCStrStartsWith(key, "Hugetlb")
         || NQStrcmp(key, "Threads") == 0 || NQStrcmp(key, "FDSize") == 0;
}

static int sampleWrite(char* text, uint64_t pid, NQTimeMs started, NQJSONWriter* writer)
{
  enum { SECTION_NONE, SECTION_STATUS, SECTION_SMAPS, SECTION_MEMINFO } section = SECTION_NONE;

  SmapsSummary summary;
  NQMemset(&summary, 0, sizeof(summary));
  MemComponent* current = NULL;

  const char* name = NULL;
  const char* state = NULL;

  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyUint64(writer, "pid", pid);
  NQJSONWriter_writeKeyInt64(writer, "time", started);

  /* status and meminfo are written as they are read; smaps is summed and written after. */
  char* cursor = text;
  char* line;
  while ((line = nextLine(&cursor)) != NULL) {
    if (line[0] == '@' && line[1] == '@') {
      if (section == SECTION_STATUS || section == SECTION_MEMINFO)
        NQJSONWriter_writeObjectEnd(writer);
      if (NQStrcmp(line, "@@status") == 0) {
        section = SECTION_STATUS;
        NQJSONWriter_writeKeyObjectBegin(writer, "status");
      } else if (NQStrcmp(line, "@@smaps") == 0) {
        section = SECTION_SMAPS;
      } else if (NQStrcmp(line, "@@meminfo") == 0) {
        section = SECTION_MEMINFO;
        NQJSONWriter_writeKeyObjectBegin(writer, "meminfo");
      } else {
        section = SECTION_NONE;
      }
      continue;
    }

    if (section == SECTION_SMAPS && isMappingHeader(line)) {
      current = smapsComponent(&summary, mappingName(line));
      if (current != NULL)
        current->count++;
      summary.totals.count++;
      continue;
    }

    char* key;
    char* value;
    if (!splitField(line, &key, &value))
      continue;
    uint64_t count;

    switch (section) {
    case SECTION_STATUS:
      if (NQStrcmp(key, "Name") == 0)
        name = value;
      else if (NQStrcmp(key, "State") == 0)
        state = value;
      else if (isStatusMemoryKey(key) && parseCount(value, &count))
        NQJSONWriter_writeKeyUint64(writer, key, count);
      break;
    case SECTION_MEMINFO:
      if (parseCount(value, &count))
        NQJSONWriter_writeKeyUint64(writer, key, count);
      break;
    case SECTION_SMAPS: {
      int index = smapsFieldIndex(key);
      if (index < 0 || !parseCount(value, &count))
        break;
      summary.present |= 1u << index;
      summary.totals.values[index] += count;
      if (current != NULL)
        current->values[index] += count;
      break;
    }
    default:
      break;
    }
  }
  if (section == SECTION_STATUS || section == SECTION_MEMINFO)
    NQJSONWriter_writeObjectEnd(writer);

  if (name != NULL)
    NQJSONWriter_writeKeyString(writer, "name", name);
  if (state != NULL)
    NQJSONWriter_writeKeyString(writer, "state", state);
  NQJSONWriter_writeKeyInt64(writer, "elapsed_ms", NQGetTimeMs() - started);

  NQJSONWriter_writeKeyArrayBegin(writer, "fields");
  for (size_t i = 0; i < SMAPS_FIELD_COUNT; ++i) {
    if (summary.present & (1u << i))
      NQJSONWriter_writeString(writer, kSmapsFields[i].json);
  }
  NQJSONWriter_writeArrayEnd(writer);

  NQJSONWriter_writeKeyObjectBegin(writer, "totals");
  memComponentWriteValues(writer, &summary.totals, summary.present);
  NQJSONWriter_writeObjectEnd(writer);

  NQJSONWriter_writeKeyArrayBegin(writer, "components");
  for (size_t i = 0; i < summary.count; ++i) {
    const MemComponent* component = &summary.items[i];
    NQJSONWriter_writeObjectBegin(writer);
    NQJSONWriter_writeKeyString(writer, "name", component->name[0] != '\0' ? component->name : "[anon]");
    NQJSONWriter_writeKeyString(writer, "kind", component->kind);
    memComponentWriteValues(writer, component, summary.present);
    NQJSONWriter_writeObjectEnd(writer);
  }
  NQJSONWriter_writeArrayEnd(writer);

  NQJSONWriter_writeObjectEnd(writer);

  NQFree(summary.items);
  return responseFinish(writer);
}

/* --------------------------------------------------------------- dispatch */

typedef enum ApiMethod {
  API_PROCESSES,
  API_SAMPLE,
} ApiMethod;

/* processes / sample: one remote command on an existing session, parsed into JSON. */
static int sessionCommandRespond(const NQJSON* root, ApiMethod method, NQJSONWriter* writer)
{
  const char* id = optionalString(root, "session");
  if (id == NULL || id[0] == '\0')
    return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"session\" is required");

  int64_t pid = 0;
  char command[512];
  if (method == API_SAMPLE) {
    if (!NQJSON_objectGetInt64(root, "pid", &pid) || pid < 1 || pid > NQ_INT32_MAX)
      return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"pid\" must be a positive integer");
    NQSnprintf(command, sizeof(command),
               "p=/proc/%lld; "
               "[ -d $p ] || { echo 'Process %lld is not running' >&2; exit 3; }; "
               "echo '@@status'; cat $p/status || exit 4; "
               "echo '@@smaps'; cat $p/smaps || exit 5; "
               "echo '@@meminfo'; cat /proc/meminfo",
               (long long)pid, (long long)pid);
  }

  SshSession* session = sessionAcquire(id);
  if (session == NULL)
    return responseJsonError(writer, NQ_HTTP_NOT_FOUND, "SSH session expired or not found, connect again");

  NQTimeMs started = NQGetTimeMs();
  char error[512];
  ExecResult result;
  execResultInit(&result);

  NQMutex_lock(&session->lock);
  bool ok = sshExec(session, method == API_SAMPLE ? command : kProcessesCommand, &result, error, sizeof(error));
  NQMutex_unlock(&session->lock);

  int status;
  if (!ok) {
    /* A transport failure leaves the session unusable; let the client reconnect. */
    sessionClose(session);
    status = responseJsonError(writer, NQ_HTTP_BAD_GATEWAY, error);
  } else if (result.exitStatus != 0) {
    execFailureMessage(&result, error, sizeof(error));
    status = responseJsonError(writer, NQ_HTTP_PRECONDITION_FAILED, error);
  } else if (method == API_SAMPLE) {
    status = sampleWrite((char*)NQByteBuffer_data(&result.out), (uint64_t)pid, started, writer);
  } else {
    status = processesWrite((char*)NQByteBuffer_data(&result.out), writer);
  }

  execResultFinalize(&result);
  sessionRelease(session);
  return status;
}

static int disconnectRespond(const NQJSON* root, NQJSONWriter* writer)
{
  const char* id = optionalString(root, "session");
  if (id == NULL || id[0] == '\0')
    return responseJsonError(writer, NQ_HTTP_BAD_REQUEST, "\"session\" is required");

  SshSession* session = sessionAcquire(id);
  bool found = session != NULL;
  if (found) {
    sessionClose(session);
    sessionRelease(session);
  }

  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyBool(writer, "closed", found);
  NQJSONWriter_writeObjectEnd(writer);
  return responseFinish(writer);
}

/*
 * The endpoint: one POST to SMAPSTRACK_API_URL whose body names the "method"
 * — connect, processes, sample or disconnect — next to its arguments.
 */
static int requestApiHandler(NQWebRequest* request, NQWebResponse* response)
{
  RequestContext* ctx = (RequestContext*)request->userdata;

  NQWebResponse_setHeader(response, NQHTTP_HEADER_CONTENT_TYPE, NQ_MEDIATYPE_APPLICATION_JSON);

  NQJSONWriter writer;
  NQJSONWriter_init(&writer, &responseJsonWrite, response);

  int status = NQ_HTTP_OK;
  NQJSON* root = requestBodyDecode(ctx, &writer, &status);
  if (root == NULL)
    return status;

  sessionsReap(false);

  const char* method = optionalString(root, "method");
  if (method == NULL)
    status = responseJsonError(&writer, NQ_HTTP_BAD_REQUEST, "\"method\" is required");
  else if (NQStrcmp(method, "connect") == 0)
    status = connectRespond(root, &writer);
  else if (NQStrcmp(method, "processes") == 0)
    status = sessionCommandRespond(root, API_PROCESSES, &writer);
  else if (NQStrcmp(method, "sample") == 0)
    status = sessionCommandRespond(root, API_SAMPLE, &writer);
  else if (NQStrcmp(method, "disconnect") == 0)
    status = disconnectRespond(root, &writer);
  else
    status = responseJsonError(&writer, NQ_HTTP_BAD_REQUEST, "Unknown \"method\"");

  NQJSON_release(root);
  return status;
}

static const NQWebRequestOperations kApiOps = {
  .init = requestBodyInit,
  .receive = requestBodyReceive,
  .handler = requestApiHandler,
  .release = requestBodyRelease,
};

static int executorInit(NQWebExecutor* executor, void* data)
{
  NQ_UNUSED_PARAM(data);

  struct WebSmapstrackExecutor* smapstrack = (struct WebSmapstrackExecutor*)executor;

  NQLibraryInfo info;
  int ret = NQLibraryInfoLoad(&info, &executorInit);
  if (ret != 0)
    return ret;

  NQPath* manifest = NQPath_join3(info.filename, "../../" SMAPSTRACK_ASSETS_DIR, NQ_WEBMANIFEST_FILE);
  NQLibraryInfoFinalize(&info);
  if (manifest == NULL) {
    return -NQ_ENOMEM;
  }

  ret = NQWebManifestListenersInit(executor, &smapstrack->manifestListeners, NQPath_characters(manifest));
  NQPath_destroy(manifest);
  if (ret != 0) {
    return ret;
  }

  ret = NQWebExecutor_addRequestListener(&smapstrack->executor, &smapstrack->apiListener, &kApiOps, smapstrack, NQ_HTTP_POST, SMAPSTRACK_API_URL);
  if (ret != 0) {
    NQWebManifestListenersFinalize(&smapstrack->executor, &smapstrack->manifestListeners);
    return ret;
  }

  return ret;
}

static void executorRelease(NQWebExecutor* executor)
{
  struct WebSmapstrackExecutor* smapstrack = (struct WebSmapstrackExecutor*)executor;
  NQWebExecutor_removeRequestListener(&smapstrack->executor, &smapstrack->apiListener);
  NQWebManifestListenersFinalize(&smapstrack->executor, &smapstrack->manifestListeners);
  sessionsReap(true);
}

static struct NQWebExecutorOperations s_executorOps = {
  .name = "smapstrack",
  .init = executorInit,
  .release = executorRelease,
  .size = sizeof(struct WebSmapstrackExecutor),
};

static int moduleInit(NQContext* context)
{
  NQ_UNUSED_PARAM(context);

  int ret = libssh2_init(0);
  if (ret != 0)
    return -NQ_EIO;

  NQWebExecutorRegister(&s_executorOps);
  return 0;
}

static void moduleExit(NQContext* context)
{
  NQ_UNUSED_PARAM(context);

  NQWebExecutorUnregister(&s_executorOps);
  sessionsReap(true);
  libssh2_exit();
}

NQ_MODULE_INIT(moduleInit);
NQ_MODULE_EXIT(moduleExit);
