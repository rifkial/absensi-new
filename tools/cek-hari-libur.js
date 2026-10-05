'use strict';

/* Pemeriksaan manual fitur hari libur (dipakai developer, bukan test). */

const h = require('../src/services/holidays');
const db = require('../src/db/pool');

(async () => {
  await db.execute(
    "UPDATE holidays SET source = 'manual', is_workday = 1 WHERE holiday_date = '2026-01-01'"
  );

  const again = await h.syncYear(2026);
  console.log('sync ulang:', again.message);

  const row = await h.getByDate('2026-01-01');
  console.log('baris manual dipertahankan:', row.source, 'is_workday =', row.is_workday);

  const map = await h.mapForRange('2026-01-01', '2026-01-31');
  console.log('peta libur Januari:', [...map.keys()]);

  const upcoming = await h.upcoming(20);
  console.log('upcoming:', upcoming.map((r) => `${r.holiday_date} ${r.name}`));

  await db.execute("UPDATE holidays SET source = 'sync', is_workday = 0 WHERE holiday_date = '2026-01-01'");
  h.invalidateCache();
  process.exit(0);
})().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
