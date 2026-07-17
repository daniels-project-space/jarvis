import type { AuthConfig } from "convex/server";

// Browser read access uses a short-lived ES256 identity minted only after the
// trusted-device cookie is checked at the Jarvis origin. Convex verifies this
// JWT once at the connection boundary, so reactive queries no longer perform
// an extra viewerSessions document read on every rerun.
export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "jarvis-convex",
      issuer: "https://jarvis-orcin-six.vercel.app",
      jwks: "data:text/plain;charset=utf-8;base64,eyJrZXlzIjpbeyJrdHkiOiJFQyIsIngiOiI3aXYtamItc3VpMHNad2hNaHNUUnBHZkRRd0tXb0pndTVFanJBRGlubFhrIiwieSI6IjBEeTNTOTdoMllTSGdJd2poMnhZQ0ZMM1JlTjlIaFdobXF6aU1VWU43dUUiLCJjcnYiOiJQLTI1NiIsImtpZCI6ImJfRVlKaVM1TnUwZ3hKR2xXRGxfcmVaSnRBTlR3SFI2bVNzTVhjOEtfWmsiLCJhbGciOiJFUzI1NiIsInVzZSI6InNpZyJ9XX0=",
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
