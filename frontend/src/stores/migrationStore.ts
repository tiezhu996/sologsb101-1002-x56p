/**
 * 整箱改挂状态（Zustand）
 * 维护冻结单（两端录入/派工冻结的唯一权威）与搬迁单列表。
 * 设备/采集/处置 store 的写操作在执行前统一调用 assertWritable() 守卫。
 */
import { create } from 'zustand';
import {
  getFreeze,
  listMigrations,
  putFreeze,
  putMigration,
  removeMigration,
  type MigrationFreezeRow,
  type MigrationRow,
} from '../utils/db';
import {
  acquireFreeze as apiAcquireFreeze,
  releaseFreeze as apiReleaseFreeze,
  runMigration as apiRunMigration,
  createMigration as apiCreateMigration,
} from '../utils/migration';
import type { MigrationDraft, MigrationRunResult } from '../types/migration';
import { emitChange, subscribeChange } from '../utils/events';
import { nowIso } from '../utils/format';

/** 冻结期内禁止两端录入与派工；复测回填保留原结论，不改变归属故不在冻结禁止之列 */
export class FrozenError extends Error {
  constructor(message = '冻结期内：设备台账与采集处置的录入、派工已暂停') {
    super(message);
    this.name = 'FrozenError';
  }
}

interface MigrationStoreState {
  freeze: MigrationFreezeRow | null;
  migrations: MigrationRow[];
  loading: boolean;
  error: string;
  loadMigrationState: () => Promise<void>;
  subscribe: () => void;
  /** 冻结中（供 UI 与各 store 守卫同步读取） */
  isFrozen: () => boolean;
  freezeScope: () => { operator: string; reason: string; frozenAt?: string; migrationId?: string };
  freezeBothEnds: (input: { operator: string; reason: string }) => Promise<void>;
  unfreeze: (reason?: string) => Promise<void>;
  createDraft: (draft: MigrationDraft) => Promise<MigrationRow>;
  run: (migrationId: string) => Promise<MigrationRunResult>;
  deleteMigration: (migrationId: string) => Promise<void>;
  /** 标记条目迁移（供未来扩展，当前主要由 run 内部写库） */
  saveMigration: (row: MigrationRow) => Promise<void>;
}

let unsubscribed: (() => void) | null = null;

export const useMigrationStore = create<MigrationStoreState>((set, get) => ({
  freeze: null,
  migrations: [],
  loading: false,
  error: '',

  async loadMigrationState() {
    set({ loading: true });
    try {
      const [freeze, migrations] = await Promise.all([getFreeze(), listMigrations()]);
      set({ freeze, migrations, loading: false, error: '' });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '搬迁状态读取失败' });
    }
  },

  subscribe() {
    if (unsubscribed) return;
    unsubscribed = subscribeChange(() => {
      void get().loadMigrationState();
    });
  },

  isFrozen() {
    return get().freeze?.frozen === true;
  },

  freezeScope() {
    const freeze = get().freeze;
    return {
      operator: freeze?.operator ?? '',
      reason: freeze?.reason ?? '',
      frozenAt: freeze?.frozenAt,
      migrationId: freeze?.migrationId,
    };
  },

  async freezeBothEnds(input) {
    await apiAcquireFreeze(input);
    emitChange();
  },

  async unfreeze(reason) {
    await apiReleaseFreeze(reason);
    emitChange();
  },

  async createDraft(draft) {
    const row = await apiCreateMigration(draft);
    // 关联搬迁单到当前冻结单（createMigration 已校验冻结存在）
    const freeze = await getFreeze();
    await putFreeze({ ...freeze, migrationId: row.id, updatedAt: nowIso() });
    emitChange();
    return row;
  },

  async run(migrationId) {
    const result = await apiRunMigration(migrationId);
    emitChange();
    return result;
  },

  async deleteMigration(migrationId) {
    await removeMigration(migrationId);
    emitChange();
  },

  async saveMigration(row) {
    await putMigration(row);
    emitChange();
  },
}));

/**
 * 跨 store 写守卫：冻结期内直接抛错，阻断设备台账/采集/处置的录入与派工。
 * 复测回填（不改变归属、保留原基准）由调用方在白名单中放行。
 */
export function assertWritable(): void {
  if (useMigrationStore.getState().isFrozen()) throw new FrozenError();
}
