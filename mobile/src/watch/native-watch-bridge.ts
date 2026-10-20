import { Platform } from 'react-native'
import { requireNativeModule } from 'expo-modules-core'

type WatchRequestEvent = { id: string; json: string }

type NativeWatchBridge = {
  respond: (id: string, json: string) => Promise<void>
  sendToWatch: (json: string) => Promise<void>
  addListener: (
    event: 'onWatchRequest',
    listener: (event: WatchRequestEvent) => void
  ) => { remove: () => void }
}

// Why: the module only exists in an iOS native build, so Android and Expo Go see no bridge.
export const nativeWatchBridge: NativeWatchBridge | null =
  Platform.OS === 'ios'
    ? (() => {
        try {
          return requireNativeModule<NativeWatchBridge>('OrcaWatchBridge')
        } catch {
          return null
        }
      })()
    : null
