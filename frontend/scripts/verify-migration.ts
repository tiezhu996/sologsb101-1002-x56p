/* eslint-disable no-console */
import 'fake-indexeddb/auto';
import { assert } from 'node:console';
import {
  initDatabase,
  db,
  listStrings,
  listDisposals,
  listSamples,
  listInverters,
  getFreeze,
  getMigration,
  removeInverter,
  moveMigrationBox,
} from '../src/utils/db';
import { reconcileBox, runMigration, createMigration, acquireFreeze, releaseFreeze } from '../src/utils/migration';
import type { MigrationBoxItem } from '../src/types/migration';

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

async function main(): Promise<void> {
  await initDatabase();
  const inverters = await listInverters();
  const strings = await listStrings();

  // 选取第一个有 ≥1 箱、≥3 串的逆变器作为源；选另一台作为目标
  const boxesByInv = new Map<string, { box: string; ids: string[] }[]>();
  for (const s of strings) {
    const list = boxesByInv.get(s.inverterId) ?? [];
    let entry = list.find((e) => e.box === s.combinerBox);
    if (!entry) {
      entry = { box: s.combinerBox, ids: [] };
      list.push(entry);
    }
    entry.ids.push(s.id);
    boxesByInv.set(s.inverterId, list);
  }
  let sourceInvId = '';
  let sourceBox = '';
  let sourceIds: string[] = [];
  for (const [invId, boxes] of boxesByInv) {
    const candidate = boxes.find((b) => b.ids.length >= 3);
    if (candidate) {
      sourceInvId = invId;
      sourceBox = candidate.box;
      sourceIds = candidate.ids;
      break;
    }
  }
  assert(sourceInvId, '未找到合适的源逆变器');
  const targetInverter = inverters.find((i) => i.id !== sourceInvId)!;
  const targetInvId = targetInverter.id;

  // 1) 未冻结不能建单
  let threw = false;
  try {
    await createMigration({
      name: 't', operator: 'x', sourceInverterIds: [sourceInvId], targetInverterIds: [targetInvId],
      boxes: [{ sourceInverterId: sourceInvId, sourceCombinerBox: sourceBox, targetInverterId: targetInvId, targetCombinerBox: sourceBox, stringIds: sourceIds }],
    });
  } catch { threw = true; }
  check('未冻结禁止创建搬迁单', threw);

  // 2) 冻结
  await acquireFreeze({ operator: '测试员', reason: '扩容改挂测试' });
  check('冻结生效', (await getFreeze()).frozen === true);

  // 3) 对账一致
  const rec = await reconcileBox(sourceInvId, sourceBox);
  check('搬迁前对账一致', rec.consistent, `${rec.ledgerStringIds.length} 串 / 悬空 ${rec.orphanStringIds.length}`);

  // 4) 建单
  const migration = await createMigration({
    name: '扩容改挂测试', operator: '测试员', sourceInverterIds: [sourceInvId], targetInverterIds: [targetInvId],
    boxes: [{ sourceInverterId: sourceInvId, sourceCombinerBox: sourceBox, targetInverterId: targetInvId, targetCombinerBox: sourceBox, stringIds: sourceIds }],
  });

  // 5) 准备处置单：1 未完成(assigned) + 1 已复测(retested)
  const beforeDisposals = await listDisposals();
  const stringA = sourceIds[0];
  const stringB = sourceIds[1] ?? sourceIds[0];
  await db.disposals.bulkPut([
    {
      id: 'test-open', stringId: stringA, type: 'clean', state: 'assigned', owner: '张三', dueDate: '2026-12-31',
      retestCurrentA: null, baselineCurrentA: null, redispatchCount: 0, initialDiscreteRate: 6,
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', revision: 3,
    },
    {
      id: 'test-done', stringId: stringB, type: 'retest', state: 'retested', owner: '李四', dueDate: '2026-09-01',
      retestCurrentA: 9.2, baselineCurrentA: 9.4, redispatchCount: 0, initialDiscreteRate: 11,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', revision: 3,
    },
  ]);
  void beforeDisposals;

  // 6) 执行搬迁
  const result = await runMigration(migration.id);
  check('搬迁成功', result.state === 'migrated', `state=${result.state} ${result.error ?? ''}`);
  check('搬迁 1 个箱', result.movedBoxes === 1);
  check(`搬迁组串数 ${sourceIds.length}`, result.movedStrings === sourceIds.length);
  check('未完成处置单重派 1 单', result.redispatchedDisposals === 1);
  check('已复测结论保留 1 单', result.retainedRetests === 1);

  // 7) 组串归属：当前→目标；原归属→源（不变）
  const afterStrings = await listStrings();
  const moved = afterStrings.filter((s) => sourceIds.includes(s.id));
  check(
    '整箱组串已挂到新设备',
    moved.every((s) => s.inverterId === targetInvId && s.combinerBox === sourceBox),
  );
  check(
    '原归属保留（旧数据回填口径）',
    moved.every((s) => s.originInverterId === sourceInvId && s.originCombinerBox === sourceBox),
  );

  // 8) 处置单：未完成回到 pending + redispatchCount=1；已复测保留
  const openAfter = await db.disposals.get('test-open');
  const doneAfter = await db.disposals.get('test-done');
  check('未完成单回到待处理', openAfter!.state === 'pending');
  check('重派次数 +1', openAfter!.redispatchCount === 1);
  check('已复测单状态/复测值/基准不变',
    doneAfter!.state === 'retested' && doneAfter!.retestCurrentA === 9.2 && doneAfter!.baselineCurrentA === 9.4);

  // 9) 离散率：源箱与目标箱采集已重算（值为有限数）
  const samples = await listSamples();
  const movedIds = new Set(sourceIds);
  const targetSamples = samples.filter((sm) => movedIds.has(sm.stringId));
  check('搬迁组串采集仍在且离散率为数值', targetSamples.length > 0 && targetSamples.every((s) => Number.isFinite(s.discreteRate)));

  // 10) 完成后自动解冻
  check('全部完成后自动解冻', (await getFreeze()).frozen === false);

  // 11) 失败回滚 + 重试不重复搬迁
  await acquireFreeze({ operator: '测试员', reason: '第二次改挂测试' });
  // 第一次搬迁改变了布局，这里重新按当前台账计算逆变器/汇流箱
  const freshStrings = await listStrings();
  const freshBoxMap = new Map<string, { box: string; ids: string[] }[]>();
  for (const s of freshStrings) {
    const list = freshBoxMap.get(s.inverterId) ?? [];
    let entry = list.find((e) => e.box === s.combinerBox);
    if (!entry) { entry = { box: s.combinerBox, ids: [] }; list.push(entry); }
    entry.ids.push(s.id);
    freshBoxMap.set(s.inverterId, list);
  }
  // 选一个既不是第一次目标、且仍有 ≥2 串整箱的逆变器作源
  const secondSourceEntry = [...freshBoxMap.entries()]
    .filter(([invId]) => invId !== targetInvId)
    .map(([invId, boxes]) => ({ invId, box: boxes.find((b) => b.ids.length >= 2) }))
    .find((e) => e.box)!;
  const secondSourceId = secondSourceEntry.invId;
  const secondBox = secondSourceEntry.box!;
  // 目标选另一台当前不持有同名箱的逆变器，随后删除它制造写入失败
  const fakeTarget = inverters.find(
    (i) => i.id !== targetInvId && i.id !== secondSourceId && !freshBoxMap.get(i.id)?.some((b) => b.box === secondBox.box),
  )!;
  const m2 = await createMigration({
    name: '部分失败测试', operator: '测试员', sourceInverterIds: [secondSourceId], targetInverterIds: [fakeTarget.id],
    boxes: [{ sourceInverterId: secondSourceId, sourceCombinerBox: secondBox.box, targetInverterId: fakeTarget.id, targetCombinerBox: secondBox.box, stringIds: secondBox.ids }],
  });
  // 删除目标逆变器 → moveMigrationBox 前置校验抛错，事务不开、数据不动
  await removeInverter(fakeTarget.id);
  const r2 = await runMigration(m2.id);
  check('失败时状态为 failed', r2.state === 'failed');
  const m2row = (await getMigration(m2.id))!;
  check('失败条目标记 failed', m2row.boxes[0].state === 'failed');
  const rollbackStrings = (await listStrings()).filter((s) => secondBox.ids.includes(s.id));
  check('失败后设备归属恢复为源侧', rollbackStrings.every((s) => s.inverterId === secondSourceId && s.combinerBox === secondBox.box));
  check('部分失败保持冻结', (await getFreeze()).frozen === true);

  // 重建一个合法目标（当前台账中另一台逆变器），重试
  const newTarget = inverters.find(
    (i) => i.id !== targetInvId && i.id !== secondSourceId && i.id !== fakeTarget.id,
  )!;
  m2row.targetInverterIds = [newTarget.id];
  m2row.boxes[0].targetInverterId = newTarget.id;
  await db.migrations.put(m2row);
  const r3 = await runMigration(m2.id);
  check('重试成功', r3.state === 'migrated');
  check('重试不重复搬迁（只搬 1 箱）', r3.movedBoxes === 1);
  const finalStrings = (await listStrings()).filter((s) => secondBox.ids.includes(s.id));
  check('重试后组串挂到新目标', finalStrings.every((s) => s.inverterId === newTarget.id));

  await releaseFreeze('测试结束');
  await db.delete();
  console.log(`\n全部 ${passed} 项断言通过`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
