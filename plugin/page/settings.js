/* This bridge replaces the WHOLE options object and retires Magpie's shared
 * host. Merge only launcher fields over a fresh official options.get result.
 * Network options (including a saved secret) and unknown keys remain untouched.
 */
(function (root) {
  "use strict";
  function mergeLaunch(base, patch) {
    var source = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    var merged = {};
    Object.keys(source).forEach(function (key) { merged[key] = source[key]; });
    var previous = source.consoleLaunch;
    var launch = {};
    if (previous && typeof previous === "object" && !Array.isArray(previous)) {
      Object.keys(previous).forEach(function (key) { launch[key] = previous[key]; });
    }
    if (typeof patch.autoOpen === "boolean") launch.autoOpen = patch.autoOpen;
    if (patch.request) launch.request = {
      nonce: patch.request.nonce, issuedAt: patch.request.issuedAt, expiresAt: patch.request.expiresAt,
    };
    if (patch.approval) launch.approval = {
      id: patch.approval.id, code: patch.approval.code,
      issuedAt: patch.approval.issuedAt, expiresAt: patch.approval.expiresAt,
    };
    merged.consoleLaunch = launch;
    return merged;
  }
  root.OHMYAIHUB_SETTINGS = { mergeLaunch: mergeLaunch };
})(typeof window !== "undefined" ? window : globalThis);
