import { useRouter } from 'expo-router'
import { VoiceModeScreen } from '../src/voicemode/voice-mode-screen'

export default function VoiceModeRoute() {
  const router = useRouter()
  return <VoiceModeScreen onExit={() => router.back()} />
}
