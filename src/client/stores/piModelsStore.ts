import { create } from "zustand";
import type { PiModelEntry } from "../../shared/types";

interface PiModelsState {
  /** Cached Pi model entries fetched from the server. Empty until fetched. */
  models: PiModelEntry[];
  /** Whether a fetch is currently in progress. */
  loading: boolean;
  /** Whether a fetch has been attempted (success or failure). */
  initialized: boolean;
  /** Fetch models from the server via the provided callback. Idempotent while loading. */
  fetch: (fetchFn: () => Promise<PiModelEntry[]>) => Promise<void>;
  /** Clear cached models, e.g. when the connection drops. */
  clear: () => void;
}

export const usePiModelsStore = create<PiModelsState>((set, get) => ({
  models: [],
  loading: false,
  initialized: false,

  fetch: async (fetchFn) => {
    const state = get();
    if (state.loading) return;

    set({ loading: true });
    try {
      const models = await fetchFn();
      set({ models, loading: false, initialized: true });
    } catch {
      set({ loading: false, initialized: true });
    }
  },

  clear: () => {
    set({ models: [], loading: false, initialized: false });
  },
}));
