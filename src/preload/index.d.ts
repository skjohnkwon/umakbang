import type { UmakbangApi } from './index'

declare global {
  interface Window {
    umakbang: UmakbangApi
  }
}

export {}
