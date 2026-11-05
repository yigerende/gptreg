import assert from 'node:assert/strict';
import {test} from 'vitest';
import {shiftPeriod} from './report-period';
test('period navigation normalizes month and year without rollover',()=>{
 assert.equal(shiftPeriod('2024-01-31','month',1),'2024-02-01');
 assert.equal(shiftPeriod('2024-02-29','year',1),'2025-01-01');
 assert.equal(shiftPeriod('2026-01-01','day',-1),'2025-12-31');
 assert.equal(shiftPeriod('2026-01-01','week',-1),'2025-12-25');
 assert.equal(shiftPeriod('1900-01-01','day',-1),'1900-01-01');
 assert.equal(shiftPeriod('9998-12-31','year',1),'9998-12-31');
});
