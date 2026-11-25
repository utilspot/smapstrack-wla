/**
 * The SSH target the build locked the app to (`endpoint` in config.json), with
 * host 0.0.0.0 replaced by the hostname this page was loaded from; null when
 * the user picks one in the connect form.
 */
export const FIXED_ENDPOINT = __ENDPOINT__ && {
  ...__ENDPOINT__,
  host: __ENDPOINT__.host === '0.0.0.0' ? window.location.hostname : __ENDPOINT__.host,
};

/** How long to wait before connecting to the fixed endpoint again after a failure. */
export const RECONNECT_MS = 5000;
