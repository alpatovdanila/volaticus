export type AtomicEventHandler<T> = (payload: T) => void
type AtomicEventHandlerOffShortcut = VoidFunction
export type AtomicEvent<T> = {
  (payload: T): void
  on(handler: AtomicEventHandler<T>): AtomicEventHandlerOffShortcut
  off(handler: AtomicEventHandler<T>): void
  once(handler: AtomicEventHandler<T>): AtomicEventHandlerOffShortcut
}

export const createEvent = <T = void>(): AtomicEvent<T> => {
  const subs = new Set<AtomicEventHandler<T>>()

  const emit = (payload: T) => {
    ;[...subs].forEach((sub) => sub(payload))
  }
  emit.off = (handler: AtomicEventHandler<T>) => {
    subs.delete(handler)
  }

  emit.on = (handler: AtomicEventHandler<T>) => {
    subs.add(handler)
    return () => emit.off(handler)
  }

  emit.once = (handler: AtomicEventHandler<T>) => {
    const oneTimer = (payload: T) => {
      try {
        handler(payload)
      } finally {
        emit.off(oneTimer)
      }
    }
    return emit.on(oneTimer)
  }

  return emit
}
