import {
  DemoModulesConfig,
  KeyValueStoreAdapter,
  ModuleDefinition,
  ModuleKey,
  ModulePresetKey,
} from './types';

export const DEMO_MODULES_REDIS_KEY = 'demo:modules:config';

export const DEFAULT_DEMO_MODULES: Readonly<DemoModulesConfig> = {
  attendance: true,
  piecework: true,
  operations: true,
  payroll: true,
  gamification: true,
  ai_sop: true,
};

export const DEMO_MODULE_METADATA: readonly ModuleDefinition[] = [
  {
    key: 'attendance',
    label: 'Chấm công, Lịch ca & Duyệt đơn (Core)',
    description: 'Check-in WiFi/GPS, đăng ký lịch ca, đổi ca & duyệt đơn nghỉ phép',
    isCore: true,
  },
  {
    key: 'piecework',
    label: 'Khoán Đóng gói, Bốc vác & Chợ WFH',
    description: 'Tính tiền theo sản lượng đóng gói, bốc vác và nhận việc WFH',
  },
  {
    key: 'operations',
    label: 'Giao việc Ca, Checklist Quản lý & KPI',
    description: 'Checklist mở/đóng ca, giao việc nhân viên & ma trận Eisenhower',
  },
  {
    key: 'payroll',
    label: 'Tự động Tính lương & Phiếu lương',
    description: 'Tự động tổng hợp công, thưởng chuyên cần, KPI & chốt phiếu lương',
  },
  {
    key: 'gamification',
    label: 'Vòng quay may mắn, Gacha & Thành tích',
    description: 'Game hóa động lực đi làm đúng giờ, mở túi mù & huy hiệu',
  },
  {
    key: 'ai_sop',
    label: 'Trợ lý AI Nội quy (Capy RAG + TTS)',
    description: 'Hỏi đáp quy trình vận hành cửa hàng bằng AI & giọng đọc TTS',
  },
] as const;

export const MODULE_PRESETS: Readonly<Record<ModulePresetKey, DemoModulesConfig>> = {
  FULL_SUITE: {
    attendance: true,
    piecework: true,
    operations: true,
    payroll: true,
    gamification: true,
    ai_sop: true,
  },
  RETAIL_CORE: {
    attendance: true,
    piecework: true,
    operations: true,
    payroll: true,
    gamification: false,
    ai_sop: false,
  },
  FNB_SHIFT: {
    attendance: true,
    piecework: false,
    operations: true,
    payroll: true,
    gamification: true,
    ai_sop: true,
  },
  MINIMAL_ATTENDANCE: {
    attendance: true,
    piecework: false,
    operations: false,
    payroll: false,
    gamification: false,
    ai_sop: false,
  },
};

export interface ModuleStudioManagerOptions {
  store?: KeyValueStoreAdapter | (() => KeyValueStoreAdapter | null | undefined) | null;
  redisKey?: string;
  initialConfig?: Partial<DemoModulesConfig>;
  catalog?: readonly ModuleDefinition[];
  enforceCoreModules?: boolean;
}

/**
 * Super App Module Studio Manager:
 * Manages real-time feature module toggles with an optional Redis/Valkey key-value store
 * adapter and automatic resilient in-memory fallback.
 */
export class ModuleStudioManager {
  private readonly redisKey: string;
  private readonly catalog: readonly ModuleDefinition[];
  private readonly enforceCoreModules: boolean;
  private readonly storeProvider?:
    | KeyValueStoreAdapter
    | (() => KeyValueStoreAdapter | null | undefined)
    | null;
  private memoryConfig: DemoModulesConfig;

  constructor(options?: ModuleStudioManagerOptions) {
    this.redisKey = options?.redisKey || DEMO_MODULES_REDIS_KEY;
    this.catalog = options?.catalog || DEMO_MODULE_METADATA;
    this.enforceCoreModules = options?.enforceCoreModules ?? false;
    this.storeProvider = options?.store;
    this.memoryConfig = this.normalizeConfig(options?.initialConfig);
  }

  private resolveStore(): KeyValueStoreAdapter | null {
    if (!this.storeProvider) return null;
    if (typeof this.storeProvider === 'function') {
      return this.storeProvider() || null;
    }
    return this.storeProvider;
  }

  private normalizeConfig(input?: Partial<DemoModulesConfig> | null): DemoModulesConfig {
    const base: DemoModulesConfig = {
      attendance: typeof input?.attendance === 'boolean' ? input.attendance : DEFAULT_DEMO_MODULES.attendance,
      piecework: typeof input?.piecework === 'boolean' ? input.piecework : DEFAULT_DEMO_MODULES.piecework,
      operations: typeof input?.operations === 'boolean' ? input.operations : DEFAULT_DEMO_MODULES.operations,
      payroll: typeof input?.payroll === 'boolean' ? input.payroll : DEFAULT_DEMO_MODULES.payroll,
      gamification:
        typeof input?.gamification === 'boolean' ? input.gamification : DEFAULT_DEMO_MODULES.gamification,
      ai_sop: typeof input?.ai_sop === 'boolean' ? input.ai_sop : DEFAULT_DEMO_MODULES.ai_sop,
    };

    if (input && typeof input === 'object') {
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'boolean') {
          base[k] = v;
        }
      }
    }

    if (this.enforceCoreModules) {
      for (const item of this.catalog) {
        if (item.isCore) {
          base[item.key] = true;
        }
      }
    }

    return base;
  }

  getCatalog(): readonly ModuleDefinition[] {
    return this.catalog;
  }

  async getConfig(): Promise<DemoModulesConfig> {
    try {
      const store = this.resolveStore();
      if (store) {
        const raw = await store.get(this.redisKey);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<DemoModulesConfig>;
          const normalized = this.normalizeConfig(parsed);
          this.memoryConfig = { ...normalized };
          return normalized;
        }
      }
    } catch {
      // Resilient fallback to in-memory config when Redis is unreachable or payload is malformed
    }
    return { ...this.memoryConfig };
  }

  async updateConfig(
    updates: Partial<DemoModulesConfig> | null | undefined
  ): Promise<DemoModulesConfig> {
    const current = await this.getConfig();
    const merged: Partial<DemoModulesConfig> = { ...current };

    if (updates && typeof updates === 'object') {
      for (const [key, val] of Object.entries(updates)) {
        if (typeof val === 'boolean') {
          merged[key] = val;
        }
      }
    }

    const next = this.normalizeConfig(merged);
    this.memoryConfig = { ...next };

    try {
      const store = this.resolveStore();
      if (store) {
        await store.set(this.redisKey, JSON.stringify(next));
      }
    } catch {
      // Keep in-memory state if Redis write fails
    }

    return { ...next };
  }

  async toggleModule(key: ModuleKey | string): Promise<DemoModulesConfig> {
    const current = await this.getConfig();
    const nextValue = !current[key];
    return this.updateConfig({ [key]: nextValue });
  }

  async applyPreset(preset: ModulePresetKey): Promise<DemoModulesConfig> {
    const presetConfig = MODULE_PRESETS[preset] || MODULE_PRESETS.FULL_SUITE;
    return this.updateConfig(presetConfig);
  }

  async isModuleEnabled(key: ModuleKey | string): Promise<boolean> {
    const config = await this.getConfig();
    return Boolean(config[key]);
  }

  async reset(): Promise<DemoModulesConfig> {
    const fresh = this.normalizeConfig(DEFAULT_DEMO_MODULES);
    this.memoryConfig = { ...fresh };
    try {
      const store = this.resolveStore();
      if (store) {
        if (typeof store.del === 'function') {
          await store.del(this.redisKey);
        } else {
          await store.set(this.redisKey, JSON.stringify(fresh));
        }
      }
    } catch {
      // Ignore store errors on reset
    }
    return { ...fresh };
  }
}
