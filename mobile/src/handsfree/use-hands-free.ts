import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useRpcClientContext } from '../transport/client-context'
import {
  isHandsFreeActive,
  reportHandsFreeFailed,
  reportHandsFreeReady,
  setHandsFreeActive,
  subscribeHandsFree
} from './hands-free-state'
import { startHandsFree } from './hands-free-session'

export function useHandsFreeActive(): boolean {
  return useSyncExternalStore(subscribeHandsFree, isHandsFreeActive)
}

/** Runs the hands-free conversation loop while the mode is on. Mount once below the RPC provider. */
export function useHandsFree(): void {
  const ctx = useRpcClientContext()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const active = useHandsFreeActive()

  useEffect(() => {
    if (!active) {
      return
    }
    return startHandsFree(
      () => ctxRef.current,
      (message) => {
        reportHandsFreeFailed(message)
        setHandsFreeActive(false)
      },
      reportHandsFreeReady
    )
  }, [active])
}
