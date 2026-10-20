import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import type { VoiceState } from './voice-conversation'

const BARS = 11
const FRAME_MS = 60
const MAX_HEIGHT = 120
const MIN_HEIGHT = 6

const BAR_COLOR: Record<VoiceState, string> = {
  idle: colors.textMuted,
  listening: '#4ade80',
  thinking: colors.textSecondary,
  speaking: '#60a5fa'
}

// Bars that move with your voice while it listens, and with a steady rhythm while the agent thinks
// or speaks (the app has no feed of its own speech, so that part is an animation, not a meter).
export function VoiceVisualizer({ state }: { state: VoiceState }) {
  const [heights, setHeights] = useState<number[]>(() => Array(BARS).fill(MIN_HEIGHT))
  const level = useRef(0)

  useEffect(() => {
    const subscription = nativeHandsFree?.addListener('onLevel', (event) => {
      // Speech sits around 0.02 to 0.3 on this scale; stretch it so quiet talking still shows.
      level.current = Math.min(1, event.level * 6)
    })
    return () => subscription?.remove()
  }, [])

  useEffect(() => {
    let tick = 0
    let smooth = 0
    const timer = setInterval(() => {
      tick += 1
      smooth = smooth * 0.6 + level.current * 0.4
      level.current *= 0.85
      setHeights(
        Array.from({ length: BARS }, (_, index) => {
          const wave = 0.5 + 0.5 * Math.sin(tick * 0.45 + index * 0.7)
          let amount = 0
          if (state === 'listening') {
            amount = smooth * (0.35 + 0.65 * wave)
          } else if (state === 'speaking') {
            amount = 0.25 + 0.45 * Math.abs(Math.sin(tick * 0.3 + index * 0.6))
          } else if (state === 'thinking') {
            amount = 0.12 + 0.12 * wave
          }
          return MIN_HEIGHT + amount * (MAX_HEIGHT - MIN_HEIGHT)
        })
      )
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [state])

  return (
    <View style={styles.row} accessibilityLabel={`Voice ${state}`}>
      {heights.map((height, index) => (
        <View key={index} style={[styles.bar, { height, backgroundColor: BAR_COLOR[state] }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    height: MAX_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  bar: { width: 8, borderRadius: 4 }
})
