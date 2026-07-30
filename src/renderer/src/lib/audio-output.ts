import { useSyncExternalStore } from 'react'
import type { Settings } from '@shared/types'
import { getAudioTap } from '@/components/visualizers/audio-tap'

/**
 * Which output the player's audio comes out of.
 *
 * **Two things have to be told, not one**, and that is the whole reason this module exists.
 * `HTMLMediaElement.setSinkId` routes an element that is playing on its own - but the moment
 * `createMediaElementSource` is called on it (`visualizers/audio-tap.ts`, the first time any
 * visualizer mounts) the element stops feeding a device directly and feeds the graph
 * instead, and its own sinkId is ignored from then on. `AudioContext.setSinkId` is what
 * routes it after that. Setting only the element is exactly the failure this feature exists
 * to prevent: the picker looks like it works, and with the now-playing panel open - which is
 * the default - nothing at all moves.
 *
 * Nothing here pauses or re-routes when a device is unplugged mid-track. That, ASIO/WASAPI
 * and asking the OS for permission to read device names are release-gate work; this is the
 * minimum, which is that a friend can choose where the sound goes and is told when it
 * couldn't go there.
 */

/** What the setting holds: an id paired with the name it had when it was chosen, or null. */
type Chosen = Settings['outputDevice']

/**
 * `setSinkId` on a context is Chromium 110+ and is not in TypeScript's DOM library yet, so
 * the shape is declared here rather than the call being cast to `any` at the point of use.
 */
type RoutableContext = AudioContext & {
  readonly sinkId?: string
  setSinkId?: (id: string) => Promise<void>
}

export interface OutputDeviceOption {
  id: string
  label: string
}

export interface OutputState {
  /** The real outputs, aliases removed. Empty until the first enumeration lands. */
  devices: OutputDeviceOption[]
  /** Whether a list has been fetched at all - "no devices" and "not asked yet" differ. */
  loaded: boolean
  /** True when the OS handed back ids with no names on them. See `refreshOutputDevices`. */
  unlabelled: boolean
  /** Why the chosen device is not the one playing, or null when it is. */
  failure: string | null
}

/**
 * Chromium's own aliases, deliberately left out of the list.
 *
 * `default` and `communications` are not devices, they are the OS's current pick for two
 * roles, and "System default" is already offered here as the null setting. Listing them
 * would put three entries in one menu that can all be the same pair of speakers, and
 * picking the wrong one of the three is how somebody ends up routed to a headset they
 * only ever use for calls.
 */
const ALIAS_IDS = new Set(['default', 'communications'])

let state: OutputState = { devices: [], loaded: false, unlabelled: false, failure: null }
const listeners = new Set<() => void>()

function publish(next: Partial<OutputState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function onDeviceChange(): void {
  // Only the list. What is playing right now is left where it is: chasing a device that
  // came back mid-track means deciding whether to interrupt playback to do it, which is
  // the device-disconnect story and belongs at the release gate.
  void refreshOutputDevices()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
    // Nothing outside the picker reads the list, so it is fetched when something starts
    // looking rather than at launch.
    void refreshOutputDevices()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
    }
  }
}

/** Subscribes a component to the device list and to why the chosen one isn't playing. */
export function useAudioOutput(): OutputState {
  return useSyncExternalStore(subscribe, () => state)
}

/**
 * Reads the outputs the machine has.
 *
 * **Device names, and why nothing here asks for the microphone.** A browser hides
 * `MediaDeviceInfo.label` until the page has been granted a capture permission, and the
 * usual trick is to open `getUserMedia({ audio: true })` for a moment to unlock it. This
 * deliberately does not. On macOS that call is what raises the TCC prompt, and an app whose
 * Info.plist carries no `NSMicrophoneUsageDescription` is *killed* rather than refused - and
 * the Info.plist work is a release-gate item. Electron's default permission handler already
 * answers the check that gates labels, so the names are there without asking for anything.
 * If they ever are not, the picker numbers the devices and says why, which is honest; a menu
 * of hashed ids is not.
 */
export async function refreshOutputDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const outputs = all.filter(
      (device) => device.kind === 'audiooutput' && !ALIAS_IDS.has(device.deviceId)
    )
    publish({
      loaded: true,
      unlabelled: outputs.length > 0 && outputs.every((device) => !device.label),
      devices: outputs.map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Output ${index + 1}`
      }))
    })
  } catch (error) {
    // One unreadable device list must not take the settings page down with it.
    console.error('[umakbang] could not list output devices', error)
    publish({ loaded: true, devices: [], unlabelled: false })
  }
}

/** The id last handed to the audio path. Null means nothing has been routed yet. */
let appliedId: string | null = null
/** The failure already handed back to a caller, so one cause is reported once. */
let announced = ''

/**
 * Points playback at `chosen`, or at the system default when it is null.
 *
 * Returns the message to show the user when the device could not be opened, and null when
 * there is nothing to say. The message comes back **once per cause**: the player calls this
 * on every track it loads, and one notice saying the interface is gone is help where one per
 * beat auditioned is a fault of its own. The same message stays in `useAudioOutput().failure`
 * for as long as it is true, which is where the settings page reads it.
 */
export async function applyOutputDevice(
  element: HTMLAudioElement,
  chosen: Chosen
): Promise<string | null> {
  const id = chosen?.id ?? ''
  // Re-opening an output device is not free on every driver, and this runs per track.
  if (id === appliedId) return null

  try {
    await route(element, id)
    appliedId = id
    announced = ''
    publish({ failure: null })
    return null
  } catch (error) {
    const message = describe(error, chosen?.label || 'That output device')
    /**
     * Put back on the default explicitly rather than left wherever the failed attempt
     * landed. Half the point of the message is the sentence "playing through the system
     * default instead", and it has to be true - after a first device was opened and a
     * second one refused, the audio would otherwise still be going to the first.
     */
    try {
      await route(element, '')
      appliedId = ''
    } catch {
      // Nothing left to try. The message below is still the right thing to say.
    }
    publish({ failure: message })
    const cause = `${id}:${message}`
    if (announced === cause) return null
    announced = cause
    return message
  }
}

async function route(element: HTMLAudioElement, id: string): Promise<void> {
  if (typeof element.setSinkId === 'function') {
    if (element.sinkId !== id) await element.setSinkId(id)
  } else if (id !== '') {
    // Every Chromium that can run this app has it; this is here so a runtime without it
    // says so instead of throwing a TypeError into a catch that would blame the device.
    throw new Error('this build cannot choose an output device')
  }

  /**
   * The graph is only reached for when it has to be.
   *
   * `getAudioTap()` *builds* the tap if it does not exist, and building it moves every
   * future playback through Web Audio - not something to do to somebody who has never
   * opened a visualizer and never chosen a device. But once a device has been chosen, the
   * context is the only thing that can route it, and waiting until a panel happened to open
   * would make the picker work or not work depending on which panels were showing. So the
   * default asks for nothing, anything else routes through the graph, and going back to the
   * default has to reach it too - by which point it certainly exists, since we built it.
   */
  if (id === '' && appliedId === null) return
  const context = getAudioTap()?.context as RoutableContext | undefined
  if (!context?.setSinkId) return
  if (context.sinkId !== id) await context.setSinkId(id)
}

function describe(error: unknown, name: string): string {
  const fallback = 'Playing through the system default instead.'
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return `${name} isn't connected. ${fallback}`
    if (error.name === 'NotAllowedError')
      return `${name} can't be used by umakbang - the system refused it. ${fallback}`
    // The case this feature was written for: a DAW holding the interface exclusively.
    if (error.name === 'AbortError')
      return `${name} couldn't be opened - another application may be holding it. ${fallback}`
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `${name} couldn't be opened (${detail}). ${fallback}`
}
