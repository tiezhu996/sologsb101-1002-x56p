/* eslint-disable no-console */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let passed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name} ${extra}`);
  }
}

async function buildV2(): Promise<void> {
  // 按旧版 v2 schema 建库并写入旧格式数据（无 origin* / baselineCurrentA / redispatchCount / revision=3 语义）
  const v2 = new Dexie('gbpvstring');
  v2.version(2).stores({
    plants: 'id, name, gridDate, latitude, capacityMWp',
    arrays: 'id, plantId, code, capacityKw',
    inverters: 'id, arrayId, model, ratedKw',
    strings: 'id, inverterId, combinerBox, code, moduleModel',
    samples: 'id, stringId, sampledAt, [stringId+sampledAt]',
    disposals: 'id, stringId, state, type, owner, dueDate',
    settings: 'id',
  });
  await v2.table('plants').bulkPut([
    { id: 'p1', name: '旧电站', capacityMWp: 1, gridDate: '2020-01-01', latitude: 30, createdAt: 't' },
  ]);
  await v2.table('arrays').bulkPut([
    { id: 'a1', plantId: 'p1', code: 'A1', tiltDeg: 20, azimuthDeg: 180, capacityKw: 100, createdAt: 't' },
  ]);
  await v2.table('inverters').bulkPut([
    { id: 'old-inv', arrayId: 'a1', model: 'OLD', ratedKw: 100, mpptCount: 4, commissionDate: '2020-01-01', createdAt: 't' },
  ]);
  await v2.table('strings').bulkPut([
    { id: 's1', inverterId: 'old-inv', combinerBox: 'BX-09', code: '09-01', moduleModel: 'M', seriesCount: 26, createdAt: 't', revision: 2 },
    { id: 's2', inverterId: 'old-inv', combinerBox: 'BX-09', code: '09-02', moduleModel: 'M', seriesCount: 24, createdAt: 't', revision: 2 },
  ]);
  await v2.table('samples').bulkPut([
    { id: 'sm1', stringId: 's1', sampledAt: '2026-09-01 10:00', currentA: 9, voltageV: 1000, irradianceWm2: 900, discreteRate: 3, createdAt: 't', revision: 2 },
  ]);
  // 旧处置单：已复测（无 baselineCurrentA）+ 未完成
  await v2.table('disposals').bulkPut([
    { id: 'd-done', stringId: 's1', type: 'retest', state: 'retested', owner: '甲', dueDate: '2026-09-01', retestCurrentA: 9.1, initialDiscreteRate: 12, createdAt: 't', updatedAt: 't', revision: 2 },
    { id: 'd-open', stringId: 's2', type: 'clean', state: 'assigned', owner: '乙', dueDate: '2026-12-01', retestCurrentA: null, initialDiscreteRate: 7, createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  await v2.close();
}

async function main(): Promise<void> {
  await buildV2();
  // 以当前模块打开 → 触发 v3 upgrade
  const { initDatabase, db, DB_SCHEMA_VERSION } = await import('../src/utils/db');
  await initDatabase();
  check('结构版本升到 v3', DB_SCHEMA_VERSION === 3);

  const s1 = await db.strings.get('s1');
  const s2 = await db.strings.get('s2');
  check('旧组串回填原归属逆变器', s1!.originInverterId === 'old-inv' && s2!.originInverterId === 'old-inv');
  check('旧组串回填原归属汇流箱', s1!.originCombinerBox === 'BX-09' && s2!.originCombinerBox === 'BX-09');
  check('组串行修订号升级', s1!.revision === 3);

  const done = await db.disposals.get('d-done');
  const open = await db.disposals.get('d-open');
  check('已复测旧单按原汇流箱基准回填（26/24 串 ≈ 9.04A）', done!.baselineCurrentA === 9.04, `got ${done!.baselineCurrentA}`);
  check('已复测结论数值保留', done!.retestCurrentA === 9.1 && done!.state === 'retested');
  check('未完成旧单基准为 null、重派次数补 0', open!.baselineCurrentA === null && open!.redispatchCount === 0);

  // 新表存在且冻结默认可读
  const freeze = await db.freezes.get('freeze');
  check('冻结单表已建立（无记录时 get 返回 undefined，由 API 兜底）', freeze === undefined);

  await db.delete();
  console.log(`\n升级迁移 ${passed} 项断言通过`);
}

main().catch((err) => { console.error(err); process.exit(1); });
