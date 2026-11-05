import { describe, expect, it } from 'vitest';

import { exportFileName, exportTimestamp, oauthLabel } from './export-file-name';

describe('exportFileName', () => {
  it('names a download by type, OAuth state, count and zero-padded local minute', () => {
    const at = new Date(2026, 9, 8, 23, 0);
    expect(exportTimestamp(at)).toBe('26-10-08-23-00');
    expect(exportFileName({ label: 'CPA', count: 100, at, ext: 'json' })).toBe('CPA-已OAuth-100个-26-10-08-23-00.json');
    expect(exportFileName({ label: '凭证', count: 3, at: new Date(2026, 0, 5, 7, 4), ext: 'txt' })).toBe('凭证-已OAuth-3个-26-01-05-07-04.txt');
  });

  it('carries what an export was restricted to, such as a registration country', () => {
    const at = new Date(2026, 9, 14, 13, 55);
    expect(exportFileName({ label: 'CPA', count: 2, at, ext: 'json', tag: 'US' })).toBe('CPA-US-已OAuth-2个-26-10-14-13-55.json');
    expect(exportFileName({ label: '凭证', count: 1, at, ext: 'txt', tag: '未知注册国' })).toBe('凭证-未知注册国-已OAuth-1个-26-10-14-13-55.txt');
    // Characters a Windows file name cannot hold never reach it.
    expect(exportFileName({ label: 'CPA', count: 1, at, ext: 'json', tag: 'a/b:c?' })).toBe('CPA-abc-已OAuth-1个-26-10-14-13-55.json');
    expect(exportFileName({ label: 'CPA', count: 1, at, ext: 'json', tag: '' })).toBe('CPA-已OAuth-1个-26-10-14-13-55.json');
  });

  it('says when a file holds accounts that never went through OAuth', () => {
    expect(oauthLabel(0, 4)).toBe('未OAuth');
    expect(oauthLabel(6, 4)).toBe('已OAuth6-未OAuth4');
    const at = new Date(2026, 9, 8, 23, 0);
    expect(exportFileName({ label: 'AT', count: 4, oauth: 0, pending: 4, at, ext: 'txt' })).toBe('AT-未OAuth-4个-26-10-08-23-00.txt');
  });
});
