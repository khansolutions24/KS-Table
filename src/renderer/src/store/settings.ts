import { create } from 'zustand';
import type { DeepPartial } from '@shared/api';
import type { AppSettings } from '@shared/types';
import { defaultSettings } from '@shared/defaults';
import { api } from '../api/client';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  update(patch: DeepPartial<AppSettings>): Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: defaultSettings(),
  loaded: false,
  update: async (patch) => {
    const settings = await api.settings.update(patch);
    set({ settings });
  }
}));

export const getSettings = (): AppSettings => useSettings.getState().settings;
