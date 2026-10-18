import { describe, expect, it } from 'vitest';
import { createCallbackServer } from '../src/auth.js';

describe('OAuth callback page', () => {
  it.each([
    ['success', 200, 'Sign-in complete'],
    ['error', 400, 'Sign-in could not be completed'],
  ] as const)('returns a private %s callback page', async (status, expectedStatus, title) => {
    const callback = createCallbackServer();
    await callback.start();
    try {
      const browserResponse = fetch(`${callback.redirectUri}?code=authorization-code&state=callback-state`);
      const result = await callback.waitForCallback();
      expect(result.params.get('code')).toBe('authorization-code');
      result.respond(status);

      const response = await browserResponse;
      const page = await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      expect(page).toContain(`<title>${title}</title>`);
      expect(page).toContain("window.addEventListener('load'");
      expect(page).toContain("history.replaceState(null,'',window.location.pathname+window.location.hash)");
      expect(page).not.toContain('authorization-code');
      expect(page).not.toContain('callback-state');
    } finally {
      callback.close();
    }
  });
});
