import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { Check, ChevronDown, ChevronRight, Headphones, Volume2 } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { nativeHandsFree, type InstalledVoice } from './native-hands-free'
import { setHandsFreeActive } from './hands-free-state'
import { useHandsFreeActive } from './use-hands-free'

const ACCENTS: Record<string, string> = {
  'en-GB': 'British',
  'en-US': 'American',
  'en-AU': 'Australian',
  'en-IE': 'Irish',
  'en-IN': 'Indian',
  'en-ZA': 'South African'
}

function detail(voice: InstalledVoice): string {
  return `${ACCENTS[voice.language] ?? voice.language} · ${voice.quality}`
}

// Matches the rows in the Settings menu: grouped panel, icon + label, hairline separators.
export function HandsFreeToggleCard() {
  const active = useHandsFreeActive()
  const [open, setOpen] = useState(false)
  const [voices, setVoices] = useState<InstalledVoice[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void nativeHandsFree?.voices().then(setVoices)
    void nativeHandsFree?.currentVoice().then(setSelected)
  }, [])

  if (!nativeHandsFree) {
    return null
  }
  const current = voices.find((voice) => voice.id === selected)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={styles.wrap}>
      <View style={styles.section}>
        <View style={styles.row}>
          <Headphones size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Hands-free mode</Text>
          <Switch
            accessibilityLabel="Hands-free mode"
            value={active}
            onValueChange={setHandsFreeActive}
          />
        </View>
        <View style={styles.separator} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voice"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => setOpen((value) => !value)}
        >
          <Volume2 size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Voice</Text>
          <Text style={styles.value} numberOfLines={1}>
            {current ? current.name : 'Automatic'}
          </Text>
          <Chevron size={16} color={colors.textMuted} />
        </Pressable>
        {open ? (
          <>
            {voices.length === 0 ? (
              <>
                <View style={styles.separator} />
                <View style={styles.row}>
                  <Text style={styles.value}>No voices found.</Text>
                </View>
              </>
            ) : null}
            {voices.map((voice) => (
              <View key={voice.id}>
                <View style={styles.separator} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${voice.name}, ${detail(voice)}`}
                  style={({ pressed }) => [
                    styles.row,
                    styles.voiceRow,
                    pressed && styles.rowPressed
                  ]}
                  onPress={() => {
                    setSelected(voice.id)
                    void nativeHandsFree?.setVoice(voice.id)
                    void nativeHandsFree?.preview(voice.id)
                  }}
                >
                  <Text style={styles.rowLabel}>{voice.name}</Text>
                  <Text style={styles.value}>{detail(voice)}</Text>
                  {voice.id === selected ? (
                    <Check size={16} color={colors.textPrimary} />
                  ) : (
                    <View style={styles.checkSpace} />
                  )}
                </Pressable>
              </View>
            ))}
          </>
        ) : null}
      </View>
      <Text style={styles.caption}>
        When an agent finishes, Orca reads the result aloud, listens for your reply and sends it to
        that chat. Talk over it, or press play/pause, to interrupt. It keeps Orca running with the
        screen locked and the microphone ready, so turn it off when you are done. Download more
        voices in iOS Settings under Accessibility, Read &amp; Speak, Voices.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md },
  section: { backgroundColor: colors.bgPanel, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  voiceRow: { paddingLeft: spacing.md + 2 + 16 + spacing.sm + 2 },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  value: { fontSize: typography.bodySize, color: colors.textMuted, flexShrink: 1 },
  checkSpace: { width: 16 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md
  }
})
