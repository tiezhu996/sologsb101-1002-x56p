import type { Revisioned } from './persistence';

/**
 * 电站扩容后旧逆变器退运、整箱组串改挂到新设备的搬迁领域。
 * 设备台账（strings.inverterId/combinerBox）与采集处置（samples/disposals 经 stringId 引用）
 * 各有独立数据所有权：搬迁前必须冻结两端录入与派工，核对箱内组串归属一致后才允许搬迁。
 */

/** 搬迁单状态：草稿（已确认范围待执行）→ 已搬迁（成功）/ 失败（已回滚，可重试） */
export type MigrationState = 'draft' | 'migrated' | 'failed';

/** 改挂范围中的单个汇流箱条目的执行状态 */
export type BoxMigrationState = 'pending' | 'migrated' | 'failed';

export const MIGRATION_STATE_LABEL: Record<MigrationState, string> = {
  draft: '待搬迁',
  migrated: '已搬迁',
  failed: '部分失败',
};

export const BOX_MIGRATION_STATE_LABEL: Record<BoxMigrationState, string> = {
  pending: '待搬迁',
  migrated: '已搬迁',
  failed: '搬迁失败',
};

/** 改挂范围中的单个汇流箱条目（整箱搬迁，不拆串） */
export interface MigrationBoxItem {
  /** 源逆变器 */
  sourceInverterId: string;
  /** 源汇流箱编号 */
  sourceCombinerBox: string;
  /** 目标逆变器（创建搬迁单时必须已选定） */
  targetInverterId: string;
  /** 目标汇流箱编号（默认沿用源箱号，可改） */
  targetCombinerBox: string;
  /** 确认搬迁的组串 id 集合（冻结后两端对账一致的整箱组串） */
  stringIds: string[];
  /** 执行状态：重试时只处理 failed/pending，migrated 不重复搬迁 */
  state: BoxMigrationState;
  /** 最近一次失败原因 */
  error?: string;
  migratedAt?: string;
}

/** 搬迁单 */
export interface StringMigration {
  id: string;
  /** 搬迁单名称，如「沙湖滩一期扩容改挂」 */
  name: string;
  /** 退运的旧逆变器 id（便于台账标注，可多个） */
  sourceInverterIds: string[];
  /** 新逆变器 id */
  targetInverterIds: string[];
  /** 整箱改挂范围 */
  boxes: MigrationBoxItem[];
  state: MigrationState;
  /** 发起冻结/搬迁的操作人 */
  operator: string;
  /** 最近一次失败原因（汇总） */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** 全部条目搬迁完成的时间 */
  migratedAt?: string;
}

/** 冻结单：冻结设备台账与采集处置两端录入与派工 */
export interface MigrationFreeze {
  id: 'freeze';
  /** 是否处于冻结期 */
  frozen: boolean;
  /** 发起冻结的操作人 */
  operator: string;
  reason: string;
  /** 关联的搬迁单 id（解冻后保留，便于审计） */
  migrationId?: string;
  frozenAt?: string;
  releasedAt?: string;
  updatedAt: string;
}

export type MigrationRow = StringMigration & Revisioned;
export type MigrationFreezeRow = MigrationFreeze & Revisioned;

/** 创建搬迁单草稿的入参 */
export interface MigrationDraft {
  name: string;
  operator: string;
  sourceInverterIds: string[];
  targetInverterIds: string[];
  boxes: Array<Pick<MigrationBoxItem, 'sourceInverterId' | 'sourceCombinerBox' | 'targetInverterId' | 'targetCombinerBox' | 'stringIds'>>;
}

/** 单个汇流箱搬迁前的对账结果 */
export interface BoxReconcileResult {
  sourceInverterId: string;
  sourceCombinerBox: string;
  /** 台账侧该箱组串 id 集合 */
  ledgerStringIds: string[];
  /** 采集处置侧（samples + disposals）引用到的组串 id 集合 */
  referencedStringIds: string[];
  /** 两端一致：台账组串与被引用组串归属同一箱，且无悬空引用 */
  consistent: boolean;
  /** 悬空引用：采集/处置单引用了台账中不存在或不在本箱的组串 */
  orphanStringIds: string[];
  /** 有采集记录的组串数 */
  sampledCount: number;
  /** 有未完成处置单的组串数 */
  openDisposalCount: number;
}

/** 搬迁执行结果（供 UI 展示） */
export interface MigrationRunResult {
  migrationId: string;
  /** 本次实际搬迁的汇流箱条目数（已成功的条目不重复搬迁） */
  movedBoxes: number;
  movedStrings: number;
  /** 按新归属重派（回到待处理）的处置单数 */
  redispatchedDisposals: number;
  /** 已复测、结论保留原基准的处置单数 */
  retainedRetests: number;
  /** 重算离散率的汇流箱分组数（源端 + 目标端去重） */
  recalcedGroups: number;
  state: MigrationState;
  error?: string;
}

export const FREEZE_RECORD_ID = 'freeze';

/** 未复测消缺判定的默认基准（无历史基准时兜底） */
export const FALLBACK_BASELINE_CURRENT_A = 9.4;

/** 汇总搬迁单进度 */
export function migrationProgress(migration: StringMigration): {
  total: number;
  migrated: number;
  failed: number;
  pending: number;
  stringTotal: number;
  stringMigrated: number;
} {
  const boxes = migration.boxes;
  return {
    total: boxes.length,
    migrated: boxes.filter((item) => item.state === 'migrated').length,
    failed: boxes.filter((item) => item.state === 'failed').length,
    pending: boxes.filter((item) => item.state === 'pending').length,
    stringTotal: boxes.reduce((sum, item) => sum + item.stringIds.length, 0),
    stringMigrated: boxes
      .filter((item) => item.state === 'migrated')
      .reduce((sum, item) => sum + item.stringIds.length, 0),
  };
}
