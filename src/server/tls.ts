import type { SettingsAccess } from './settings.js';

type TlsSettings = Partial<Pick<SettingsAccess, 'isInsecureTlsEnabled'>>;

export function masterTlsEnv(settings?: TlsSettings) {
  if (typeof settings?.isInsecureTlsEnabled !== 'function' || !settings.isInsecureTlsEnabled()) return {};
  return {
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    UNSAFE_SSL: 'true',
    TRINO_INSECURE_TLS: 'true',
    TRINO_TLS_INSECURE: 'true',
    STARBURST_INSECURE_TLS: 'true',
    STARBURST_TLS_INSECURE: 'true'
  };
}

export function fetchWithMasterTls(settings: TlsSettings, input: RequestInfo | URL, init: RequestInit = {}) {
  applyMasterTls(settings);
  return fetch(input, init);
}

export function applyMasterTls(settings: TlsSettings) {
  if (typeof settings.isInsecureTlsEnabled === 'function' && settings.isInsecureTlsEnabled()) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}
