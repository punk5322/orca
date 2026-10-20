import { useRouter } from 'expo-router'
import { VoiceModeScreen } from '../src/voicemode/voice-mode-screen'

// Opened by orca://new-task (a Siri or Shortcuts launch): starts asking "Which project?" at once.
export default function NewTaskRoute() {
  const router = useRouter()
  return (
    <VoiceModeScreen
      autoStartTask
      // Why: a launch from a link has nothing beneath it, so go home instead of going back.
      onExit={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  )
}
