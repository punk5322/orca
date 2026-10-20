import { nativeHandsFree } from './native-hands-free'

// Why: hands-free mode and the voice mode screen share one native audio session. Each takes a
// lease, and the session stops only when the last lease is released, so closing one does not cut
// the other off.
let leases = 0

export async function acquireAudio(): Promise<() => Promise<void>> {
  const native = nativeHandsFree
  if (!native) {
    throw new Error('Voice is not available in this build.')
  }
  if (leases === 0) {
    if (!(await native.requestPermission())) {
      throw new Error('Microphone access is off for Orca.')
    }
    try {
      await native.start()
    } catch {
      // Why: iOS refuses to bring up the microphone for an app that is not on screen, and says so
      // with an opaque audio error. This is the usual cause, so say it plainly.
      throw new Error(
        "iOS only lets Orca start the microphone while Orca is open on your phone's screen. Open Orca, then turn hands-free on."
      )
    }
  }
  leases += 1
  let released = false
  return async () => {
    if (released) {
      return
    }
    released = true
    leases -= 1
    if (leases === 0) {
      await native.stop()
    }
  }
}
