/**
 * 逆变器退运后的整箱组串改挂。
 * 设备台账、采集处置各自保留归属字段；计划单同时作为搬迁期间的冻结锁。
 */

/** 归属快照：设备归属与采集归属分别核对，不假设任一端可推导另一端 */
export interface OwnershipSnapshot {
  inverterId: string;
  combinerBox: string;
}

/** 改挂计划 / 冻结锁 */
export interface RelocationPlan {
  id: string;
  status: 'frozen' | 'completed' | 'failed' | 'cancelled';
  sourceInverterId: string;
  sourceCombinerBox: string;
  targetInverterId: string;
  targetCombinerBox: string;
  /** 冻结并核对箱内组串后确认的搬迁范围，重试时只认该范围 */
  confirmedStringIds: string[];
  stringCount: number;
  unfinishedDisposalCount: number;
  retestedDisposalCount: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  /** 执行失败时已写入到目标归属的组串，补偿恢复成功后清空 */
  appliedStringIds: string[];
  lastError: string;
}

/** 发起整箱改挂的入参 */
export interface RelocationDraft {
  sourceInverterId: string;
  sourceCombinerBox: string;
  targetInverterId: string;
  targetCombinerBox?: string;
  reason?: string;
}

/** 搬迁前端离散率结果，设备台账与采集处置两端分别返回以便对账 */
export interface RelocationGroupRates {
  oldLedgerRate: number;
  newLedgerRate: number;
  oldCollectionRate: number;
  newCollectionRate: number;
}

export interface RelocationResult {
  planId: string;
  relocatedStringIds: string[];
  reassignedDisposalIds: string[];
  retestedDisposalIds: string[];
  rates: RelocationGroupRates;
  /** 新汇流箱下按阈值判定出的可疑组串 */
  suspiciousStringIds: string[];
  reconciled: boolean;
}

export class RelocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelocationValidationError';
  }
}

export function sameOwnership(a: OwnershipSnapshot, b: OwnershipSnapshot): boolean {
  return a.inverterId === b.inverterId && a.combinerBox === b.combinerBox;
}
