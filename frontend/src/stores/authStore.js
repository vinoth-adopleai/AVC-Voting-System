import { create } from 'zustand'

export const useAuthStore = create((set) => ({
  isSessionResolved: false,
  accessToken: null,
  user: null,
  setSession: ({ accessToken, user }) =>
    set({ accessToken, user, isSessionResolved: true }),
  clearSession: () =>
    set({ accessToken: null, user: null, isSessionResolved: true }),
}))
