import { Platform } from 'react-native'
import { requireNativeModule } from 'expo-modules-core'

type Subscription = { remove: () => void }

export type InstalledVoice = {
  id: string
  name: string
  language: string
  quality: 'premium' | 'enhanced' | 'compact'
}

type NativeHandsFree = {
  getRate: () => Promise<number>
  setRate: (value: number) => Promise<void>
  voices: () => Promise<InstalledVoice[]>
  currentVoice: () => Promise<string | null>
  setVoice: (id: string | null) => Promise<void>
  preview: (id: string) => Promise<void>
  requestPermission: () => Promise<boolean>
  start: () => Promise<void>
  stop: () => Promise<void>
  speak: (text: string, interruptible: boolean) => Promise<void>
  listen: () => Promise<void>
  stopListening: () => Promise<void>
  cancelSpeech: () => Promise<void>
  addListener: {
    (event: 'onChunk', listener: (event: { audio: string }) => void): Subscription
    (event: 'onListenEnded', listener: (event: { reason: string }) => void): Subscription
    (event: 'onLevel', listener: (event: { level: number }) => void): Subscription
  }
}

// Why: the module only exists in an iOS native build, so Android and Expo Go see no hands-free mode.
export const nativeHandsFree: NativeHandsFree | null =
  Platform.OS === 'ios'
    ? (() => {
        try {
          return requireNativeModule<NativeHandsFree>('OrcaHandsFree')
        } catch {
          return null
        }
      })()
    : null
