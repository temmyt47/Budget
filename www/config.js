// Build settings for the phone apps. The web copy served by the sync server gets
// its own version of this file from the server; the Claude artifact ignores it.
window.SAFE_CONFIG = {
  server: "",             // your sync server, e.g. "https://api.safetospend.app"; blank = the app asks
  requireAccount: false,  // true for the paid app: sign-in and an active trial or subscription are required
  checkoutInApp: true,    // false for App Store / Play builds: no prices or purchase links inside the app
  supportEmail: ""        // shown on the sign-in and subscription screens
};
