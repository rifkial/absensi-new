'use strict';

/* Cek struktur kolom device_id & is_wrong_device setelah migrate. */

const db = require('../src/db/pool');

(async () => {
  const cols = await db.queryAll("SHOW COLUMNS FROM employees LIKE 'device_id'");
  console.log('employees.device_id:', JSON.stringify(cols));

  const flag = await db.queryAll("SHOW COLUMNS FROM attendance_daily LIKE 'is_wrong_device'");
  console.log('attendance_daily.is_wrong_device:', JSON.stringify(flag));

  const fks = await db.queryAll(
    `SELECT tc.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_NAME
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'employees'
        AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`
  );
  console.log('FK employees:', fks.map((r) => `${r.CONSTRAINT_NAME} -> ${r.REFERENCED_TABLE_NAME}`).join(', '));

  await db.closePool();
  process.exit(0);
})().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
