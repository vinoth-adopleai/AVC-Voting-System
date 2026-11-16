import { create } from 'zustand'

export const useUiStore = create((set) => ({
  isNavigationOpen: false,
  openNavigation: () => set({ isNavigationOpen: true }),
  closeNavigation: () => set({ isNavigationOpen: false }),
  toggleNavigation: () =>
    set((state) => ({ isNavigationOpen: !state.isNavigationOpen })),
}))
