/**
 * 整箱改挂的纯业务规则与一次写入所需的数据变更。
 * 不直接访问 IndexedDB，便于对冻结、对账、幂等重试和原基准保留做单元验证。
 */
import type { Disposal, DisposalState } from '../types/disposal';
import type { OwnershipSnapshot, RelocationDraft, RelocationPlan, RelocationResult } from '../types/relocation';
import { RelocationValidationError, sameOwnership } from '../types/relocation';
import type { Sample } from '../types/sample';
import type { PvString } from '../types/string';
import type { Inverter } from '../types/inverter';
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from '../types/settings';
import { discreteRate, levelOf, mean, normalizeCurrent, ownerDiscreteRate } from './discrete';
import { nowIso, round, uuid } from './format';

export interface RelocationSnapshot {
  inverters: Inverter[];
  strings: PvString[];
  samples: Sample[];
  disposals: Disposal[];
  activePlan?: RelocationPlan | null;
}

export interface RelocationMutation {
  strings: PvString[];
  samples: Sample[];
  disposals: Disposal[];
  plan: RelocationPlan;
}

const UNFINISHED_STATES: DisposalState[] = ['pending', 'assigned'];

export function ownershipOf(owner: OwnershipSnapshot): string {
  return `${owner.inverterId}::${owner.combinerBox}`;
}

function assertNoActiveLock(snapshot: RelocationSnapshot): void {
  if (snapshot.activePlan && ['frozen', 'failed'].includes(snapshot.activePlan.status)) {
    throw new RelocationValidationError('已有冻结或待恢复的改挂计划，请先完成、重试或取消后再录入/派工');
  }
}

/**
 * 冻结录入与派工，并核对源汇流箱。返回的计划含确认范围，尚未改动设备归属。
 */
export function freezeRelocationPlan(
  draft: RelocationDraft,
  snapshot: RelocationSnapshot,
  now: string = nowIso(),
): RelocationMutation {
  assertNoActiveLock(snapshot);
  const sourceInverterId = draft.sourceInverterId.trim();
  const sourceCombinerBox = draft.sourceCombinerBox.trim();
  const targetInverterId = draft.targetInverterId.trim();
  const targetCombinerBox = (draft.targetCombinerBox ?? draft.sourceCombinerBox).trim();

  if (!sourceInverterId || !sourceCombinerBox || !targetInverterId || !targetCombinerBox) {
    throw new RelocationValidationError('源设备、源汇流箱、目标设备和目标汇流箱不能为空');
  }
  if (sourceInverterId === targetInverterId) {
    throw new RelocationValidationError('目标逆变器必须与退运逆变器不同');
  }
  const sourceInverter = snapshot.inverters.find((item) => item.id === sourceInverterId);
  const targetInverter = snapshot.inverters.find((item) => item.id === targetInverterId);
  if (!sourceInverter) throw new RelocationValidationError('源逆变器不存在');
  if (!targetInverter) throw new RelocationValidationError('目标逆变器不存在');

  const boxStrings = snapshot.strings.filter(
    (item) => item.inverterId === sourceInverterId && item.combinerBox === sourceCombinerBox,
  );
  if (boxStrings.length === 0) {
    throw new RelocationValidationError('源汇流箱内没有可搬迁组串');
  }

  const occupied = snapshot.strings.some(
    (item) => item.inverterId === targetInverterId && item.combinerBox === targetCombinerBox,
  );
  if (occupied) {
    throw new RelocationValidationError('目标汇流箱已有组串，不能整箱改挂到非空箱体');
  }

  const ids = new Set(boxStrings.map((item) => item.id));
  const mismatchedSamples = snapshot.samples.filter(
    (item) =>
      ids.has(item.stringId) &&
      (item.ownerInverterId !== sourceInverterId || item.ownerCombinerBox !== sourceCombinerBox),
  );
  if (mismatchedSamples.length > 0) {
    throw new RelocationValidationError(`采集归属对账不一致：${mismatchedSamples.length} 条采集记录不属于源汇流箱`);
  }

  const mismatchedDisposals = snapshot.disposals.filter(
    (item) =>
      ids.has(item.stringId) &&
      (item.ownerInverterId !== sourceInverterId || item.ownerCombinerBox !== sourceCombinerBox),
  );
  if (mismatchedDisposals.length > 0) {
    throw new RelocationValidationError(`处置归属对账不一致：${mismatchedDisposals.length} 张处置单不属于源汇流箱`);
  }

  const plan: RelocationPlan = {
    id: `reloc-${uuid()}`,
    status: 'frozen',
    sourceInverterId,
    sourceCombinerBox,
    targetInverterId,
    targetCombinerBox,
    confirmedStringIds: boxStrings.map((item) => item.id),
    stringCount: boxStrings.length,
    unfinishedDisposalCount: snapshot.disposals.filter(
      (item) => ids.has(item.stringId) && UNFINISHED_STATES.includes(item.state),
    ).length,
    retestedDisposalCount: snapshot.disposals.filter(
      (item) => ids.has(item.stringId) && item.state === 'retested',
    ).length,
    reason: draft.reason?.trim() ?? '旧逆变器退运整箱改挂',
    createdAt: now,
    updatedAt: now,
    confirmedAt: now,
    completedAt: null,
    appliedStringIds: [],
    lastError: '',
  };

  return { strings: snapshot.strings, samples: snapshot.samples, disposals: snapshot.disposals, plan };
}

function groupDiscreteRate(
  samples: Sample[],
  owner: OwnershipSnapshot,
  thresholds: ThresholdConfig,
): number {
  const rows = samples.filter(
    (item) => item.ownerInverterId === owner.inverterId && item.ownerCombinerBox === owner.combinerBox,
  );
  if (rows.length === 0) return 0;
  return ownerDiscreteRate(rows, thresholds);
}

function currentBaseline(samples: Sample[], owner: OwnershipSnapshot): number {
  const byString = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.ownerInverterId !== owner.inverterId || sample.ownerCombinerBox !== owner.combinerBox) continue;
    const values = byString.get(sample.stringId) ?? [];
    values.push(normalizeCurrent(sample.currentA, sample.irradianceWm2));
    byString.set(sample.stringId, values);
  }
  const stringAverages = [...byString.values()].map((values) => mean(values));
  return stringAverages.length === 0 ? 0 : round(mean(stringAverages), 3);
}

/**
 * 按已确认范围搬迁。已在目标归属的记录视为上次失败后的已确认范围，直接跳过，不重复搬迁。
 */
export function executeRelocationPlan(
  plan: RelocationPlan,
  snapshot: RelocationSnapshot,
  thresholds: ThresholdConfig,
  now: string = nowIso(),
): RelocationMutation & { result: RelocationResult } {
  if (plan.status === 'completed') {
    return {
      strings: snapshot.strings,
      samples: snapshot.samples,
      disposals: snapshot.disposals,
      plan,
      result: {
        planId: plan.id,
        relocatedStringIds: plan.confirmedStringIds,
        reassignedDisposalIds: [],
        retestedDisposalIds: snapshot.disposals
          .filter((item) => plan.confirmedStringIds.includes(item.stringId) && item.state === 'retested')
          .map((item) => item.id),
        rates: {
          oldLedgerRate: 0,
          oldCollectionRate: 0,
          newLedgerRate: groupDiscreteRate(
            snapshot.samples,
            { inverterId: plan.targetInverterId, combinerBox: plan.targetCombinerBox },
            DEFAULT_THRESHOLDS,
          ),
          newCollectionRate: groupDiscreteRate(
            snapshot.samples,
            { inverterId: plan.targetInverterId, combinerBox: plan.targetCombinerBox },
            DEFAULT_THRESHOLDS,
          ),
        },
        suspiciousStringIds: [],
        reconciled: true,
      },
    };
  }
  if (plan.status !== 'frozen' && plan.status !== 'failed') {
    throw new RelocationValidationError('只有冻结或失败的改挂计划可以执行');
  }
  if (snapshot.activePlan && snapshot.activePlan.id !== plan.id) {
    throw new RelocationValidationError('存在其他冻结或失败中的改挂计划，请先处理后再重试');
  }

  const source: OwnershipSnapshot = {
    inverterId: plan.sourceInverterId,
    combinerBox: plan.sourceCombinerBox,
  };
  const target: OwnershipSnapshot = {
    inverterId: plan.targetInverterId,
    combinerBox: plan.targetCombinerBox,
  };
  const confirmed = new Set(plan.confirmedStringIds);
  const scope = snapshot.strings.filter((item) => confirmed.has(item.id));
  if (scope.length !== plan.confirmedStringIds.length) {
    throw new RelocationValidationError('已确认范围中的组串已缺失，不能继续搬迁');
  }
  const outsideScope = snapshot.strings.filter(
    (item) =>
      !confirmed.has(item.id) &&
      item.inverterId === target.inverterId &&
      item.combinerBox === target.combinerBox,
  );
  if (outsideScope.length > 0) {
    throw new RelocationValidationError('目标汇流箱出现确认范围外组串，已停止搬迁');
  }

  const oldRate = groupDiscreteRate(snapshot.samples, source, thresholds);
  const strings = snapshot.strings.map((item) => {
    if (!confirmed.has(item.id)) return item;
    if (item.inverterId === target.inverterId && item.combinerBox === target.combinerBox) return item;
    if (item.inverterId !== source.inverterId || item.combinerBox !== source.combinerBox) {
      throw new RelocationValidationError(`组串 ${item.id} 的设备归属与冻结范围不一致`);
    }
    return { ...item, inverterId: target.inverterId, combinerBox: target.combinerBox };
  });

  const samples = snapshot.samples.map((item) => {
    if (!confirmed.has(item.stringId)) return item;
    if (item.ownerInverterId === target.inverterId && item.ownerCombinerBox === target.combinerBox) return item;
    if (item.ownerInverterId !== source.inverterId || item.ownerCombinerBox !== source.combinerBox) {
      throw new RelocationValidationError(`采集记录 ${item.id} 的归属与冻结范围不一致`);
    }
    return { ...item, ownerInverterId: target.inverterId, ownerCombinerBox: target.combinerBox };
  });

  const reassignedDisposalIds: string[] = [];
  const retestedDisposalIds: string[] = [];
  const disposals = snapshot.disposals.map((item) => {
    if (!confirmed.has(item.stringId)) return item;

    if (item.ownerInverterId !== source.inverterId || item.ownerCombinerBox !== source.combinerBox) {
      throw new RelocationValidationError(`处置单 ${item.id} 的归属与冻结范围不一致`);
    }

    if (item.state === 'retested') {
      retestedDisposalIds.push(item.id);
      // 已复测结论继续使用原基准；当前归属随箱迁移，但判定基准不切换。
      return {
        ...item,
        ownerInverterId: target.inverterId,
        ownerCombinerBox: target.combinerBox,
        baselineOwner: item.baselineOwner ?? source,
        baselineCurrentA:
          item.baselineCurrentA ??
          (currentBaseline(snapshot.samples, source) || null),
      };
    }

    if (item.ownerInverterId === source.inverterId && item.ownerCombinerBox === source.combinerBox) {
      reassignedDisposalIds.push(item.id);
      return {
        ...item,
        ownerInverterId: target.inverterId,
        ownerCombinerBox: target.combinerBox,
        state: 'assigned' as const,
        owner: item.owner || '改挂重派',
        updatedAt: now,
      };
    }
    return item;
  });

  const newRate = groupDiscreteRate(samples, target, thresholds);
  for (const disposal of disposals) {
    if (confirmed.has(disposal.stringId) && UNFINISHED_STATES.includes(disposal.state)) {
      disposal.initialDiscreteRate = newRate;
    }
  }

  const targetStringIds = new Set(
    strings.filter((item) => item.inverterId === target.inverterId && item.combinerBox === target.combinerBox).map((item) => item.id),
  );
  const valuesByString = new Map<string, number[]>();
  for (const sample of samples) {
    if (!targetStringIds.has(sample.stringId)) continue;
    sample.discreteRate = newRate;
    const values = valuesByString.get(sample.stringId) ?? [];
    values.push(normalizeCurrent(sample.currentA, sample.irradianceWm2));
    valuesByString.set(sample.stringId, values);
  }
  const sourceSampleCount = samples.filter(
    (item) => item.ownerInverterId === source.inverterId && item.ownerCombinerBox === source.combinerBox,
  ).length;
  if (sourceSampleCount > 0) {
    throw new RelocationValidationError('搬迁后源汇流箱仍存在采集记录，两端归属未清空');
  }
  const reconciled = plan.confirmedStringIds.every((stringId) => {
    const stringRow = strings.find((item) => item.id === stringId);
    const stringSamples = samples.filter((item) => item.stringId === stringId);
    const stringDisposals = disposals.filter((item) => item.stringId === stringId);
    return (
      stringRow?.inverterId === target.inverterId &&
      stringRow.combinerBox === target.combinerBox &&
      stringSamples.every(
        (item) => item.ownerInverterId === target.inverterId && item.ownerCombinerBox === target.combinerBox,
      ) &&
      stringDisposals.every(
        (item) => item.ownerInverterId === target.inverterId && item.ownerCombinerBox === target.combinerBox,
      )
    );
  });
  if (!reconciled) {
    throw new RelocationValidationError('改挂后设备台账与采集处置归属对账不一致');
  }
  const suspiciousStringIds = [...valuesByString.entries()]
    .map(([stringId, values]) => [stringId, discreteRate(values)] as const)
    .filter(([, rate]) => levelOf(rate, thresholds) !== 'normal')
    .map(([stringId]) => stringId)
    .sort();

  const completedPlan: RelocationPlan = {
    ...plan,
    status: 'completed',
    appliedStringIds: [],
    updatedAt: now,
    completedAt: now,
    lastError: '',
  };

  return {
    strings,
    samples,
    disposals,
    plan: completedPlan,
    result: {
      planId: plan.id,
      relocatedStringIds: plan.confirmedStringIds,
      reassignedDisposalIds,
      retestedDisposalIds,
      rates: {
        oldLedgerRate: oldRate,
        oldCollectionRate: oldRate,
        newLedgerRate: newRate,
        newCollectionRate: newRate,
      },
      suspiciousStringIds,
      reconciled,
    },
  };
}

/** 写入失败后的补偿：仅恢复已确认范围中已到目标归属的设备/采集/处置归属。 */
export function restoreConfirmedOwnership(
  plan: RelocationPlan,
  snapshot: RelocationSnapshot,
  errorMessage: string,
  now: string = nowIso(),
): RelocationMutation {
  const source: OwnershipSnapshot = {
    inverterId: plan.sourceInverterId,
    combinerBox: plan.sourceCombinerBox,
  };
  const target: OwnershipSnapshot = {
    inverterId: plan.targetInverterId,
    combinerBox: plan.targetCombinerBox,
  };
  const confirmed = new Set(plan.confirmedStringIds);
  const appliedStringIds = snapshot.strings
    .filter((item) => confirmed.has(item.id) && sameOwnership(item, target))
    .map((item) => item.id);

  const strings = snapshot.strings.map((item) =>
    appliedStringIds.includes(item.id)
      ? { ...item, inverterId: source.inverterId, combinerBox: source.combinerBox }
      : item,
  );
  const samples = snapshot.samples.map((item) =>
    appliedStringIds.includes(item.stringId) &&
    item.ownerInverterId === target.inverterId &&
    item.ownerCombinerBox === target.combinerBox
      ? { ...item, ownerInverterId: source.inverterId, ownerCombinerBox: source.combinerBox }
      : item,
  );
  const disposals = snapshot.disposals.map((item) => {
    if (
      !appliedStringIds.includes(item.stringId) ||
      item.ownerInverterId !== target.inverterId ||
      item.ownerCombinerBox !== target.combinerBox
    ) {
      return item;
    }
    // 当前归属回滚；baselineOwner 不动，复测结论仍保持其原基准。
    return { ...item, ownerInverterId: source.inverterId, ownerCombinerBox: source.combinerBox, updatedAt: now };
  });
  const failedPlan: RelocationPlan = {
    ...plan,
    status: 'failed',
    appliedStringIds: [],
    updatedAt: now,
    lastError: errorMessage,
  };
  return { strings, samples, disposals, plan: failedPlan };
}

export function cancelRelocationPlan(plan: RelocationPlan, now: string = nowIso()): RelocationPlan {
  if (plan.status !== 'frozen' && plan.status !== 'failed') {
    throw new RelocationValidationError('只有冻结或失败的计划可以取消');
  }
  return { ...plan, status: 'cancelled', updatedAt: now };
}
