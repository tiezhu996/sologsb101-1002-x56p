/**
 * 整箱组串改挂编排（旧逆变器退运 → 新设备）
 *
 * 业务顺序（严格）：
 *  1. 冻结两端（设备台账录入 + 采集处置录入/派工）；
 *  2. 搬迁前按汇流箱核对箱内组串：台账归属 vs 采集/处置引用必须一致，不阻塞项也要可见；
 *  3. 以汇流箱为单位执行搬迁（utils/db.moveMigrationBox，单箱单事务）；
 *  4. 搬迁后源/目标两端离散率与可疑标记重算（事务内回写，stores 重拉后可疑集合随之刷新）；
 *     未完成处置单按新归属重派（回到待处理，redispatchCount+1），已复测结论保留原基准；
 *  5. 写入失败：该箱事务整体回滚恢复设备归属，条目标记 failed；搬迁单与已确认范围保留；
 *     重试只处理 failed/pending 条目，已 migrated 的不重复搬迁。
 */
import {
  getFreeze,
  getMigration,
  listDisposals,
  listSamples,
  listStrings,
  moveMigrationBox,
  newMigrationRow,
  putFreeze,
  putMigration,
  type MigrationRow,
} from './db';
import {
  FREEZE_RECORD_ID,
  type BoxReconcileResult,
  type MigrationDraft,
  type MigrationRunResult,
  type StringMigration,
} from '../types/migration';
import { nowIso } from './format';

/** 两端对账：核对一个源汇流箱内的组串在台账侧与采集处置侧的归属是否一致 */
export async function reconcileBox(
  sourceInverterId: string,
  sourceCombinerBox: string,
): Promise<BoxReconcileResult> {
  const [strings, samples, disposals] = await Promise.all([
    listStrings(),
    listSamples(),
    listDisposals(),
  ]);
  const ledger = strings.filter(
    (item) => item.inverterId === sourceInverterId && item.combinerBox === sourceCombinerBox,
  );
  const ledgerStringIds = ledger.map((item) => item.id);
  const ledgerSet = new Set(ledgerStringIds);

  const sampledSet = new Set(samples.map((item) => item.stringId));
  const disposalSet = new Set(disposals.map((item) => item.stringId));
  // 采集处置侧引用到、且台账归属在本箱的组串
  const referencedStringIds = ledgerStringIds.filter(
    (id) => sampledSet.has(id) || disposalSet.has(id),
  );

  // 悬空引用：采集/处置单仍引用，但台账中已不存在的组串（独立数据所有权下的不一致）
  const knownIds = new Set(strings.map((item) => item.id));
  const orphanStringIds = [...new Set([...sampledSet, ...disposalSet])].filter(
    (id) => !knownIds.has(id),
  );

  const openDisposalCount = disposals.filter(
    (item) => ledgerSet.has(item.stringId) && item.state !== 'retested',
  ).length;

  return {
    sourceInverterId,
    sourceCombinerBox,
    ledgerStringIds,
    referencedStringIds,
    // 箱内必须有组串，且两端无悬空引用
    consistent: ledgerStringIds.length > 0 && orphanStringIds.length === 0,
    orphanStringIds,
    sampledCount: ledgerStringIds.filter((id) => sampledSet.has(id)).length,
    openDisposalCount,
  };
}

/** 批量对账多个源汇流箱 */
export async function reconcileBoxes(
  boxes: Array<{ sourceInverterId: string; sourceCombinerBox: string }>,
): Promise<BoxReconcileResult[]> {
  return Promise.all(boxes.map((box) => reconcileBox(box.sourceInverterId, box.sourceCombinerBox)));
}

/** 创建搬迁单（须在冻结后调用；不改变任何组串归属） */
export async function createMigration(draft: MigrationDraft): Promise<MigrationRow> {
  const freeze = await getFreeze();
  if (!freeze.frozen) {
    throw new Error('请先冻结两端录入与派工，再创建搬迁单');
  }
  if (draft.boxes.length === 0) throw new Error('改挂范围为空：至少选择一个整箱');
  const row = newMigrationRow(draft);
  await putMigration(row);
  return row;
}

/** 取搬迁单（供页面/重试） */
export async function fetchMigration(id: string): Promise<MigrationRow | undefined> {
  return getMigration(id);
}

/**
 * 执行（或重试）搬迁。
 * - 前置：处于冻结期；
 * - 逐箱独立事务：单箱失败不影响已成功箱；失败箱设备归属随事务回滚恢复；
 * - 幂等：state==='migrated' 的条目直接跳过，不重复搬迁；
 * - 全部条目成功后自动解冻；仍有 failed 时保持冻结，等待重试（已确认范围保留）。
 */
export async function runMigration(migrationId: string): Promise<MigrationRunResult> {
  const freeze = await getFreeze();
  if (!freeze.frozen) throw new Error('搬迁必须在冻结期执行');

  const migration = await getMigration(migrationId);
  if (!migration) throw new Error('搬迁单不存在');

  let movedBoxes = 0;
  let movedStrings = 0;
  let redispatchedDisposals = 0;
  let retainedRetests = 0;
  const recalcKeySet = new Set<string>();
  let firstError: string | undefined;

  for (const item of migration.boxes) {
    if (item.state === 'migrated') continue; // 重试不重复搬迁
    try {
      const outcome = await moveMigrationBox(item);
      item.state = 'migrated';
      item.error = undefined;
      item.migratedAt = nowIso();
      movedBoxes += 1;
      movedStrings += outcome.movedStringIds.length;
      redispatchedDisposals += outcome.redisposed;
      retainedRetests += outcome.retainedRetests;
      outcome.recalcKeys.forEach((key) => recalcKeySet.add(key));
    } catch (error) {
      // 事务已回滚：该箱组串仍在源侧（设备归属恢复）。保留条目与已确认范围，标记失败待重试。
      item.state = 'failed';
      item.error = error instanceof Error ? error.message : '搬迁写入失败';
      firstError ??= item.error;
    }
  }

  const anyFailed = migration.boxes.some((item) => item.state === 'failed');
  const allMigrated = migration.boxes.every((item) => item.state === 'migrated');
  migration.state = anyFailed ? 'failed' : allMigrated ? 'migrated' : 'draft';
  migration.lastError = firstError;
  migration.updatedAt = nowIso();
  if (allMigrated) migration.migratedAt = nowIso();
  await putMigration(migration);

  // 全部完成才解冻；部分失败保持冻结，避免重试期间两端继续录入
  if (allMigrated) {
    const current = await getFreeze();
    await putFreeze({
      ...current,
      frozen: false,
      migrationId: migration.id,
      releasedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  return {
    migrationId,
    movedBoxes,
    movedStrings,
    redispatchedDisposals,
    retainedRetests,
    recalcedGroups: recalcKeySet.size,
    state: migration.state,
    error: firstError,
  };
}

/** 手动解冻（放弃搬迁或异常处置时使用，保留搬迁单与已确认范围） */
export async function releaseFreeze(reason = '人工解除冻结'): Promise<void> {
  const current = await getFreeze();
  if (!current.frozen) return;
  await putFreeze({
    ...current,
    frozen: false,
    reason,
    releasedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

/** 冻结两端（同一时刻只允许一个有效冻结） */
export async function acquireFreeze(input: {
  operator: string;
  reason: string;
  migrationId?: string;
}): Promise<void> {
  const current = await getFreeze();
  if (current.frozen) throw new Error('已处于冻结期，请先完成搬迁或解除冻结');
  const stamp = nowIso();
  await putFreeze({
    id: FREEZE_RECORD_ID,
    frozen: true,
    operator: input.operator.trim(),
    reason: input.reason.trim(),
    migrationId: input.migrationId,
    frozenAt: stamp,
    releasedAt: undefined,
    updatedAt: stamp,
    revision: current.revision,
  });
}

/** 视图辅助：搬迁单状态摘要 */
export function migrationSummary(migration: StringMigration): string {
  const done = migration.boxes.filter((item) => item.state === 'migrated').length;
  return `${done}/${migration.boxes.length} 箱`;
}
