// Entity-doc validation guard, shared by everything that turns raw inventory JSON into a
// typed doc. Fails LOUDLY at load rather than letting an invalid doc surface as a missing
// clip or a black mesh hours later.
import { validateEntity, type EntityDoc } from '../inventory/schema'

export function validatedDoc(raw: unknown, name: string): EntityDoc {
  const { doc, issues } = validateEntity(raw)
  if (!doc) throw new Error(`${name}: invalid entity doc: ${issues.join('; ')}`)
  return doc
}
