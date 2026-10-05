/**
 * 整箱改挂状态（Zustand）
 * 冻结计划持久化在 relocations 表；frozen 状态同时是设备台账与采集处置两端的写入锁。
 */
import { create } from 'zustand';
import {
  cancelRelocationPlan as cancelDbRelocationPlan,
  executeRelocationPlan,
  freezeRelocationPlan,
  getActiveRelocationPlan,
  listRelocationPlans,
  type RelocationPlanRow,
} from '../utils/db';
import type { RelocationDraft, RelocationResult } from '../types/relocation';
import { emitChange, subscribeChange } from '../utils/events';

interface RelocationStoreState {
  plans: RelocationPlanRow[];
  activePlan: RelocationPlanRow | null;
  loading: boolean;
  error: string;
  loadRelocations: () => Promise<void>;
  subscribe: () => void;
  freeze: (draft: RelocationDraft) => Promise<RelocationPlanRow>;
  execute: (planId: string) => Promise<RelocationResult>;
  cancel: (planId: string) => Promise<void>;
}

let unsubscribed: (() => void) | null = null;

export const useRelocationStore = create<RelocationStoreState>((set) => ({
  plans: [],
  activePlan: null,
  loading: false,
  error: '',

  async loadRelocations() {
    set({ loading: true });
    try {
      const [plans, activePlan] = await Promise.all([listRelocationPlans(), getActiveRelocationPlan()]);
      set({ plans, activePlan, loading: false, error: '' });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '改挂计划读取失败' });
    }
  },

  subscribe() {
    if (unsubscribed) return;
    unsubscribed = subscribeChange(() => {
      void useRelocationStore.getState().loadRelocations();
    });
  },

  async freeze(draft) {
    const plan = await freezeRelocationPlan(draft);
    emitChange();
    return plan;
  },

  async execute(planId) {
    const applied = await executeRelocationPlan(planId);
    emitChange();
    return applied.result;
  },

  async cancel(planId) {
    await cancelDbRelocationPlan(planId);
    emitChange();
  },
}));
