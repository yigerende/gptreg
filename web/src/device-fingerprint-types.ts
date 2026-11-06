import type { PageInfo } from './components/Pagination';

export type DeviceFingerprint = {
  id: string; email: string; archived: boolean; lifecycle: string; status: string;
  createdAt: string; sourceRunId: string; countryCode: string;
  fingerprint: string; deviceId: string; fingerprintAccounts: number; deviceAccounts: number;
  profile: {
    schemaVersion: number | null; browser: string; browserVersion: string; userAgent: string;
    platform: string; oscpu: string; language: string; languages: string[];
    acceptLanguage: string; timeZone: string; hardwareConcurrency: number | null;
    maxTouchPoints: number | null; storageQuotaBytes: number | null;
    screen: Record<string, number>; viewport: Record<string, number>;
    gpu: { vendor: string; renderer: string };
  };
};
export type DeviceFingerprintFilter = 'all' | 'fingerprint' | 'device' | 'missing';
export type DeviceFingerprintPage = PageInfo & {
  items: DeviceFingerprint[];
  summary: {
    total: number; uniqueFingerprints: number; uniqueDeviceIds: number;
    duplicateFingerprintGroups: number; duplicateFingerprintAccounts: number;
    duplicateDeviceAccounts: number; missing: number; unreadable: number;
  };
};
