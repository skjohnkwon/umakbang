import { create } from 'zustand'
import type {
  ContractData,
  ContractInput,
  ContractPreset,
  ContractProfile,
  ContractRecord
} from '@shared/contracts'
import { useLibrary } from '@/state/library'

/**
 * Contracts, kept apart from the library store.
 *
 * Nothing here is on the path of scrolling a quarter-million rows, and the library store is
 * already the biggest thing in the app - a few dozen contracts and a template do not belong
 * in it. Every write goes through main and comes back as the whole document, so there is
 * one copy of the truth rather than two that can drift.
 */
interface ContractState {
  loaded: boolean
  data: ContractData | null
  /** The file(s) a contract is being drafted for, or null when the dialog is closed. */
  drafting: string[] | null
  /** The last contract generated, so the page can point at it. */
  lastGenerated: ContractRecord | null

  load: () => Promise<void>
  draft: (titles: string[]) => void
  closeDraft: () => void
  generate: (input: ContractInput) => Promise<ContractRecord | null>
  saveProfile: (profile: Partial<ContractProfile>) => Promise<void>
  saveTemplate: (template: string) => Promise<void>
  savePreset: (preset: ContractPreset) => Promise<void>
  deletePreset: (key: string) => Promise<void>
  deleteRecord: (id: string) => Promise<void>
  chooseOutputDir: () => Promise<void>
}

export const useContracts = create<ContractState>((set, get) => ({
  loaded: false,
  data: null,
  drafting: null,
  lastGenerated: null,

  load: async () => {
    const data = await window.umakbang.contracts()
    set({ data, loaded: true })
  },

  draft: (titles) => set({ drafting: titles }),
  closeDraft: () => set({ drafting: null }),

  generate: async (input) => {
    const result = await window.umakbang.generateContract(input)
    set({ data: result.data })
    if (result.error) {
      useLibrary.getState().notify(result.error, 'error')
      return null
    }
    const record = result.record ?? null
    set({ lastGenerated: record, drafting: null })
    if (record) {
      useLibrary
        .getState()
        .notify(
          record.pdfPath
            ? `Contract written for ${record.input.titles.join(' & ')}.`
            : `Contract written, but the PDF failed: ${record.pdfError ?? 'unknown error'}`,
          record.pdfPath ? 'info' : 'error'
        )
    }
    return record
  },

  saveProfile: async (profile) => set({ data: await window.umakbang.saveContractProfile(profile) }),
  saveTemplate: async (template) =>
    set({ data: await window.umakbang.saveContractTemplate(template) }),
  savePreset: async (preset) => set({ data: await window.umakbang.saveContractPreset(preset) }),
  deletePreset: async (key) => set({ data: await window.umakbang.deleteContractPreset(key) }),
  deleteRecord: async (id) => set({ data: await window.umakbang.deleteContractRecord(id) }),

  chooseOutputDir: async () => {
    const picked = await window.umakbang.pickDirectory(
      'Where contracts are written',
      get().data?.outputDir || undefined
    )
    if (!picked) return
    set({ data: await window.umakbang.setContractOutputDir(picked) })
  }
}))
