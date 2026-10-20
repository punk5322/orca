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
    await native.start()
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
