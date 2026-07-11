// CSP nonce for webview scripts, shared by the visual editor and the
// Review Changes (redline) panel.

import { randomBytes } from 'crypto';

export function makeNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}
